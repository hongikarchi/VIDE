// One step of the non-developer persona (PLAN-51 T-266): a NEW isolated `claude -p` process per
// step sees one screenshot and answers with one action as JSON. No tools, no MCP, no settings, no
// session, fresh empty cwd — the persona knows only the screenshot and its own last steps.
//
// The CLI takes an image only as a stream-json user message (`--input-format stream-json`), and
// that input format requires `--output-format stream-json` (+ `--verbose`); `json` output is
// rejected ("--input-format=stream-json requires output-format=stream-json"). So the run reads the
// final `{"type":"result"}` event of the stream instead of a single json document. See README.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';

export const VIEWPORT = { width: 1440, height: 900 };

/** The isolation arguments of src/ai/claude-cli.ts cliArguments() (output format: see header). */
export const ISOLATION_ARGS = [
  '-p',
  '--safe-mode',
  '--tools',
  '',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--setting-sources',
  '',
  '--no-session-persistence',
  '--no-chrome',
  '--disable-slash-commands',
  '--permission-mode',
  'dontAsk',
  '--output-format',
  'stream-json',
  '--verbose',
  '--input-format',
  'stream-json',
];

/** The environment of claude-cli.ts subscriptionEnvironment(): no API fallback credentials. */
export function claudeEnv(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env))
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_ENV_FILE$|TYPESAFE_)/i.test(key))
      delete env[key];
  return env;
}

/**
 * How to start the CLI without a shell (a shell would drop the empty `--tools ''` argument): a
 * `.js`/`.mjs` file runs on this Node (the test fake); bare `claude` is the native install when it
 * exists (like src/ai/paths.ts), else `claude` on PATH.
 */
export function claudeCommand(claude = 'claude') {
  if (['.js', '.mjs', '.cjs'].includes(extname(claude).toLowerCase()))
    return { command: process.execPath, prefix: [claude] };
  if (claude === 'claude') {
    const native = join(
      homedir(),
      '.local',
      'bin',
      process.platform === 'win32' ? 'claude.exe' : 'claude',
    );
    if (existsSync(native)) return { command: native, prefix: [] };
  }
  return { command: claude, prefix: [] };
}

/** Runs one isolated turn; resolves { text, model, ms } from the stream's result event. */
export async function runClaude({ claude = 'claude', system, content, timeoutMs = 180_000 }) {
  const cwd = await mkdtemp(join(tmpdir(), 'vide-persona-'));
  const { command, prefix } = claudeCommand(claude);
  const began = Date.now();
  try {
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(
        command,
        [...prefix, ...ISOLATION_ARGS, '--append-system-prompt', system],
        { cwd, env: claudeEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`claude timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const result = out
          .split(/\r?\n/)
          .filter((line) => line.startsWith('{'))
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return undefined;
            }
          })
          .filter((event) => event?.type === 'result')
          .at(-1);
        if (!result || result.is_error || typeof result.result !== 'string')
          return reject(
            new Error(
              `claude exited ${code} without a result: ${(result?.result ?? err ?? out).toString().slice(0, 400)}`,
            ),
          );
        resolvePromise({
          text: result.result,
          model: Object.keys(result.modelUsage ?? {})[0] ?? null,
          ms: Date.now() - began,
        });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    });
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

const ACTIONS = new Set(['click', 'type', 'wait', 'declare_stuck', 'done']);
const strings = (value) => Array.isArray(value) && value.every((v) => typeof v === 'string');

/** Parses and validates one persona answer; throws with the reason when it is not usable. */
export function parseStep(text) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in the answer');
  const value = JSON.parse(raw.slice(start, end + 1));
  const problems = [];
  if (typeof value.sees !== 'string') problems.push('sees');
  if (!strings(value.reads)) problems.push('reads');
  if (!strings(value.unknownWords)) problems.push('unknownWords');
  const action = value.action;
  if (!action || !ACTIONS.has(action.type)) problems.push('action.type');
  else {
    const inside = (n, max) => Number.isFinite(n) && n >= 0 && n <= max;
    if (
      action.type === 'click' &&
      !(inside(action.x, VIEWPORT.width) && inside(action.y, VIEWPORT.height))
    )
      problems.push('action.x/y');
    if (action.type === 'type' && typeof action.text !== 'string') problems.push('action.text');
    if (
      action.type === 'type' &&
      action.x != null &&
      !(inside(action.x, VIEWPORT.width) && inside(action.y, VIEWPORT.height))
    )
      problems.push('action.x/y');
  }
  if (typeof value.confidence !== 'number') problems.push('confidence');
  for (const key of ['stuck', 'wrongTurn', 'done'])
    if (typeof value[key] !== 'boolean') problems.push(key);
  if (problems.length) throw new Error('invalid fields: ' + problems.join(', '));
  return {
    sees: value.sees,
    reads: value.reads,
    unknownWords: value.unknownWords,
    action: {
      type: action.type,
      ...(action.x != null ? { x: action.x, y: action.y } : {}),
      ...(typeof action.text === 'string' ? { text: action.text } : {}),
      ...(action.submit === true ? { submit: true } : {}),
    },
    confidence: value.confidence,
    stuck: value.stuck,
    wrongTurn: value.wrongTurn,
    done: value.done,
    ...(typeof value.evidence === 'string' ? { evidence: value.evidence } : {}),
  };
}

export const STEP_SCHEMA = `{
  "sees": "화면에서 지금 보이는 것 한두 문장",
  "reads": ["화면 글을 그대로 옮긴 문자열", "..."],
  "unknownWords": ["처음 보는 말"],
  "action": { "type": "click | type | wait | declare_stuck | done", "x": 0, "y": 0, "text": "type일 때 입력할 글", "submit": false },
  "confidence": 0.0,
  "stuck": false,
  "wrongTurn": false,
  "done": false,
  "evidence": "done일 때 목표를 이뤘다고 보는 화면 근거"
}`;

const summary = (step) =>
  `${step.step}단계 — 본 것: ${step.persona?.sees ?? step.sees ?? ''} / 한 행동: ${JSON.stringify(step.persona?.action ?? step.action ?? {})}` +
  ((step.persona?.stuck ?? step.stuck) ? ' / 막힘' : '');

export function stepPrompt(goal, history = []) {
  const recent = history.slice(-3);
  return [
    `목표: ${goal}`,
    '',
    recent.length
      ? '지난 단계(내가 적은 요약):\n' + recent.map(summary).join('\n')
      : '지난 단계: 없음(첫 화면)',
    '',
    `첨부한 스크린샷은 지금 화면입니다(${VIEWPORT.width}x${VIEWPORT.height} 픽셀, 좌표는 이 픽셀 기준).`,
    '다음 한 가지 행동을 정해 아래 형식의 JSON 하나만 출력하세요. 다른 글은 쓰지 마세요.',
    STEP_SCHEMA,
  ].join('\n');
}

/** One persona step: screenshot + goal + last 3 own summaries → validated action (one retry). */
export async function personaStep({
  goal,
  screenshotPath,
  history = [],
  personaFile,
  claude = 'claude',
  timeoutMs,
}) {
  const system = await readFile(personaFile, 'utf8');
  const image = (await readFile(screenshotPath)).toString('base64');
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text =
      stepPrompt(goal, history) +
      (attempt
        ? `\n\n앞선 답은 쓸 수 없었습니다(${lastError.message}). 형식에 맞는 JSON만 다시 출력하세요.`
        : '');
    const answer = await runClaude({
      claude,
      system,
      timeoutMs,
      content: [
        { type: 'text', text },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
      ],
    });
    try {
      return {
        ...parseStep(answer.text),
        meta: { model: answer.model, ms: answer.ms, attempts: attempt + 1 },
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('persona answer invalid twice: ' + lastError.message);
}

export const CANARY_QUESTION = 'VIDE·jig·Sync·Link가 무엇인지 아세요? 모르면 모른다고만 답하세요.';

/**
 * Conservative: the persona counts as not knowing the words only when it says it does not know
 * (모른/모르/모릅/몰라) and does not go on to explain any of them.
 */
export function canaryUnknown(text) {
  const answer = String(text ?? '').trim();
  if (!/모른|모르|모릅|몰라/.test(answer)) return false;
  if (answer.length > 80) return false;
  const explains =
    /(이란|란\s|라는\s*것은|동기화|연결하|연동|플러그인|소프트웨어|프로그램|도구|기능|파일|모델|도면|맞추|입니다\.?\s*\S+(은|는)\s)/;
  return !explains.test(answer.replace(/(모릅니다|모르겠습니다|모른다|몰라요|모르겠어요)/g, ''));
}

export async function canaryStep({ personaFile, claude = 'claude', timeoutMs }) {
  const system = await readFile(personaFile, 'utf8');
  const answer = await runClaude({
    claude,
    system,
    timeoutMs,
    content: [{ type: 'text', text: CANARY_QUESTION }],
  });
  return {
    asked: true,
    answeredUnknown: canaryUnknown(answer.text),
    answer: answer.text,
    model: answer.model,
  };
}

// --- API guard (the persona browser holds a full engine session) --------------------------------
/** Non-GET API calls the screen makes outside a project that change nothing of the person's. */
const HARMLESS = new Set(['/api/v1/diagnostics/client']);
/**
 * Whether the persona's page may make this request. Pages and assets pass (other-origin page
 * navigations are aborted separately). On the engine's API: anything with `shutdown` is refused;
 * GET/HEAD pass; any other method passes only under /api/v1/projects/<projectId>/ — so the persona
 * cannot delete projects (DELETE /projects/:id), change settings, accounts, AccountSwitch,
 * extensions or connectors, or send requests into another project. Pure.
 * @returns {{ allow: boolean, reason?: string }}
 */
export function apiAllowed({ method, url, origin, projectId }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { allow: false, reason: 'unparsable url' };
  }
  if (u.origin !== origin || !u.pathname.startsWith('/api/')) return { allow: true };
  const path = u.pathname;
  const verb = String(method ?? 'GET').toUpperCase();
  if (/\/shutdown(\/|$)/.test(path)) return { allow: false, reason: `${verb} ${path}: shutdown` };
  if (verb === 'GET' || verb === 'HEAD') return { allow: true };
  if (HARMLESS.has(path)) return { allow: true };
  const own = `/api/v1/projects/${encodeURIComponent(projectId)}/`;
  if (projectId && path.startsWith(own)) return { allow: true };
  return { allow: false, reason: `${verb} ${path}: outside the loop project` };
}

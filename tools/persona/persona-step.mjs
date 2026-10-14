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

const ACTIONS = new Set([
  'click',
  'type',
  'select',
  'wait',
  'ask_operator',
  'declare_stuck',
  'done',
]);
/** The fact an `ask_operator` names: a short ASCII key such as `address` or `project_name`. */
const FIELD = /^[a-z][a-z0-9_]{0,39}$/;
const strings = (value) => Array.isArray(value) && value.every((v) => typeof v === 'string');

/**
 * Parses and validates one persona answer; throws with the reason when it is not usable. `choices`
 * are the open native select's options (selectChoices) the last click found (T-292): a `select`
 * action is valid only then, with `index` (the list number, 1-based) or `text` naming one of them.
 */
export function parseStep(text, { choices } = {}) {
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
    if (action.type === 'select') {
      if (!choices?.length) problems.push('action.type (select: no open choice list)');
      else if (!resolveSelect(action, choices).ok) problems.push('action.index/text');
    }
    if (
      action.type === 'ask_operator' &&
      !(typeof action.field === 'string' && FIELD.test(action.field))
    )
      problems.push('action.field');
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
      ...(typeof action.text === 'string' && action.type !== 'ask_operator'
        ? { text: action.text }
        : {}),
      ...(action.type === 'select' && Number.isInteger(action.index)
        ? { index: action.index }
        : {}),
      ...(action.submit === true ? { submit: true } : {}),
      ...(action.type === 'ask_operator'
        ? {
            field: action.field,
            ...(typeof action.question === 'string'
              ? { question: action.question.slice(0, 200) }
              : {}),
          }
        : {}),
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
  "action": { "type": "click | type | select | wait | ask_operator | declare_stuck | done", "x": 0, "y": 0, "text": "type일 때 입력할 글, select일 때 고를 항목 글", "index": "select일 때 고를 항목 번호(1부터)", "submit": false, "field": "ask_operator일 때 물을 사실(address, project_name 등)", "question": "ask_operator일 때 선배에게 하는 질문 한 문장" },
  "confidence": 0.0,
  "stuck": false,
  "wrongTurn": false,
  "done": false,
  "evidence": "done일 때 목표를 이뤘다고 보는 화면 근거"
}`;

const summary = (step) =>
  `${step.step}단계 — 본 것: ${step.persona?.sees ?? step.sees ?? ''} / 한 행동: ${JSON.stringify(step.persona?.action ?? step.action ?? {})}` +
  ((step.persona?.stuck ?? step.stuck) ? ' / 막힘' : '') +
  (step.operatorAnswers?.length
    ? ' / 선배 답: ' + step.operatorAnswers.map((a) => a.answer ?? '모른다고 함').join(', ')
    : '');

/** Every fact the operator told the persona so far (kept beyond the last 3 steps). */
export function toldFacts(history = []) {
  return history.flatMap((step) => step.operatorAnswers ?? []);
}

export function stepPrompt(goal, history = [], choices = null) {
  const recent = history.slice(-3);
  const told = toldFacts(history);
  return [
    `목표: ${goal}`,
    '',
    ...(choices?.length ? [choicesPrompt(choices), ''] : []),
    ...(told.length
      ? [
          '선배에게 물어서 들은 것:\n' +
            told
              .map((a) => `- ${a.question ?? a.field}: ${a.answer ?? '선배도 모른다고 했습니다'}`)
              .join('\n'),
          '',
        ]
      : []),
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
  choices = null,
}) {
  const system = await readFile(personaFile, 'utf8');
  const image = (await readFile(screenshotPath)).toString('base64');
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text =
      stepPrompt(goal, history, choices) +
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
        ...parseStep(answer.text, { choices }),
        meta: { model: answer.model, ms: answer.ms, attempts: attempt + 1 },
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('persona answer invalid twice: ' + lastError.message);
}

// --- native select (T-292) ----------------------------------------------------------------------
/**
 * The choosable options of a native <select> the persona clicked, numbered from 1. A screenshot
 * never shows the opened list (Chrome draws it outside the page, R4 R1-D), so the driver reads the
 * options and gives them to the persona as text. Disabled options and the empty-value placeholder
 * ('레이어를 고르세요') are left out. Pure.
 * @param {{ text: string, value: string, disabled?: boolean }[]} options in DOM order
 * @returns {{ n: number, optionIndex: number, text: string, value: string }[]}
 */
export function selectChoices(options) {
  return (Array.isArray(options) ? options : [])
    .map((option, optionIndex) => ({
      optionIndex,
      text: String(option?.text ?? '').trim(),
      value: String(option?.value ?? ''),
      disabled: option?.disabled === true,
    }))
    .filter((option) => !option.disabled && option.value !== '')
    .map(({ optionIndex, text, value }, i) => ({ n: i + 1, optionIndex, text, value }));
}

/** The prompt block that lists the open select's choices for the persona. Pure. */
export function choicesPrompt(choices) {
  return [
    '방금 누른 칸은 고르는 칸입니다. 펼친 목록은 스크린샷에 보이지 않으므로 항목을 글로 적어 둡니다:',
    ...choices.map((choice) => `${choice.n}. ${choice.text}`),
    '이 중 하나를 고르려면 action에 {"type":"select","index":번호} 또는 {"type":"select","text":"항목 글"}을 적으세요. 고르지 않을 거면 다른 행동을 하세요.',
  ].join('\n');
}

/**
 * Which choice a `select` action names: `index` (the list number) first, else `text` (exact after
 * trimming, then the one choice that contains it). Pure.
 * @returns {{ ok: true, choice: object } | { ok: false, reason: string }}
 */
export function resolveSelect(action, choices) {
  const list = Array.isArray(choices) ? choices : [];
  if (!list.length) return { ok: false, reason: 'no open choice list' };
  if (action?.index != null) {
    const choice = Number.isInteger(action.index) ? list.find((c) => c.n === action.index) : null;
    return choice
      ? { ok: true, choice }
      : { ok: false, reason: `index ${action.index} is not 1–${list.length}` };
  }
  const want = typeof action?.text === 'string' ? action.text.trim() : '';
  if (!want) return { ok: false, reason: 'neither index nor text' };
  const exact = list.find((c) => c.text === want);
  if (exact) return { ok: true, choice: exact };
  const partial = list.filter((c) => c.text.includes(want));
  if (partial.length === 1) return { ok: true, choice: partial[0] };
  return {
    ok: false,
    reason: partial.length
      ? `text '${want}' matches ${partial.length} choices`
      : `no choice '${want}'`,
  };
}

// --- after the goal (T-292) ----------------------------------------------------------------------
/**
 * Whether an undo after the goal brought the view back (R1-HIDE: U shows the hidden objects
 * again): true when objects were hidden and none are after, false when some still are, null when
 * nothing was hidden before or the count could not be read (no 3D view). Pure.
 * @returns {{ undoRestored: boolean | null, reason?: string }}
 */
export function undoVerdict(hiddenBefore, hiddenAfter) {
  if (!Number.isFinite(hiddenBefore) || !Number.isFinite(hiddenAfter))
    return { undoRestored: null, reason: 'hidden count unreadable (no 3D view)' };
  if (hiddenBefore === 0) return { undoRestored: null, reason: 'nothing was hidden' };
  return { undoRestored: hiddenAfter === 0 };
}

// --- operator answers (T-286) --------------------------------------------------------------------
/** How many times one run answers ask_operator; later asks get no answer (the intern must go on). */
export const MAX_OPERATOR_ANSWERS = 5;
/**
 * The operator's answer to an `ask_operator` action: the scenario's `operator` block merged with
 * `--answers`. Only facts a senior would tell (an address, a project name) are in there; anything
 * else, how to use the screen included, gets `answer: null`. Pure.
 * @returns {{ field: string, question?: string, answer: string | null, reason?: string }}
 */
export function operatorAnswer(operator, action, asked = 0) {
  const field = action?.field;
  const base = { field, ...(action?.question ? { question: action.question } : {}) };
  if (asked >= MAX_OPERATOR_ANSWERS) return { ...base, answer: null, reason: 'limit' };
  const value = operator && Object.hasOwn(operator, field) ? operator[field] : undefined;
  if (typeof value !== 'string' || !value.trim())
    return { ...base, answer: null, reason: 'unknown' };
  return { ...base, answer: value };
}

// --- host check before a run (T-286) -------------------------------------------------------------
/**
 * Whether the project's links fit the scenario's hosts (GET /projects/:id/links rows). A host link
 * is open when the row has a `connection` (a host window holds that document). Refuses when a host
 * outside `hosts` is open (round 2: an open ZWCAD link drew every request to zwcad) or when a
 * listed host has no open link. File links (`kind: 'file'`) are not host windows. Pure.
 * @returns {{ ok: boolean, reason?: string, open: { host: string, id: string, name?: string }[] }}
 */
export function hostsCheck(rows, hosts) {
  const open = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.kind !== 'file' && row.connection)
    .map((row) => ({ host: row.host ?? 'rhino', id: row.id, name: row.name }));
  const wanted = new Set(hosts ?? []);
  const foreign = open.filter((link) => !wanted.has(link.host));
  if (foreign.length)
    return {
      ok: false,
      reason: `hosts: ${foreign.map((l) => `${l.host} link ${l.id}${l.name ? ` '${l.name}'` : ''}`).join(', ')} is open but the scenario uses only ${[...wanted].join('+') || 'no host'}`,
      open,
    };
  const missing = [...wanted].filter((host) => !open.some((l) => l.host === host));
  if (missing.length)
    return { ok: false, reason: `hosts: no open ${missing.join(', ')} link in the project`, open };
  return { ok: true, open };
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

// Offline round trip of the persona step with a fake `claude` (no model, no UI).
//   node --test tools/persona/persona-step.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ISOLATION_ARGS,
  canaryStep,
  canaryUnknown,
  claudeEnv,
  parseStep,
  personaStep,
} from './persona-step.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const personaFile = join(here, 'personas', 'intern.md');
const dir = await mkdtemp(join(tmpdir(), 'persona-test-'));
const fake = join(dir, 'fake-claude.mjs');
const screenshot = join(dir, 'shot.png');
await writeFile(
  screenshot,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);

// The fake checks the isolation arguments and the stream-json input, records what it got, and
// answers FAKE_PERSONA_ANSWERS[n] for its n-th call (counted in FAKE_PERSONA_COUNTER).
await writeFile(
  fake,
  `import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const expected = ${JSON.stringify(ISOLATION_ARGS)};
for (let i = 0; i < expected.length; i++)
  if (args[i] !== expected[i]) { process.stderr.write('bad arg ' + i + ': ' + args[i]); process.exit(2); }
const system = args[args.indexOf('--append-system-prompt') + 1];
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const counter = process.env.FAKE_PERSONA_COUNTER;
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(n + 1));
  const message = JSON.parse(input.trim());
  appendFileSync(process.env.FAKE_PERSONA_LOG, JSON.stringify({ cwd: process.cwd(), system, message,
    leaked: Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_)/.test(k)) }) + '\\n');
  const answers = JSON.parse(process.env.FAKE_PERSONA_ANSWERS);
  const result = answers[Math.min(n, answers.length - 1)];
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result,
    modelUsage: { 'fake-model': {} } }) + '\\n');
});
`,
);

let round = 0;
function setup(answers) {
  round++;
  process.env.FAKE_PERSONA_COUNTER = join(dir, `counter-${round}`);
  process.env.FAKE_PERSONA_LOG = join(dir, `log-${round}.jsonl`);
  process.env.FAKE_PERSONA_ANSWERS = JSON.stringify(answers);
  return async () =>
    (await readFile(process.env.FAKE_PERSONA_LOG, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
}

const good = {
  sees: '왼쪽에 채팅 입력칸이 있다',
  reads: ['무엇을 할까요?'],
  unknownWords: ['Sync'],
  action: { type: 'click', x: 200, y: 820 },
  confidence: 0.6,
  stuck: false,
  wrongTurn: false,
  done: false,
};

test('a valid answer is parsed; the run is isolated and carries the screenshot', async () => {
  process.env.ANTHROPIC_API_KEY = 'must-not-leak';
  const log = setup([JSON.stringify(good)]);
  const step = await personaStep({
    goal: '보만 남기고 다 숨겨줘',
    screenshotPath: screenshot,
    history: [{ step: 1, persona: { ...good, sees: '첫 화면' } }],
    personaFile,
    claude: fake,
  });
  delete process.env.ANTHROPIC_API_KEY;
  assert.deepEqual(step.action, { type: 'click', x: 200, y: 820 });
  assert.deepEqual(step.unknownWords, ['Sync']);
  assert.equal(step.meta.model, 'fake-model');
  assert.equal(step.meta.attempts, 1);
  const [call] = await log();
  assert.equal(call.system, await readFile(personaFile, 'utf8'));
  assert.deepEqual(call.leaked, []);
  assert.match(call.cwd, /vide-persona-/);
  const [text, image] = call.message.message.content;
  assert.match(text.text, /보만 남기고 다 숨겨줘/);
  assert.match(text.text, /1단계 — 본 것: 첫 화면/);
  assert.equal(image.type, 'image');
  assert.equal(image.source.media_type, 'image/png');
});

test('an invalid answer is retried once, then succeeds', async () => {
  const log = setup(['이건 JSON이 아닙니다', '```json\n' + JSON.stringify(good) + '\n```']);
  const step = await personaStep({
    goal: 'g',
    screenshotPath: screenshot,
    personaFile,
    claude: fake,
  });
  assert.equal(step.meta.attempts, 2);
  const calls = await log();
  assert.equal(calls.length, 2);
  assert.match(calls[1].message.message.content[0].text, /앞선 답은 쓸 수 없었습니다/);
});

test('two invalid answers fail the step', async () => {
  const log = setup(['{"sees": 1}', 'nope']);
  await assert.rejects(
    personaStep({ goal: 'g', screenshotPath: screenshot, personaFile, claude: fake }),
    /invalid twice/,
  );
  assert.equal((await log()).length, 2);
});

test('parseStep rejects off-screen clicks and missing fields', () => {
  assert.throws(
    () => parseStep(JSON.stringify({ ...good, action: { type: 'click', x: 2000, y: 10 } })),
    /action.x/,
  );
  assert.throws(() => parseStep(JSON.stringify({ ...good, done: 'yes' })), /done/);
  assert.throws(
    () => parseStep(JSON.stringify({ ...good, action: { type: 'fly' } })),
    /action.type/,
  );
  const typed = parseStep(
    JSON.stringify({
      ...good,
      action: { type: 'type', x: 300, y: 850, text: '보만 남기고', submit: true },
    }),
  );
  assert.deepEqual(typed.action, {
    type: 'type',
    x: 300,
    y: 850,
    text: '보만 남기고',
    submit: true,
  });
});

test('canary answers', async () => {
  for (const [answer, unknown] of [
    ['모릅니다.', true],
    ['모릅니다. VIDE, jig, Sync, Link 모두 처음 듣는 말이라 뜻을 모릅니다.', true],
    ['잘 모르겠습니다.', true],
    ['네 하나도 모르겠어요', true],
    ['{"answer":"모릅니다"}', true],
    ['VIDE는 건축 AI 도구이고 Sync는 동기화입니다.', false],
    ['Sync는 모델과 도면을 맞추는 기능 같은데 나머지는 모릅니다.', false],
    ['알아요.', false],
    ['jig는 모르지만 Link는 연결하는 것입니다', false],
  ])
    assert.equal(canaryUnknown(answer), unknown, answer);
  setup(['모릅니다.']);
  const canary = await canaryStep({ personaFile, claude: fake });
  assert.equal(canary.asked, true);
  assert.equal(canary.answeredUnknown, true);
});

test('the CLI environment drops API fallback credentials', () => {
  const env = claudeEnv({
    PATH: 'p',
    ANTHROPIC_API_KEY: 'k',
    CLAUDE_CODE_X: '1',
    TYPESAFE_KEY: 't',
    CLAUDE_CONFIG_DIR: 'c',
  });
  assert.deepEqual(env, { PATH: 'p', CLAUDE_CONFIG_DIR: 'c' });
});

test('apiAllowed keeps the persona inside its project', async () => {
  const { apiAllowed } = await import('./persona-step.mjs');
  const origin = 'http://127.0.0.1:47821';
  const ok = (method, path, projectId = 'p1') =>
    apiAllowed({ method, url: origin + path, origin, projectId }).allow;
  // Pages, assets and reads pass.
  assert.equal(ok('GET', '/?project=p1'), true);
  assert.equal(ok('GET', '/api/v1/projects'), true);
  assert.equal(ok('GET', '/api/v1/projects/p2/requests'), true);
  // Writes in the loop project pass.
  assert.equal(ok('POST', '/api/v1/projects/p1/requests'), true);
  assert.equal(ok('POST', '/api/v1/projects/p1/route'), true);
  assert.equal(ok('POST', '/api/v1/diagnostics/client'), true);
  // Everything else that writes is refused.
  assert.equal(ok('DELETE', '/api/v1/projects/p1'), false);
  assert.equal(ok('DELETE', '/api/v1/projects/p2'), false);
  assert.equal(ok('POST', '/api/v1/projects/p2/requests'), false);
  assert.equal(ok('POST', '/api/v1/projects/p10/requests'), false);
  assert.equal(ok('POST', '/api/v1/projects'), false);
  assert.equal(ok('POST', '/api/v1/shutdown'), false);
  assert.equal(ok('GET', '/api/v1/shutdown'), false);
  for (const path of [
    '/api/v1/accounts/usage-settings',
    '/api/v1/accountswitch/open',
    '/api/v1/settings/ai',
    '/api/v1/extensions/x/install',
    '/api/v1/connectors/x/install',
    '/api/v1/host/pins',
  ])
    assert.equal(ok('POST', path), false, path);
  assert.equal(ok('PUT', '/api/v1/settings/routing'), false);
  // Other origins are not the engine's API (navigations are aborted elsewhere).
  assert.equal(apiAllowed({ method: 'POST', url: 'https://example.com/api/v1/x', origin, projectId: 'p1' }).allow, true);
});

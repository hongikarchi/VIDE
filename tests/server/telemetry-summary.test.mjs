// ADR-036, PLAN-34 T-155: what an opt-in report may carry. Free text loses paths, user and file
// names, Korean text, quoted text, addresses and ids; each event keeps only its allowlisted fields;
// a summary of real-looking logs holds none of the private words, and stays under its cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allowedFields,
  capSummary,
  reportStack,
  reportText,
  routePattern,
  summarizeLogs,
} from '../../src/server/telemetry-summary.ts';

// Words that must never reach a report, and the places they hide. Korean words and the words the
// engine names (Windows user, PC, project names) may stand anywhere; other ASCII names reach a log
// only inside paths, quotes, file names, addresses and keys.
const ANYWHERE = [
  '홍길동',
  '김 철수',
  '서울역 광장',
  'A동 평면',
  'jsmith',
  'DESKTOP-7Q2K',
  'Tower B',
  'tower-final',
];
const PLACED = ['John Smith', 'Kim Lee', 'fileserver', 'studio', 'sk-ant-abcdef123456'];
const SECRETS = [...ANYWHERE, ...PLACED];
const SENSITIVE = ['jsmith', 'DESKTOP-7Q2K', 'Tower B', 'tower-final'];
// Templates whose word sits inside a path, quotes, a file name, an address or a key.
const PLACED_TEMPLATES = [
  (w) => `ENOENT: no such file or directory, open 'C:\\Users\\${w}\\Documents\\x.3dm'`,
  (w) => `failed C:\\Users\\${w}\\My Projects\\${w} v2\\plan.dwg then retried`,
  (w) => `\\\\fileserver\\프로젝트\\${w}\\model.dwg is not reachable`,
  (w) => `\\\\?\\C:\\Users\\${w}\\AppData\\Local\\VIDE\\x.json`,
  (w) => `C:/Users/${w}/Desktop/new folder/${w}.pdf`,
  (w) => `request "${w} 리모델링 해줘" failed`,
  (w) => `see https://${w.replace(/ /g, '-')}.trycloudflare.com/api/v1/projects/9f?x=1`,
  (w) => `mail ${w.replace(/ /g, '.')}@studio.co.kr`,
  (w) => `layer “${w}” not found`,
  (w) => `token=sk-ant-abcdef123456 for '${w}'`,
];
const TEMPLATES = [
  (w) => `ENOENT: no such file or directory, open 'C:\\Users\\${w}\\Documents\\x.3dm'`,
  (w) => `failed C:\\Users\\${w}\\My Projects\\${w} v2\\plan.dwg then retried`,
  (w) => `\\\\fileserver\\프로젝트\\${w}\\model.dwg is not reachable`,
  (w) => `\\\\?\\C:\\Users\\${w}\\AppData\\Local\\VIDE\\x.json`,
  (w) => `EPERM rename /home/${w}/.vide/telemetry.json`,
  (w) => `C:/Users/${w}/Desktop/new folder/${w}.pdf`,
  (w) => `request "${w} 리모델링 해줘" failed`,
  (w) => `Cannot open ${w}.3dm: locked`,
  (w) => `see https://${w}.trycloudflare.com/api/v1/projects/9f?x=${w} or mail ${w}@studio.co.kr`,
  (w) => `user ${w} on DESKTOP-7Q2K has no access`,
  (w) => `layer “${w}” not found`,
  (w) => `오류: ${w} 프로젝트를 열 수 없습니다`,
  (w) => `token=sk-ant-abcdef123456 for ${w}`,
];

const leaks = (out) => SECRETS.filter((secret) => out.toLowerCase().includes(secret.toLowerCase()));
const cases = () => [
  ...TEMPLATES.flatMap((template) => ANYWHERE.map((word) => template(word))),
  ...PLACED_TEMPLATES.flatMap((template) => SECRETS.map((word) => template(word))),
];

test('free text keeps no path, name, Korean text, quoted text, address or key', () => {
  for (const text of cases()) {
    const out = reportText(text, 300, SENSITIVE);
    assert.deepEqual(leaks(out), [], `${JSON.stringify(text)} → ${JSON.stringify(out)}`);
    assert.ok(!/[^\x00-\x7F]/.test(out), `${out} has non-ASCII`);
    assert.ok(!/[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\//.test(out), `${out} has a path`);
    assert.ok(out.length <= 300);
  }
});

test('random mixes of private words and paths never survive (property)', () => {
  // A seeded generator: the same cases on every run.
  let seed = Number(process.env.VIDE_PROPERTY_SEED ?? 7);
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (list) => list[Math.floor(random() * list.length)];
  const glue = [' ', '\\', '/', ': ', ' in ', ", '", "' ", '"', '(', ')', ' - ', '\n'];
  const all = cases();
  for (let i = 0; i < 3000; i++) {
    const parts = [];
    for (let j = 0, n = 2 + Math.floor(random() * 6); j < n; j++)
      parts.push(random() < 0.5 ? pick(all) : pick(ANYWHERE), pick(glue));
    const text = parts.join('');
    const out = reportText(text, 400, SENSITIVE);
    assert.deepEqual(leaks(out), [], `${JSON.stringify(text)} → ${JSON.stringify(out)}`);
    assert.ok(!/[^\x00-\x7F]/.test(out), `${out} has non-ASCII`);
  }
});

test('stack frames keep VIDE source places and drop every other path', () => {
  const stack = [
    'TypeError: Cannot read properties of undefined',
    '    at Execution.run (C:\\Users\\홍길동\\AppData\\Local\\VIDE.App\\current\\app\\src\\server\\execution.ts:1018:21)',
    '    at file:///C:/Users/jsmith/work/src/server/a.ts:3:4',
    '    at Object.<anonymous> (D:\\프로젝트\\Tower B\\script.js:1:1)',
    '    at node:internal/process/task_queues:105:5',
    '    at Vide.Worker.GhApply.Run(String json) in C:\\Users\\jsmith\\src\\VIDE\\hosts\\rhino\\worker\\Grasshopper\\GhApply.cs:line 42',
  ].join('\n');
  const out = reportStack(stack, 8, ['jsmith']);
  assert.match(out, /at Execution\.run \(src\/server\/execution\.ts:1018:21\)/);
  assert.match(out, /at src\/server\/a\.ts:3:4/);
  assert.match(out, /node:internal\/process\/task_queues/);
  assert.match(
    out,
    /GhApply\.Run\(String json\) \(hosts\/rhino\/worker\/Grasshopper\/GhApply\.cs:42\)/,
  );
  assert.ok(!/홍길동|jsmith|Tower|프로젝트|TypeError/.test(out), out);
});

test('each event keeps only its listed fields, in their kinds', () => {
  const line = {
    at: '2026-10-06T01:00:00.000Z',
    event: 'api-error',
    requestId: 'r-secret',
    projectId: 'p-secret',
    request: 'r-77',
    method: 'POST',
    path: '/api/v1/projects/서울역/requests/abc123/delta',
    status: 409,
    code: 'PROJECT_BUSY',
    body: '서울역 광장 리모델링',
  };
  assert.deepEqual(allowedFields('api-error', line), {
    method: 'POST',
    path: '/api/v1/projects/:id/requests/:id/delta',
    status: 409,
    code: 'PROJECT_BUSY',
  });
  // A field of the wrong kind is dropped (a code with spaces, a name that is a sentence).
  assert.deepEqual(allowedFields('sync-failed', { code: 'not a code', name: '홍길동', ms: 12 }), {
    ms: 12,
  });
  // tool-call: the tool and code, never the link or request.
  assert.deepEqual(
    allowedFields('tool-call', {
      tool: 'gh_apply',
      ok: false,
      code: 'GH_OBJECT_NOT_FOUND',
      linkId: 'l1',
      requestId: 'r',
    }),
    { tool: 'gh_apply', code: 'GH_OBJECT_NOT_FOUND', ok: false },
  );
  // An event without a list gives nothing.
  assert.deepEqual(allowedFields('route', { target: 'view', body: 'x' }), {});
  assert.equal(routePattern('/projects/홍길동/links/Tower B?x=1'), '/projects/:id/links/:id');
});

test('a summary of real-looking logs carries counts, failures, exits and timings — and no private words', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-telemetry-sum-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logs = join(directory, 'logs');
  await mkdir(logs);
  const day = '2026-10-06';
  const line = (fields) => JSON.stringify({ v: '0.2.21', sid: 'abcd', ...fields });
  const engine = [
    line({ at: `${day}T00:00:01.000Z`, event: 'engine-start', port: 47821, pid: 1 }),
    line({
      at: `${day}T01:00:00.000Z`,
      event: 'api-error',
      method: 'GET',
      path: '/api/v1/projects/:id',
      status: 404,
      code: 'PROJECT_NOT_FOUND',
      projectId: 'Tower B',
    }),
    line({
      at: `${day}T01:00:01.000Z`,
      event: 'api-error',
      method: 'GET',
      path: '/api/v1/projects/:id',
      status: 404,
      code: 'PROJECT_NOT_FOUND',
      repeated: 4,
    }),
    line({
      at: `${day}T02:00:00.000Z`,
      event: 'server-error',
      name: 'Error',
      message: "EBUSY: resource busy, open 'C:\\Users\\홍길동\\서울역 광장.3dm'",
      stack: 'Error: x\n    at f (C:\\Users\\홍길동\\app\\src\\server\\x.ts:1:2)',
    }),
    line({
      at: `${day}T02:00:01.000Z`,
      event: 'cli-exit',
      provider: 'claude-cli',
      cliVersion: '2.1.0',
      code: 1,
      ms: 5000,
      // A fake key (low entropy, so the secret scanner does not take the test for a leak).
      stderrTail: 'Error at C:\\Users\\jsmith\\.claude\\x.json: token=fakefakefakefake',
    }),
    line({
      at: `${day}T02:00:02.000Z`,
      event: 'request-stages',
      totalMs: 12000,
      firstOutputMs: 900,
      queries: 2,
    }),
    line({
      at: `${day}T02:00:03.000Z`,
      event: 'request-end',
      state: 'failed',
      code: 'PROVIDER_LIMIT',
      ms: 12000,
      requestId: 'r1',
    }),
    line({
      at: `${day}T02:00:04.000Z`,
      event: 'tool-call',
      tool: 'query',
      ms: 40,
      bytes: 10,
      ok: true,
    }),
    line({
      at: `${day}T02:00:05.000Z`,
      event: 'route',
      target: 'view',
      body: '서울역 광장 숨겨줘',
    }),
    line({
      at: `${day}T02:00:06.000Z`,
      event: 'health',
      rssMB: 300,
      heapMB: 120,
      loopMaxMs: 40,
      loopP99Ms: 20,
    }),
    'not json',
    line({ at: '2026-10-05T23:00:00.000Z', event: 'server-error', message: 'before the window' }),
  ];
  await writeFile(join(logs, `engine-${day}.jsonl`), engine.join('\n') + '\n');
  await writeFile(
    join(logs, `rhino-${day}.jsonl`),
    [
      line({
        at: `${day}T03:00:00.000Z`,
        event: 'plugin-load',
        rhino: '8.15.25019.13001',
        v: '0.2.21',
      }),
      line({ at: `${day}T03:00:01.000Z`, event: 'call', method: 'live-sync', ms: 30, ok: true }),
      line({
        at: `${day}T03:00:02.000Z`,
        event: 'call',
        method: 'execute',
        ms: 300,
        ok: false,
        code: 'SCRIPT_FAILED',
        type: 'System.IO.IOException',
        message: 'The file D:\\Tower B\\x.3dm is locked by jsmith',
      }),
    ].join('\n') + '\n',
  );
  await writeFile(
    join(logs, 'engine-exits.jsonl'),
    [
      JSON.stringify({
        at: `${day}T04:00:00.000Z`,
        event: 'engine-exit',
        pid: 9,
        code: -1073740791,
        hex: '0xC0000409',
        uptimeSec: 40,
        asked: false,
      }),
      JSON.stringify({
        at: `${day}T04:10:00.000Z`,
        event: 'engine-exit',
        pid: 10,
        code: 0,
        hex: '0x00000000',
        uptimeSec: 400,
        asked: true,
      }),
    ].join('\n') + '\n',
  );
  const summary = await summarizeLogs({
    directory,
    since: `${day}T00:00:00.000Z`,
    until: `${day}T23:59:59.000Z`,
    sensitive: ['jsmith', 'Tower B'],
  });
  const text = JSON.stringify(summary);
  for (const secret of [
    '홍길동',
    '서울역',
    'jsmith',
    'Tower B',
    'fakefake',
    'r1',
    'C:\\\\',
    'before the window',
  ])
    assert.ok(!text.includes(secret), `${secret} in ${text}`);
  assert.equal(summary.counts['engine:api-error'], 2);
  assert.equal(summary.counts['engine:route'], 1);
  const notFound = summary.errors.find((error) => error.fields.code === 'PROJECT_NOT_FOUND');
  assert.equal(notFound.count, 6, 'the same failure merged with its repeats');
  const serverError = summary.errors.find((error) => error.event === 'server-error');
  assert.match(serverError.fields.stack, /src\/server\/x\.ts:1:2/);
  assert.ok(
    summary.errors.some(
      (error) => error.event === 'request-end' && error.fields.code === 'PROVIDER_LIMIT',
    ),
  );
  assert.ok(
    summary.errors.some((error) => error.part === 'rhino' && error.fields.code === 'SCRIPT_FAILED'),
  );
  assert.ok(!summary.errors.some((error) => error.event === 'route'));
  assert.deepEqual(summary.exits, [
    { at: `${day}T04:00:00.000Z`, code: -1073740791, hex: '0xC0000409', uptimeSec: 40 },
  ]);
  assert.deepEqual(summary.hosts, { rhino: ['8.15.25019.13001'] });
  assert.equal(summary.timings['request.totalMs'].p50, 12000);
  assert.equal(summary.timings['health.rssMB'].max, 300);
  assert.ok(summary.timings['rhino.live-sync.ms']);
  assert.deepEqual(summary.versions.engine, ['0.2.21']);
});

test('the cap leaves out stacks, then errors, and says so', () => {
  const errors = Array.from({ length: 300 }, (_, i) => ({
    part: 'engine',
    event: 'server-error',
    count: 300 - i,
    first: 'a',
    last: 'b',
    fields: { code: `E_${i}`, message: 'x'.repeat(200), stack: 'at f (src/x.ts:1:1)\n'.repeat(8) },
  }));
  const summary = {
    from: 'a',
    to: 'b',
    versions: {},
    hosts: {},
    counts: {},
    errors,
    exits: [],
    timings: {},
  };
  const capped = capSummary(summary, 32 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= 32 * 1024);
  assert.equal(capped.truncated.stacks, true);
  assert.ok(capped.truncated.errors > 0);
  assert.equal(capped.errors[0].fields.code, 'E_0', 'the most frequent stay');
  assert.equal(capped.errors[0].fields.stack, undefined);
});

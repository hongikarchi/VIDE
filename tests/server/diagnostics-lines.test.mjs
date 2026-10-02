// T-126: the diagnostic log gathers lines and writes them together, every failure carries its code,
// tool calls and CLI processes leave a line, and no request text or key reaches a line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { Diagnostics, RepeatGate, routeOf } from '../../src/server/diagnostics.ts';
import { startServer } from '../../src/server/server.ts';
import { AgentTools } from '../../src/server/agent-tools.ts';
import { runDocumentSync } from '../../src/server/document-sync.ts';
import { SyncCoalescer } from '../../src/server/sync-coalesce.ts';
import { writeDiagnosticBundle } from '../../src/server/diagnostic-bundle.ts';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { scrub, setDiagnosticSink, withTrace } from '../../src/core/breadcrumbs.ts';
import { watchedSpawn } from '../../src/ai/cli-log.ts';

const DAY = '2026-10-02';
const at = () => new Date(`${DAY}T10:00:00Z`);
const read = async (directory, day = DAY) =>
  (await readFile(join(directory, 'logs', `engine-${day}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('lines are gathered: a write touches no file until the interval, the size or a sync line', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-diag-buf-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = new Diagnostics({ directory, now: at, flushMs: 30, flushBytes: 4096 });
  const file = join(directory, 'logs', `engine-${DAY}.jsonl`);
  log.write('one', { n: 1 });
  assert.equal(existsSync(file), false, 'nothing written yet');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal((await read(directory)).length, 1, 'written after the interval');
  for (let i = 0; i < 60; i++) log.write('many', { n: i, pad: 'x'.repeat(80) });
  assert.ok((await read(directory)).length > 1, 'written once the size is reached');
  log.write('crumb', {}, true);
  assert.equal((await read(directory)).at(-1).event, 'crumb', 'a sync line is on disk at once');
  log.close();
});

test('10,000 lines cost the caller well under a millisecond each and arrive in order', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-diag-speed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = new Diagnostics({ directory, now: at });
  const started = performance.now();
  for (let i = 0; i < 10_000; i++) log.write('probe', { i, ms: 12, code: 'HOST_BUSY' });
  const perLine = (performance.now() - started) / 10_000;
  log.close();
  const lines = await read(directory);
  assert.equal(lines.length, 10_000);
  assert.deepEqual(
    lines.slice(0, 3).map((line) => line.i),
    [0, 1, 2],
  );
  assert.ok(perLine < 0.05, `per line ${perLine.toFixed(4)} ms`);
});

test('the gathered lines reach the file when the process exits', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-diag-exit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = new URL('../../src/server/diagnostics.ts', import.meta.url).href;
  const script = `const { Diagnostics } = await import(${JSON.stringify(module)});
    const log = new Diagnostics({ directory: ${JSON.stringify(directory)} });
    log.write('last-words', { n: 1 });
    process.exit(3);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 3, child.stderr);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal((await read(directory, day))[0].event, 'last-words');
});

test("a day's file stops at its cap with one notice and the dropped count", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-diag-cap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = new Diagnostics({ directory, now: at, dayCapBytes: 2000 });
  for (let i = 0; i < 50; i++) log.write('probe', { i, pad: 'y'.repeat(60) });
  log.close();
  const lines = await read(directory);
  assert.equal(lines.filter((line) => line.event === 'log-cap').length, 1);
  const dropped = lines.find((line) => line.event === 'log-cap-dropped');
  assert.equal(dropped.dropped + lines.filter((line) => line.event === 'probe').length, 50);
});

test('routes are logged without ids; repeats are counted, not written', () => {
  assert.deepEqual(routeOf('/api/v1/projects/p-1/requests/9f3c2a/undo?x=1'), {
    path: '/api/v1/projects/:id/requests/:id/undo',
    projectId: 'p-1',
    request: '9f3c2a',
  });
  let now = 0;
  const gate = new RepeatGate(1000, () => now);
  assert.equal(gate.note('GET', '/a', 'X'), 0);
  assert.equal(gate.note('GET', '/a', 'X'), undefined);
  assert.equal(gate.note('GET', '/a', 'X'), undefined);
  now = 1500;
  assert.equal(gate.note('GET', '/a', 'X'), 2);
});

test('scrub takes keys, tokens and the Windows user name out of outside text', () => {
  const text = scrub(
    'Error at C:\\Users\\kim\\AppData\\x Bearer abcdefghijklmnop api_key=SECRET123 sk-ant-abcdefghijk token: "zzzzzzzz" ' +
      'a'.repeat(40),
  );
  for (const secret of ['kim', 'abcdefghijklmnop', 'SECRET123', 'ant-abcdefghijk', 'zzzzzzzz'])
    assert.ok(!text.includes(secret), `${secret} in ${text}`);
  assert.equal(scrub('x'.repeat(5000), 2048).length, 2048);
});

test('an error the user sees is logged with its code, path pattern and ids; request text never', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-diag-api-'));
  const app = await startServer({
    filename: join(directory, 'workspace.sqlite'),
    host: { status: async () => ({ available: true }) },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const headers = {
    Origin: app.origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const missing = await fetch(app.origin + '/api/v1/projects/nope-1/requests/r-77', { headers });
  assert.equal(missing.status, 404);
  const { requestId } = await missing.json();
  const invalid = await fetch(app.origin + '/api/v1/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 7, secret: '비밀 요청 문장' }),
  });
  assert.equal(invalid.status, 400);
  // A page's own error report: logged cleaned, rate-limited.
  const report = await fetch(app.origin + '/api/v1/diagnostics/client', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'error',
      message: 'TypeError: x is undefined token=abcdefgh123',
      stack: 'at C:\\Users\\kim\\app.js:1:2',
      route: '#/projects/p-9/conversations/c-1',
    }),
  });
  assert.deepEqual(await report.json(), { logged: true });
  app.diagnostics.flush();
  const lines = await read(directory, new Date().toISOString().slice(0, 10));
  const notFound = lines.find((line) => line.event === 'api-error' && line.code === 'NOT_FOUND');
  assert.equal(notFound.requestId, requestId);
  assert.equal(notFound.status, 404);
  assert.equal(notFound.path, '/api/v1/projects/:id/requests/:id');
  assert.equal(notFound.projectId, 'nope-1');
  assert.equal(notFound.request, 'r-77');
  const bad = lines.find((line) => line.event === 'api-error' && line.code === 'INVALID_INPUT');
  assert.equal(bad.status, 400);
  const client = lines.find((line) => line.event === 'client-error');
  assert.match(client.message, /TypeError/);
  assert.ok(!client.message.includes('abcdefgh123'));
  assert.ok(!client.stack.includes('kim'));
  for (const line of lines) assert.equal(typeof line.v, 'string');
  assert.ok(!JSON.stringify(lines).includes('비밀 요청 문장'), 'request text is never logged');
  // The bundle: logs and a summary, never keys or the DB.
  await writeFile(join(directory, 'local-session.key'), 'KEY');
  await writeFile(join(directory, 'typesafe.env'), 'TYPESAFE_API_KEY=x');
  const bundle = await (
    await fetch(app.origin + '/api/v1/diagnostics/bundle', {
      method: 'POST',
      headers,
      body: '{}',
    })
  ).json();
  assert.ok(bundle.files.includes('about.json'));
  assert.ok(bundle.files.some((name) => name.startsWith('logs/engine-')));
  assert.ok(
    !bundle.files.some((name) => /sqlite|session\.key|typesafe|launch\.json/.test(name)),
    bundle.files.join(','),
  );
});

test('a failed Sync is logged with its code and step', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const project = store.createProject('Sync');
  const written = [];
  const context = {
    workspace,
    zwcadSdk: {
      editors: {
        has: async () => true,
        capture: async () => {
          throw Object.assign(new Error('too large'), { code: 'HOST_RESULT_TOO_LARGE' });
        },
      },
    },
    rhinoImport: {},
    host: {},
    documentSyncs: new SyncCoalescer(),
    diagnostics: { write: (event, fields) => written.push({ event, ...fields }) },
  };
  const { result } = await runDocumentSync(context, project.id, {
    id: 'sync-1',
    instance: '1:2',
    documentId: 1,
  });
  assert.equal(result.state, 'failed');
  const line = written.find((entry) => entry.event === 'sync');
  assert.equal(line.state, 'failed');
  assert.equal(line.code, 'HOST_RESULT_TOO_LARGE');
  assert.equal(line.host, 'zwcad');
  assert.equal(typeof line.ms, 'number');
});

test('every tool call leaves a line with its tool, time, size and code, not its arguments', async (t) => {
  const events = [];
  const sink = (event, fields) => events.push({ event, ...fields });
  setDiagnosticSink(sink);
  t.after(() => setDiagnosticSink(undefined, sink));
  const tools = new AgentTools();
  const scope = withTrace({ requestId: 'req-1' }, () =>
    tools.issue({
      targetRef: 'conversation:c-1',
      handlers: {
        jig_list: async () => ({ instances: [], note: 'x'.repeat(100) }),
        jig_state: async () => {
          throw Object.assign(new Error('closed'), { code: 'JIG_NOT_OPEN' });
        },
      },
      isCurrent: () => true,
    }),
  );
  t.after(() => scope.revoke());
  await tools.call(scope.token, 'jig_list', {});
  await tools.call(scope.token, 'jig_state', { instanceId: 'secret-arg' });
  const [ok, failed] = events.filter((entry) => entry.event === 'tool-call');
  assert.deepEqual([ok.tool, ok.ok, ok.requestId], ['jig_list', true, 'req-1']);
  assert.ok(ok.bytes > 100);
  assert.equal(typeof ok.ms, 'number');
  assert.deepEqual([failed.tool, failed.ok, failed.code], ['jig_state', false, 'JIG_NOT_OPEN']);
  assert.ok(!JSON.stringify(events).includes('secret-arg'));
});

test('a CLI process logs its start and a failed end with exit code and a cleaned error tail', async (t) => {
  const events = [];
  const sink = (event, fields) => events.push({ event, ...fields });
  setDiagnosticSink(sink);
  t.after(() => setDiagnosticSink(undefined, sink));
  const watched = watchedSpawn(spawn, () => ({
    provider: 'claude-cli',
    version: '2.1.0',
    model: 'opus',
  }));
  const child = watched(
    process.execPath,
    [
      '-e',
      "console.error('boom api_key=SECRETVALUE1 at C:\\\\Users\\\\kim\\\\x'); process.exit(3)",
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  await new Promise((resolve) => child.once('close', resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const start = events.find((entry) => entry.event === 'cli-start');
  assert.deepEqual(
    [start.provider, start.cliVersion, start.model],
    ['claude-cli', '2.1.0', 'opus'],
  );
  const exit = events.find((entry) => entry.event === 'cli-exit');
  assert.equal(exit.code, 3);
  assert.match(exit.stderrTail, /boom/);
  assert.ok(!exit.stderrTail.includes('SECRETVALUE1'));
  assert.ok(!exit.stderrTail.includes('kim'));
  assert.ok(!JSON.stringify(events).includes('console.error'), 'arguments are never logged');
});

test('a bundle zip holds the dated logs and a readable about.json', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-diag-zip-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'logs'));
  await writeFile(join(directory, 'logs', `engine-${DAY}.jsonl`), '{"event":"a"}\n');
  await writeFile(join(directory, 'logs', `rhino-${DAY}.jsonl`), '{"event":"b"}\n');
  await writeFile(join(directory, 'logs', 'engine-2026-01-01.jsonl'), 'old\n');
  await writeFile(join(directory, 'launch.json'), '{"url":"secret"}');
  await writeFile(join(directory, 'desktop.json'), '{"UpdateSource":"C:\\\\Users\\\\kim\\\\x"}');
  const bundle = await writeDiagnosticBundle({ directory, now: at });
  assert.deepEqual(bundle.files.sort(), [
    'about.json',
    `logs/engine-${DAY}.jsonl`,
    `logs/rhino-${DAY}.jsonl`,
    'settings.json',
  ]);
  // Read the zip back: local headers in order, deflated data.
  const zip = await readFile(bundle.file);
  const entries = {};
  for (let offset = 0; zip.readUInt32LE(offset) === 0x04034b50; ) {
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength;
    entries[name] = inflateRawSync(zip.subarray(start, start + size)).toString();
    offset = start + size;
  }
  assert.equal(JSON.parse(entries['about.json']).node, process.version);
  assert.ok(!entries['settings.json'].includes('kim'));
  assert.equal(entries[`logs/rhino-${DAY}.jsonl`], '{"event":"b"}\n');
  assert.ok((await readdir(join(directory, 'diagnostics'))).length === 1);
});

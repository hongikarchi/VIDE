import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { countCrashes, readStages } from './stages.mjs';

const logs = mkdtempSync(join(tmpdir(), 'ab-stages-'));
after(() => rmSync(logs, { recursive: true, force: true }));

const ID = '11111111-2222-4333-8444-555555555555';
const line = (fields) => JSON.stringify({ v: '0.2.31', sid: 'a1b2c3d4', ...fields });
writeFileSync(
  join(logs, 'engine-2026-10-08.jsonl'),
  [
    line({ at: '2026-10-08T01:00:00.000Z', event: 'engine-start', port: 50111 }),
    line({
      at: '2026-10-08T01:00:01.000Z',
      event: 'request-start',
      requestId: ID,
      projectId: 'p1',
      provider: 'claude-cli',
      host: 'rhino',
      mode: 'auto',
    }),
    '{not json',
    line({
      at: '2026-10-08T01:00:20.000Z',
      event: 'request-stages',
      requestId: ID,
      projectId: 'p1',
      queuedMs: 3,
      contextMs: 0,
      providerMs: 40,
      authMs: 12,
      authCached: true,
      spawnMs: 900,
      firstOutputMs: 4100,
      firstNoteMs: 4200,
      firstToolMs: 6000,
      lastToolMs: 9000,
      answerMs: 10000,
      totalMs: 19000,
      queries: 2,
      executes: 1,
    }),
    line({
      at: '2026-10-08T01:00:20.001Z',
      event: 'request-end',
      requestId: ID,
      projectId: 'p1',
      state: 'succeeded',
      code: null,
      ms: 19010,
    }),
    line({
      at: '2026-10-08T01:00:30.000Z',
      event: 'request-end',
      requestId: 'other',
      state: 'failed',
      code: 'X',
    }),
  ].join('\n') + '\n',
);
writeFileSync(
  join(logs, 'engine-exits.jsonl'),
  [
    // before the window
    '{"at":"2026-10-08T00:59:00.0000000Z","event":"engine-exit","pid":1,"code":-1073740791,"hex":"0xC0000409","uptimeSec":5,"asked":false}',
    // inside, unasked: counted
    '{"at":"2026-10-08T01:00:10.0000000Z","event":"engine-exit","pid":2,"code":-1073740791,"hex":"0xC0000409","uptimeSec":9,"asked":false}',
    // inside, asked (an update or quit): not a crash
    '{"at":"2026-10-08T01:00:12.0000000Z","event":"engine-exit","pid":3,"code":0,"hex":"0x0","uptimeSec":9,"asked":true}',
    // within the 5 s grace after the end: counted
    '{"at":"2026-10-08T01:00:24.0000000Z","event":"engine-exit","pid":4,"code":1,"hex":"0x1","uptimeSec":1,"asked":false}',
    // after the grace
    '{"at":"2026-10-08T01:00:40.0000000Z","event":"engine-exit","pid":5,"code":1,"hex":"0x1","uptimeSec":1,"asked":false}',
  ].join('\r\n') + '\r\n',
);

test('joins request-stages and request-end by request id', () => {
  const joined = readStages({
    logsDir: logs,
    requestId: ID,
    startedAt: '2026-10-08T01:00:00.500Z',
    endedAt: '2026-10-08T01:00:21.000Z',
  });
  assert.equal(joined.stages.totalMs, 19000);
  assert.equal(joined.stages.answerMs, 10000);
  assert.equal(joined.stages.authCached, true);
  assert.equal(joined.stages.event, undefined);
  assert.equal(joined.stages.requestId, undefined);
  assert.deepEqual(joined.end, { state: 'succeeded', code: null, ms: 19010 });
  assert.equal(joined.lines.length, 3);
  assert.equal(joined.unreadable, 1);
});

test('a request without lines, a missing folder or another day joins nothing', () => {
  const none = readStages({
    logsDir: logs,
    requestId: 'missing',
    startedAt: Date.parse('2026-10-08T01:00:00Z'),
    endedAt: Date.parse('2026-10-08T01:01:00Z'),
  });
  assert.equal(none.stages, null);
  assert.equal(none.end, null);
  assert.equal(none.lines.length, 0);
  const otherDay = readStages({
    logsDir: logs,
    requestId: ID,
    startedAt: '2026-10-20T00:00:00Z',
    endedAt: '2026-10-20T00:01:00Z',
  });
  assert.equal(otherDay.stages, null);
  const noFolder = readStages({ logsDir: join(logs, 'nope'), requestId: ID });
  assert.equal(noFolder.stages, null);
});

test('counts unasked engine exits inside the window plus 5 s', () => {
  assert.equal(
    countCrashes({
      logsDir: logs,
      startedAt: '2026-10-08T01:00:00.000Z',
      endedAt: '2026-10-08T01:00:20.000Z',
    }),
    2,
  );
  assert.equal(
    countCrashes({
      logsDir: logs,
      startedAt: '2026-10-08T02:00:00.000Z',
      endedAt: '2026-10-08T02:00:20.000Z',
    }),
    0,
  );
  assert.equal(countCrashes({ logsDir: join(logs, 'nope'), startedAt: 0, endedAt: 1 }), 0);
});

test('reads the route line inside the window', async () => {
  const { readRouteLine } = await import('./stages.mjs');
  writeFileSync(
    join(logs, 'engine-2026-10-09.jsonl'),
    line({ at: '2026-10-09T03:00:00.500Z', event: 'route', by: 'rules', target: null, reason: 'JEV_KEY_MISSING', ms: 2 }) + '\n',
  );
  const found = readRouteLine({ logsDir: logs, startedAt: '2026-10-09T03:00:00.400Z', endedAt: '2026-10-09T03:00:00.450Z' });
  assert.equal(found.reason, 'JEV_KEY_MISSING');
  assert.equal(readRouteLine({ logsDir: logs, startedAt: '2026-10-09T05:00:00Z', endedAt: '2026-10-09T05:00:01Z' }), null);
});

test('identifyEngine: the person engines by port, launch origin or data folder', async () => {
  const { identifyEngine } = await import('./stages.mjs');
  const engines = [
    { kind: 'installed', dir: 'C:/Users/u/AppData/Local/VIDE', port: '47821', url: 'http://127.0.0.1:52001/#t' },
    { kind: 'dev', dir: 'C:/repo/.vide/dev-data', port: '47831', url: 'http://localhost:52002/#t' },
  ];
  const id = (origin, launchFile = null, logsDir = null) =>
    identifyEngine({ origin, launchFile, logsDir, engines }).kind;
  assert.equal(id('http://127.0.0.1:47821'), 'installed');
  // A fallback port is caught by the origin in that engine's launch.json (localhost = 127.0.0.1).
  assert.equal(id('http://localhost:52001'), 'installed');
  assert.equal(id('http://127.0.0.1:52002'), 'dev');
  assert.equal(id('http://127.0.0.1:47831'), 'dev');
  // A launch file or logs dir inside their data folders (case-insensitive, either slash).
  assert.equal(id('http://127.0.0.1:50000', 'c:/users/u/appdata/local/vide/launch.json'), 'installed');
  assert.equal(id('http://127.0.0.1:50000', null, 'C:/repo/.vide/dev-data/logs'), 'dev');
  // A loop engine with its own data folder.
  assert.equal(id('http://127.0.0.1:50000', 'C:/repo/.vide/loop/r1/launch.json', 'C:/repo/.vide/loop/r1/logs'), null);
  assert.equal(id('http://127.0.0.1:50000', 'C:/Users/u/AppData/Local/VIDE-other/launch.json'), null);
});

test('personEngines reads the launch URLs of the two data folders', async () => {
  const { personEngines } = await import('./stages.mjs');
  const { mkdirSync } = await import('node:fs');
  const local = join(logs, 'local');
  mkdirSync(join(local, 'VIDE'), { recursive: true });
  writeFileSync(join(local, 'VIDE', 'launch.json'), JSON.stringify({ url: 'http://127.0.0.1:52001/#t' }));
  const [installed, dev] = personEngines({ env: { LOCALAPPDATA: local }, root: join(logs, 'repo') });
  assert.equal(installed.url, 'http://127.0.0.1:52001/#t');
  assert.equal(installed.dir, join(local, 'VIDE'));
  assert.equal(dev.url, null);
  assert.equal(dev.dir, join(logs, 'repo', '.vide', 'dev-data'));
});

test('countLogLines counts engine lines inside the window', async () => {
  const { countLogLines } = await import('./stages.mjs');
  assert.ok(countLogLines({ logsDir: logs, startedAt: '2026-10-08T01:00:00.000Z', endedAt: '2026-10-08T01:00:30.000Z' }) >= 3);
  assert.equal(countLogLines({ logsDir: logs, startedAt: '2026-10-08T09:00:00Z', endedAt: '2026-10-08T09:00:01Z' }), 0);
  assert.equal(countLogLines({ logsDir: join(logs, 'nope'), startedAt: 0, endedAt: 1 }), 0);
});

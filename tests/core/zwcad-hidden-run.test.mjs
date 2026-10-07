// The common hidden ZWCAD run (PLAN-47 T-226): limit, stop of the owned process only, exit code,
// last worker step and new crash dumps. The host is a fake; the real one is
// tests/integration/zwcad-drawing-output.mjs and zwcad-xref.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiddenRunError, runHiddenZwcad } from '../../hosts/zwcad/hidden-run.ts';

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
};

/** A launch that records what it was given; `exit` makes the host end by itself. */
function fakeLaunch({ exit, steps = [] } = {}) {
  const calls = { launches: [], stops: 0, settled: 0 };
  let polls = 0;
  return {
    calls,
    launch: async (options) => {
      calls.launches.push(options);
      if (steps.length)
        await writeFile(options.environment.VIDE_WORKER_STEP, steps.join('\n') + '\n');
      return {
        identity: { pid: 4100, startTicks: '1', executable: options.executable },
        exitStatus: () => (exit && ++polls > 2 ? exit : undefined),
        settled: () => void calls.settled++,
        async stop() {
          calls.stops++;
        },
      };
    },
  };
}

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vide-hidden-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const base = (dir, extra) => ({
  label: 'test',
  executable: 'C:\\ZWCAD\\ZWCAD.exe',
  plugin: 'C:\\VIDE\\VIDE.Zwcad.Worker.dll',
  command: 'VIDEDRAWINGCOPY',
  folder: dir,
  crashDumps: async () => [],
  ...clock(),
  ...extra,
});

test('a finished run stops only its own host and reports done', async (t) => {
  const dir = await folder(t);
  const { launch, calls } = fakeLaunch();
  const logs = [];
  let polls = 0;
  const report = await runHiddenZwcad(
    base(dir, {
      launch,
      environment: { VIDE_X: '1' },
      finished: async () => ++polls > 3,
      log: (fields) => logs.push(fields),
    }),
  );
  assert.equal(report.ended, 'done');
  assert.equal(calls.stops, 1);
  const [options] = calls.launches;
  assert.deepEqual(options.args, ['/b', join(dir, 'start.scr')]);
  assert.equal(options.visible, false);
  assert.equal(options.environment.VIDE_X, '1');
  assert.equal(options.environment.VIDE_WORKER_STEP, join(dir, 'step.txt'));
  assert.equal(
    await readFile(join(dir, 'start.scr'), 'utf8'),
    '(command "_NETLOAD" "C:/VIDE/VIDE.Zwcad.Worker.dll")\nVIDEDRAWINGCOPY\n',
  );
  assert.equal(logs.at(-1).outcome, 'done');
  assert.ok(!('exitCode' in logs.at(-1)));
});

test('the time limit stops the host and names the last worker step', async (t) => {
  const dir = await folder(t);
  const { launch, calls } = fakeLaunch({ steps: ['grant', 'read'] });
  const logs = [];
  const error = await runHiddenZwcad(
    base(dir, { launch, finished: async () => false, timeoutMs: 2000, log: (f) => logs.push(f) }),
  ).catch((e) => e);
  assert.ok(error instanceof HiddenRunError);
  assert.equal(error.code, 'HIDDEN_HOST_TIMEOUT');
  assert.equal(error.details.lastStep, 'read');
  assert.equal(error.details.exit, undefined);
  assert.equal(calls.stops, 1);
  assert.equal(logs.at(-1).outcome, 'HIDDEN_HOST_TIMEOUT');
  assert.equal(logs.at(-1).exitCode, null);
});

test('a host that ends by itself fails with its exit code and the dumps it left', async (t) => {
  const dir = await folder(t);
  const { launch } = fakeLaunch({ exit: { code: 3221225477, signal: null }, steps: ['stage'] });
  let dumps = ['ko-KR/old.dmp'];
  const logs = [];
  const error = await runHiddenZwcad(
    base(dir, {
      launch: async (options) => {
        const owner = await launch(options);
        dumps = [...dumps, 'ko-KR/new.dmp'];
        return owner;
      },
      crashDumps: async () => dumps,
      finished: async () => false,
      log: (f) => logs.push(f),
    }),
  ).catch((e) => e);
  assert.equal(error.code, 'HIDDEN_HOST_EXITED');
  assert.deepEqual(error.details.exit, { code: 3221225477, signal: null });
  assert.deepEqual(error.details.newDumps, ['ko-KR/new.dmp']);
  assert.equal(error.details.lastStep, 'stage');
  assert.equal(logs.at(-1).newDumps, 1);
});

test('the marker written just before the host ended still counts as done', async (t) => {
  const dir = await folder(t);
  const { launch } = fakeLaunch({ exit: { code: 0, signal: null } });
  let checks = 0;
  // Not finished on the first three looks, finished on the look after the exit was seen.
  const report = await runHiddenZwcad(base(dir, { launch, finished: async () => ++checks > 3 }));
  assert.equal(report.ended, 'done');
});

test('a caller abort stops the run; a stall either fails or ends with what was read', async (t) => {
  const dir = await folder(t);
  const controller = new AbortController();
  const { launch, calls } = fakeLaunch();
  let polls = 0;
  await assert.rejects(
    runHiddenZwcad(
      base(dir, {
        launch,
        signal: controller.signal,
        finished: async () => {
          if (++polls === 3) controller.abort();
          return false;
        },
      }),
    ),
    (e) => e.code === 'STOPPED',
  );
  assert.equal(calls.stops, 1);
  const stalled = fakeLaunch();
  const report = await runHiddenZwcad(
    base(dir, {
      launch: stalled.launch,
      finished: async () => false,
      progress: async () => 2,
      stallMs: 3000,
      onStall: 'end',
    }),
  );
  assert.equal(report.ended, 'stalled');
  assert.ok(stalled.calls.settled >= 1, 'the first result ends the crash-prompt watch');
  await assert.rejects(
    runHiddenZwcad(
      base(dir, {
        launch: fakeLaunch().launch,
        finished: async () => false,
        progress: async () => 0,
        stallMs: 3000,
      }),
    ),
    (e) => e.code === 'HIDDEN_HOST_STALLED',
  );
});

test('a stop that cannot confirm the identity is logged, not thrown over the result', async (t) => {
  const dir = await folder(t);
  const logs = [];
  const report = await runHiddenZwcad(
    base(dir, {
      launch: async () => ({
        exitStatus: () => undefined,
        settled() {},
        stop: async () => {
          throw new Error('HOST_OWNERSHIP_MISMATCH');
        },
      }),
      finished: async () => true,
      log: (f) => logs.push(f),
    }),
  );
  assert.equal(report.ended, 'done');
  assert.ok(logs.some((f) => f.stop === 'HOST_OWNERSHIP_MISMATCH'));
  await assert.rejects(
    runHiddenZwcad(base(dir, { command: 'bad;cmd', finished: async () => true })),
    /INVALID_HOST_LAUNCH/,
  );
});

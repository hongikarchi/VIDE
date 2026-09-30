import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analysisWorkerStats,
  analyzeSummary,
  buildFrameModel,
  closeAnalysisWorker,
} from '../../src/jigs/official/structure-analysis/index.ts';
import { corePath } from '../../src/jigs/structure/core.ts';
import { bayPlan, gridPlan } from './frame-fixtures.mjs';

// The core runs in a worker thread: the event loop must keep turning while a large model is
// analysed (ARCH-03 §13: `/links` delay ≤ 50 ms), and only the newest queued request per key survives.

test('analysis in the worker does not block the event loop for more than 50 ms', async () => {
  const { model, map, assumptions } = buildFrameModel(gridPlan());
  assert.ok(model.members.length >= 1500);
  let last = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last - 5);
    last = now;
  }, 5);
  try {
    const warm = await analyzeSummary(model, map, { mode: 'preview', key: 'grid', assumptions });
    assert.equal(warm.summary.status, 'ok', warm.summary.error);
    last = performance.now();
    maxGap = 0;
    const started = performance.now();
    const { summary, result } = await analyzeSummary(model, map, {
      mode: 'preview',
      key: 'grid',
      assumptions,
    });
    const elapsed = performance.now() - started;
    assert.equal(summary.status, 'ok');
    assert.equal(result, undefined, 'preview returns the summary only');
    assert.equal(summary.label, '미확정 미리보기');
    assert.ok(summary.ms > 0);
    assert.ok(
      maxGap < 50,
      `event loop stalled ${maxGap.toFixed(1)} ms during a ${elapsed.toFixed(0)} ms analysis`,
    );
    console.log(
      `worker analysis ${elapsed.toFixed(0)} ms, core+summary ${summary.ms} ms, max event-loop gap ${maxGap.toFixed(1)} ms`,
    );
  } finally {
    clearInterval(timer);
  }
});

test('latest request wins per key; other keys queue; full detail returns the result', async () => {
  const { model, map } = buildFrameModel(gridPlan({ nx: 8, ny: 8 }));
  const small = buildFrameModel(bayPlan());
  const before = analysisWorkerStats();
  const settled = await Promise.allSettled([
    analyzeSummary(model, map, { mode: 'preview', key: 'a' }),
    analyzeSummary(model, map, { mode: 'preview', key: 'a' }),
    analyzeSummary(model, map, { mode: 'preview', key: 'a' }),
    analyzeSummary(small.model, small.map, { mode: 'confirmed', key: 'b', detail: 'full' }),
  ]);
  assert.equal(settled[0].status, 'fulfilled', 'the running request completes');
  assert.equal(settled[1].status, 'rejected');
  assert.equal(settled[1].reason.code, 'STRUCTURE_SUPERSEDED');
  assert.equal(settled[2].status, 'fulfilled', 'the newest request survives');
  assert.equal(settled[3].status, 'fulfilled', 'another key is not superseded');
  assert.equal(settled[3].value.summary.mode, 'confirmed');
  assert.equal(settled[3].value.result.status, 'ok');
  assert.equal(settled[3].value.result.modelHash, settled[3].value.summary.modelHash);
  const after = analysisWorkerStats();
  assert.equal(after.superseded - before.superseded, 1);
  assert.equal(after.queued, 0);
  assert.equal(after.running, false);
});

test('an invalid model comes back as an invalid summary, not an exception', async () => {
  const { model, map } = buildFrameModel(bayPlan());
  const broken = { ...model, nodes: model.nodes.map((n) => ({ id: n.id, xyz_m: n.xyz_m })) };
  const { summary } = await analyzeSummary(broken, map, { mode: 'preview', key: 'c' });
  assert.equal(summary.status, 'invalid');
  assert.ok(summary.issues.some((i) => i.code === 'NO_SUPPORT'));
});

// Closing the worker must never unload the core: its solver threads (rayon) outlive the worker,
// and unloading the library under them crashed the process at exit (0xC0000005), mostly under load.
const coreLoaded = () => {
  const name = basename(corePath()).toLowerCase();
  return process.report
    .getReport()
    .sharedObjects.some((path) => basename(path.replaceAll('\\', '/')).toLowerCase() === name);
};

test('open/close cycles: every request settles, close is idempotent, the core stays loaded', async () => {
  const { model, map } = buildFrameModel(gridPlan({ nx: 6, ny: 6 }));
  const small = buildFrameModel(bayPlan());
  const expected = new Set(['STRUCTURE_WORKER_CLOSED', 'STRUCTURE_SUPERSEDED']);
  for (let cycle = 0; cycle < 4; cycle++) {
    const before = analysisWorkerStats();
    const settled = Promise.allSettled([
      analyzeSummary(model, map, { mode: 'preview', key: 'cycle-a', stability: false }),
      analyzeSummary(small.model, small.map, { mode: 'preview', key: 'cycle-b' }),
      analyzeSummary(small.model, small.map, { mode: 'confirmed', key: 'cycle-b' }),
    ]);
    // Even cycles close while the first request runs; odd cycles once every request is answered.
    if (cycle % 2) await settled;
    await Promise.all([closeAnalysisWorker(), closeAnalysisWorker()]);
    for (const outcome of await settled) {
      if (outcome.status === 'fulfilled') assert.equal(outcome.value.summary.status, 'ok');
      else assert.ok(expected.has(outcome.reason.code), outcome.reason.message);
    }
    const after = analysisWorkerStats();
    assert.deepEqual(
      [after.alive, after.running, after.queued, after.closing],
      [false, false, 0, 0],
      `cycle ${cycle}`,
    );
    assert.equal(after.closed - before.closed, 1, 'one worker started and exited');
    assert.equal(after.restarts, before.restarts, 'a closed worker is not a restart');
    assert.ok(coreLoaded(), `cycle ${cycle}: the core was unloaded with the worker`);
  }
  // Nothing open: returns at once; a new request starts a new worker.
  await closeAnalysisWorker();
  const again = await analyzeSummary(small.model, small.map, { mode: 'preview', key: 'again' });
  assert.equal(again.summary.status, 'ok');
  assert.equal(analysisWorkerStats().alive, true);
});

test('analyse then close, several times, with every core busy: the process exits cleanly', async () => {
  // In a child process of its own (worker-load.mjs), so a crash shows as its exit code.
  const script = new URL('./worker-load.mjs', import.meta.url);
  const child = spawn(process.execPath, [fileURLToPath(script), '6'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const [code, signal] = await new Promise((resolve) =>
    child.on('close', (...result) => resolve(result)),
  );
  assert.equal(code, 0, `child exited ${code} (${signal ?? 'no signal'}):\n${output}`);
  assert.match(output, /6 cycles done/, output);
});

test.after(async () => {
  await closeAnalysisWorker();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analysisWorkerStats,
  analyzeSummary,
  buildFrameModel,
  closeAnalysisWorker,
} from '../../src/jigs/official/structure-analysis/index.ts';
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

test.after(async () => {
  await closeAnalysisWorker();
});

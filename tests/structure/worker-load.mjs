// Child process of worker.test.mjs: analyse in the worker and close it right away, several times,
// while every core is busy. Before the core was pinned on the main thread, closing the worker
// unloaded the core under its still-spinning solver threads and this process crashed (0xC0000005).
// Runs at a lower priority so the other test files keep their timing.

import { availableParallelism, constants, setPriority } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  analyzeSummary,
  buildFrameModel,
  closeAnalysisWorker,
} from '../../src/jigs/official/structure-analysis/index.ts';
import { gridPlan } from './frame-fixtures.mjs';

try {
  setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  /* priority is a courtesy to parallel tests, not needed for the check */
}
const spin = 'const a = new Int32Array(new SharedArrayBuffer(4)); for (;;) Atomics.add(a, 0, 1);';
const busy = Array.from({ length: availableParallelism() }, () => new Worker(spin, { eval: true }));
const cycles = Number(process.argv[2] ?? 6);
const { model, map } = buildFrameModel(gridPlan({ nx: 6, ny: 6 }));
for (let i = 0; i < cycles; i++) {
  const { summary } = await analyzeSummary(model, map, {
    mode: 'preview',
    key: 'load',
    stability: false,
  });
  if (summary.status !== 'ok') throw new Error(`analysis ${summary.status}: ${summary.error}`);
  await closeAnalysisWorker();
}
await Promise.all(busy.map((w) => w.terminate()));
console.log(`${cycles} cycles done`);

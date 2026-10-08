// SPIKE T-259 (PLAN-49): whole-net PQ optimization on about 5,000 panels — engine only, no host.
// For each synthetic face: the stage-1 grid layout (vide/paneling-kit, 1 m, 192 × 128 sample), the
// product's per-panel 'best-fit' planarization as the baseline (optimizePanels with a no-joint
// member set), then pq.ts with a few closeness weights. Prints JSON; `--out <file>` also writes it.
//
//   node tools/spikes/2026-10-08-paneling-pq/run-pq.mjs [--only aligned,wave] [--out result-pq.json]
import { writeFileSync } from 'node:fs';
import {
  faceSampler,
  layoutPanels,
  optimizePanels,
  resolveOptimizeSettings,
} from '../../../src/jigs/official/paneling-kit/index.ts';
import { previewSettings, sampleOf } from '../../../tests/fixtures/paneling-surfaces.mjs';
import { membersOf } from '../../../tests/fixtures/paneling-members-stub.mjs';
import { FACES } from './surfaces.mjs';
import { optimizePq } from './pq.ts';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const only = arg('--only')?.split(',');
const mm = (m) => Math.round(m * 1e5) / 100;
const TOL = 0.001; // PQ target: every panel vertex within 1 mm of its plane
const RUNS = [
  { name: 'points-0.1', mode: 'points', wClose: 0.1, wFair: 0.01 },
  { name: 'planes-1', mode: 'planes', wClose: 1, wFair: 0.01 },
  { name: 'planes-0.1', mode: 'planes', wClose: 0.1, wFair: 0.01 },
  { name: 'planes-0.01', mode: 'planes', wClose: 0.01, wFair: 0.001 },
];

const out = { node: process.version, tolMm: TOL * 1000, faces: {} };
for (const [name, make] of Object.entries(FACES)) {
  if (only && !only.includes(name)) continue;
  const sample = sampleOf(make());
  const ps = previewSettings({ size: [1, 1] });
  let t = performance.now();
  const laid = layoutPanels(sample, ps);
  if (!laid.ok) throw Error(`${name}: ${JSON.stringify(laid)}`);
  const layout = laid.layout;
  const layoutMs = performance.now() - t;
  // Baseline: the product's per-panel planarization (SPEC-16.7 2 'best-fit').
  t = performance.now();
  const typed = optimizePanels({
    sample,
    layout,
    members: membersOf(layout),
    direction: ps.direction.value,
    settings: resolveOptimizeSettings({ planarize: 'best-fit' }),
  });
  if (!typed.ok) throw Error(`${name}: ${JSON.stringify(typed)}`);
  const bf = typed.typing.panels.filter((p) => !p.failure);
  const max = (key) => Math.max(...bf.map((p) => p[key] ?? 0));
  const flatOver = bf.filter((p) => p.flatness > 0.003).length;
  const row = {
    panels: layout.panels.length,
    layoutMs: Math.round(layoutMs),
    bestFit: {
      ms: Math.round(performance.now() - t),
      flatnessMaxMm: mm(max('flatness')),
      flatnessOver3mm: flatOver,
      planarGapMaxMm: mm(max('planarGap')),
      offSurfaceMaxMm: mm(max('offSurface')),
      types: typed.typing.types.length,
    },
    pq: {},
  };
  const sampler = faceSampler(sample.faces[0]);
  for (const run of RUNS) {
    const r = optimizePq(sampler, layout, { tol: TOL, ...run, maxIter: 5000, budgetMs: 60000 });
    row.pq[run.name] = {
      converged: r.converged,
      stalled: r.stalled,
      iterations: r.iterations,
      ms: Math.round(r.ms),
      msPerIteration: Math.round(r.msPerIteration * 100) / 100,
      vertices: r.vertices,
      planarityStartMm: mm(r.planarityStart),
      planarityEndMm: mm(r.planarityEnd),
      planarityMeanMm: mm(r.planarityMean),
      panelsOverTol: Math.round(r.panelsOverTol * 1000) / 1000,
      planarGapMm: mm(r.planarGap),
      offSurfaceMaxMm: mm(r.offSurfaceMax),
      offSurfaceMeanMm: mm(r.offSurfaceMean),
      offSurfaceOverTol: Math.round(r.offSurfaceOverTol * 1000) / 1000,
      moveMaxMm: mm(r.moveMax),
      history: r.history.map(([i, p]) => [i, mm(p)]),
    };
    console.error(name, run.name, JSON.stringify(row.pq[run.name]));
  }
  out.faces[name] = row;
}
const text = JSON.stringify(out, null, 2);
console.log(text);
const file = arg('--out');
if (file) writeFileSync(file, text + '\n');

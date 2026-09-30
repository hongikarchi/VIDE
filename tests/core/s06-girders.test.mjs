import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  girders,
  pointAt,
  DEFAULT_GIRDERS_PARAMS,
} from '../../extensions/jigs/s06-frame/steps/girders.ts';

// S-06 frame jig ⑤ drawn mode (PLAN-23 T-053, M2 머리말 2026-09-30): drawn girder curves are read
// and corrected against drawn columns — ends snapped to column tops, cut at columns, duplicates
// merged, dangling ends and slab/void crossings listed, curved polylines fitted with arcs (plan or
// vertical ramp), spans judged in plan. Synthetic fixtures only.
const FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  'extensions',
  'jigs',
  's06-frame',
  'fixtures',
);
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `girders-${name}.json`), 'utf8'));
const run = (name, params) => {
  const f = fixture(name);
  return girders(f.input, { ...f.params, ...params });
};
const close = (actual, expected, eps = 1e-3, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} ≠ ${expected}`);
const bySource = (out, sourceId) => out.girders.find((g) => g.sourceId === sourceId);

test('every girders fixture meets its expected summary, is JSON and ignores row order', () => {
  const names = readdirSync(FIXTURES)
    .filter((f) => /^girders-.*\.json$/.test(f))
    .map((f) => f.slice('girders-'.length, -'.json'.length));
  assert.ok(names.length >= 4);
  for (const name of names) {
    const f = fixture(name);
    const out = girders(f.input, f.params);
    assert.deepEqual(out.summary, f.expect.summary, name);
    assert.equal(out.spans.length, f.expect.spans, `${name} spans`);
    assert.equal(out.crossings.length, f.expect.crossings, `${name} crossings`);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out, `${name} JSON`);
    const reversed = structuredClone(f.input);
    for (const role of Object.values(reversed.site)) role.rows.reverse();
    assert.deepEqual(girders(reversed, f.params), out, `${name} order`);
  }
});

test('straight grid: ends snap in plan to column tops keeping girder z, cut at the middle column', () => {
  const out = run('straight-grid');
  const g = bySource(out, 'g-y0');
  const col = (id) => out.columns.find((c) => c.id === id);
  assert.deepEqual(
    g.snapped.map((s) => s.end),
    ['start', 'end'],
  );
  close(g.snapped[0].moved_m, Math.hypot(0.15, 0.1), 1e-3, 'moved');
  assert.deepEqual(g.points, [
    [0, 0, 6.4],
    [21, 0, 6.4],
  ]);
  assert.deepEqual(col(g.supports[0].columnId).top, [0, 0, 6]);
  assert.equal(g.supports.length, 3);
  close(g.supports[1].t, 7 / 21, 1e-5, 't');
  assert.deepEqual(
    pointAt(g.points, g.supports[1].t)
      .slice(0, 2)
      .map((v) => Math.round(v)),
    [7, 0],
  );
  assert.deepEqual(
    out.spans.filter((s) => s.girderId === g.id).map((s) => [s.planLength_m, s.over]),
    [
      [7, false],
      [14, true],
    ],
  );
  // The jig setting `spanMax` is read when `spanMax_m` is not given.
  assert.equal(run('straight-grid', { spanMax: 15 }).summary.spansOver, 0);
  assert.equal(run('straight-grid', { spanMax_m: 6.5 }).summary.spansOver, 7);
});

test('a dangling end is listed with its nearest column; slab and void crossings in order', () => {
  const f = fixture('dangling-end');
  const out = girders(f.input, f.params);
  const g1 = bySource(out, 'g-1'),
    g2 = bySource(out, 'g-2');
  assert.deepEqual(out.dangling, [
    { girderId: g2.id, end: 'end', nearestColumnId: g2.supports[0].columnId, distance_m: 6 },
  ]);
  assert.deepEqual(
    out.crossings.filter((c) => c.girderId === g1.id),
    [
      { girderId: g1.id, boundary: 'void', at: [4, 0] },
      { girderId: g1.id, boundary: 'void', at: [6, 0] },
    ],
  );
  assert.deepEqual(
    out.crossings.filter((c) => c.girderId === g2.id),
    [{ girderId: g2.id, boundary: 'slab', at: [10, 4] }],
  );
  // A column within the snap tolerance takes the end.
  const site = structuredClone(f.input.site);
  site.columns.rows.push({ id: 'c-c', line: [10.2, 6.1, 0, 10.2, 6.1, 6] });
  const near = girders({ site });
  assert.equal(near.summary.dangling, 0);
  assert.equal(near.summary.snapped, 1);
  // A column of another floor (top 5 m away in z) does not.
  site.columns.rows.at(-1).line = [10.2, 6.1, 11, 10.2, 6.1, 12];
  assert.equal(girders({ site }).summary.dangling, 1);
});

test('curved girders become arcs: a vertical-plane ramp keeps its rise, a plan arc its radius', () => {
  const out = run('curved-ramp');
  const ramp = bySource(out, 'g-ramp');
  assert.equal(ramp.kind, 'arc');
  assert.equal(ramp.arc.plane, 'vertical');
  close(ramp.arc.rise, 1.5, 0.05, 'rise');
  assert.deepEqual(ramp.points[0], [0, 0, 5]);
  assert.deepEqual(ramp.points.at(-1), [20, 0, 7]);
  assert.ok(
    ramp.points.every((p) => Math.abs(p[1]) < 1e-3),
    'stays in its vertical plane',
  );
  close(ramp.arc.endDeg - ramp.arc.startDeg, ramp.arc.sweepDeg, 1e-3);
  const plan = bySource(out, 'g-plan');
  assert.equal(plan.kind, 'arc');
  assert.equal(plan.arc.plane, 'plan');
  close(plan.arc.radius, 10, 1e-3, 'radius');
  close(plan.arc.sweepDeg, 90, 0.01, 'sweep');
  assert.ok(plan.points.every((p) => p[2] === 6));
  const span = out.spans.find((s) => s.girderId === plan.id);
  close(span.planLength_m, (Math.PI / 2) * 10, 0.01, 'arc span');
  assert.equal(span.over, true);
  // A bend under the sagitta limit is read as a straight line.
  const flat = run('curved-ramp', { arcSagitta_m: 5 });
  assert.equal(bySource(flat, 'g-ramp').kind, 'line');
  assert.equal(bySource(flat, 'g-ramp').points.length, 2);
});

test('duplicates and overlapping collinear pieces merge; a piece touching at an end does not', () => {
  const out = run('duplicates');
  const a = bySource(out, 'g-a');
  assert.deepEqual(a.mergedFrom, ['g-b', 'g-c']);
  assert.deepEqual(a.points, [
    [0, 0, 6],
    [24, 0, 6],
  ]);
  assert.equal(a.supports.length, 3);
  assert.ok(bySource(out, 'g-d'), 'touching piece stays its own girder');
  assert.deepEqual(bySource(out, 'g-e').mergedFrom, ['g-f']);
  assert.equal(bySource(out, 'g-e').kind, 'arc');
  // Below the merge tolerance the drawn offsets (0.01–0.02 m) are separate lines.
  assert.equal(run('duplicates', { mergeTol_m: 0.005 }).summary.girders, 6);
});

test('bad params are refused; missing roles give notes, not errors', () => {
  assert.throws(() => girders({ site: {} }, { snapTol_m: -1 }), RangeError);
  assert.throws(() => girders({ site: {} }, { spanMax_m: 0 }), RangeError);
  const empty = girders({ site: {} });
  assert.equal(empty.summary.girders, 0);
  assert.ok(empty.notes.length >= 2);
  assert.equal(empty.params.snapTol_m, DEFAULT_GIRDERS_PARAMS.snapTol_m);
});

test('scale: about 1,000 drawn girders on a 26 × 21 column grid in well under a second', () => {
  const columns = [],
    rows = [];
  for (let i = 0; i < 26; i++)
    for (let j = 0; j < 21; j++)
      columns.push({ id: `c${i}-${j}`, line: [i * 8, j * 8, 0, i * 8, j * 8, 6] });
  for (let i = 0; i < 25; i++)
    for (let j = 0; j < 21; j++)
      rows.push({ id: `x${i}-${j}`, line: [i * 8 + 0.1, j * 8, 6.5, i * 8 + 8.1, j * 8, 6.5] });
  for (let i = 0; i < 26; i++)
    for (let j = 0; j < 20; j++)
      rows.push({ id: `y${i}-${j}`, line: [i * 8, j * 8, 6.5, i * 8, j * 8 + 8, 6.5] });
  const t0 = performance.now();
  const out = girders({ site: { columns: { rows: columns }, girders: { rows } } });
  const ms = performance.now() - t0;
  assert.equal(out.summary.girders, rows.length);
  assert.equal(out.summary.dangling, 0);
  assert.ok(ms < 1000, `${ms} ms`);
});

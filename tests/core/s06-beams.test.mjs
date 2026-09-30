import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cells } from '../../extensions/jigs/s06-frame/steps/cells.ts';
import { beams } from '../../extensions/jigs/s06-frame/steps/beams.ts';

// PLAN-23 T-053 drawn mode: cells and infill beams from a hand-made `girders` output (synthetic).
const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`../../extensions/jigs/s06-frame/fixtures/${name}.json`, import.meta.url)),
  );
const close = (actual, expected, eps = 1e-6, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} ≠ ${expected}`);
const run = (f, params = f.params) => {
  const c = cells({ site: f.input.site, steps: f.input.steps });
  const b = beams({ site: f.input.site, steps: { ...f.input.steps, cells: c } }, params);
  return { c, b };
};

test('grid: T-junction girders make four cells, the void is a hole', () => {
  const f = fixture('beams-grid');
  const { c } = run(f);
  assert.equal(c.cells.length, f.expect.cells);
  close(c.summary.area_m2, f.expect.area_m2);
  const withHole = c.cells.filter((cell) => cell.holes?.length);
  assert.equal(withHole.length, 1);
  close(withHole[0].area_m2, 46);
  assert.deepEqual(withHole[0].girderIds, ['G01', 'G02', 'G05', 'G06']);
  assert.deepEqual(
    c.cells.map((cell) => cell.id),
    ['K01', 'K02', 'K03', 'K04'],
  );
  // JSON-serialisable and deterministic.
  assert.deepEqual(JSON.parse(JSON.stringify(c)), run(f).c);
});

test('grid: beams parallel to the long edge, ends on girders with t, void cuts one line', () => {
  const f = fixture('beams-grid');
  const { b } = run(f);
  assert.equal(b.beams.length, f.expect.beams);
  close(b.summary.spacingUsed_m, 2);
  for (const beam of b.beams) {
    assert.ok(beam.length_m >= 0.5);
    assert.equal(beam.points[0][1], beam.points[1][1], 'along x');
    assert.equal(beam.points[0][2], 6);
  }
  const onGirders = b.beams.filter((x) => x.from.girderId && x.to.girderId);
  assert.equal(onGirders.length, 7);
  const beam = onGirders.find((x) => x.points[0][1] === 4 && x.points[0][0] === 0);
  assert.deepEqual(beam.from, { girderId: 'G05', t: 0.3333 });
  assert.equal(beam.to.girderId, 'G06');
  const cut = b.beams.filter((x) => x.to.edge === 'void' || x.from.edge === 'void');
  assert.equal(cut.length, 2);
  assert.ok(b.notes.some((n) => n.includes('보이드')));
});

test('grid: the 5 m east strip is listed as cantilevers, the 1 m strips are not', () => {
  const f = fixture('beams-grid');
  const { b } = run(f);
  assert.equal(b.edgeCantilevers.length, f.expect.edgeCantilevers);
  for (const e of b.edgeCantilevers) {
    assert.equal(e.from.girderId, 'G08');
    close(e.length_m, 5);
    assert.ok(e.cantilever_m > 3.5);
  }
  const relaxed = run(f, { ...f.params, cantileverMax_m: 6 }).b;
  assert.equal(relaxed.edgeCantilevers.length, 0);
});

test('grid: u / v directions and spacing clamp', () => {
  const f = fixture('beams-grid');
  const v = run(f, { ...f.params, beamDirection: 'v' }).b;
  for (const beam of v.beams) assert.equal(beam.points[0][0], beam.points[1][0], 'along y');
  // 8 m across at ≤ 2.5 m: 4 bays, 3 lines per cell; the void cuts the line x = 4 in two.
  assert.equal(v.beams.length, 13);
  const clamped = run(f, { ...f.params, beamSpacing_m: 5 }).b;
  assert.ok(clamped.notes.some((n) => n.includes('범위')));
  assert.equal(clamped.params.beamSpacing_m, 3);
});

test('triangle: a slab corner clips the cells, beams stay inside and long enough', () => {
  const f = fixture('beams-triangle');
  const { c, b } = run(f);
  assert.equal(c.cells.length, f.expect.cells);
  close(c.summary.area_m2, f.expect.area_m2);
  for (const cell of c.cells) assert.deepEqual(cell.edges, ['slab']);
  assert.ok(b.beams.length > 0);
  for (const beam of b.beams) {
    assert.ok(beam.length_m >= 0.5);
    for (const end of [beam.from, beam.to])
      assert.ok(end.girderId ? end.t >= 0 && end.t <= 1 : end.edge === 'slab');
  }
  // Beams parallel to the diagonal (longest straight edge of each triangle).
  for (const beam of b.beams) {
    const [a, z] = beam.points;
    close(z[1] - a[1], z[0] - a[0], 1e-3, 'slope 1');
  }
  assert.equal(b.edgeCantilevers.length, 0);
});

test('no slab or no girders: empty output with a note', () => {
  const f = fixture('beams-grid');
  const c = cells({ site: {}, steps: f.input.steps });
  assert.equal(c.cells.length, 0);
  assert.ok(c.notes.length);
  const d = cells({ site: f.input.site, steps: { girders: { girders: [] } } });
  assert.equal(d.cells.length, 0);
  const b = beams({ site: f.input.site, steps: { ...f.input.steps, cells: d } });
  assert.equal(b.beams.length, 0);
});

test('concave cell: a beam on the notch girder line stops at the notch, never runs along the girder', () => {
  const g = (id, pts) => ({ id, points: pts.map(([x, y]) => [x, y, 10]) });
  const ring = [
    [0, 0],
    [8, 0],
    [8, 4],
    [4, 4],
    [4, 8],
    [0, 8],
  ];
  const girders = ring.map((a, i) => g(`G0${i + 1}`, [a, ring[(i + 1) % ring.length]]));
  const cell = { id: 'K01', polygon: ring, girderIds: girders.map((x) => x.id), area_m2: 48 };
  const b = beams({ site: {}, steps: { girders: { girders }, cells: { cells: [cell] } } });
  const onNotch = b.beams.filter((beam) => beam.points.every((q) => q[1] === 4));
  assert.equal(onNotch.length, 1);
  assert.deepEqual(
    onNotch[0].points.map((q) => q[0]),
    [0, 4],
  );
  assert.equal(onNotch[0].to.girderId, 'G03');
});

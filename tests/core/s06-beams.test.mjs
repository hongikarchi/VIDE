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
  const infill = v.beams.filter((beam) => !beam.backspanOf);
  for (const beam of infill) assert.equal(beam.points[0][0], beam.points[1][0], 'along y');
  // 8 m across at ≤ 2.5 m: 4 bays, 3 lines per cell; the void cuts the line x = 4 in two.
  assert.equal(infill.length, 13);
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

// T-053 real-data leftover: an edge cantilever continues the nearest interior beam line through
// the girder (that end rigid); without one within half a spacing it gets a back span in the cell
// behind; a beam cut by a void continues the beam across its root girder; corner rays that run
// along a girder are that girder, not a cantilever.
test('grid: edge cantilevers continue the interior beam lines, those ends rigid', () => {
  const f = fixture('beams-grid');
  const { b } = run(f);
  const byId = new Map(b.beams.map((x) => [x.id, x]));
  const continued = b.edgeCantilevers.filter((e) => e.continues);
  assert.equal(continued.length, 4);
  for (const e of continued) {
    const beam = byId.get(e.continues);
    assert.equal(beam.backspanOf, undefined);
    // Same line: the cantilever root is the beam's end on G08, and that end is rigid.
    assert.deepEqual(e.points[0], beam.points[1]);
    assert.equal(e.points[0][1], e.points[1][1]);
    assert.ok(beam.rigidAt.includes('to'));
    assert.equal(beam.to.girderId, 'G08');
  }
  // The corner stations sit on columns with a girder behind them: no back span there.
  assert.equal(b.summary.backspans, 0);
  // The void cuts the line y = 2 of the west cell: it continues the east cell's beam through G06.
  const cutEast = b.beams.find((x) => x.from.edge === 'void');
  assert.equal(cutEast.to.girderId, 'G06');
  const across = b.beams.find(
    (x) => x.from.girderId === 'G06' && x.points[0][1] === cutEast.points[1][1],
  );
  assert.ok(across.rigidAt.includes('from'));
  // The west half (root on the outer girder G05) has nothing across: noted.
  assert.ok(b.notes.some((n) => n.includes('뒤쪽 보를 두지 못했습니다')));
});

test('grid v: no beam line ends on the edge girder → square cantilevers with back spans on a beam', () => {
  const f = fixture('beams-grid');
  const { b } = run(f, { ...f.params, beamDirection: 'v' });
  const byId = new Map(b.beams.map((x) => [x.id, x]));
  const backspans = b.beams.filter((x) => x.backspanOf);
  assert.equal(b.summary.backspans, backspans.length);
  assert.equal(backspans.length, 4);
  for (const r of backspans) {
    const e = b.edgeCantilevers.find((x) => x.id === r.backspanOf);
    assert.equal(e.continues, r.id);
    // Continuous through G08: same root point, rigid there, pinned on the infill beam it meets.
    assert.deepEqual(r.points[0], e.points[0]);
    assert.deepEqual(r.from.girderId, 'G08');
    assert.deepEqual(r.rigidAt, ['from']);
    const host = byId.get(r.to.beamId);
    assert.equal(host.cellId, r.cellId);
    assert.equal(host.points[0][0], r.points[1][0], 'lands on the beam line');
    close(r.length_m, 2);
  }
  // Infill beams stay along y; only the back spans run across.
  for (const x of b.beams.filter((y) => !y.backspanOf))
    assert.equal(x.points[0][0], x.points[1][0], 'along y');
});

test('a corner ray running along a girder is not an edge cantilever', () => {
  const g = (id, pts) => ({ id, points: pts.map(([x, y]) => [x, y, 6]) });
  const girders = [
    g('G1', [
      [0, 0],
      [10, 0],
    ]),
    g('G2', [
      [10, 0],
      [10, 10],
    ]),
    g('G3', [
      [10, 10],
      [0, 10],
    ]),
    g('G4', [
      [0, 10],
      [0, 0],
    ]),
    // A girder running on from the corner along the slab, framing no cell, stopping 8 m short
    // of the slab edge.
    g('G5', [
      [10, 10],
      [10, 22],
    ]),
  ];
  const cell = {
    id: 'K01',
    polygon: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    girderIds: ['G1', 'G2', 'G3', 'G4'],
    area_m2: 100,
  };
  const site = {
    slab: {
      rows: [{ id: 's', line: [-1, -1, 6.3, 16, -1, 6.3, 16, 30, 6.3, -1, 30, 6.3, -1, -1, 6.3] }],
    },
  };
  const b = beams({ site, steps: { girders: { girders }, cells: { cells: [cell] } } });
  assert.ok(b.edgeCantilevers.length > 0);
  for (const e of b.edgeCantilevers) {
    const along = e.points.every((q) => Math.abs(q[0] - 10) < 1e-6);
    assert.ok(!along, `${e.id} runs along G5: ${JSON.stringify(e.points)}`);
  }
});

// Review (wave 5): snapping stations onto beam lines must not leave a gap wider than a spacing
// (the girder G03 meets G08 at y = 6, no beam line there), and each cantilever carries its own
// strip, so the edge strip is loaded once, in full.
test('grid: no edge-strip gap wider than a spacing; strip widths add up to the strip', () => {
  const f = fixture('beams-grid');
  for (const beamDirection of ['u', 'v']) {
    const { b } = run(f, { ...f.params, beamDirection });
    const at = b.edgeCantilevers.map((e) => e.points[0][1]).sort((x, y) => x - y);
    for (let k = 1; k < at.length; k++)
      assert.ok(at[k] - at[k - 1] <= f.params.beamSpacing_m + 1e-6, `${beamDirection} ${at}`);
    const width = b.edgeCantilevers.reduce((s, e) => s + e.width_m, 0);
    // G08 runs 12 m; the end widths mirror their neighbours (the slab runs on 1 m past each end).
    assert.ok(width >= 12 && width <= 14.5, `${beamDirection} ${width}`);
  }
  const u = run(f, { ...f.params, beamDirection: 'u' }).b;
  const gapFill = u.edgeCantilevers.find((e) => e.points[0][1] === 6);
  assert.ok(gapFill, 'a square cantilever at y = 6');
  close(gapFill.width_m, 2);
});

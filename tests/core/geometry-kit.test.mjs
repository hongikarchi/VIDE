import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GeometryError,
  bandFromMesh,
  blockFootprints,
  clipConvex,
  convexHull,
  minAreaRect,
  orientation,
  overlapArea,
  planLength,
  pointInPolygon,
  polygonArea,
  separation,
  signedArea,
  signedDistance,
  splitAtSupports,
  validatePolygon,
} from '../../src/jigs/official/geometry-kit/index.ts';

// Synthetic shapes only (PLAN-23 결정 A12): sizes follow the S-06 kinds of blocks, not its data.
const close = (actual, expected, eps = 1e-9, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} ≠ ${expected}`);

/** Box mesh in definition space as a Sync block definition has it (flat xyz + triangle indices). */
function box([cx, cy], [sx, sy], [z0, z1]) {
  const vertices = [];
  for (const z of [z0, z1])
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ])
      vertices.push(cx + (x * sx) / 2, cy + (y * sy) / 2, z);
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const indices = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  return { vertices, indices };
}
function merge(...meshes) {
  const vertices = [],
    indices = [];
  for (const mesh of meshes) {
    const base = vertices.length / 3;
    vertices.push(...mesh.vertices);
    indices.push(...mesh.indices.map((i) => i + base));
  }
  return { vertices, indices };
}
/** Closed outline as flat segment pairs (e.g. an open-cut square drawn with curves). */
function outline(points, z = 0) {
  const segments = [];
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length];
    segments.push(p[0], p[1], z, q[0], q[1], z);
  });
  return segments;
}
/** Row-major 4×4 as Sync `block.transform`: rotate about z, then translate. */
function placed(deg, [tx, ty, tz]) {
  const r = (deg * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  return [c, -s, 0, tx, s, c, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1];
}
const at = [448.852, -142.517, -5.53];
const turn = (deg, [x, y]) => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r) * x - Math.sin(r) * y, Math.sin(r) * x + Math.cos(r) * y];
};
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scaled = (v, k) => [v[0] * k, v[1] * k];
/** A plan square of side `side` rotated by `deg` about `center`. */
function square(center, side, deg) {
  const h = side / 2;
  return [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ].map((p) => add(center, turn(deg, p)));
}
const rejects = (fn, code) =>
  assert.throws(fn, (error) => error instanceof GeometryError && error.code === code);

test('plan basics: hull, area, orientation, containment and rotated rectangles', () => {
  const hull = convexHull([
    [0, 0],
    [2, 0],
    [1, 1],
    [2, 2],
    [0, 2],
    [1, 0], // collinear, dropped
    [0, 0], // duplicate
  ]);
  assert.equal(hull.length, 4);
  assert.equal(orientation(hull), 'ccw');
  close(signedArea(hull), 4);
  close(signedArea([...hull].reverse()), -4);
  assert.equal(orientation([...hull].reverse()), 'cw');
  assert.equal(pointInPolygon([1, 1], hull), true);
  assert.equal(pointInPolygon([2, 1], hull), true, 'boundary counts as inside');
  assert.equal(pointInPolygon([2.01, 1], hull), false);
  // Plan length reads x, y only.
  close(
    planLength([
      [0, 0, 0],
      [3, 4, 10],
      [3, 10, -2],
    ]),
    11,
  );
  // A 3 × 2 rectangle turned 158° reports its long axis folded to −22°, not an upright box.
  const rect = minAreaRect(
    [
      [-1.5, -1],
      [1.5, -1],
      [1.5, 1],
      [-1.5, 1],
      [0.3, 0.2],
    ].map((p) => add([1000, 2000], turn(158, p))),
  );
  close(rect.angleDeg, -22, 1e-9, 'angle');
  close(rect.halfU, 1.5);
  close(rect.halfV, 1);
  close(rect.center[0], 1000);
  close(rect.center[1], 2000);
  close(signedArea(rect.corners), 6, 1e-9, 'corners ccw');
});

test('block footprints keep the instance rotation (−21° pile cap, open cut, footing base)', () => {
  const cap = {
    hash: 'synthetic-cap',
    // Cap 2.7 m square (1.5 m deep) with a 0.5 m column stub; drawn open cut 3.6 m square.
    ...merge(box([0, 0], [2.7, 2.7], [-1.5, 0]), box([0, 0], [0.5, 0.5], [0, 1])),
  };
  cap.segments = outline(square([0, 0], 3.6, 0));
  cap.texts = [];
  const transform = placed(-21, at);

  const solid = blockFootprints(cap, transform, 'solid');
  close(solid.rect.angleDeg, -21, 1e-9, 'solid angle');
  close(solid.rect.halfU, 1.35);
  close(solid.rect.halfV, 1.35);
  close(solid.rect.center[0], at[0]);
  close(solid.rect.center[1], at[1]);
  close(solid.z[0], at[2] - 1.5);
  close(solid.z[1], at[2] + 1);
  close(polygonArea(solid.hull), 2.7 * 2.7);
  // Rotated, not an axis-aligned box: every corner lies on a −21° square around the centre.
  for (const [corner, expected] of solid.rect.corners.map((c, i) => [
    c,
    square([at[0], at[1]], 2.7, -21)[i],
  ])) {
    close(corner[0], expected[0], 1e-9, 'corner x');
    close(corner[1], expected[1], 1e-9, 'corner y');
  }

  const cut = blockFootprints(cap, transform, 'outline');
  close(cut.rect.angleDeg, -21, 1e-9, 'outline angle');
  close(cut.rect.halfU, 1.8);
  close(cut.rect.halfV, 1.8);

  // An existing footing: 2.7 m slab under a 4 m × 1 m pedestal plate. `base` sees the slab only.
  const footing = merge(box([1, 2], [2.7, 2.7], [-1, -0.4]), box([1, 2], [4, 1], [0, 0.2]));
  const footingAt = placed(-22, [455, -150, -5.53]);
  const whole = blockFootprints(footing, footingAt, 'solid');
  const base = blockFootprints(footing, footingAt, 'base');
  close(whole.rect.halfU, 2);
  close(whole.rect.halfV, 1.35);
  close(base.rect.halfU, 1.35);
  close(base.rect.angleDeg, -22, 1e-9, 'base angle');
  const center = add([455, -150], turn(-22, [1, 2]));
  close(base.rect.center[0], center[0]);
  close(base.rect.center[1], center[1]);
  assert.equal(base.points, 4);
  // A band that reaches the plate brings the plate back in.
  close(blockFootprints(footing, footingAt, 'base', { baseBand: 1.5 }).rect.halfU, 2);

  // Typed arrays (the wire format) are read the same way.
  const typed = blockFootprints(
    { vertices: new Float32Array(cap.vertices), indices: cap.indices },
    transform,
  );
  close(typed.rect.angleDeg, -21, 1e-5);

  // A Brep render mesh of an underground beam becomes its plan band.
  const band = bandFromMesh(box([0, 0], [20, 0.8], [-3, -2]).vertices, placed(30, [10, 10, 0]));
  assert.equal(orientation(band), 'ccw');
  close(polygonArea(band), 16);
});

test('overlapping footprints give a negative distance and an overlap area', () => {
  const u = turn(-21, [1, 0]);
  const cap = square([448.852, -142.517], 2.7, -21);
  const footing = square(add([448.852, -142.517], scaled(u, 2.0)), 2.7, -21);
  const result = separation(cap, footing);
  close(result.distance, -0.7, 1e-9, 'penetration');
  close(result.axis[0], u[0], 1e-9);
  close(result.axis[1], u[1], 1e-9);
  close(overlapArea(cap, footing), 0.7 * 2.7, 1e-9, 'overlap area');
  // Different rotations still interfere by their real shapes.
  const skew = square(add([448.852, -142.517], scaled(u, 2.5)), 2.7, -22);
  assert.ok(signedDistance(cap, skew) < 0);
  assert.ok(overlapArea(cap, skew) > 0);
  // A 2.0 m cap wholly inside a 2.7 m footing: the depth is the way out, not the shared width.
  const centre = [448.852, -142.517];
  close(signedDistance(square(centre, 2.0, -21), square(centre, 2.7, -21)), -2.35, 1e-9, 'inside');
  const offset = separation(
    square(add(centre, scaled(u, 0.2)), 2.0, -21),
    square(centre, 2.7, -21),
  );
  close(offset.distance, -2.15, 1e-9, 'inside, off centre');
  close(offset.axis[0], -u[0], 1e-9, 'the footing leaves on the near side');
  close(offset.axis[1], -u[1], 1e-9);
  // Shapes that only touch share no area.
  assert.deepEqual(clipConvex(square([0, 0], 2, 0), square([2, 0], 2, 0)), []);
  assert.equal(clipConvex(cap, footing).length, 4);
});

test('footprints apart in one direction pass even when their projections overlap', () => {
  const u = turn(-21, [1, 0]),
    v = turn(-21, [0, 1]);
  const cap = square([100, 100], 2.7, -21);
  // Same row along u, 3.0 m apart across v: 0.3 m gap although the u projections overlap fully.
  const footing = square(add(add([100, 100], scaled(v, 3.0)), scaled(u, 0.5)), 2.7, -21);
  close(signedDistance(cap, footing), 0.3, 1e-9, 'gap');
  assert.equal(overlapArea(cap, footing), 0);
  // The gap is the true minimum distance, not the separating-axis bound.
  const a = square([0.5, 0.5], 1, 0),
    b = square([2.5, 2.5], 1, 0);
  close(signedDistance(a, b), Math.SQRT2, 1e-12, 'corner to corner');
  const direction = separation(a, b).axis;
  close(direction[0], Math.SQRT1_2);
  close(direction[1], Math.SQRT1_2);
  // Touching is zero.
  close(signedDistance(a, square([1.5, 0.5], 1, 0)), 0);
});

test('a member curve is cut at supports within tolerance into spans and overhangs', () => {
  const girder = [
    [0, 0, 10],
    [30, 0, 10],
  ];
  const supports = [
    [3, 0.29], // inside 0.3 m
    [15, -0.1],
    [27, 0.31], // outside 0.3 m
    [15, -0.1], // the same column twice
    [40, 0], // far away
  ];
  const cut = splitAtSupports(girder, supports, 0.3);
  assert.deepEqual(
    cut.stations.map((s) => s.supports),
    [[0], [1, 3]],
  );
  assert.deepEqual(
    cut.spans.map((s) => [s.from, s.to, s.length]),
    [[0, 1, 12]],
  );
  assert.deepEqual(
    cut.overhangs.map((s) => [s.from, s.to, s.length]),
    [
      [null, 0, 3],
      [1, null, 15],
    ],
  );
  close(cut.stations[0].offset, 0.29);
  // Widening the tolerance picks up the third column.
  const wider = splitAtSupports(girder, supports, 0.32);
  assert.deepEqual(
    wider.spans.map((s) => s.length),
    [12, 12],
  );
  assert.deepEqual(
    wider.overhangs.map((s) => s.length),
    [3, 3],
  );

  // Deterministic: the support order does not change the pieces.
  const order = [4, 2, 3, 0, 1];
  const shuffled = splitAtSupports(
    girder,
    order.map((i) => supports[i]),
    0.3,
  );
  assert.deepEqual(
    shuffled.stations.map((s) => s.supports.map((i) => order[i]).sort()),
    cut.stations.map((s) => s.supports),
  );
  assert.deepEqual(
    shuffled.spans.map((s) => s.points),
    cut.spans.map((s) => s.points),
  );

  // Sloped polyline: along-curve and plan lengths differ; supports at and past the ends.
  const ramp = [
    [0, 0, 0],
    [10, 0, 0],
    [20, 0, 5],
  ];
  const onRamp = splitAtSupports(
    ramp,
    [
      [5, 0],
      [20.2, 0.1], // beyond the end but within 0.3 m of it
      [-0.0004, 0], // a hair before the start: the start itself
    ],
    0.3,
  );
  assert.equal(onRamp.stations.length, 3);
  assert.equal(onRamp.overhangs.length, 0);
  assert.deepEqual(
    onRamp.spans.map((s) => s.planLength),
    [5, 15],
  );
  close(onRamp.spans[1].length, 5 + Math.hypot(10, 5));
  assert.deepEqual(onRamp.spans[1].points, [
    [5, 0, 0],
    [10, 0, 0],
    [20, 0, 5],
  ]);
  close(onRamp.length, 10 + Math.hypot(10, 5));
  assert.equal(onRamp.planLength, 20);
  // A support at a polyline vertex does not duplicate the vertex.
  const atVertex = splitAtSupports(ramp, [[10, 0]], 0.3);
  assert.deepEqual(
    atVertex.overhangs.map((s) => s.points.length),
    [2, 2],
  );
  // No support within reach: nothing to cut.
  const free = splitAtSupports(ramp, [[5, 3]], 0.3);
  assert.equal(free.stations.length, 0);
  assert.equal(free.spans.length + free.overhangs.length, 0);
});

test('NaN and degenerate input are rejected with the gate codes', () => {
  const t = placed(-21, at);
  rejects(() => blockFootprints({ vertices: [], indices: [], segments: [] }, t), 'polygon-valid');
  rejects(
    () => blockFootprints({ vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0] }, t, 'outline'),
    'polygon-valid',
  );
  rejects(
    () => blockFootprints({ vertices: [0, 0, 0, 1, 1, 0, 2, 2, 5, 3, 3, 1] }, t),
    'polygon-valid',
  );
  rejects(() => blockFootprints({ vertices: [0, 0, 0, 1, NaN, 0, 1, 1, 0] }, t), 'no-nan');
  rejects(() => blockFootprints(box([0, 0], [1, 1], [0, 1]), [...t.slice(0, 15), NaN]), 'no-nan');
  rejects(() => blockFootprints(box([0, 0], [1, 1], [0, 1]), t.slice(0, 12)), 'no-nan');
  rejects(() => bandFromMesh([0, 0, 0, 5, 0, 1, 10, 0, 2]), 'polygon-valid');

  const unit = square([0, 0], 1, 0);
  rejects(
    () =>
      signedDistance(
        [
          [0, 0],
          [1, 0],
        ],
        unit,
      ),
    'polygon-valid',
  );
  rejects(
    () =>
      signedDistance(
        [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        unit,
      ),
    'polygon-valid',
  );
  rejects(
    () =>
      signedDistance(
        [
          [0, 0],
          [1, NaN],
          [1, 1],
        ],
        unit,
      ),
    'no-nan',
  );
  const bowtie = [
    [0, 0],
    [1, 1],
    [1, 0],
    [0, 1],
  ];
  rejects(() => signedDistance(bowtie, unit), 'polygon-valid');
  assert.deepEqual(validatePolygon(bowtie).ok, false);
  assert.equal(validatePolygon(bowtie).code, 'polygon-valid');
  const ell = [
    [0, 0],
    [2, 0],
    [2, 1],
    [1, 1],
    [1, 2],
    [0, 2],
  ];
  assert.deepEqual(validatePolygon(ell), { ok: true });
  assert.equal(validatePolygon(ell, { convex: true }).ok, false);
  rejects(() => overlapArea(ell, unit), 'polygon-valid');
  const star = [0, 2, 4, 1, 3].map((k) => {
    const r = (k * 2 * Math.PI) / 5;
    return [Math.cos(r), Math.sin(r)];
  });
  assert.equal(validatePolygon(star, { convex: true }).ok, false, 'a star winds twice');
  assert.equal(
    validatePolygon([
      [0, 0],
      [1, 0],
      [NaN, 1],
    ]).code,
    'no-nan',
  );

  rejects(
    () =>
      minAreaRect([
        [0, 0],
        [1, 1],
        [2, 2],
      ]),
    'polygon-valid',
  );
  rejects(() => pointInPolygon([NaN, 0], unit), 'no-nan');
  rejects(
    () =>
      planLength([
        [0, 0],
        [Infinity, 0],
      ]),
    'no-nan',
  );
  rejects(
    () =>
      splitAtSupports(
        [
          [0, 0],
          [1, 0],
        ],
        [[NaN, 0]],
        0.3,
      ),
    'no-nan',
  );
  rejects(
    () =>
      splitAtSupports(
        [
          [0, 0],
          [1, 0],
        ],
        [],
        NaN,
      ),
    'no-nan',
  );
  rejects(() => splitAtSupports([[0, 0]], [], 0.3), 'polygon-valid');
});

test('1,000-member diagnosis scale runs within 50 ms', () => {
  // A −21° grid of 1,000 columns (4.0 m × 5.559 m bays), each with a pile cap and an open cut,
  // checked against 1,000 existing footings; 1,000 girders cut at every column top.
  const cap = { ...box([0, 0], [2.7, 2.7], [-1.5, 0]), segments: outline(square([0, 0], 3.6, 0)) };
  const footing = box([0, 0], [2.7, 2.7], [-1, -0.4]);
  const columns = [];
  for (let i = 0; i < 40; i++)
    for (let j = 0; j < 25; j++)
      columns.push(add([448.852, -142.517], turn(-21, [i * 4, j * 5.559])));
  const existing = columns.map((c) => add(c, turn(-22, [1.9, 2.2])));
  const girders = [];
  const girder = (a, b) =>
    girders.push([
      [a[0], a[1], 10],
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 10.2],
      [b[0], b[1], 10],
    ]);
  for (let i = 0; i < 40; i++)
    for (let j = 0; j + 1 < 25; j++) girder(columns[i * 25 + j], columns[i * 25 + j + 1]);
  for (let j = 0; girders.length < 1000; j++) girder(columns[j], columns[j + 25]);
  const tops = columns.map((c) => [c[0] + 0.05, c[1] - 0.05]);
  const run = () => {
    let clashes = 0,
      spans = 0;
    for (let k = 0; k < columns.length; k++) {
      const c = columns[k];
      const pile = blockFootprints(cap, placed(-21, [c[0], c[1], -5.53]), 'solid');
      const cut = blockFootprints(cap, placed(-21, [c[0], c[1], -5.53]), 'outline');
      const e = existing[k];
      const old = blockFootprints(footing, placed(-22, [e[0], e[1], -8]), 'base');
      if (signedDistance(pile.rect.corners, old.rect.corners) < 0) clashes++;
      if (signedDistance(cut.rect.corners, old.rect.corners) < 0)
        overlapArea(cut.rect.corners, old.rect.corners);
    }
    for (const g of girders) {
      spans += splitAtSupports(g, tops, 0.3).spans.length;
      planLength(g);
    }
    return { clashes, spans };
  };
  const cold = performance.now();
  const first = run();
  const coldMs = performance.now() - cold;
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    assert.deepEqual(run(), first);
    best = Math.min(best, performance.now() - start);
  }
  assert.equal(girders.length, 1000);
  assert.equal(first.spans, 1000);
  assert.ok(first.clashes > 0);
  console.log(
    `geometry-kit 1,000 members: first run ${coldMs.toFixed(1)} ms, warm ${best.toFixed(1)} ms`,
  );
  // The engine reruns the diagnosis on every change, so the budget applies to a warm run; the
  // first (compiling) run is logged. Parallel test files share the CPU, hence best of three.
  assert.ok(best <= 50, `warm run ${best.toFixed(1)} ms`);
});

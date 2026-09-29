import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GeometryError,
  allowedWindows,
  arcPoint,
  arcThrough,
  cantileverBeams,
  cellInfill,
  cellPolygon,
  fitArc,
  inWindows,
  insetPolygon,
  orientation,
  outlineFromMesh,
  polygonArea,
  segmentArc,
  segmentPolyline,
  splitAtSupports,
  triangulate,
  triangulateRegion,
  verticalArc,
} from '../../src/jigs/official/geometry-kit/index.ts';

// PLAN-23 T-050 layout functions. Synthetic layouts only (결정 A12): the bay sizes and block sizes
// follow the S-06 kinds of members, never its data.
const close = (actual, expected, eps = 1e-9, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} ≠ ${expected}`);
const rejects = (fn, code) =>
  assert.throws(fn, (error) => error instanceof GeometryError && error.code === code);
const turn = (deg, [x, y]) => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r) * x - Math.sin(r) * y, Math.sin(r) * x + Math.cos(r) * y];
};
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
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
/** Deterministic jitter source. */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const edgeKeys = (result) => result.edges.map((e) => `${e.a}-${e.b}`);
const hasEdge = (result, a, b) =>
  result.edges.some((e) => e.a === Math.min(a, b) && e.b === Math.max(a, b));
const removedReason = (result, a, b) =>
  result.removed.find((e) => e.a === Math.min(a, b) && e.b === Math.max(a, b))?.reason;

test('triangulate keeps constraints and drops edges outside the slab, across a void or a barrier', () => {
  // Staggered rows (unique Delaunay): row 0 at v = 0, row 1 shifted 4 m, row 2 at v = 12.
  const points = [
    [0, 0],
    [8, 0],
    [16, 0],
    [4, 6],
    [12, 6],
    [20, 6],
    [0, 12],
    [8, 12],
    [16, 12],
  ];
  const plain = triangulate(points);
  assert.equal(plain.decided.length, 0, 'a staggered grid needs no diagonal rule');
  assert.ok(hasEdge(plain, 1, 3), 'Delaunay joins (8,0)–(4,6)');
  assert.ok(!hasEdge(plain, 0, 4));
  assert.ok(plain.cells.every((c) => c.vertices.length === 3 && c.minAngleDeg > 30));
  assert.deepEqual(triangulate(points), plain, 'same input, same result');

  const clipped = triangulate(points, {
    constraints: [[0, 4]],
    // L-shaped slab: the top-right corner (u > 10, v > 8) is not slab.
    outer: [
      [-2, -2],
      [22, -2],
      [22, 8],
      [10, 8],
      [10, 14],
      [-2, 14],
    ],
    holes: [
      [
        [9, 2],
        [11, 2],
        [11, 4],
        [9, 4],
      ],
    ],
    barriers: [
      [
        [14, -2],
        [14, 14],
      ],
    ],
  });
  const constrained = clipped.edges.find((e) => e.a === 0 && e.b === 4);
  assert.ok(constrained?.constrained, 'the constraint (0,0)–(12,6) is an edge');
  assert.ok(!hasEdge(clipped, 1, 3), 'the Delaunay edge it crossed is gone');
  assert.equal(removedReason(clipped, 1, 4), 'crosses-hole');
  assert.equal(removedReason(clipped, 1, 2), 'crosses-barrier');
  assert.ok(
    !clipped.edges.some((e) => e.a === 8 || e.b === 8),
    'no girder to the column off the slab',
  );
  assert.ok(
    clipped.removed
      .filter((e) => e.a === 8 || e.b === 8)
      .every((e) => e.reason === 'outside' || e.reason === 'crosses-boundary'),
  );
  for (const cell of clipped.cells)
    for (let i = 0; i < 3; i++)
      assert.ok(hasEdge(clipped, cell.vertices[i], cell.vertices[(i + 1) % 3]), 'cells are closed');
  const keys = edgeKeys(clipped);
  assert.deepEqual([...keys].sort(), keys, 'edges are sorted');
  // A girder may be left with no closed bay beside it (its bays lost an edge to the barrier).
  for (const edge of clipped.edges) assert.ok(edge.cells.length <= 2);
  assert.equal(clipped.edges.find((e) => e.a === 2 && e.b === 5).cells.length, 0);
  const kept = clipped.edges.find((e) => e.a === 0 && e.b === 3);
  assert.equal(kept.cells.length, 2, '(0,0)–(4,6) has a cell on both sides');
  assert.equal(polygonArea(cellPolygon(points, clipped.cells[0])), clipped.cells[0].area);

  // Constraint indices and coincident points are input errors.
  rejects(() => triangulate(points, { constraints: [[0, 9]] }), 'polygon-valid');
  rejects(() => triangulate(points, { constraints: [[2, 2]] }), 'polygon-valid');
  rejects(() => triangulate([...points, [8, 0.0000001]]), 'polygon-valid');
  rejects(
    () =>
      triangulate([
        [0, 0],
        [1, NaN],
        [2, 0],
      ]),
    'no-nan',
  );
  rejects(
    () =>
      triangulate(points, {
        outer: [
          [0, 0],
          [1, 1],
          [1, 0],
          [0, 1],
        ],
      }),
    'polygon-valid',
  );
  // Two points make one edge; collinear points make a chain.
  assert.deepEqual(
    edgeKeys(
      triangulate([
        [0, 0],
        [5, 0],
      ]),
    ),
    ['0-1'],
  );
  assert.deepEqual(
    edgeKeys(
      triangulate([
        [10, 0],
        [0, 0],
        [5, 0],
      ]),
    ),
    ['0-2', '1-2'],
  );
  assert.equal(triangulate([[3, 3]]).edges.length, 0);
});

test('a region triangulated on its own vertices is covered exactly, voids left open', () => {
  // L-shaped slab with a triangular void: the ring edges are constraints, the cells tile the
  // slab, no cell sits in the void or in the notch, and every cell is convex for the window search.
  const outer = [
    [0, 0],
    [30, 0],
    [30, 12],
    [14, 12],
    [14, 24],
    [0, 24],
  ];
  const hole = [
    [4, 4],
    [8, 4],
    [4, 8],
  ];
  const { points, result } = triangulateRegion({ outer, holes: [hole] });
  assert.equal(points.length, 9);
  const covered = result.cells.reduce((sum, c) => sum + c.area, 0);
  close(covered, 30 * 12 + 14 * 12 - 8, 1e-9, 'cells tile the slab less the void');
  assert.ok(result.cells.every((c) => c.vertices.length === 3));
  for (let i = 0; i < 6; i++) {
    const edge = result.edges.find(
      (e) => e.a === Math.min(i, (i + 1) % 6) && e.b === Math.max(i, (i + 1) % 6),
    );
    assert.ok(edge?.constrained, `outer edge ${i} is kept`);
  }
  assert.ok(result.removed.some((e) => e.reason === 'inside-hole' || e.reason === 'outside'));
  // The notch chord (30,12)–(14,24) is a hull edge with its middle off the slab.
  assert.equal(removedReason(result, 2, 4), 'outside');
  // The cells serve as convex obstacles: a 1 m square cannot sit in the void's corner.
  const blocked = allowedWindows(
    { origin: [0, 5], direction: [1, 0], from: 0, to: 30 },
    square([0, 0], 1, 0),
    result.cells.map((c) => cellPolygon(points, c)),
  );
  assert.ok(!inWindows(blocked.windows, 20), 'on the slab: blocked');
  assert.ok(inWindows(blocked.windows, 5.5), 'in the void: free');
});

test('rect-grid-degenerate: a rectangular grid keeps the same girders under ±1 mm moves', () => {
  // 6 × 5 columns, 4.0 m × 5.559 m bays at −21° in site coordinates.
  const origin = [5000, 3000];
  const angle = -21;
  const local = (p) => turn(-angle, sub(p, origin));
  const grid = (jitter) => {
    const points = [];
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 5; j++)
        points.push(add(origin, turn(angle, [i * 4 + jitter(), j * 5.559 + jitter()])));
    return points;
  };
  const base = triangulate(
    grid(() => 0),
    { axisDeg: angle },
  );
  assert.equal(base.edges.length, 25 + 24 + 20, '25 row + 24 column + 20 diagonal girders');
  assert.equal(base.cells.length, 40);
  assert.equal(base.decided.length, 20, 'every rectangular bay is decided by the rule');
  const points = grid(() => 0);
  for (const [a, b] of base.decided) {
    const [du, dv] = turn(-angle, sub(points[b], points[a]));
    close(Math.abs(du), 4, 1e-9, 'diagonal spans one bay in u');
    close(Math.abs(dv), 5.559, 1e-9, 'and one bay in v');
    assert.ok(du * dv > 0, 'equal diagonals take the u+v direction');
  }
  assert.ok(base.edges.filter((e) => e.decided).length === 20);

  const random = lcg(2026);
  for (let run = 0; run < 20; run++) {
    const jittered = triangulate(
      grid(() => (random() - 0.5) * 0.002),
      { axisDeg: angle },
    );
    assert.deepEqual(edgeKeys(jittered), edgeKeys(base), `run ${run}: same girder set`);
    assert.deepEqual(jittered.decided, base.decided, `run ${run}: same diagonals`);
    assert.deepEqual(
      jittered.cells.map((c) => c.vertices),
      base.cells.map((c) => c.vertices),
    );
  }

  // The previous run's diagonal is kept when it is not longer by 0.2 m (here the diagonals are
  // equal), so a bay the user saw stays as it was.
  const flipped = base.decided[7];
  const [i, j] = flipped;
  // The other diagonal of that bay joins the bay's two other corners.
  const [ui, vi] = local(points[i]).map((x) => Math.round(x * 1000) / 1000);
  const [uj, vj] = local(points[j]).map((x) => Math.round(x * 1000) / 1000);
  const at = (u, v) =>
    points.findIndex((p) => {
      const [pu, pv] = local(p);
      return Math.abs(pu - u) < 1e-6 && Math.abs(pv - v) < 1e-6;
    });
  const other = [at(ui, vj), at(uj, vi)].sort((a, b) => a - b);
  const kept = triangulate(points, { axisDeg: angle, previous: [other] });
  assert.ok(hasEdge(kept, other[0], other[1]), 'the previous diagonal is kept');
  assert.ok(!hasEdge(kept, i, j));
  assert.equal(kept.decided.length, 20);
  assert.equal(kept.edges.length, base.edges.length);

  // Merging the two triangles of each bay gives 20 quad cells and no diagonal girders.
  const quads = triangulate(points, { axisDeg: angle, mergeQuads: true });
  assert.equal(quads.cells.length, 20);
  assert.ok(
    quads.cells.every((c) => c.vertices.length === 4 && Math.abs(c.minAngleDeg - 90) < 1e-6),
  );
  assert.equal(quads.edges.length, 49);
  assert.equal(quads.removed.filter((e) => e.reason === 'merged').length, 20);
  assert.ok(quads.edges.every((e) => e.cells.length >= 1));
});

test('a cocircular cell takes the shorter diagonal, a tie the u+v one, a previous one within 0.2 m', () => {
  const onCircle = (deg, r = 5) => [
    r * Math.cos((deg * Math.PI) / 180),
    r * Math.sin((deg * Math.PI) / 180),
  ];
  // Cyclic quad: diagonal 0–2 is the diameter (10 m), 1–3 the chord of 150° (9.659 m).
  const cyclic = [onCircle(0), onCircle(90), onCircle(180), onCircle(300)];
  const shorter = triangulate(cyclic);
  assert.deepEqual(edgeKeys(shorter), ['0-1', '0-3', '1-2', '1-3', '2-3']);
  assert.deepEqual(shorter.decided, [[1, 3]]);
  // A previous diameter is 0.341 m longer than the other diagonal: not kept under the 0.2 m rule.
  assert.deepEqual(triangulate(cyclic, { previous: [[0, 2]] }).decided, [[1, 3]]);
  assert.deepEqual(triangulate(cyclic, { previous: [[0, 2]], diagonal: { keep: 0.5 } }).decided, [
    [0, 2],
  ]);
  // A square whose diagonals run along x and y: the tie goes to the one along u+v.
  const diamond = [onCircle(0), onCircle(90), onCircle(180), onCircle(270)];
  assert.deepEqual(triangulate(diamond, { axisDeg: -45 }).decided, [[0, 2]], 'u+v is +x');
  assert.deepEqual(triangulate(diamond, { axisDeg: 45 }).decided, [[1, 3]], 'u+v is +y');
  assert.deepEqual(triangulate(diamond, { axisDeg: 0 }).decided, [[0, 2]], 'exact tie: lower key');
  // Far from cocircular: Delaunay decides and nothing is marked.
  assert.equal(
    triangulate([
      [0, 0],
      [10, 0],
      [10, 4],
      [0, 8],
    ]).decided.length,
    0,
  );
});

test('allowed windows on a rotated grid: one-direction clearance passes (grid-4m-bay, grid-rot21)', () => {
  const angle = -21;
  const u = turn(angle, [1, 0]);
  // grid-4m-bay: 4 m bays; existing 2.7 m footings clear a 2.0 m cap in v only, one turned 45°.
  let origin = [3000, 1000];
  const site = (p) => add(origin, turn(angle, p));
  const cap = square([0, 0], 2.0, angle);
  const footings = [
    square(site([0, 2.5]), 2.7, angle),
    square(site([4, -2.5]), 2.7, angle),
    square(site([10.5, 2.5]), 2.7, angle + 45),
  ];
  const line = { origin: site([0, 0]), direction: u, from: -3, to: 12 };
  const free = allowedWindows(line, cap, footings);
  // The two axis-aligned footings keep 0.15 m in v wherever the cap is along u: no block. The
  // turned footing's lower corner dips to v = 2.5 − 2.7/√2 = 0.591, so its section at the cap's top
  // edge (v = 1) blocks the cap between u = 10.5 ± (0.409 + 1); the column at 8 keeps 0.771 m.
  const half = 2.7 / Math.SQRT2;
  const dip = 1 - (2.5 - half);
  assert.deepEqual(
    free.blocked.map((b) => b.obstacle),
    [2],
    'only the turned footing blocks at clearance 0',
  );
  close(free.blocked[0].interval[0], 10.5 - dip - 1, 1e-9, 'blocked from');
  close(free.blocked[0].interval[1], 10.5 + dip + 1, 1e-9, 'blocked to');
  assert.equal(free.windows.length, 2);
  for (const t of [0, 4, 8]) assert.ok(inWindows(free.windows, t), `column at ${t}`);
  assert.ok(!inWindows(free.windows, 10.5));
  const clear = allowedWindows(line, cap, footings, { clearance: 0.2 });
  assert.equal(clear.blocked.length, 3);
  const first = clear.blocked.find((b) => b.obstacle === 0);
  // Along u the cap corner leaves the 0.2 m circle at 2.35 + √(0.2² − 0.15²).
  close(first.interval[0], -2.35 - Math.sqrt(0.04 - 0.0225), 1e-9, 'blocked from');
  close(first.interval[1], 2.35 + Math.sqrt(0.04 - 0.0225), 1e-9, 'blocked to');
  assert.ok(!inWindows(clear.windows, 0) && !inWindows(clear.windows, 4), '0.15 m < 0.2 m');
  assert.ok(inWindows(clear.windows, 8), '0.771 m ≥ 0.2 m');
  const third = clear.blocked.find((b) => b.obstacle === 2);
  // The cap corner is 0.2 m from the turned footing's edge 0.2·√2 before the overlap starts.
  close(third.interval[0], 10.5 - dip - 1 - 0.2 * Math.SQRT2, 1e-9, 'turned footing');

  // grid-rot21: along the v = 0 line the columns at u = 4 and 9.559 sit in the window although
  // footings overlap them along u; the columns at 0 and 13.559 do not.
  origin = [5000, 3000];
  const rot21 = [
    [0, 1.5],
    [4, -2.8],
    [6.559, -3.0],
    [13.559, 2.2],
    [2.6, 5.559],
    [9.559, 7.059],
  ].map((p) => square(site(p), 2.7, angle));
  const row = allowedWindows(
    { origin: site([0, 0]), direction: u, from: -1, to: 14.5 },
    cap,
    rot21,
  );
  assert.deepEqual(
    row.blocked.map((b) => b.obstacle),
    [0, 3],
  );
  assert.equal(row.windows.length, 1);
  close(row.windows[0][0], 2.35, 1e-9);
  close(row.windows[0][1], 13.559 - 2.35, 1e-9);
  assert.ok(inWindows(row.windows, 4) && inWindows(row.windows, 9.559));
  assert.ok(!inWindows(row.windows, 0) && !inWindows(row.windows, 13.559));
  // With 0.5 m clearance the footing 0.45 m below u = 4 blocks it as well.
  const strict = allowedWindows(
    { origin: site([0, 0]), direction: u, from: -1, to: 14.5 },
    cap,
    rot21,
    { clearance: 0.5 },
  );
  assert.deepEqual(
    strict.blocked.map((b) => b.obstacle),
    [0, 1, 3],
  );
  assert.ok(!inWindows(strict.windows, 4) && inWindows(strict.windows, 9.559));
  // The line's direction may be given at any length; parameters are metres.
  const scaled = allowedWindows(
    { origin: site([0, 0]), direction: turn(angle, [7, 0]), from: -1, to: 14.5 },
    cap,
    rot21,
  );
  assert.deepEqual(scaled.windows, row.windows);
  assert.deepEqual(allowedWindows(line, cap, []).windows, [[-3, 12]]);
  rejects(() => allowedWindows({ ...line, from: 5, to: 1 }, cap, footings), 'no-nan');
  rejects(
    () =>
      allowedWindows(
        line,
        [
          [0, 0],
          [1, 0],
        ],
        footings,
      ),
    'polygon-valid',
  );
  rejects(() => allowedWindows(line, cap, footings, { clearance: -1 }), 'no-nan');
});

/** Mesh helpers: flat xyz + triangle indices, with a per-triangle vertex copy when `split`. */
function mesh(triangles, split = false) {
  const vertices = [],
    indices = [];
  const seen = new Map();
  const id = (p) => {
    const k = split ? Symbol() : p.join(',');
    if (!split && seen.has(k)) return seen.get(k);
    const i = vertices.length / 3;
    vertices.push(...p);
    if (!split) seen.set(k, i);
    return i;
  };
  for (const [a, b, c] of triangles) indices.push(id(a), id(b), id(c));
  return { vertices, indices };
}
const flip = (triangles) => triangles.map(([a, b, c]) => [a, c, b]);
/** Counter-clockwise ring (seen from above) at height z with a hole ring, as triangles. */
function slabRing(outer, inner, z) {
  const triangles = [];
  for (let k = 0; k < outer.length; k++) {
    const o0 = [...outer[k], z],
      o1 = [...outer[(k + 1) % outer.length], z],
      i0 = [...inner[k], z],
      i1 = [...inner[(k + 1) % inner.length], z];
    triangles.push([o0, o1, i1], [o0, i1, i0]);
  }
  return triangles;
}
function placed(deg, [tx, ty, tz]) {
  const r = (deg * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  return [c, -s, 0, tx, s, c, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1];
}

test('outlineFromMesh reads a concave outline with voids from the upward faces', () => {
  const outer = [
    [-5, -3],
    [5, -3],
    [5, 3],
    [-5, 3],
  ];
  const inner = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const top = slabRing(outer, inner, 3.1);
  const bottom = flip(slabRing(outer, inner, 2.8));
  const slab = mesh([...top, ...bottom], true);
  const transform = placed(30, [1000, 2000, 0]);
  const outlines = outlineFromMesh(slab.vertices, slab.indices, { transform });
  assert.equal(outlines.length, 1);
  const [face] = outlines;
  assert.equal(face.outer.length, 4);
  assert.equal(orientation(face.outer), 'ccw');
  close(polygonArea(face.outer), 60);
  assert.equal(face.holes.length, 1);
  close(polygonArea(face.holes[0]), 4);
  assert.equal(orientation(face.holes[0]), 'cw', 'holes come out clockwise');
  close(face.area, 56);
  assert.deepEqual(face.z, [3.1, 3.1]);
  // Rotated, not a bounding box: each outer corner is the placed corner.
  const corners = outer.map((p) => add([1000, 2000], turn(30, p)));
  for (const corner of corners)
    assert.ok(
      face.outer.some((p) => Math.hypot(p[0] - corner[0], p[1] - corner[1]) < 1e-9),
      'placed corner is on the outline',
    );

  // An L-shaped top face meshed in five triangles: the inner edges vanish and the collinear
  // vertex (0,2) on the left side is simplified away.
  const rect = ([x0, y0], [x1, y1], z) => [
    [
      [x0, y0, z],
      [x1, y0, z],
      [x1, y1, z],
    ],
    [
      [x0, y0, z],
      [x1, y1, z],
      [x0, y1, z],
    ],
  ];
  const at5 = (p) => [...p, 5];
  const ell = mesh(
    [
      [
        [0, 0],
        [6, 0],
        [6, 2],
      ],
      [
        [0, 0],
        [6, 2],
        [2, 2],
      ],
      [
        [0, 0],
        [2, 2],
        [0, 2],
      ],
      [
        [0, 2],
        [2, 2],
        [0, 5],
      ],
      [
        [2, 2],
        [2, 5],
        [0, 5],
      ],
    ].map((t) => t.map(at5)),
  );
  const [shape] = outlineFromMesh(ell.vertices, ell.indices);
  assert.equal(shape.outer.length, 6);
  close(shape.area, 18);
  assert.equal(shape.holes.length, 0);

  // Two decks at different levels joined by a wall give two outlines, largest first; the wall and
  // the undersides are not top faces. The sloped deck (1:4) still counts.
  const wall = [
    [
      [6, 0, 5],
      [6, 0, 6],
      [6, 4, 6],
    ],
    [
      [6, 0, 5],
      [6, 4, 6],
      [6, 4, 5],
    ],
  ];
  const sloped = [
    [
      [6, 0, 6],
      [8, 0, 6.5],
      [8, 4, 6.5],
    ],
    [
      [6, 0, 6],
      [8, 4, 6.5],
      [6, 4, 6],
    ],
  ];
  const stepped = mesh([...rect([0, 0], [6, 4], 5), ...wall, ...sloped]);
  const decks = outlineFromMesh(stepped.vertices, stepped.indices);
  assert.equal(decks.length, 2);
  close(decks[0].area, 24);
  close(decks[1].area, 8);
  assert.deepEqual(decks[1].z, [6, 6.5]);

  // Only downward faces, an empty mesh and a bad index are rejected.
  const under = mesh(bottom);
  rejects(() => outlineFromMesh(under.vertices, under.indices), 'polygon-valid');
  rejects(() => outlineFromMesh([], []), 'polygon-valid');
  rejects(() => outlineFromMesh(slab.vertices, [0, 1, 999]), 'polygon-valid');
  rejects(() => outlineFromMesh([0, 0, NaN, 1, 0, 0, 0, 1, 0], [0, 1, 2]), 'no-nan');
});

test('cell infill runs parallel to the longest edge at a pitch within the spacing', () => {
  const triangle = [
    [0, 0],
    [12, 0],
    [0, 9],
  ];
  const fill = cellInfill(triangle, { spacing: 2.5 });
  close(fill.width, 7.2, 1e-9, 'height over the 15 m hypotenuse');
  close(fill.pitch, 2.4);
  assert.equal(fill.beams.length, 2);
  assert.deepEqual(
    fill.beams.map((b) => Math.round(b.length * 1e6) / 1e6),
    [10, 5],
  );
  for (const beam of fill.beams) {
    const d = sub(beam.to, beam.from);
    close(Math.abs(d[0] * 9 + d[1] * 12) / (15 * beam.length), 0, 1e-9, 'parallel to hypotenuse');
    close(Math.abs(d[0] * fill.direction[0] + d[1] * fill.direction[1]), beam.length);
  }
  // Tighter spacing: 7 beams; a 2 m minimum drops the shortest one.
  assert.equal(cellInfill(triangle, { spacing: 1.0 }).beams.length, 7);
  const trimmed = cellInfill(triangle, { spacing: 1.0, minLength: 2.0 });
  assert.equal(trimmed.beams.length, 6);
  assert.equal(trimmed.dropped, 1);
  // Rectangle 8 × 3: one beam along the long side; explicit directions are honoured.
  const rect = [
    [0, 0],
    [8, 0],
    [8, 3],
    [0, 3],
  ];
  const across = cellInfill(rect, { spacing: 2.5 });
  assert.equal(across.beams.length, 1);
  close(across.beams[0].length, 8);
  close(across.beams[0].from[1], 1.5);
  assert.equal(cellInfill(rect, { spacing: 2.5, direction: 90 }).beams.length, 3);
  assert.equal(cellInfill(rect, { spacing: 2.5, direction: [0, 1] }).beams.length, 3);
  // A cell narrower than the spacing needs no beam.
  assert.equal(
    cellInfill(
      [
        [0, 0],
        [10, 0],
        [10, 2],
        [0, 2],
      ],
      { spacing: 2.5 },
    ).beams.length,
    0,
  );
  // Concave L cell: a pitch line crossing the notch gives a short piece, cut at the boundary.
  const ell = [
    [0, 0],
    [6, 0],
    [6, 2],
    [2, 2],
    [2, 5],
    [0, 5],
  ];
  const pieces = cellInfill(ell, { spacing: 2.0 });
  assert.deepEqual(
    pieces.beams.map((b) => [b.line, Math.round(b.length * 1e6) / 1e6]),
    [
      [1, 6],
      [2, 2],
    ],
  );
  // Site coordinates and a turned cell behave the same.
  const turned = cellInfill(
    triangle.map((p) => add([448852, -142517], turn(-21, p))),
    { spacing: 2.5 },
  );
  assert.deepEqual(
    turned.beams.map((b) => Math.round(b.length * 1e6) / 1e6),
    [10, 5],
  );
  rejects(() => cellInfill(triangle, { spacing: 0 }), 'no-nan');
  rejects(() => cellInfill(triangle, { spacing: 2.5, minLength: -1 }), 'no-nan');
  rejects(
    () =>
      cellInfill(
        [
          [0, 0],
          [1, 1],
          [1, 0],
          [0, 1],
        ],
        { spacing: 1 },
      ),
    'polygon-valid',
  );
});

test('edge girder inset line and cantilever arms out to it', () => {
  const slab = [
    [-2, -3],
    [14, -3],
    [14, 8],
    [-2, 8],
  ];
  const edge = insetPolygon(slab, 1.77);
  assert.equal(orientation(edge), 'ccw');
  close(polygonArea(edge), (16 - 3.54) * (11 - 3.54));
  assert.ok(edge.some((p) => Math.abs(p[0] + 0.23) < 1e-9 && Math.abs(p[1] + 1.23) < 1e-9));
  close(
    polygonArea(insetPolygon([...slab].reverse(), 1.77)),
    polygonArea(edge),
    1e-9,
    'any winding',
  );
  close(polygonArea(insetPolygon(slab, -1)), 18 * 13, 1e-9, 'negative = outward');
  const ell = [
    [0, 0],
    [6, 0],
    [6, 2],
    [2, 2],
    [2, 5],
    [0, 5],
  ];
  const ellInset = insetPolygon(ell, 0.5);
  assert.equal(ellInset.length, 6);
  close(polygonArea(ellInset), 8);
  rejects(() => insetPolygon(ell, 1.5), 'polygon-valid');
  rejects(() => insetPolygon(slab, NaN), 'no-nan');

  // Girder along y = 0 between two columns; the slab reaches 3 m past it (side 'right' = −y).
  const girder = [
    [0, 0],
    [12, 0],
  ];
  const arms = cantileverBeams(girder, { spacing: 2.5, side: 'right', boundary: slab, edge });
  assert.equal(arms.arms.length, 6, 'ends included: 0, 2.4 … 12');
  close(arms.pitch, 2.4);
  for (const arm of arms.arms) {
    close(arm.length, 1.23, 1e-9, 'arm ends on the edge girder line');
    close(arm.cantilever, 3, 1e-9, 'cantilever is measured to the slab edge');
    close(arm.to[1], -1.23);
  }
  close(arms.cantileverMax, 3);
  assert.deepEqual(arms.outward, [0, -1]);
  assert.equal(
    cantileverBeams(girder, {
      spacing: 2.5,
      side: 'right',
      boundary: slab,
      edge,
      includeEnds: false,
    }).arms.length,
    4,
  );
  // Facing away from the cell's centroid picks the same side; without an edge line the arms reach
  // the slab edge; the other side is the long one.
  const away = cantileverBeams(girder, {
    spacing: 2.5,
    side: { awayFrom: [6, 4] },
    boundary: slab,
  });
  assert.deepEqual(away.outward, [0, -1]);
  close(away.arms[0].length, 3);
  const left = cantileverBeams(girder, { spacing: 4, side: 'left', boundary: slab, edge });
  close(left.arms[0].length, 8 - 1.77);
  close(left.cantileverMax, 8);
  assert.equal(left.arms.length, 4);
  // Short arms can be left out; a girder facing away from the slab has nothing to hold.
  assert.equal(
    cantileverBeams(girder, { spacing: 2.5, side: 'right', boundary: slab, edge, minLength: 1.5 })
      .arms.length,
    0,
  );
  const outside = cantileverBeams(
    [
      [0, 10],
      [12, 10],
    ],
    { spacing: 2.5, side: 'left', boundary: slab },
  );
  assert.equal(outside.arms.length, 0);
  assert.equal(outside.skipped.length, 6);
  rejects(
    () =>
      cantileverBeams(
        [
          [0, 0],
          [0, 0],
        ],
        { spacing: 1, side: 'left', boundary: slab },
      ),
    'polygon-valid',
  );
  rejects(
    () =>
      cantileverBeams(girder, {
        spacing: 1,
        side: 'left',
        boundary: [
          [0, 0],
          [1, 0],
        ],
      }),
    'polygon-valid',
  );
});

test('arcs: three-point fit, vertical arch with a rise, segmentation within length and sagitta', () => {
  const arc = arcThrough([0, 0, 0], [5, 0, 1], [10, 0, 0]);
  close(arc.radius, 13);
  assert.deepEqual(
    arc.center.map((x) => Math.round(x * 1e9) / 1e9),
    [5, 0, -12],
  );
  close(arc.chord, 10);
  close(arc.rise, 1);
  close(arc.sweep, 2 * Math.asin(5 / 13));
  close(arc.length, 13 * 2 * Math.asin(5 / 13));
  assert.equal(arc.vertical, true);
  assert.deepEqual(
    arcPoint(arc, 0).map((x) => Math.round(x * 1e9) / 1e9),
    [0, 0, 0],
  );
  assert.deepEqual(
    arcPoint(arc, 0.5).map((x) => Math.round(x * 1e9) / 1e9),
    [5, 0, 1],
  );
  assert.deepEqual(
    arcPoint(arc, 1).map((x) => Math.round(x * 1e9) / 1e9),
    [10, 0, 0],
  );

  // The arch girder: same circle from its ends and rise; sloping ends stay in a vertical plane.
  const arch = verticalArc([0, 0, 0], [10, 0, 0], 1);
  close(arch.radius, 13);
  assert.deepEqual(arch.through, [5, 0, 1]);
  const sloping = verticalArc([100, 200, 5], [106, 208, 7], 0.5);
  assert.equal(sloping.vertical, true);
  assert.deepEqual(sloping.through, [103, 204, 6.5]);
  close(sloping.chord, Math.hypot(6, 8, 2));
  const sag = verticalArc([0, 0, 0], [10, 0, 0], -1);
  close(sag.radius, 13);
  assert.equal(sag.through[2], -1);
  // A plan arc is not vertical.
  assert.equal(arcThrough([0, 0], [5, 5], [10, 0]).vertical, false);

  // Segmentation: pieces ≤ 1 m and chord sagitta ≤ 5 mm; ends are exact.
  const pieces = segmentArc(arc, { maxLength: 1.0, maxSagitta: 0.005 });
  assert.equal(pieces.length, 16, '15 pieces: the sagitta limit needs more than the 11 by length');
  assert.deepEqual(pieces[0], [0, 0, 0]);
  assert.deepEqual(pieces[15], [10, 0, 0]);
  for (let i = 1; i < pieces.length; i++) {
    const a = pieces[i - 1],
      b = pieces[i];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    assert.ok(length <= 1 + 1e-9, `piece ${i} is ${length} m`);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const sagitta = arc.radius - Math.hypot(...mid.map((x, k) => x - arc.center[k]));
    assert.ok(sagitta <= 0.005 + 1e-9, `piece ${i} sagitta ${sagitta}`);
  }
  assert.equal(segmentArc(arc, { maxLength: 100, maxSagitta: 100 }).length, 2);

  // Fitting 129 sampled points (the Sync curve density) gives the arc back; noise shows up.
  const sampled = Array.from({ length: 129 }, (_, i) => arcPoint(arc, i / 128));
  const fit = fitArc(sampled);
  close(fit.arc.radius, 13, 1e-9);
  assert.ok(fit.deviation <= 1e-9 && fit.planeDeviation <= 1e-9);
  const noisy = sampled.map((p, i) => (i === 40 ? [p[0], p[1] + 0.02, p[2]] : p));
  close(fitArc(noisy).planeDeviation, 0.02, 1e-9);
  assert.ok(fitArc(noisy).deviation >= 0.02);

  // Polyline segmentation keeps the vertices.
  const line = segmentPolyline(
    [
      [0, 0, 0],
      [2.5, 0, 0],
      [2.5, 4, 0],
    ],
    1.0,
  );
  assert.equal(line.length, 8);
  assert.deepEqual(line[3], [2.5, 0, 0]);
  assert.deepEqual(line[7], [2.5, 4, 0]);

  rejects(() => arcThrough([0, 0, 0], [5, 0, 0], [10, 0, 0]), 'planar-curve');
  rejects(() => verticalArc([0, 0, 0], [0, 0, 5], 1), 'planar-curve');
  rejects(() => verticalArc([0, 0, 0], [10, 0, 0], 0), 'planar-curve');
  rejects(
    () =>
      fitArc([
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    'planar-curve',
  );
  rejects(
    () =>
      fitArc([
        [0, 0],
        [1, 1],
      ]),
    'planar-curve',
  );
  rejects(() => arcThrough([0, 0, NaN], [5, 0, 1], [10, 0, 0]), 'no-nan');
  rejects(() => segmentArc(arc, { maxLength: 0 }), 'no-nan');
  rejects(() => segmentPolyline([[0, 0]], 1), 'polygon-valid');
});

test('span splitting ignores supports of another level when a z tolerance is set', () => {
  const girder = [
    [0, 0, 10],
    [30, 0, 10],
  ];
  const supports = [
    [10, 0, 10.2],
    [20, 0, 4], // a column of the floor below, right under the girder in plan
    [25, 0], // no z: always a support
  ];
  const all = splitAtSupports(girder, supports, 0.3);
  assert.equal(all.stations.length, 3);
  close(all.stations[0].dz, 0.2);
  close(all.stations[1].dz, -6);
  assert.equal(all.stations[2].dz, null);
  const level = splitAtSupports(girder, supports, 0.3, { zTolerance: 0.5 });
  assert.deepEqual(
    level.stations.map((s) => s.supports),
    [[0], [2]],
  );
  assert.deepEqual(
    level.spans.map((s) => s.length),
    [15],
  );
  rejects(() => splitAtSupports(girder, supports, 0.3, { zTolerance: -1 }), 'no-nan');
});

test('1,000-column layout scale runs within 50 ms', () => {
  // 40 × 25 columns (4.0 × 5.559 m bays) at −21°, a notched slab with one void and a new
  // expansion joint; every closed cell filled with beams at 2.5 m; windows on all 25 grid lines
  // against 1,000 existing footings; the outline of a 2,000-triangle slab mesh.
  const angle = -21;
  const origin = [448.852, -142.517];
  const site = (p) => add(origin, turn(angle, p));
  const random = lcg(7);
  const columns = [];
  for (let i = 0; i < 40; i++)
    for (let j = 0; j < 25; j++)
      columns.push(site([i * 4 + (random() - 0.5) * 0.002, j * 5.559 + (random() - 0.5) * 0.002]));
  const outer = [
    [-2, -2],
    [158, -2],
    [158, 100],
    [120, 100],
    [120, 136],
    [-2, 136],
  ].map(site);
  const hole = [
    [81, 46],
    [83, 46],
    [83, 49],
    [81, 49],
  ].map(site);
  const barriers = [[site([82, -2]), site([82, 136])]];
  const footings = columns.map((c) => square(add(c, turn(-22, [1.9, 2.2])), 2.7, -22));
  const cap = square([0, 0], 2.0, angle);
  const slab = (() => {
    const triangles = [];
    for (let i = 0; i < 40; i++)
      for (let j = 0; j < 25; j++) {
        const a = [...site([i * 4, j * 5.559]), 6],
          b = [...site([(i + 1) * 4, j * 5.559]), 6],
          c = [...site([(i + 1) * 4, (j + 1) * 5.559]), 6],
          d = [...site([i * 4, (j + 1) * 5.559]), 6];
        triangles.push([a, b, c], [a, c, d]);
      }
    return mesh(triangles);
  })();
  const run = () => {
    const net = triangulate(columns, { outer, holes: [hole], barriers, axisDeg: angle });
    let beams = 0;
    for (const cell of net.cells)
      beams += cellInfill(cellPolygon(columns, cell), { spacing: 2.5 }).beams.length;
    let windows = 0;
    for (let j = 0; j < 25; j++) {
      const found = allowedWindows(
        { origin: site([0, j * 5.559]), direction: turn(angle, [1, 0]), from: -2, to: 158 },
        cap,
        footings,
        { clearance: 0.2 },
      );
      windows += found.windows.length;
    }
    const outline = outlineFromMesh(slab.vertices, slab.indices);
    return {
      edges: net.edges.length,
      cells: net.cells.length,
      decided: net.decided.length,
      beams,
      windows,
      outlineVertices: outline[0].outer.length,
    };
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
  assert.ok(first.decided >= 39 * 24 - 60, `most bays are decided (${first.decided})`);
  // 1,872 half-bays less the notch, the void and the joint; a half-bay is 3.25 m across its
  // diagonal, so one beam per cell less the short ones.
  assert.ok(first.cells > 1500 && first.beams > 1400, `${first.cells} cells, ${first.beams} beams`);
  assert.ok(first.windows > 0);
  assert.equal(first.outlineVertices, 4);
  console.log(
    `geometry-kit 1,000 columns: first run ${coldMs.toFixed(1)} ms, warm ${best.toFixed(1)} ms`,
  );
  // Warm run: the engine recomputes the layout on every settings change (ARCH-03 §13).
  assert.ok(best <= 50, `warm run ${best.toFixed(1)} ms`);
});

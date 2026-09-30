import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GeometryError,
  interiorPoint,
  orientation,
  planarFaces,
  pointInPolygon,
  polygonArea,
} from '../../src/jigs/official/geometry-kit/index.ts';

// PLAN-23 T-053 planar faces. Synthetic plans only.
const close = (actual, expected, eps = 1e-9, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} ≠ ${expected}`);
const seg = (a, b, tag) => ({ a, b, tag });
const ringSegs = (points, tag) =>
  points.map((p, i) => seg(p, points[(i + 1) % points.length], tag));
const areas = (faces) => faces.map((f) => Math.round(f.area * 1e6) / 1e6).sort((a, b) => a - b);

test('a square cut by a cross gives four CCW faces and no outer face', () => {
  const { faces } = planarFaces([
    ...ringSegs(
      [
        [0, 0],
        [8, 0],
        [8, 6],
        [0, 6],
      ],
      'edge',
    ),
    seg([4, 0], [4, 6], 'g-v'),
    seg([0, 3], [8, 3], 'g-h'),
  ]);
  assert.equal(faces.length, 4);
  assert.deepEqual(areas(faces), [12, 12, 12, 12]);
  for (const f of faces) {
    assert.equal(orientation(f.outer), 'ccw');
    assert.deepEqual(f.tags, ['edge', 'g-h', 'g-v']);
    assert.equal(f.outerTags.length, f.outer.length);
  }
});

test('T-junctions split the through line; endpoints within tol merge', () => {
  const { faces, vertices } = planarFaces(
    [
      seg([0, 0], [16, 0], 'A'),
      seg([0, 6], [16, 6], 'B'),
      seg([0, 0], [0, 6.0004], 'C'),
      seg([8, 0.0003], [8, 6], 'D'),
      seg([16, 0], [16, 6], 'E'),
    ],
    { tol: 0.001 },
  );
  assert.deepEqual(areas(faces), [48, 48]);
  assert.equal(vertices.length, 6);
  const right = faces.find((f) => f.outer.some((p) => p[0] > 12));
  assert.deepEqual(right.tags, ['A', 'B', 'D', 'E']);
});

test('concave L face, dangling edges pruned, overlapping segments merged', () => {
  const L = [
    [0, 0],
    [6, 0],
    [6, 3],
    [3, 3],
    [3, 6],
    [0, 6],
  ];
  const { faces, pruned } = planarFaces([
    ...ringSegs(L, 'L'),
    seg([6, 3], [9, 3], 'stub'),
    seg([0, 0], [3, 0], 'dup'),
  ]);
  assert.equal(faces.length, 1);
  close(faces[0].area, 27);
  assert.equal(pruned, 1);
  assert.ok(faces[0].tags.includes('dup'));
  const p = interiorPoint(faces[0].outer);
  assert.ok(pointInPolygon(p, faces[0].outer, 0));
});

test('an island inside a face becomes its hole; the island is also a face', () => {
  const { faces } = planarFaces([
    ...ringSegs(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      'out',
    ),
    ...ringSegs(
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
      ],
      'void',
    ),
  ]);
  assert.equal(faces.length, 2);
  const big = faces.find((f) => f.tags.includes('out'));
  assert.equal(big.holes.length, 1);
  assert.equal(orientation(big.holes[0]), 'cw');
  close(big.area, 96);
  close(polygonArea(big.outer), 100);
  const p = interiorPoint(big.outer, big.holes);
  assert.ok(!pointInPolygon(p, big.holes[0], 0));
  const small = faces.find((f) => !f.tags.includes('out'));
  close(small.area, 4);
});

test('crossing diagonals make triangles; bad input throws', () => {
  const { faces } = planarFaces([
    ...ringSegs([
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ]),
    seg([0, 0], [4, 4]),
    seg([4, 0], [0, 4]),
  ]);
  assert.deepEqual(areas(faces), [4, 4, 4, 4]);
  assert.equal(planarFaces([seg([0, 0], [1, 0])]).faces.length, 0);
  assert.throws(
    () => planarFaces([seg([0, NaN], [1, 0])]),
    (e) => e instanceof GeometryError && e.code === 'no-nan',
  );
});

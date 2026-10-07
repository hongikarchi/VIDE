// 도면 관계 graph (SPEC-01.11 11, PLAN-43 T-200): synthetic reads of a parent with xrefs — an
// absolute path, a relative one, another PC's path found in the same folder, a missing one, a
// duplicate — and a cycle; the roots; the placement of each shown drawing in the root's metres.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildXrefGraph,
  multiply,
  pathKey,
  placementsOf,
  resolveXref,
} from '../../src/core/xref-graph.ts';
import { insertTransform } from '../fixtures/xref.mjs';

const F = 'C:\\프로젝트\\도면';
const at = (name) => `${F}\\${name}`;
const read = (xrefs = [], inserts = [], scale = 0.001) => ({
  units: 4,
  scale,
  unitsAssumed: false,
  error: null,
  xrefs,
  inserts,
});
const xref = (name, path, overlay = false) => ({ name, path, overlay, status: 'Unresolved' });
const insert = (name, position, rotation = 0, scale = 1, space = 'model') => ({
  name,
  handle: 'H' + name,
  space,
  layout: null,
  block: null,
  nested: false,
  position,
  rotation,
  scale: [scale, scale, scale],
  transform: insertTransform(position, rotation, scale),
});
const apply = (m, [x, y, z]) =>
  [0, 1, 2].map((r) => m[r * 4] * x + m[r * 4 + 1] * y + m[r * 4 + 2] * z + m[r * 4 + 3]);
const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${a} ≈ ${b}`));

function sample() {
  const reads = new Map([
    [
      at('parent.dwg'),
      read(
        [
          xref('child', at('child.dwg')),
          xref('child-again', at('CHILD.dwg')),
          xref('grand', 'sub\\grand.dwg', true),
          xref('beam', 'D:\\old\\beam.dwg'),
          xref('missing', 'Z:\\gone\\missing.dwg'),
        ],
        [
          insert('child', [1000, 0, 0], Math.PI / 2, 2),
          insert('CHILD', [0, 0, 0], 0, 1, 'paper'),
          insert('grand', [0, 500, 0]),
          insert('beam', [0, 0, 3000]),
        ],
      ),
    ],
    [at('child.dwg'), read([xref('nested', 'nested.dwg', true)], [insert('nested', [0, 0, 0])])],
    [at('nested.dwg'), read()],
    [at('sub\\grand.dwg'), read()],
    [at('beam.dwg'), read()],
    [at('loop-a.dwg'), read([xref('loop-b', 'loop-b.dwg')], [insert('loop-b', [0, 0, 0])])],
    [at('loop-b.dwg'), read([xref('loop-a', 'loop-a.dwg')], [insert('loop-a', [0, 0, 0])])],
  ]);
  const present = new Set([...reads.keys()].map(pathKey));
  return buildXrefGraph(reads, (path) => present.has(pathKey(path)));
}

test('stored xref paths resolve absolute, relative, then by name in the parent folder', () => {
  const present = new Set([at('a.dwg'), at('sub\\b.dwg'), at('c.dwg')].map(pathKey));
  const exists = (path) => present.has(pathKey(path));
  assert.deepEqual(resolveXref(at('a.dwg'), at('p.dwg'), exists), {
    path: at('a.dwg'),
    how: 'absolute',
  });
  assert.deepEqual(resolveXref('sub\\b.dwg', at('p.dwg'), exists), {
    path: at('sub\\b.dwg'),
    how: 'relative',
  });
  assert.deepEqual(resolveXref('..\\도면\\a.dwg', at('p.dwg'), exists).how, 'relative');
  // Another PC's absolute path: the same file name next to the parent.
  assert.deepEqual(resolveXref('E:\\옛 PC\\c.dwg', at('p.dwg'), exists), {
    path: at('c.dwg'),
    how: 'folder',
  });
  assert.equal(resolveXref('Z:\\없음\\d.dwg', at('p.dwg'), exists), null);
  assert.equal(resolveXref('  ', at('p.dwg'), exists), null);
});

test('the graph marks missing, duplicate and cycle references and finds the roots', () => {
  const graph = sample();
  const of = (name) => graph.edges.find((edge) => edge.name === name);
  assert.equal(of('child').child, at('child.dwg'));
  assert.equal(of('child').how, 'absolute');
  // Another case of the same path is the same drawing: a duplicate reference.
  assert.equal(of('child-again').child, at('child.dwg'));
  assert.equal(of('child-again').duplicate, true);
  assert.equal(of('child').duplicate, false);
  assert.equal(of('grand').how, 'relative');
  assert.equal(of('beam').how, 'folder');
  assert.equal(of('missing').missing, true);
  assert.equal(of('missing').child, null);
  assert.equal(
    graph.edges.filter((edge) => edge.cycle).length,
    1,
    'one edge of the loop closes it',
  );
  // Inserts belong to their block name (case does not matter).
  assert.equal(of('child-again').inserts.length, 0);
  assert.deepEqual(
    of('child').inserts.map((item) => item.space),
    ['model', 'paper'],
  );
  // Roots: the parent, and the loop (no other drawing reaches it).
  assert.deepEqual(graph.roots, [at('loop-a.dwg'), at('parent.dwg')]);
  assert.equal(
    graph.nodes.find((node) => node.name === 'missing.dwg'),
    undefined,
  );
});

test('placements compose the insert transforms in the root metres, each drawing once', () => {
  const graph = sample();
  const shown = placementsOf(graph, at('parent.dwg'));
  assert.deepEqual(
    shown.map((item) => [item.name, item.depth]),
    [
      ['parent.dwg', 0],
      ['child.dwg', 1],
      ['grand.dwg', 1],
      ['beam.dwg', 1],
    ],
    // child's own xref is an overlay: not shown through child (as in CAD).
  );
  assert.equal(shown[0].matrix, null);
  // child: rotated 90°, scale 2, at (1000, 0) mm → its (0.5 m, 0) lands at (1 m, 1 m).
  near(apply(shown[1].matrix, [0.5, 0, 0]), [1, 1, 0]);
  // grand: an overlay the root itself refers to is shown.
  near(apply(shown[2].matrix, [0, 0, 0]), [0, 0.5, 0]);
  // beam: its 2 m stay 2 m, placed 3 m up.
  near(apply(shown[3].matrix, [2, 0, 0]), [2, 0, 3]);
  // A cycle stops at the drawing already on the way.
  assert.deepEqual(
    placementsOf(graph, at('loop-a.dwg')).map((item) => item.name),
    ['loop-a.dwg', 'loop-b.dwg'],
  );
  assert.deepEqual(placementsOf(graph, at('nowhere.dwg')), []);
});

test('nested references compose the parent placement', () => {
  const reads = new Map([
    [at('a.dwg'), read([xref('b', 'b.dwg')], [insert('b', [1000, 0, 0])])],
    [at('b.dwg'), read([xref('c', 'c.dwg')], [insert('c', [0, 2000, 0], Math.PI)])],
    [at('c.dwg'), read()],
  ]);
  const present = new Set([...reads.keys()].map(pathKey));
  const graph = buildXrefGraph(reads, (path) => present.has(pathKey(path)));
  const [, b, c] = placementsOf(graph, at('a.dwg'));
  near(apply(b.matrix, [0, 0, 0]), [1, 0, 0]);
  near(apply(c.matrix, [1, 0, 0]), [0, 2, 0]);
  near(multiply([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], b.matrix), b.matrix);
});

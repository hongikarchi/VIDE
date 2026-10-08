import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLayerTree,
  flattenTree,
  layerOptions,
  orderLayerPaths,
  subtreeItems,
} from '../../src/core/layer-tree.ts';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const layer = (n, fullPath, parent, extra = {}) => ({
  id: id(n),
  parentId: parent === undefined ? null : id(parent),
  fullPath,
  visible: true,
  locked: false,
  color: '#000000',
  order: n,
  objectCount: 0,
  ...extra,
});
const items = (...paths) => paths.map((path, i) => ({ id: 'o' + i, path }));
const pathOf = (item) => item.path;
const shape = (nodes) =>
  nodes.map((node) => (node.children.length ? [node.name, shape(node.children)] : node.name));

test('nests by the table in Rhino panel order, with subtree totals', () => {
  const table = [
    layer(5, 'B', undefined),
    layer(1, 'A', undefined),
    layer(3, 'A::Z', 1),
    layer(2, 'A::Y', 1),
    layer(4, 'A::Y::Deep', 2),
  ];
  const tree = buildLayerTree(table, items('A::Y::Deep', 'A::Y::Deep', 'A::Z', 'B', 'A'), pathOf);
  assert.equal(tree.source, 'table');
  // Rhino order (SortIndex), not alphabetical: Y (2) before Z (3); A (1) before B (5).
  assert.deepEqual(shape(tree.roots), [['A', [['Y', ['Deep']], 'Z']], 'B']);
  const a = tree.roots[0];
  assert.equal(a.total, 4);
  assert.equal(a.own.length, 1);
  assert.equal(a.children[0].children[0].depth, 2);
  assert.deepEqual(
    subtreeItems(a).map((item) => item.path),
    ['A', 'A::Y::Deep', 'A::Y::Deep', 'A::Z'],
  );
  assert.equal(tree.count, 5);
});

test('a parent with no objects of its own stays; empty leaves go unless the host counted objects', () => {
  const table = [
    layer(1, 'P', undefined),
    layer(2, 'P::C', 1),
    layer(3, 'Empty', undefined),
    layer(4, 'Off', undefined, { visible: false, objectCount: 7 }),
  ];
  const tree = buildLayerTree(table, items('P::C'), pathOf);
  assert.deepEqual(shape(tree.roots), [['P', ['C']], 'Off']);
  const off = tree.roots[1];
  assert.equal(off.hidden, true);
  assert.equal(off.total, 0);
  assert.equal(off.hostTotal, 7);
});

test('a sublayer under a parent that is off counts as hidden (Rhino semantics)', () => {
  const table = [
    layer(1, 'P', undefined, { visible: false }),
    layer(2, 'P::C', 1),
    layer(3, 'P::C::G', 2, { objectCount: 2 }),
  ];
  const tree = buildLayerTree(table, [], pathOf);
  const [p] = tree.roots;
  assert.equal(p.hidden, true);
  assert.equal(p.children[0].visible, true);
  assert.equal(p.children[0].hidden, true);
  assert.equal(p.children[0].children[0].hidden, true);
  assert.equal(p.hostTotal, 2);
});

test('duplicate leaf names under different parents stay apart', () => {
  const table = [
    layer(1, 'A', undefined),
    layer(2, 'A::Walls', 1),
    layer(3, 'B', undefined),
    layer(4, 'B::Walls', 3),
  ];
  const tree = buildLayerTree(table, items('A::Walls', 'B::Walls', 'B::Walls'), pathOf);
  assert.deepEqual(shape(tree.roots), [
    ['A', ['Walls']],
    ['B', ['Walls']],
  ]);
  assert.equal(tree.roots[0].children[0].total, 1);
  assert.equal(tree.roots[1].children[0].total, 2);
});

test('a missing parent id becomes a root, or nests by its path when that layer exists', () => {
  const table = [
    layer(1, 'A', undefined),
    { ...layer(2, 'A::B', 99) }, // parent id unknown, path parent known
    { ...layer(3, 'Lost::C', 98) }, // parent unknown by id and by path
  ];
  const tree = buildLayerTree(table, items('A::B', 'Lost::C'), pathOf);
  assert.deepEqual(shape(tree.roots), [['A', ['B']], 'C']);
});

test('a parent cycle is broken instead of looping', () => {
  const table = [layer(1, 'X', 2), layer(2, 'Y', 3), layer(3, 'Z', 1), layer(4, 'Self', 4)];
  const tree = buildLayerTree(table, items('X', 'Y', 'Z', 'Self'), pathOf);
  const all = flattenTree(tree.roots);
  assert.equal(all.length, 4);
  assert.equal(
    all.reduce((sum, node) => sum + node.own.length, 0),
    4,
  );
  assert.ok(tree.roots.length >= 1);
});

test('without a table, full paths nest by "::" (older Syncs); missing parents are inferred', () => {
  const tree = buildLayerTree(undefined, items('A::B::C::D', 'A::B', 'Z'), pathOf);
  assert.equal(tree.source, 'paths');
  assert.deepEqual(shape(tree.roots), [['A', [['B', [['C', ['D']]]]]], 'Z']);
  assert.equal(tree.roots[0].total, 2);
  assert.equal(tree.roots[0].own.length, 0);
});

test('rows on layers the table does not know join the tree by their path', () => {
  const table = [layer(1, 'A', undefined)];
  const tree = buildLayerTree(table, items('A::New::Leaf'), pathOf);
  assert.deepEqual(shape(tree.roots), [['A', [['New', ['Leaf']]]]]);
});

test('deep nesting (200 levels) builds and counts', () => {
  const table = [];
  let path = '';
  for (let i = 1; i <= 200; i++) {
    path = path ? `${path}::L${i}` : `L${i}`;
    table.push(layer(i, path, i === 1 ? undefined : i - 1));
  }
  const tree = buildLayerTree(table, items(path), pathOf);
  const all = flattenTree(tree.roots);
  assert.equal(all.length, 200);
  assert.equal(all.at(-1).depth, 199);
  assert.equal(tree.roots[0].total, 1);
});

test('a flat (DWG) list never nests and keeps the whole name', () => {
  const tree = buildLayerTree(undefined, items('A-WALL', 'S-BEAM'), pathOf, { flat: true });
  assert.equal(tree.source, 'flat');
  assert.deepEqual(shape(tree.roots), ['A-WALL', 'S-BEAM']);
});

test('picker options indent sublayers and add their parents as non-pickable rows', () => {
  const options = layerOptions(['A::B::C', 'D', 'A::X']);
  assert.deepEqual(
    options.map((option) => [option.label, option.present]),
    [
      ['A', false],
      ['　B', false],
      ['　　C', true],
      ['　X', true],
      ['D', true],
    ],
  );
  // DWG names: as given.
  assert.deepEqual(
    layerOptions(['S-BEAM', 'A-WALL']).map((option) => option.label),
    ['S-BEAM', 'A-WALL'],
  );
  // With a table: Rhino order.
  const table = [layer(2, 'A', undefined), layer(1, 'B', undefined), layer(3, 'B::C', 1)];
  assert.deepEqual(orderLayerPaths(['A', 'B::C', 'B'], table), ['B', 'B::C', 'A']);
});

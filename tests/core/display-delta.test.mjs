import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDisplayDelta, displayCoverage } from '../../src/core/display-delta.ts';

const mesh = (nativeId, hash) => ({
  id: nativeId,
  nativeId,
  nativeType: 'Brep',
  geometryHash: hash,
  vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: [0, 1, 2],
  line: [],
  valid: true,
});
const object = (nativeId) => ({ id: nativeId, nativeId, kind: 'native', name: nativeId });

test('live delta replaces, removes and appends by native ID and keeps untouched items', () => {
  const kept = mesh('a', 'h1');
  const model = {
    objects: [object('a'), object('b'), object('c')],
    scene: [kept, mesh('b', 'h2'), mesh('c', 'h3')],
  };
  const merged = applyDisplayDelta(model, {
    objects: [object('b'), object('d')],
    scene: [mesh('b', 'h2-moved'), mesh('d', 'h4')],
    removed: ['c'],
  });
  assert.deepEqual(
    merged.scene.map((item) => [item.nativeId, item.geometryHash]),
    [
      ['a', 'h1'],
      ['b', 'h2-moved'],
      ['d', 'h4'],
    ],
  );
  assert.deepEqual(
    merged.objects.map((item) => item.nativeId),
    ['a', 'b', 'd'],
  );
  // Untouched items keep identity (no copy) so the viewport and memory can reuse them.
  assert.equal(merged.scene[0], kept);
  // The input model is not mutated.
  assert.equal(model.scene.length, 3);
});

test('an empty delta leaves the model as it was', () => {
  const model = { objects: [object('a')], scene: [mesh('a', 'h1')] };
  const merged = applyDisplayDelta(model, { objects: [], scene: [], removed: [] });
  assert.deepEqual(merged, model);
});

test('display coverage counts omitted items per native type, invalid ones separately', () => {
  const scene = [
    mesh('a', 'h1'),
    {
      id: 'b',
      nativeId: 'b',
      nativeType: 'InstanceReference',
      vertices: [],
      indices: [],
      line: [],
      valid: true,
    },
    {
      id: 'c',
      nativeId: 'c',
      nativeType: 'Brep',
      vertices: [],
      indices: [],
      line: [],
      valid: false,
    },
  ];
  assert.deepEqual(displayCoverage(scene), {
    total: 3,
    displayed: 1,
    omitted: 2,
    omittedTypes: { InstanceReference: 1, 'Brep (invalid)': 1 },
  });
});

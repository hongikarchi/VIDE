import test from 'node:test';
import assert from 'node:assert/strict';
import { composeLayers, displayIdOf, sourceIdOf, layerSignature } from '../../src/ui/layers.ts';

const file = (key, requestId, ids) => ({
  key,
  name: key + '.dwg',
  requestId,
  objects: ids.map((id) => ({ id, name: 'L' + id })),
  scene: ids.map((id) => ({ id, segments: [0, 0, 0, 1, 0, 0] })),
  definitions: { ['h-' + key]: { hash: 'h-' + key } },
});

test('one file keeps its own ids', () => {
  const shown = composeLayers([file('a', 'sync-a', ['cad-1', 'cad-2'])]);
  assert.equal(shown.many, false);
  assert.deepEqual(
    shown.objects.map((o) => o.id),
    ['cad-1', 'cad-2'],
  );
  assert.equal(shown.objects[0].revision, 'sync-a');
  assert.equal(sourceIdOf(shown.objects[0]), 'cad-1');
});

test('files with equal ids stay apart and keep their basis', () => {
  const shown = composeLayers([
    file('a', 'sync-a', ['cad-1', 'cad-2']),
    file('b', 'sync-b', ['cad-1']),
  ]);
  assert.equal(shown.many, true);
  assert.deepEqual(
    shown.objects.map((o) => o.id),
    ['a::cad-1', 'a::cad-2', 'b::cad-1'],
  );
  assert.deepEqual(
    shown.scene.map((s) => s.id),
    ['a::cad-1', 'a::cad-2', 'b::cad-1'],
  );
  assert.equal(shown.objects[2].documentName, 'b.dwg');
  assert.equal(displayIdOf(shown.objects, 'sync-b', 'cad-1'), 'b::cad-1');
  assert.equal(displayIdOf(shown.objects, 'sync-a', 'cad-1'), 'a::cad-1');
  assert.equal(displayIdOf(shown.objects, 'sync-b', 'cad-2'), undefined);
  assert.deepEqual(Object.keys(shown.definitions).sort(), ['h-a', 'h-b']);
  assert.equal(
    layerSignature([
      { key: 'a', requestId: 'sync-a' },
      { key: 'b', requestId: 'sync-b' },
    ]),
    'a=sync-a|b=sync-b',
  );
});

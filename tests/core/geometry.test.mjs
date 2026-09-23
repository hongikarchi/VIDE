import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpret, protectGeometry } from '../../src/core/geometry.ts';
const box = { kind: 'box', id: 'a', name: 'A', origin: [0, 0, 0], size: [10, 8, 6] };
const apply = (operations, objects = [], permission = 'candidate') =>
  interpret(JSON.stringify({ message: '안', operations }), objects, permission);
test('bounded geometry edits preserve base snapshots and unrelated dimensions', () => {
  const initial = apply([box]).objects;
  const next = apply(
    [
      { kind: 'height', id: 'a', height: 4.5 },
      { kind: 'move', id: 'a', delta: [2, 0, 0] },
    ],
    initial,
  );
  assert.deepEqual(next.objects[0].size, [10, 8, 4.5]);
  assert.deepEqual(next.objects[0].origin, [2, 0, 0]);
  assert.equal(initial[0].size[2], 6);
});
test('read-only permissions, arbitrary code, invalid geometry and missing targets are rejected', () => {
  assert.throws(() => apply([box], [], 'review'), { code: 'WRITE_NOT_ALLOWED' });
  for (const operation of [
    { kind: 'code', id: 'a', code: 'evil' },
    { ...box, size: [10, 8, -1] },
    { ...box, id: 'a";' },
    { kind: 'height', id: 'missing', height: 4 },
  ])
    assert.throws(() => apply([operation]), { code: 'INVALID_GEOMETRY' });
});
test('extrusions require closed planar boundaries and explicit positive height', () => {
  const e = {
    kind: 'extrude',
    id: 'a',
    name: 'A',
    points: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 8, 0],
      [0, 0, 0],
    ],
    height: 6,
  };
  assert.equal(apply([e]).objects[0].height, 6);
  assert.throws(() => apply([{ ...e, points: e.points.slice(0, 3) }]), {
    code: 'INVALID_GEOMETRY',
  });
  assert.throws(
    () =>
      apply([
        {
          ...e,
          points: [
            [0, 0, 0],
            [10, 0, 1],
            [10, 8, 0],
            [0, 0, 0],
          ],
        },
      ]),
    { code: 'INVALID_GEOMETRY' },
  );
});
test('imported native shapes retain identity and cannot be silently rebuilt as boxes', () => {
  const source = {
    id: 'native-a',
    kind: 'native',
    nativeId: 'preserved-guid',
    name: 'Imported',
    origin: [0, 0, 0],
  };
  const moved = apply([{ kind: 'move', id: 'native-a', delta: [2, 0, 0] }], [source]);
  assert.equal(moved.objects[0].nativeId, 'preserved-guid');
  assert.deepEqual(moved.objects[0].origin, [2, 0, 0]);
  assert.throws(() => apply([{ kind: 'height', id: 'native-a', height: 5 }], [source]), {
    code: 'INVALID_GEOMETRY',
  });
});

test('preserved geometry refuses movement, removal and renamed replacements before host execution', () => {
  const original = [box],
    unchanged = structuredClone(original);
  assert.doesNotThrow(() => protectGeometry(original, unchanged, ['a']));
  for (const operations of [
    [{ kind: 'move', id: 'a', delta: [1, 0, 0] }],
    [{ kind: 'remove', id: 'a' }],
    [{ kind: 'height', id: 'a', height: 9 }],
  ]) {
    const result = apply(operations, original);
    assert.throws(() => protectGeometry(original, result.objects, ['a']), {
      code: 'PROTECTED_OBJECT_CHANGED',
    });
  }
  assert.doesNotThrow(() => protectGeometry(original, [box, { ...box, id: 'b' }], ['a']));
});

test('vertex edits preserve extrusion height and copying translates independent geometry', () => {
  const outline = {
    kind: 'extrude',
    id: 'outline',
    name: 'Mass',
    points: [
      [0, 0, 0],
      [4, 0, 0],
      [4, 3, 0],
      [0, 0, 0],
    ],
    height: 6,
  };
  const points = [
    [0, 0, 0],
    [5, 0, 0],
    [5, 3, 0],
    [0, 0, 0],
  ];
  const result = apply(
    [
      { kind: 'vertices', id: 'outline', points },
      { kind: 'copy', id: 'copy', sourceId: 'outline', name: 'Second', delta: [10, 0, 0] },
    ],
    [outline],
  );
  assert.equal(result.objects[0].height, 6);
  assert.deepEqual(result.objects[0].points, points);
  assert.deepEqual(result.objects[1].points[0], [10, 0, 0]);
  assert.equal(outline.points[1][0], 4);
  assert.throws(
    () => apply([{ kind: 'vertices', id: 'outline', points: points.slice(0, 3) }], [outline]),
    { code: 'INVALID_GEOMETRY' },
  );
  assert.throws(
    () =>
      apply(
        [{ kind: 'copy', id: 'copy', sourceId: 'outline', name: 'Second', delta: [100000, 0, 0] }],
        [outline],
      ),
    { code: 'INVALID_GEOMETRY' },
  );
  assert.throws(
    () =>
      apply(
        [{ kind: 'copy', id: 'copy', sourceId: 'native', name: 'N', delta: [1, 0, 0] }],
        [{ id: 'native', kind: 'native', origin: [0, 0, 0] }],
      ),
    { code: 'INVALID_GEOMETRY' },
  );
});

test('native copies retain source provenance through move-copy-copy-remove without reconstructing geometry', () => {
  const source = {
    id: 'native',
    nativeId: 'guid',
    kind: 'native',
    name: 'Original',
    origin: [0, 0, 0],
  };
  const result = apply(
    [
      { kind: 'move', id: 'native', delta: [2, 0, 0] },
      { kind: 'copy', id: 'a', sourceId: 'native', name: 'A', delta: [10, 0, 0] },
      { kind: 'copy', id: 'b', sourceId: 'a', name: 'B', delta: [5, 0, 0] },
      { kind: 'remove', id: 'native' },
    ],
    [source],
  );
  assert.deepEqual(
    result.objects.map((object) => object.origin),
    [
      [12, 0, 0],
      [17, 0, 0],
    ],
  );
  assert.ok(
    result.objects.every(
      (object) => object.kind === 'native' && object.nativeSourceId === 'native',
    ),
  );
  assert.deepEqual(source.origin, [0, 0, 0]);
  const follow = apply(
    [{ kind: 'copy', id: 'c', sourceId: 'b', name: 'C', delta: [3, 0, 0] }],
    result.objects,
  );
  assert.equal(follow.objects[2].nativeSourceId, 'b');
});

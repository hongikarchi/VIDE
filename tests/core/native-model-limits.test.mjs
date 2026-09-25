import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nativeModelSchema } from '../../src/contracts/native-model.ts';

test('native model admits 10000 matched identities and rejects oversized or incomplete models', () => {
  const objects = Array.from({ length: 10000 }, (_, i) => ({
    id: String(i),
    nativeId: randomUUID(),
    kind: 'native',
    name: 'Point',
    origin: [i, 0, 0],
  }));
  const scene = objects.map(({ id, nativeId, origin }) => ({
    id,
    nativeId,
    origin,
    nativeType: 'Point',
    name64: 'UG9pbnQ=',
    boundsSize: [0, 0, 0],
    vertices: [],
    indices: [],
    line: [],
    area: null,
    volume: null,
    length: null,
    layer64: '',
    attributes64: [],
    attributesComplete: true,
    valid: true,
  }));
  assert.equal(nativeModelSchema.safeParse({ objects, scene }).success, true);
  assert.equal(nativeModelSchema.safeParse({ objects, scene: scene.slice(1) }).success, false);
  const extra = { ...objects[0], id: 'extra', nativeId: randomUUID() };
  assert.equal(
    nativeModelSchema.safeParse({
      objects: [...objects, extra],
      scene: [...scene, { ...scene[0], id: extra.id, nativeId: extra.nativeId }],
    }).success,
    false,
  );
});

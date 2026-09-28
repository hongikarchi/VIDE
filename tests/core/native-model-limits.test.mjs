import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nativeModelSchema } from '../../src/contracts/native-model.ts';

test('native model admits 20000 matched identities and rejects oversized or incomplete models', () => {
  const objects = Array.from({ length: 20000 }, (_, i) => ({
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

test('native model keeps optional Rhino display colours and rejects malformed ones', () => {
  const nativeId = randomUUID();
  const model = (colors) => ({
    objects: [{ id: 'a', nativeId, kind: 'native', name: 'Wall', origin: [0, 0, 0] }],
    scene: [
      {
        id: 'a',
        nativeId,
        origin: [0, 0, 0],
        nativeType: 'Brep',
        name64: 'V2FsbA==',
        boundsSize: [1, 1, 1],
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
        ...colors,
      },
    ],
  });
  const parsed = nativeModelSchema.parse(
    model({ displayColor: '#aa3322', layerColor: '#22aa33', materialColor: null }),
  );
  assert.equal(parsed.scene[0].displayColor, '#aa3322');
  assert.equal(parsed.scene[0].layerColor, '#22aa33');
  assert.equal(nativeModelSchema.safeParse(model({})).success, true);
  assert.equal(nativeModelSchema.safeParse(model({ displayColor: 'red' })).success, false);
});

test('block instances must reference a definition carried by the same display model', async () => {
  const { displayModelSchema } = await import('../../src/contracts/native-model.ts');
  const nativeId = '11111111-1111-4111-8111-111111111111',
    definition = '22222222-2222-4222-8222-222222222222';
  const model = (definitions) => ({
    objects: [{ id: nativeId, nativeId, kind: 'native', name: 'Rail', origin: [0, 0, 0] }],
    scene: [
      {
        id: nativeId,
        nativeId,
        nativeType: 'InstanceReference',
        name64: '',
        origin: [0, 0, 0],
        boundsSize: [1, 1, 1],
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
        block: { definition, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      },
    ],
    ...(definitions ? { definitions } : {}),
  });
  const rail = {
    hash: 'a'.repeat(64),
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    segments: [0, 0, 0, 1, 1, 1],
    texts: [{ s: '난간', p: [0, 0, 0], h: 0.3, r: 0, ax: 1, ay: 1 }],
  };
  assert.equal(displayModelSchema.safeParse(model({ [definition]: rail })).success, true);
  assert.equal(displayModelSchema.safeParse(model()).success, false);
  assert.equal(
    displayModelSchema.safeParse(model({ [definition]: { ...rail, indices: [0, 1, 9] } })).success,
    false,
  );
});

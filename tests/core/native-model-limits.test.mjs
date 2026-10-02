import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nativeModelSchema } from '../../src/contracts/native-model.ts';

test('native model admits 30000 matched identities (no count cap) and rejects incomplete models', () => {
  const objects = Array.from({ length: 30000 }, (_, i) => ({
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
  // A row whose identity does not match its object is still refused.
  assert.equal(
    nativeModelSchema.safeParse({
      objects,
      scene: [{ ...scene[0], nativeId: randomUUID() }, ...scene.slice(1)],
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

test('display coverage carries what the host left out and the layer table (T-043)', async () => {
  const { displayModelSchema, sourceCoverageSchema, readScopeSchema } =
    await import('../../src/contracts/native-model.ts');
  const nativeId = randomUUID();
  const layer = {
    id: randomUUID(),
    parentId: null,
    fullPath: '기둥',
    visible: true,
    locked: false,
    color: '#000000',
    order: 0,
    objectCount: 1,
  };
  const model = (coverage) => ({
    objects: [{ id: 'a', nativeId, kind: 'native', name: 'Column', origin: [0, 0, 0] }],
    scene: [
      {
        id: 'a',
        nativeId,
        origin: [0, 0, 0],
        nativeType: 'Curve',
        name64: '',
        boundsSize: [0, 0, 3],
        vertices: [],
        indices: [],
        line: [0, 0, 0, 0, 0, 3],
        area: null,
        volume: null,
        length: null,
        layer64: '',
        attributes64: [],
        attributesComplete: true,
        valid: true,
      },
    ],
    layers: [layer, { ...layer, id: randomUUID(), fullPath: '기존::기초', visible: false }],
    displayCoverage: { total: 1, displayed: 1, omitted: 0, omittedTypes: {}, ...coverage },
  });
  const parsed = displayModelSchema.parse(
    model({
      omittedHidden: 96,
      omittedFiltered: 0,
      omittedBlockInternal: 14,
      hiddenLayers: [{ path: '기존::기초', count: 96 }],
    }),
  );
  assert.equal(parsed.layers.length, 2);
  assert.equal(parsed.displayCoverage.omittedBlockInternal, 14);
  // Older captures carry only the row counts.
  assert.equal(displayModelSchema.safeParse(model({})).success, true);
  // A hidden layer cannot keep out more objects than the read counts as hidden.
  assert.equal(
    displayModelSchema.safeParse(
      model({ omittedHidden: 1, hiddenLayers: [{ path: '기존::기초', count: 2 }] }),
    ).success,
    false,
  );
  assert.equal(
    sourceCoverageSchema.safeParse({
      total: 3,
      displayed: 1,
      omittedHidden: 1,
      omittedFiltered: 1,
      omittedBlockInternal: 0,
      hiddenLayers: [],
    }).success,
    true,
  );
  assert.equal(readScopeSchema.safeParse({ layers: ['기둥'], includeHidden: true }).success, true);
  assert.equal(readScopeSchema.safeParse({ layers: [''] }).success, false);
  assert.equal(readScopeSchema.safeParse({ layer: '기둥' }).success, false);
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

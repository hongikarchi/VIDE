import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeGeometry,
  decodeItem,
  encodeGeometry,
  encodeItem,
  joinGeometry,
} from '../../src/contracts/geometry-transfer.ts';

test('binary geometry round-trips scene and block arrays; other fields stay as they were', () => {
  const big = Array.from({ length: 70000 * 3 }, (_, i) => i % 70000);
  const request = {
    id: 'r1',
    state: 'succeeded',
    input: { body: '보 그려줘', pins: [] },
    result: {
      host: 'rhino',
      objects: [{ id: 'a', name: '실명' }],
      scene: [
        {
          id: 'a',
          // Survey coordinates: 0.1 mm detail at 200 km.
          vertices: [
            200000.1234, 500000.5678, 12.3456, 200010.1235, 500000.5679, 12.3457, 200000, 500020, 0,
          ],
          indices: [0, 1, 2],
          segments: [200000, 500000, 0, 200000.0001, 500000, 0],
          layer64: 'QQ==',
          attributes64: [['a', 'b']],
          texts: [{ s: 'X1', p: [1, 2, 3], h: 1, r: 0 }],
        },
        {
          id: 'big',
          vertices: Array.from({ length: 70000 * 3 }, (_, i) => i * 0.001),
          indices: big,
        },
        { id: 'empty', vertices: [], indices: [], line: [] },
      ],
      definitions: {
        d: { hash: 'h', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], segments: [] },
      },
    },
  };
  const bytes = encodeGeometry(request);
  assert.ok(bytes.byteLength < JSON.stringify(request).length * 0.75);
  const back = decodeGeometry(bytes);
  const a = back.result.scene[0];
  a.vertices.forEach((v, i) => assert.ok(Math.abs(v - request.result.scene[0].vertices[i]) < 1e-5));
  assert.ok(Math.abs(a.segments[3] - 200000.0001) < 1e-6);
  assert.deepEqual(a.indices, [0, 1, 2]);
  assert.deepEqual(a.texts, request.result.scene[0].texts);
  assert.deepEqual(a.attributes64, [['a', 'b']]);
  assert.deepEqual(back.result.scene[1].indices, big);
  assert.deepEqual(back.result.scene[2], request.result.scene[2]);
  assert.deepEqual(back.result.definitions.d.indices, [0, 1, 2]);
  assert.deepEqual(back.input, request.input);
  assert.ok(Array.isArray(a.vertices));
  // A request without a scene is plain JSON inside the container.
  assert.deepEqual(decodeGeometry(encodeGeometry({ id: 'x', result: null })), {
    id: 'x',
    result: null,
  });
  assert.throws(() => decodeGeometry(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /GEOMETRY_FORMAT/);
});

// PLAN-27 1단계: per-object storage parts.
const request = () => ({
  id: 'r2',
  state: 'succeeded',
  result: {
    host: 'rhino',
    objects: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    scene: [
      {
        id: 'a',
        nativeType: 'Brep',
        vertices: [
          200000.1234, 500000.5678, 12.3456, 200003.5, 500001.25, 15.75, 200000, 500005, 0,
        ],
        indices: [0, 1, 2],
        line: [1, 2, 3, 4, 5, 6],
        texts: [],
      },
      { id: 'b', nativeType: 'Point', valid: false },
      {
        id: 'c',
        segments: [0, 0, 0, 1, 1, 1],
        vertices: [],
        indices: Array.from({ length: 70000 }, (_, i) => i),
      },
    ],
    definitions: {
      d: { hash: 'h', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], segments: [] },
      e: { hash: 'h2', vertices: [], segments: [], texts: [] },
    },
    layers: [{ name: 'L' }],
  },
});

test('an item round-trips through meta and geometry, keeping key order and other fields', () => {
  const item = request().result.scene[0];
  const { meta, geometry } = encodeItem(item);
  assert.deepEqual(Object.keys(meta), Object.keys(item));
  assert.equal(meta.vertices, '$bin');
  assert.equal(meta.nativeType, 'Brep');
  assert.ok(geometry instanceof Uint8Array);
  const back = decodeItem(meta, geometry);
  assert.deepEqual(Object.keys(back), Object.keys(item));
  assert.deepEqual(back.indices, [0, 1, 2]);
  assert.deepEqual(back.texts, []);
  // An item without arrays to move stays as it is, without a container.
  const plain = { id: 'b', nativeType: 'Point', valid: false };
  assert.deepEqual(encodeItem(plain), { meta: plain, geometry: null });
  assert.equal(decodeItem(plain, null), plain);
  // Encoding is deterministic: the same item gives the same bytes.
  assert.deepEqual(encodeItem(item).geometry, geometry);
});

test('stored coordinates stay within 0.001 mm for objects up to 10 m at survey coordinates', () => {
  let worst = 0;
  for (let n = 0; n < 200; n++) {
    const base = [200000 + n * 37.1, 500000 - n * 11.3, n * 0.7];
    const vertices = [];
    for (let i = 0; i < 300; i++)
      vertices.push(
        base[0] + Math.sin(i * 1.7 + n) * 10,
        base[1] + Math.cos(i * 0.3) * 10,
        base[2] + ((i * 7.31) % 10),
      );
    const back = decodeItem(...Object.values(encodeItem({ id: 'x', vertices })));
    vertices.forEach((v, i) => (worst = Math.max(worst, Math.abs(back.vertices[i] - v))));
  }
  // Metres: 1e-6 m = 0.001 mm.
  assert.ok(worst < 1e-6, `worst ${worst}`);
});

test('joining stored items gives the same VGT1 bytes as encoding the whole request', () => {
  const value = request();
  const whole = encodeGeometry(value);
  const scene = value.result.scene.map(encodeItem);
  const definitions = Object.entries(value.result.definitions).map(([k, v]) => [k, encodeItem(v)]);
  const joined = joinGeometry(value, { scene, definitions });
  assert.deepEqual(Buffer.from(joined), Buffer.from(whole));
  assert.deepEqual(decodeGeometry(joined), decodeGeometry(whole));
  // A delta at the top level decodes to the same items.
  const delta = joinGeometry(
    { revision: 3, objects: [], scene: [], definitions: {}, removed: ['z'] },
    { scene: scene.slice(0, 1), definitions: [] },
    'root',
  );
  const decoded = decodeGeometry(delta);
  assert.deepEqual(decoded.removed, ['z']);
  assert.deepEqual(decoded.scene[0], decodeGeometry(whole).result.scene[0]);
});

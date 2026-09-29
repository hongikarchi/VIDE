import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGeometry, encodeGeometry } from '../../src/contracts/geometry-transfer.ts';

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureMeasurements } from '../../src/core/measurement-cache.ts';

const target = { instance: '123:456', documentId: 7 };
const nativeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const geometryHash = 'a'.repeat(64);
const result = {
  host: 'rhino',
  executionMode: 'sdk',
  measurementVersion: 1,
  sourceDocument: target,
  objects: [{ id: 'box', nativeId, kind: 'native', name: 'Box', origin: [0, 0, 0] }],
  scene: [
    {
      id: 'box',
      nativeId,
      nativeType: 'Brep',
      geometryHash,
      name64: '',
      origin: [0, 0, 0],
      boundsSize: [1, 1, 1],
      vertices: [],
      indices: [],
      line: [],
      area: 6,
      volume: 1,
      length: null,
      layer64: '',
      attributes64: [],
      attributesComplete: true,
      valid: true,
    },
  ],
};
const row = { state: 'succeeded', input: { source: 'document' }, result };
test('Sync measurements are selected only from successful captures of the exact document instance', () => {
  assert.deepEqual(captureMeasurements([row], target), [
    { id: 'box', geometryHash, area: 6, volume: 1, length: null },
  ]);
  for (const changed of [
    { ...row, state: 'unknown' },
    { ...row, input: {} },
    { ...row, result: { ...result, host: 'zwcad' } },
    { ...row, result: { ...result, sourceDocument: { ...target, documentId: 8 } } },
    { ...row, result: { ...result, sourceDocument: { ...target, instance: '123:999' } } },
  ])
    assert.deepEqual(captureMeasurements([changed], target), []);
});
test('Missing geometry proof, invalid quantities or a new calculation version cannot reuse older measurements', () => {
  for (const changed of [
    { ...result, measurementVersion: 2 },
    { ...result, measurementVersion: undefined },
    { ...result, scene: [{ ...result.scene[0], geometryHash: undefined }] },
    { ...result, scene: [{ ...result.scene[0], geometryHash: 'invalid' }] },
    { ...result, scene: [{ ...result.scene[0], volume: -1 }] },
  ])
    assert.deepEqual(captureMeasurements([row, { ...row, result: changed }], target), []);
});

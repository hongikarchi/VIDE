import test from 'node:test';
import assert from 'node:assert/strict';
import { displayCoordinates } from '../../src/core/display-coordinates.ts';
test('GPU positions preserve millimetre details at survey coordinates without changing original world input', () => {
  const positions = [90000.001, 80000.001, 0, 90000.003, 80000.001, 0, 90000.003, 80000.003, 0],
    original = [...positions];
  const result = displayCoordinates(positions);
  assert.deepEqual(positions, original);
  assert.ok(Math.abs(result.local[3] - result.local[0] - 0.002) < 1e-8);
  for (let i = 0; i < positions.length; i++)
    assert.ok(Math.abs(result.local[i] + result.origin[i % 3] - positions[i]) < 1e-8);
});

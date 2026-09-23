import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareReviews } from '../../src/core/review-comparison.ts';
const snapshot = (id, hash, volume, query = {}) => ({
  id,
  payload: {
    table: {
      host: 'rhino',
      query,
      units: { volume: 'm³' },
      rows: [{ id: 'object', length: null, area: null, volume }],
    },
    model: [{ id: 'object', name: 'Object', kind: 'native', comparable: true, geometryHash: hash }],
  },
});
test('review comparison uses frozen representations and only matching table definitions', () => {
  const before = snapshot('a', 'first', 288),
    after = snapshot('b', 'second', 216);
  assert.equal(compareReviews(before, after, true).rows[0].delta.volume, -72);
  assert.equal(compareReviews(before, after, true).rows[0].status, 'changed');
  after.payload.table.query = { type: 'Brep' };
  const mismatch = compareReviews(before, after, true);
  assert.equal(mismatch.rows[0].status, 'changed');
  assert.equal(mismatch.rows[0].delta.volume, null);
  assert.equal(mismatch.tableCompatible, false);
  assert.equal(compareReviews(before, after, false).rows[0].status, 'incomparable');
});
test('same captured native document confirms identity while incomplete representations remain incomparable', () => {
  const before = snapshot('a', 'same', 1),
    after = snapshot('b', 'same', 1);
  before.payload.sourceDocument = after.payload.sourceDocument = { instance: '1:2', documentId: 3 };
  assert.equal(compareReviews(before, after).rows[0].status, 'unchanged');
  after.payload.model[0].comparable = false;
  assert.equal(compareReviews(before, after).rows[0].status, 'incomparable');
});

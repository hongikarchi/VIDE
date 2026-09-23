import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareCandidates } from '../../src/core/comparison.ts';
const object = { id: 'a', name: 'Wall', kind: 'box', origin: [0, 0, 0], size: [1, 2, 3] };
const candidate = (id, objects, scene, host = 'rhino') => ({
  id,
  createdAt: '2026-09-22T00:00:00.000Z',
  result: { hostExecuted: true, host, objects, scene },
});
test('related candidates distinguish geometry edits, additions, removals and measured deltas', () => {
  const a = candidate('first', [object, { ...object, id: 'removed' }], [{ id: 'a', volume: 6 }]);
  const b = candidate(
    'next',
    [
      { ...object, size: [1, 2, 4] },
      { ...object, id: 'added' },
    ],
    [{ id: 'a', volume: 8 }],
  );
  const comparison = compareCandidates(a, b, true);
  assert.deepEqual(
    comparison.rows.map((r) => r.status),
    ['changed', 'removed', 'added'],
  );
  assert.equal(comparison.rows[0].delta.volume, 2);
  assert.equal(comparison.rows[0].delta.area, null);
});
test('same names and IDs cannot establish cross-host or unrelated identity', () => {
  const a = candidate('first', [object], []),
    b = candidate('other', [object], []);
  assert.equal(compareCandidates(a, b, false).rows[0].status, 'incomparable');
  assert.equal(
    compareCandidates(a, { ...b, result: { ...b.result, host: 'zwcad' } }, true).compatible,
    false,
  );
  assert.equal(compareCandidates(a, a, true).rows[0].status, 'unchanged');
});

test('attribute-only and layer-only changes are visible in candidate comparison', () => {
  const first = candidate(
    'first',
    [object],
    [{ id: 'a', attributes64: [['TGV2ZWw=', 'TDAx']], layer64: 'QQ==' }],
  );
  for (const changed of [{ attributes64: [['TGV2ZWw=', 'TDAy']] }, { layer64: 'Qg==' }]) {
    const second = candidate('second', [object], [{ ...first.result.scene[0], ...changed }]);
    assert.equal(compareCandidates(first, second, true).rows[0].status, 'changed');
  }
});
test('native change evidence is used only against its exact input candidate', () => {
  const first = candidate('first', [object], [{ id: 'a', volume: 6 }]),
    second = candidate('second', [object], [{ id: 'a', volume: 6 }]);
  Object.assign(second.result, {
    executionMode: 'sdk',
    baseRequestId: 'first',
    changes: {
      added: [],
      removed: [],
      modified: [{ id: 'a', geometry: true, attributes: false, nativeIdentity: false }],
    },
  });
  assert.equal(compareCandidates(first, second, true).rows[0].status, 'changed');
  second.result.baseRequestId = 'other';
  assert.equal(compareCandidates(first, second, true).rows[0].status, 'unchanged');
  assert.equal(compareCandidates(first, second, false).rows[0].status, 'incomparable');
});

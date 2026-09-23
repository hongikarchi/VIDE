import test from 'node:test';
import assert from 'node:assert/strict';
import { hostDocumentsSchema, hostSelectionSchema } from '../../src/contracts/host-documents.ts';
test('host document boundary rejects invalid identity and incomplete geometry counts', () => {
  const document = { id: 1, name: 'Untitled', units: 'Meters', objectCount: 0, modified: false };
  assert.equal(
    hostDocumentsSchema.safeParse({ instance: '1:2', documents: [document] }).success,
    true,
  );
  for (const item of [
    { ...document, id: 0 },
    { ...document, id: 4294967296 },
    { ...document, objectCount: NaN },
    { ...document, objectCount: -1 },
    { ...document, units: undefined },
  ])
    assert.equal(
      hostDocumentsSchema.safeParse({ instance: '1:2', documents: [item] }).success,
      false,
    );
  assert.equal(
    hostDocumentsSchema.safeParse({ instance: 'unknown', documents: [] }).success,
    false,
  );
  assert.equal(
    hostSelectionSchema.safeParse({
      instance: '1:2',
      documentId: 1,
      documentHash: 'invalid',
      selectedIds: [],
      observedAt: 'now',
    }).success,
    false,
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryPage } from '../../src/server/query-page.ts';
import { AgentTools } from '../../src/server/agent-tools.ts';

test('pages exhaust a stable snapshot without duplicates and reject changed revisions', () => {
  const snapshot = {
    revision: 7,
    objects: Array.from({ length: 10000 }, (_, i) => ({ id: String(i) })),
  };
  let offset = 0;
  const ids = [];
  do {
    const page = queryPage(snapshot, { offset, limit: 100, expectedRevision: 7 });
    ids.push(...page.objects.map((o) => o.id));
    assert.equal(page.page.total, 10000);
    offset = page.page.nextOffset;
  } while (offset !== null);
  assert.equal(new Set(ids).size, 10000);
  assert.deepEqual(
    ids,
    snapshot.objects.map((o) => o.id),
  );
  assert.throws(() => queryPage(snapshot, { offset: 100 }), { code: 'INVALID_INPUT' });
  assert.throws(
    () => queryPage({ ...snapshot, revision: 8 }, { offset: 100, expectedRevision: 7 }),
    { code: 'STALE_REFERENCE' },
  );
});

test('filtered CAD pages preserve units and matching scene, and never mutate native results', () => {
  const model = {
    sourceUnits: 4,
    dwgEditMode: 'polyline-vertices-v1',
    objects: [{ id: 'a', points: [1, 2, 3] }, { id: 'b' }],
    scene: [
      { id: 'a', area: 24 },
      { id: 'b', area: 48 },
    ],
  };
  const page = queryPage({ revision: 1, model }, { objectIds: ['b', 'missing'] });
  assert.deepEqual(page.model.objects, [{ id: 'b' }]);
  assert.deepEqual(page.model.scene, [{ id: 'b', area: 48 }]);
  assert.equal(page.model.sourceUnits, 4);
  assert.equal(page.model.dwgEditMode, 'polyline-vertices-v1');
  assert.equal(page.page.total, 1);
  assert.equal(page.page.nextOffset, null);
  assert.equal(model.objects.length, 2);
});

test('byte-limited pages resume at the unsent row and refuse an oversized single row', () => {
  const objects = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    name: '가'.repeat(1000),
  }));
  const page = queryPage({ objects });
  assert.ok(page.objects.length < 50);
  assert.equal(page.page.nextOffset, page.objects.length);
  assert.ok(Buffer.byteLength(JSON.stringify(page.objects)) <= 65536);
  const next = queryPage({ objects }, { offset: page.page.nextOffset, expectedRevision: 0 });
  assert.equal(next.objects[0].id, String(page.objects.length));
  assert.throws(() => queryPage({ objects: [{ id: 'big', name: '가'.repeat(65536) }] }), {
    code: 'QUERY_RESULT_TOO_LARGE',
  });
});

test('agent scope enforces paging inputs and target isolation before query dispatch', async () => {
  const tools = new AgentTools();
  let calls = 0;
  const scope = tools.issue({
    targetRef: 'A',
    isCurrent: () => true,
    handlers: {
      query: (args) => {
        calls++;
        return queryPage({ objects: [{ id: 'a' }, { id: 'b' }], revision: 3 }, args);
      },
    },
  });
  const read = async (args) =>
    JSON.parse((await tools.call(scope.token, 'query', args)).content[0].text);
  try {
    assert.equal((await read({ targetRef: 'B', objectIds: ['b'] })).code, 'TARGET_MISMATCH');
    assert.equal((await read({ targetRef: 'A', limit: 101 })).code, 'INVALID_INPUT');
    assert.equal(calls, 0);
    assert.deepEqual((await read({ targetRef: 'A', objectIds: ['b'] })).objects, [{ id: 'b' }]);
    assert.equal(
      (await read({ targetRef: 'A', offset: 1, expectedRevision: 2 })).code,
      'STALE_REFERENCE',
    );
  } finally {
    tools.close();
  }
});

// 검토본과 함께 기록 (PLAN-53 T-335, ARCH-01 §5): `POST …/reviews` with `record` saves the 검토본 and a
// kept record (source manual, sourceKey review:<id>, attachments reviewId·requestId); without it no
// record; a second record of the same 검토본 is refused; a remote session that sends `record` is
// FORBIDDEN before anything is saved. Synthetic Sync and made-up sentences only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../src/server/server.ts';
import { Store } from '../../src/core/store.ts';
import { Records } from '../../src/core/records.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { captureInput } from '../../src/server/import-model.ts';
import { addReviewRecord, reviewRecordInput } from '../../src/server/review-record.ts';

const IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const b64 = (text) => Buffer.from(text).toString('base64');
function sync(workspace, projectId, id) {
  workspace.submit(projectId, captureInput({ id, instance: '1:2:3', documentId: 7 }, 'rhino'));
  workspace.update(projectId, id, 'succeeded', {
    hostExecuted: true,
    displayOnly: true,
    verified: true,
    executionMode: 'sdk',
    host: 'rhino',
    objects: [{ id: 'o1', nativeId: 'o1', kind: 'native', name: '벽' }],
    scene: [
      {
        id: 'o1',
        nativeId: 'o1',
        nativeType: 'Brep',
        layer64: b64('벽'),
        area: 6,
        volume: 1,
        valid: true,
        vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
      },
    ],
    sourceDocument: {
      instance: '1:2:3',
      documentId: 7,
      connection: 'attached-editor',
      documentHash: 'r'.repeat(64),
      revision: 1,
      name: 'Doc',
      units: 'Meters',
      capturedAt: '2026-10-06T00:00:00Z',
    },
  });
}

test('POST /reviews with record: 검토본 and a kept record; without: none', async (t) => {
  const app = await startServer({ filename: ':memory:', host: { status: async () => ({}) } });
  t.after(() => app.close());
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const headers = {
    Origin: app.origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, json: await response.json() };
  };
  const p = (await api('/projects', 'POST', { name: '검토본 기록' })).json.id;
  sync(new Workspace(app.store), p, 's1');

  const plain = await api(`/projects/${p}/reviews`, 'POST', {
    requestId: 's1',
    title: '수정 전',
    image: IMAGE,
  });
  assert.equal(plain.status, 201);
  assert.equal(plain.json.record, undefined);
  assert.equal((await api(`/projects/${p}/records`)).json.total, 0);

  const made = await api(`/projects/${p}/reviews`, 'POST', {
    requestId: 's1',
    title: 'A안',
    image: IMAGE,
    record: { type: 'D', text: '지붕 경사를 15도로 정함' },
  });
  assert.equal(made.status, 201);
  assert.equal(made.json.title, 'A안');
  assert.equal(typeof made.json.record.id, 'string');
  const titled = await api(`/projects/${p}/reviews`, 'POST', {
    requestId: 's1',
    title: 'B안',
    image: IMAGE,
    record: { type: 'E', text: '  ' },
  });
  assert.equal(titled.status, 201);
  const { records, total } = (await api(`/projects/${p}/records`)).json;
  assert.equal(total, 2);
  const decision = records.find((row) => row.id === made.json.record.id);
  assert.equal(decision.type, 'D');
  assert.equal(decision.state, 'kept');
  assert.equal(decision.source, 'manual');
  assert.equal(decision.text, '지붕 경사를 15도로 정함');
  assert.equal(decision.sourceKey, 'review:' + made.json.id);
  assert.deepEqual(decision.attachments, { reviewId: made.json.id, requestId: 's1' });
  // An empty text takes the 검토본 title.
  assert.equal(records.find((row) => row.id === titled.json.record.id).text, 'B안');

  // A malformed record (type outside D/E) saves nothing.
  const bad = await api(`/projects/${p}/reviews`, 'POST', {
    requestId: 's1',
    title: 'C안',
    image: IMAGE,
    record: { type: 'R' },
  });
  assert.equal(bad.status, 400);
  assert.equal((await api(`/projects/${p}/reviews`)).json.length, 3);
});

test('a second record of the same 검토본 is refused; a remote session is FORBIDDEN', () => {
  const store = new Store(':memory:');
  try {
    const p = store.createProject('검토본 기록').id;
    const records = new Records(store);
    const review = { id: 'review-1', requestId: 's1', title: 'A안' };
    const first = addReviewRecord(records, p, review, { type: 'D' }, '김설계');
    assert.equal(typeof first.id, 'string');
    assert.equal(records.get(p, first.id).by, '김설계');
    assert.deepEqual(addReviewRecord(records, p, review, { type: 'E', text: '다시' }, ''), {
      error: 'RECORD_SOURCE_DUPLICATE',
    });
    assert.equal(records.list(p).total, 1);

    assert.equal(reviewRecordInput({ title: 'x' }, true), undefined);
    assert.throws(() => reviewRecordInput({ record: { type: 'D' } }, true), {
      code: 'FORBIDDEN',
    });
    assert.throws(() => reviewRecordInput({ record: { type: 'D', by: 'x' } }, false), {
      code: 'INVALID_INPUT',
    });
    assert.deepEqual(reviewRecordInput({ record: { type: 'E', text: '근거' } }, false), {
      type: 'E',
      text: '근거',
    });
  } finally {
    store.close();
  }
});

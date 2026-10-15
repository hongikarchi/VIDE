// 기록 자동 후보의 진입점 (SPEC-17.3 1, SPEC-17.7, ARCH-01 §5 「프로젝트 기록」, PLAN-53 T-322): each
// hook returns at once and the candidate lands afterwards; the same source twice is one record; a
// failing store never rejects the hook; and the AI tool record_add makes candidates only. All
// sentences are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Records } from '../../src/core/records.ts';
import { attachRecordSources } from '../../src/server/record-sources.ts';
import { recordHandlers } from '../../src/server/agent-tools.ts';

const NOW = new Date('2026-10-15T05:00:00.000Z');
function setup(t, extra = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const records = new Records(store, { now: () => NOW });
  const projectId = store.createProject('기록 후보 시험').id;
  const logged = [];
  const sources = attachRecordSources({
    records,
    log: (event, fields) => logged.push({ event, fields }),
    now: () => NOW,
    ...extra,
  });
  const all = () => records.list(projectId, { state: ['candidate', 'kept', 'dropped'] }).records;
  return { store, records, projectId, sources, logged, all };
}
const finished = (projectId, extra = {}) => ({
  id: 'req-a',
  projectId,
  input: { body: '2층 보 춤을 600으로 바꿔줘', conversationId: 'conv-a' },
  state: 'succeeded',
  result: { changes: { added: [], removed: [], modified: [{ id: 'beam-1' }] } },
  createdAt: '2026-10-15T04:10:00.000Z',
  ...extra,
});

test('a finished request: the hook returns at once, the candidate lands after the request', async (t) => {
  const { sources, projectId, all } = setup(t);
  const order = [];
  const returned = sources.requestFinished(finished(projectId));
  order.push('hook returned');
  assert.equal(returned, undefined);
  assert.equal(all().length, 0, 'nothing written inside the hook');
  await Promise.resolve();
  assert.equal(all().length, 0, 'nor in the same microtask turn');
  order.push('request answered');
  await sources.idle();
  order.push('candidate stored');
  assert.deepEqual(order, ['hook returned', 'request answered', 'candidate stored']);
  const [row] = all();
  assert.equal(row.type, 'D');
  assert.equal(row.state, 'candidate');
  assert.equal(row.by, 'ai');
  assert.equal(row.source, 'request');
  assert.equal(row.sourceKey, 'request:req-a');
  assert.equal(row.attachments.requestId, 'req-a');
});

test('the same request twice is one candidate (RECORD_SOURCE_DUPLICATE is quiet)', async (t) => {
  const { sources, projectId, all, logged } = setup(t);
  sources.requestFinished(finished(projectId));
  sources.requestFinished(finished(projectId));
  await sources.idle();
  sources.requestFinished(finished(projectId));
  await sources.idle();
  assert.equal(all().length, 1);
  assert.deepEqual(logged, []);
});

test('a failing store never rejects the hook; the failure is a diagnostic only', async (t) => {
  const logged = [];
  const sources = attachRecordSources({
    records: {
      add: () => {
        throw new Error('disk full');
      },
      list: () => ({ records: [], total: 0, counts: {} }),
      parts: () => {
        throw new Error('no parts');
      },
      bySourceKey: () => null,
    },
    log: (event, fields) => logged.push({ event, fields }),
    now: () => NOW,
  });
  assert.doesNotThrow(() => sources.requestFinished(finished('p1')));
  assert.doesNotThrow(() =>
    sources.noteCopied('p1', { id: 'n', kind: 'note' }, '긴 문단이 하나 있는 노트입니다'),
  );
  await sources.idle();
  assert.ok(logged.length >= 2);
  assert.ok(logged.every((entry) => entry.event === 'record-candidate-failed'));
  assert.ok(
    logged.every((entry) => !JSON.stringify(entry).includes('disk full')),
    'codes only',
  );
  // A log that throws is swallowed too.
  const quiet = attachRecordSources({
    records: {
      add: () => {
        throw new Error('x');
      },
      list: () => ({ total: 0 }),
      parts: () => [],
      bySourceKey: () => null,
    },
    log: () => {
      throw new Error('log down');
    },
  });
  quiet.requestFinished(finished('p1'));
  await quiet.idle();
});

test('decision sentences and ledger decisions of the request → D chat candidates', async (t) => {
  const ledger = [
    { id: 'L1', kind: 'decision', body: { text: '보 춤은 600으로 한다' }, requestId: 'req-b' },
    { id: 'L2', kind: 'decision', body: '다른 요청의 결정', requestId: 'req-other' },
    { id: 'L3', kind: 'assumption', body: '가정은 후보가 아님', requestId: 'req-b' },
  ];
  const { sources, projectId, all } = setup(t, {
    conversations: { ledger: () => ledger },
  });
  sources.requestFinished(
    finished(projectId, {
      id: 'req-b',
      input: {
        body: '구조 검토 결과 봤어. 보 춤은 600으로 가자. 기둥은 아직 결정 못 했어.',
        conversationId: 'conv-b',
      },
      result: { text: '확인했습니다' },
    }),
  );
  await sources.idle();
  const rows = all();
  const keys = rows.map((row) => row.sourceKey).sort();
  assert.deepEqual(keys, ['chat:conv-b:L1', 'chat:conv-b:req-b', 'request:req-b']);
  const chat = rows.find((row) => row.sourceKey === 'chat:conv-b:req-b');
  assert.equal(chat.type, 'D');
  assert.equal(chat.source, 'chat');
  assert.equal(chat.text, '보 춤은 600으로 가자.');
  assert.equal(rows.find((row) => row.sourceKey === 'request:req-b').type, 'E');
  // A request that is itself one decision sentence: its own candidate is the D, no second one.
  sources.requestFinished(
    finished(projectId, { id: 'req-c', input: { body: '외벽은 석재로 가자' }, result: {} }),
  );
  await sources.idle();
  const own = all().filter((row) => row.attachments.requestId === 'req-c');
  assert.equal(own.length, 1);
  assert.equal(own[0].type, 'D');
  assert.equal(own[0].sourceKey, 'request:req-c');
});

test('a failed request and a document Sync: none, and a K from source sync', async (t) => {
  const { sources, projectId, all } = setup(t);
  sources.requestFinished(finished(projectId, { id: 'req-f', state: 'failed' }));
  sources.requestFinished(
    finished(projectId, {
      id: 'sync-1',
      input: { body: '열린 Rhino 문서 가져오기', source: 'document', linkId: 'l1' },
    }),
  );
  await sources.idle();
  const rows = all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'K');
  assert.equal(rows[0].source, 'sync');
});

test('changed objects mapped in the 부위 사전 fill the candidate parts', async (t) => {
  const { sources, projectId, records, all } = setup(t);
  const beam = records.addPart(projectId, {
    name: '2층 보',
    mapping: [{ kind: 'objects', linkId: 'l1', ids: ['beam-1', 'beam-2'] }],
  });
  records.addPart(projectId, {
    name: '지붕',
    mapping: [{ kind: 'layer', linkId: 'l1', layer: '지붕' }],
  });
  sources.requestFinished(finished(projectId));
  await sources.idle();
  assert.deepEqual(all()[0].parts, [beam.id]);
});

test('notes: paragraphs as ?, the daily cap, a refresh of an old note makes none', async (t) => {
  const { sources, projectId, all } = setup(t);
  const fresh = { id: 'note-1', kind: 'discussion', updatedAt: NOW.getTime() - 60_000 };
  const markdown =
    '# 협의\n\n<!-- 머리 -->\n\n건축주가 남측 발코니를 넓혀 달라고 함\n\n- 설비 업체 회신 대기 중임\n';
  sources.noteCopied(projectId, fresh, markdown);
  sources.noteCopied(projectId, fresh, markdown);
  await sources.idle();
  let rows = all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.type === '?' && row.source === 'meeting'));
  sources.noteCopied(
    projectId,
    { id: 'note-old', kind: 'note', updatedAt: NOW.getTime() - 3 * 86_400_000 },
    '오래된 노트의 문단은 다시 후보가 되지 않음',
  );
  const many = Array.from({ length: 40 }, (_, i) => `현장 메모 ${i + 1}번째 문단입니다`).join(
    '\n\n',
  );
  sources.noteCopied(projectId, { id: 'note-2', kind: 'note', updatedAt: NOW.getTime() }, many);
  await sources.idle();
  rows = all();
  assert.equal(rows.length, 30, 'two earlier + 28 of the new note');
});

test('[퇴근하기] and the journal copy of the same text are one candidate', async (t) => {
  const { sources, projectId, all } = setup(t);
  sources.dayEnded(projectId, { date: '2026-10-15', text: '지하 램프 경사 다시 확인함' });
  await sources.idle();
  sources.noteCopied(
    projectId,
    { id: 'j1', kind: 'journal', journalDate: '2026-10-15', updatedAt: NOW.getTime() },
    '# 2026-10-15 일지\n\n<!-- 머리 -->\n\n퇴근 기록 · 지하 램프 경사 다시 확인함\n',
  );
  await sources.idle();
  const rows = all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'journal');
  assert.match(rows[0].sourceKey, /^journal:2026-10-15:/);
});

test('jig settings → D (defaults are not), a confirmed review run → E', async (t) => {
  const { sources, projectId, records, all } = setup(t);
  const part = records.addPart(projectId, {
    name: '보',
    mapping: [{ kind: 'jig-output', instanceId: 'jig-1', outputId: 'beams' }],
  });
  const event = {
    projectId,
    instanceId: 'jig-1',
    jigId: 'vide/structure-analysis',
    title: '구조 검토',
    by: 'user',
    reason: '덕트 간섭',
    requestId: null,
    entries: [
      { seq: 1, key: 'span', old: { value: 8 }, new: { value: 9 }, at: '2026-10-15T03:00:00.000Z' },
      { seq: 2, key: 'depth', old: null, new: { value: 0.6 }, at: '2026-10-15T03:00:00.000Z' },
    ],
  };
  sources.paramsChanged(event);
  sources.paramsChanged(event);
  sources.paramsChanged({ ...event, by: 'default', entries: [{ ...event.entries[0], seq: 3 }] });
  sources.jigRun({
    projectId,
    instanceId: 'jig-1',
    jigId: 'vide/structure-analysis',
    title: '구조 검토',
    mode: 'confirmed',
    status: 'computed',
    outputs: {},
  });
  sources.jigRun({
    projectId,
    instanceId: 'jig-1',
    jigId: 'vide/structure-analysis',
    title: '구조 검토',
    mode: 'geometry',
    status: 'computed',
    outputs: {},
  });
  await sources.idle();
  const rows = all();
  assert.deepEqual(rows.map((row) => `${row.type} ${row.text}`).sort(), [
    'D 구조 검토 depth: 없음 → 0.6(덕트 간섭)',
    'D 구조 검토 span: 8 → 9(덕트 간섭)',
    'E 구조 검토 확정 결과',
  ]);
  assert.ok(rows.every((row) => row.parts.includes(part.id)));
});

test('a fresh checkout, a 서버에 반영 and confirmed folder roles → K', async (t) => {
  const checkouts = [
    {
      id: 'co-new',
      role: 'drawings',
      serverPath: 'Z:\\현장\\A-101.dwg',
      checkedOutAt: '2026-10-15T04:58:00.000Z',
      releasedAt: null,
    },
    {
      id: 'co-old',
      role: 'drawings',
      serverPath: 'Z:\\현장\\A-102.dwg',
      checkedOutAt: '2026-10-01T04:58:00.000Z',
      releasedAt: '2026-10-15T04:59:00.000Z',
    },
  ];
  const { sources, projectId, all } = setup(t, {
    checkouts: {
      list: () => checkouts,
      get: (_p, id) => checkouts.find((row) => row.id === id) ?? null,
    },
    roleLabels: { drawings: '도면' },
  });
  sources.checkoutsChanged(projectId);
  sources.checkoutsChanged(projectId);
  sources.checkoutLog('workspace-publish', { projectId, checkoutId: 'co-old', role: 'drawings' });
  sources.checkoutLog('workspace-dwg-backup', { projectId });
  sources.schemaConfirmed(projectId, {
    confirmedAt: '2026-10-15T04:00:00.000Z',
    paths: { drawings: '03_도면' },
  });
  await sources.idle();
  assert.deepEqual(
    all()
      .map((row) => `${row.type} ${row.sourceKey} ${row.text}`)
      .sort(),
    [
      'K checkout:co-new 체크아웃: A-101.dwg',
      'K release:co-old 서버에 반영: A-102.dwg',
      'K schema:2026-10-15T04:00:00.000Z 폴더 역할 확정: 도면=03_도면',
    ],
  );
});

test('record_add: a chat candidate by the AI, part names resolved, never kept', async (t) => {
  const { records, projectId, all } = setup(t);
  const part = records.addPart(projectId, { name: '남측 발코니' });
  const handlers = recordHandlers({
    projectId,
    conversationId: 'conv-x',
    requestId: 'req-x',
    records,
  });
  const first = await handlers.record_add({
    text: '남측 발코니 깊이를 1.8m로 하기로 함',
    type: 'D',
    parts: ['남측 발코니', '없는 부위'],
  });
  assert.equal(first.next, '거르기는 기록 탭에서');
  assert.equal(first.added.state, 'candidate');
  assert.deepEqual(first.added.parts, [part.id]);
  assert.deepEqual(first.unknownParts, ['없는 부위']);
  const second = await handlers.record_add({
    text: '건축주 요구로 1층 전면 개방',
    type: 'R',
    date: '2026-10-01',
  });
  assert.equal(second.added.date, '2026-10-01');
  const rows = all();
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every((row) => row.by === 'ai' && row.source === 'chat' && row.state === 'candidate'),
  );
  assert.deepEqual(rows.map((row) => row.sourceKey).sort(), [
    'chat:conv-x:req-x:1',
    'chat:conv-x:req-x:2',
  ]);
  // A fresh handler set for the same turn continues past the keys already taken.
  const again = recordHandlers({
    projectId,
    conversationId: 'conv-x',
    requestId: 'req-x',
    records,
  });
  await again.record_add({ text: '같은 턴에서 다시 남긴 기록' });
  assert.equal(all().length, 3);
  assert.equal(all().find((row) => row.text === '같은 턴에서 다시 남긴 기록').type, '?');
  // The store refuses an AI that tries to keep one.
  assert.throws(
    () => records.add(projectId, { text: 'AI가 바로 남김' }, { by: 'ai', state: 'kept' }),
    /RECORD_AI_FORBIDDEN/,
  );
});

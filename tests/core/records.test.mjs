// 프로젝트 기록 (SPEC-17, ARCH-01 §5 「프로젝트 기록」, PLAN-53 T-321): the store — chains from roots,
// cycle refusal, O/X states and the AI's limits, one candidate per source, corrections, the
// o/x/. marks round trip, parts that go while their records stay, and project isolation. All
// sentences are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Records } from '../../src/core/records.ts';

function setup(options = {}) {
  const store = new Store(':memory:');
  const records = new Records(store, {
    now: () => new Date('2026-10-15T03:00:00Z'),
    ...options,
  });
  const a = store.createProject('기록 시험').id;
  const b = store.createProject('다른 프로젝트').id;
  return { store, records, a, b };
}
const add = (records, p, text, extra = {}, options = { by: '홍길동' }) =>
  records.add(p, { date: '2026-03-01', type: 'D', text, ...extra }, options);

test('chains: roots with no incoming link reach their records; cycles are refused', (t) => {
  const { store, records, a } = setup();
  t.after(() => store.close());
  const r = add(records, a, '건축주가 1층 개방을 요구함', { type: 'R', date: '2026-01-05' });
  const e = add(records, a, '기존 벽 실측 결과 내력벽 아님', { type: 'E', date: '2026-02-01' });
  const d = add(records, a, '1층 벽 철거로 결정', { date: '2026-03-01' });
  const d2 = add(records, a, '보강 보 추가로 결정', { date: '2026-04-01' });
  add(records, a, '혼자 있는 기록', { type: 'I', date: '2026-01-01' });
  records.link(a, r.id, d.id);
  records.link(a, e.id, d.id);
  records.link(a, d.id, d2.id);
  assert.deepEqual(records.get(a, d.id).follows, [d2.id]);
  assert.deepEqual(records.get(a, d.id).followedBy.sort(), [r.id, e.id].sort());
  assert.deepEqual(records.chains(a), [
    { root: r.id, ids: [r.id, d.id, d2.id] },
    { root: e.id, ids: [e.id, d.id, d2.id] },
  ]);
  // d2 → r would close a loop; so would a self link.
  assert.throws(() => records.link(a, d2.id, r.id), { code: 'RECORD_LINK_CYCLE' });
  assert.throws(() => records.link(a, d.id, d.id), { code: 'RECORD_LINK_CYCLE' });
  assert.throws(() => records.link(a, d.id, 'nope'), { code: 'RECORD_NOT_FOUND' });
  records.unlink(a, d.id, d2.id);
  assert.deepEqual(records.chains(a), [
    { root: r.id, ids: [r.id, d.id] },
    { root: e.id, ids: [e.id, d.id] },
  ]);
  // Only kept records: a dropped root leaves d as its own root (no outgoing link → no chain).
  records.setState(a, e.id, 'dropped', '홍길동');
  records.link(a, d.id, d2.id);
  assert.deepEqual(records.chains(a, { state: ['kept'] }), [
    { root: r.id, ids: [r.id, d.id, d2.id] },
  ]);
});

test('states move between candidate, kept and dropped; the AI only makes candidates', (t) => {
  const { store, records, a } = setup();
  t.after(() => store.close());
  const ai = records.add(
    a,
    { text: '창호 사양을 바꾸기로 함' },
    { by: 'ai', source: 'chat', sourceKey: 'chat:c1:l1' },
  );
  assert.deepEqual(
    [ai.state, ai.type, ai.by, ai.source, ai.date],
    ['candidate', '?', 'ai', 'chat', '2026-10-15'],
  );
  assert.throws(() => records.add(a, { text: 'x' }, { by: 'ai', state: 'kept' }), {
    code: 'RECORD_AI_FORBIDDEN',
  });
  assert.throws(() => records.setState(a, ai.id, 'kept', 'ai'), { code: 'RECORD_AI_FORBIDDEN' });
  const kept = records.setState(a, ai.id, 'kept', '홍길동');
  assert.deepEqual([kept.state, kept.updatedBy], ['kept', '홍길동']);
  assert.throws(() => records.patch(a, ai.id, { text: '다른 문장' }, 'ai'), {
    code: 'RECORD_AI_FORBIDDEN',
  });
  // The AI may still propose a type for a record.
  assert.equal(records.patch(a, ai.id, { type: 'D' }, 'ai').type, 'D');
  assert.equal(records.setState(a, ai.id, 'dropped', '홍길동').state, 'dropped');
  assert.equal(records.setState(a, ai.id, 'candidate', '홍길동').state, 'candidate');
  // Bulk: all or nothing.
  const other = add(records, a, '두 번째');
  assert.throws(() => records.setStates(a, [ai.id, 'missing'], 'kept', '홍길동'), {
    code: 'RECORD_NOT_FOUND',
  });
  assert.equal(records.get(a, ai.id).state, 'candidate');
  assert.equal(records.setStates(a, [ai.id, other.id], 'kept', '홍길동'), 1);
  for (const bad of [
    { text: '  ' },
    { text: 'x', date: '2026-02-30' },
    { text: 'x', time: '24:00' },
    { text: 'x', type: 'Z' },
  ])
    assert.throws(() => records.add(a, bad, { by: '홍길동' }), { code: 'INVALID_INPUT' });
  assert.throws(() => records.add(a, { text: 'x' }, { by: '홍길동', source: 'fax' }), {
    code: 'INVALID_INPUT',
  });
});

test('one candidate per source key; the refusal names the first record', (t) => {
  const { store, records, a, b } = setup();
  t.after(() => store.close());
  const first = records.add(
    a,
    { text: '외벽 마감 변경' },
    { by: 'ai', source: 'request', sourceKey: 'request:r-1' },
  );
  assert.throws(
    () =>
      records.add(
        a,
        { text: '외벽 마감 변경' },
        { by: 'ai', source: 'request', sourceKey: 'request:r-1' },
      ),
    (error) => error.code === 'RECORD_SOURCE_DUPLICATE' && error.details.existingId === first.id,
  );
  assert.equal(records.bySourceKey(a, 'request:r-1').id, first.id);
  // Another project's same key is its own.
  records.add(
    b,
    { text: '외벽 마감 변경' },
    { by: 'ai', source: 'request', sourceKey: 'request:r-1' },
  );
});

test('a correction makes a new record, marks the old one superseded and links them', (t) => {
  const { store, records, a } = setup();
  t.after(() => store.close());
  const part = records.addPart(a, { name: '기존 슬래브', grp: '기존' });
  const old = add(records, a, '슬래브 두께 150', { parts: [part.id], chapter: '보강' });
  const next = records.correct(a, old.id, { text: '슬래브 두께 180', type: 'E' }, '홍길동');
  assert.deepEqual(
    [next.text, next.type, next.state, next.source, next.parts, next.chapter, next.by],
    ['슬래브 두께 180', 'E', 'kept', 'manual', [part.id], '보강', '홍길동'],
  );
  const after = records.get(a, old.id);
  assert.equal(after.supersededBy, next.id);
  assert.deepEqual(after.follows, [next.id]);
  assert.deepEqual(next.followedBy, [old.id]);
  assert.throws(() => records.patch(a, old.id, { text: '또' }, '홍길동'), {
    code: 'RECORD_SUPERSEDED',
  });
  assert.throws(() => records.correct(a, old.id, { text: '또' }, '홍길동'), {
    code: 'RECORD_SUPERSEDED',
  });
  assert.throws(() => records.correct(a, next.id, { text: '또' }, 'ai'), {
    code: 'RECORD_AI_FORBIDDEN',
  });
  const edited = records.patch(a, next.id, { text: '슬래브 두께 200', time: '09:30' }, '김철수');
  assert.deepEqual(
    [edited.text, edited.time, edited.updatedBy],
    ['슬래브 두께 200', '09:30', '김철수'],
  );
});

test('marks export and import round trip; a length mismatch is refused', (t) => {
  const { store, records, a } = setup();
  t.after(() => store.close());
  const rows = ['가', '나', '다', '라'].map((text, i) =>
    records.add(a, { text, date: `2026-05-0${i + 1}` }, { by: 'ai', source: 'note' }),
  );
  records.setState(a, rows[0].id, 'kept', '홍길동');
  records.setState(a, rows[2].id, 'dropped', '홍길동');
  const exported = records.exportMarks(a);
  assert.deepEqual(exported, { marks: 'o.x.', ids: rows.map((row) => row.id) });
  records.setStates(
    a,
    rows.map((row) => row.id),
    'candidate',
    '홍길동',
  );
  assert.equal(records.exportMarks(a).marks, '....');
  assert.equal(records.importMarks(a, exported.ids, exported.marks, '홍길동'), 2);
  assert.equal(records.exportMarks(a).marks, 'o.x.');
  assert.throws(
    () => records.importMarks(a, exported.ids, 'oo', '홍길동'),
    (error) =>
      error.code === 'RECORD_MARKS_MISMATCH' &&
      error.details.expected === 4 &&
      error.details.got === 2,
  );
  assert.throws(() => records.importMarks(a, exported.ids, 'oo?x', '홍길동'), {
    code: 'INVALID_INPUT',
  });
  const lines = records
    .toJsonl(a, { state: ['kept'] })
    .trim()
    .split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).text, '가');
});

test('list filters, counts and order; undone is read from the resolver', (t) => {
  const { store, records, a } = setup({
    undoneResolver: (_p, requestId) => requestId === 'req-undone',
  });
  t.after(() => store.close());
  const wall = records.addPart(a, { name: '1층 벽' });
  add(records, a, '나중 결정', { date: '2026-06-01', time: '10:00', parts: [wall.id] });
  add(records, a, '처음 요구 100%', { type: 'R', date: '2026-01-01' });
  records.add(
    a,
    { text: '되돌린 요청', date: '2026-03-01', attachments: { requestId: 'req-undone' } },
    { by: 'ai', source: 'request', sourceKey: 'request:req-undone' },
  );
  const all = records.list(a);
  assert.deepEqual(
    all.records.map((row) => row.text),
    ['처음 요구 100%', '되돌린 요청', '나중 결정'],
  );
  assert.deepEqual(
    all.records.map((row) => row.undone),
    [false, true, false],
  );
  assert.equal(all.total, 3);
  assert.deepEqual(all.counts.state, { candidate: 1, kept: 2 });
  assert.deepEqual(all.counts.type, { '?': 1, D: 1, R: 1 });
  assert.deepEqual(all.counts.chapter, { '': 3 });
  const pick = (filters) => records.list(a, filters).records.map((row) => row.text);
  assert.deepEqual(pick({ part: wall.id }), ['나중 결정']);
  assert.deepEqual(pick({ part: '-' }), ['처음 요구 100%', '되돌린 요청']);
  assert.deepEqual(pick({ type: ['R', 'D'] }), ['처음 요구 100%', '나중 결정']);
  assert.deepEqual(pick({ state: ['candidate'] }), ['되돌린 요청']);
  assert.deepEqual(pick({ from: '2026-02-01', to: '2026-05-31' }), ['되돌린 요청']);
  assert.deepEqual(pick({ q: '100%' }), ['처음 요구 100%']);
  assert.deepEqual(pick({ q: '%' }), ['처음 요구 100%']);
  assert.deepEqual(pick({ limit: 1, offset: 1 }), ['되돌린 요청']);
  const filtered = records.list(a, { state: ['kept'] });
  assert.equal(filtered.total, 2);
  assert.deepEqual(filtered.counts.state, { candidate: 1, kept: 2 });
  assert.throws(() => records.list(a, { from: '2026-13-01' }), { code: 'INVALID_INPUT' });
});

test('removing a part keeps its records; milestones; projects are isolated', (t) => {
  const { store, records, a, b } = setup();
  t.after(() => store.close());
  const wall = records.addPart(a, {
    name: '기존 벽',
    grp: '기존',
    roleFrom: '내력벽',
    roleTo: '개구부',
    mapping: [{ kind: 'layer', linkId: 'L1', layer: 'A-WALL' }],
  });
  assert.deepEqual(wall.mapping, [{ kind: 'layer', linkId: 'L1', layer: 'A-WALL' }]);
  const changed = records.setPart(a, wall.id, { seenAt: '2026-02-01', grp: null });
  assert.deepEqual([changed.seenAt, changed.grp, changed.name], ['2026-02-01', null, '기존 벽']);
  const rec = add(records, a, '벽에 개구 내기로', { parts: [wall.id] });
  assert.throws(() => add(records, a, 'x', { parts: ['nope'] }), { code: 'PART_NOT_FOUND' });
  records.removePart(a, wall.id);
  assert.deepEqual(records.get(a, rec.id).parts, []);
  assert.deepEqual(records.parts(a), []);
  assert.throws(() => records.removePart(a, wall.id), { code: 'PART_NOT_FOUND' });
  assert.throws(() => records.addPart(a, { name: 'x', mapping: [{ kind: 'bad' }] }), {
    code: 'INVALID_INPUT',
  });

  const m2 = records.addMilestone(a, { label: '착공', date: '2026-11-01' });
  records.addMilestone(a, { label: '당선', date: '2026-01-10' });
  assert.deepEqual(
    records.milestones(a).map((m) => m.label),
    ['당선', '착공'],
  );
  records.removeMilestone(a, m2.id);
  assert.throws(() => records.removeMilestone(a, m2.id), { code: 'MILESTONE_NOT_FOUND' });

  // The other project sees none of it and cannot reach it by id.
  assert.equal(records.list(b).total, 0);
  assert.deepEqual(records.milestones(b), []);
  assert.throws(() => records.get(b, rec.id), { code: 'RECORD_NOT_FOUND' });
  assert.throws(() => records.setState(b, rec.id, 'dropped', '홍길동'), {
    code: 'RECORD_NOT_FOUND',
  });
  const own = add(records, b, '다른 프로젝트 기록');
  assert.throws(() => records.link(a, rec.id, own.id), { code: 'RECORD_NOT_FOUND' });
});

test('addMany: a missing follows refuses the batch; a key twice in one batch is skipped; held keys past 500', (t) => {
  const { store, records, a } = setup();
  t.after(() => store.close());
  const before = records.list(a).records.length;
  assert.throws(
    () =>
      records.addMany(
        a,
        [
          { input: { text: '먼저 들어갈 줄' }, sourceKey: 'kakao:h:1' },
          { input: { text: '없는 기록을 잇는 줄', follows: ['no-such-record'] } },
        ],
        { by: '홍길동' },
      ),
    { code: 'RECORD_NOT_FOUND' },
  );
  assert.equal(records.list(a).records.length, before, 'nothing of the batch stays');
  const once = records.addMany(
    a,
    [
      { input: { text: '첫 줄' }, sourceKey: 'kakao:h:2' },
      { input: { text: '같은 줄 다시' }, sourceKey: 'kakao:h:2' },
    ],
    { by: '홍길동', state: 'candidate', source: 'kakao' },
  );
  assert.equal(once.added.length, 1);
  assert.deepEqual(once.skipped, [{ sourceKey: 'kakao:h:2', existingId: once.added[0] }]);
  const items = Array.from({ length: 600 }, (_, i) => ({
    input: { text: `줄 ${i}` },
    sourceKey: `kakao:big:${i}`,
  }));
  const many = records.addMany(a, items, { by: '홍길동', state: 'candidate', source: 'kakao' });
  assert.equal(many.added.length, 600);
  const held = records.heldSourceKeys(a, [...items.map((item) => item.sourceKey), 'kakao:none']);
  assert.equal(held.size, 600);
  assert.equal(held.get('kakao:big:599'), many.added[599]);
  assert.equal(held.has('kakao:none'), false);
});

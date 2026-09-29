import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vide-store-test-'));
  const filename = join(root, 'test.sqlite');
  const stores = [];
  const open = () => {
    const s = new Store(filename);
    stores.push(s);
    return s;
  };
  t.after(() => {
    for (const s of stores) s.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { open, filename };
}
function setup(s) {
  const p = s.createProject('합성 프로젝트');
  const a = s.registerConnection(p.id, {
    host: 'rhino',
    instanceId: 'rhino-one',
    documentId: 'doc-a',
  });
  const b = s.registerConnection(p.id, {
    host: 'zwcad',
    instanceId: 'zwcad-one',
    documentId: 'doc-b',
  });
  const r = s.createRun(p.id, { goal: '합성 시험', targets: [a.id, b.id] });
  return { p, a, b, r };
}
const command = (x, id, target = x.a.id) => ({
  id,
  runId: x.r.id,
  connectionId: target,
  revision: 1,
  kind: 'createCandidate',
  payload: {
    points: [
      [0, 0, 0],
      [1, 0, 0],
    ],
  },
});
const hasCode = (code) => (error) => error.code === code;

test('입력·핀·수정 버전은 실제 DB 재열기 뒤 보존된다', (t) => {
  const f = fixture(t);
  let s = f.open();
  const x = setup(s);
  const input = s.saveInput(x.p.id, {
    text: 'A 유지',
    pins: [{ connectionId: x.a.id, objectId: 'A' }],
  });
  assert.throws(
    () => s.updateInput(x.p.id, input.id, 0, { text: '오래된 화면' }),
    hasCode('REVISION_CONFLICT'),
  );
  s.updateInput(x.p.id, input.id, 1, { text: 'B 선택 뒤에도 A 핀', pins: input.body.pins });
  s.close();
  s = f.open();
  const restored = s.getInput(x.p.id, input.id);
  assert.equal(restored.revision, 2);
  assert.equal(restored.body.pins[0].objectId, 'A');
});

test('다른 프로젝트의 입력·핀·연결은 읽기와 쓰기에서 격리된다', (t) => {
  const s = fixture(t).open(),
    x = setup(s),
    other = s.createProject('다른 프로젝트');
  const input = s.saveInput(x.p.id, { text: 'private', pins: [] });
  assert.throws(() => s.getInput(other.id, input.id), hasCode('NOT_FOUND'));
  assert.throws(
    () => s.saveInput(other.id, { text: 'wrong', pins: [{ connectionId: x.a.id, objectId: 'A' }] }),
    hasCode('TARGET_MISMATCH'),
  );
  assert.throws(
    () => s.createRun(other.id, { goal: 'wrong', targets: [x.a.id] }),
    hasCode('TARGET_MISMATCH'),
  );
});

test('같은 명령 재전송은 멱등이고 변경한 내용은 거절된다', (t) => {
  const s = fixture(t).open(),
    x = setup(s),
    c = command(x, 'cmd-1');
  s.enqueue(x.p.id, c);
  assert.equal(s.enqueue(x.p.id, { ...c, payload: { points: c.payload.points } }).id, c.id);
  assert.throws(
    () => s.enqueue(x.p.id, { ...c, payload: { points: [] } }),
    hasCode('IDEMPOTENCY_CONFLICT'),
  );
  s.lease(x.a.id);
  s.complete(x.a.id, c.id, { state: 'succeeded', result: { objectIds: ['new-A'] } });
  assert.equal(s.enqueue(x.p.id, c).state, 'succeeded');
  assert.equal(s.lease(x.a.id), null);
});

test('같은 문서 쓰기는 직렬화되고 다른 호스트는 동시에 진행한다', (t) => {
  const s = fixture(t).open(),
    x = setup(s);
  s.enqueue(x.p.id, command(x, 'a1'));
  s.enqueue(x.p.id, command(x, 'a2'));
  s.enqueue(x.p.id, command(x, 'b1', x.b.id));
  assert.equal(s.lease(x.a.id).id, 'a1');
  assert.equal(s.lease(x.a.id), null);
  assert.equal(s.lease(x.b.id).id, 'b1');
});

test('재시작은 진행 중 쓰기를 unknown으로 바꾸고 자동 재전송하지 않는다', (t) => {
  const f = fixture(t);
  let s = f.open();
  const x = setup(s);
  s.enqueue(x.p.id, command(x, 'lost'));
  s.enqueue(x.p.id, command(x, 'queued'));
  s.lease(x.a.id);
  s.close();
  s = f.open();
  assert.equal(s.getCommand(x.p.id, 'lost').state, 'unknown');
  assert.equal(s.lease(x.a.id), null);
  assert.throws(() => s.enqueue(x.p.id, command(x, 'new')), hasCode('DISCONNECTED'));
  assert.equal(s.getCommand(x.p.id, 'queued').state, 'cancelled');
  const fresh = setup(s);
  s.enqueue(fresh.p.id, command(fresh, 'other', fresh.b.id));
  assert.equal(s.lease(fresh.b.id).id, 'other');
});

test('조건 변경은 미전송 명령을 취소하고 늦은 실제 결과를 이력으로만 남긴다', (t) => {
  const s = fixture(t).open(),
    x = setup(s);
  s.enqueue(x.p.id, command(x, 'running'));
  s.enqueue(x.p.id, command(x, 'pending'));
  s.lease(x.a.id);
  s.reviseRun(x.p.id, x.r.id, 1, '새 보존 조건');
  assert.equal(s.getCommand(x.p.id, 'pending').state, 'cancelled');
  const done = s.complete(x.a.id, 'running', {
    state: 'succeeded',
    result: { objectIds: ['late-A'] },
  });
  assert.equal(done.stale, true);
  assert.equal(done.state, 'succeeded');
  assert.throws(() => s.enqueue(x.p.id, command(x, 'old')), hasCode('REVISION_CONFLICT'));
});

test('다른 문서의 완료 신호와 알 수 없는 명령 종류를 거절한다', (t) => {
  const s = fixture(t).open(),
    x = setup(s);
  s.enqueue(x.p.id, command(x, 'a'));
  s.lease(x.a.id);
  assert.throws(
    () => s.complete(x.b.id, 'a', { state: 'succeeded', result: {} }),
    hasCode('TARGET_MISMATCH'),
  );
  assert.throws(
    () => s.enqueue(x.p.id, { ...command(x, 'shell'), kind: 'executeCode' }),
    hasCode('INVALID_COMMAND'),
  );
});

test('새 연결은 이전 연결 큐를 가져가지 않으며 끊긴 문서는 쓰지 않는다', (t) => {
  const s = fixture(t).open(),
    x = setup(s);
  s.enqueue(x.p.id, command(x, 'a'));
  s.disconnect(x.a.id);
  const next = s.registerConnection(x.p.id, {
    host: 'rhino',
    instanceId: 'rhino-one',
    documentId: 'doc-a',
  });
  assert.notEqual(next.id, x.a.id);
  assert.equal(s.lease(next.id), null);
  assert.equal(s.lease(x.a.id), null);
});

test('적용 승인은 정확한 명령 내용에 귀속되며 웹 권한으로 만들 수 없다', (t) => {
  const s = fixture(t).open(),
    x = setup(s),
    c = { ...command(x, 'apply'), kind: 'applyCandidate' };
  assert.throws(() => s.enqueue(x.p.id, c), hasCode('APPROVAL_REQUIRED'));
  assert.throws(() => s.approve(x.p.id, c, 'web-review'), hasCode('FORBIDDEN'));
  s.approve(x.p.id, c, 'local-controller');
  assert.throws(
    () => s.enqueue(x.p.id, { ...c, payload: { different: true } }),
    hasCode('APPROVAL_REQUIRED'),
  );
  assert.equal(s.enqueue(x.p.id, c).state, 'queued');
});

test('두 제어 프로세스는 같은 저장소의 제어권을 동시에 얻지 못한다', (t) => {
  const f = fixture(t),
    first = f.open();
  assert.throws(() => new Store(f.filename), hasCode('CONTROLLER_BUSY'));
  first.close();
  const second = f.open();
  assert.ok(second.createProject('다시 시작'));
});

test('실행 중 응답 유실은 같은 연결의 쓰기만 보류하고 조회는 허용한다', (t) => {
  const s = fixture(t).open(),
    x = setup(s);
  s.enqueue(x.p.id, command(x, 'lost'));
  s.lease(x.a.id);
  s.complete(x.a.id, 'lost', { state: 'unknown', result: null });
  assert.throws(() => s.enqueue(x.p.id, command(x, 'blocked')), hasCode('WRITE_UNCERTAIN'));
  s.enqueue(x.p.id, { ...command(x, 'read'), kind: 'sync' });
  assert.equal(s.lease(x.a.id).id, 'read');
  s.enqueue(x.p.id, command(x, 'other', x.b.id));
  assert.equal(s.lease(x.b.id).id, 'other');
});

test('새 전송 연결로 바꿔도 같은 네이티브 문서의 불명확 쓰기를 우회하지 못한다', (t) => {
  const s = fixture(t).open(),
    x = setup(s);
  s.enqueue(x.p.id, command(x, 'lost'));
  s.lease(x.a.id);
  s.disconnect(x.a.id);
  const next = s.registerConnection(x.p.id, {
    host: 'rhino',
    instanceId: x.a.instanceId,
    documentId: x.a.documentId,
  });
  const run = s.createRun(x.p.id, { goal: '재연결 뒤', targets: [next.id] });
  assert.throws(() => s.enqueue(x.p.id, { ...command(x, 'unsafe', next.id), runId: run.id }), {
    code: 'WRITE_UNCERTAIN',
  });
});

// Schema 5 store modules (T-045): data access for conversations, jigs and knowledge reviews.
test('대화·공급자 세션·원장 행은 재열기 뒤 보존되고 다른 프로젝트와 격리된다', async (t) => {
  const { ConversationStore } = await import('../../src/core/conversation-store.ts');
  const f = fixture(t);
  let s = f.open();
  const p = s.createProject('대화'),
    other = s.createProject('다른');
  let conversations = new ConversationStore(s.db);
  const c = conversations.create(p.id, {
    kind: 'model-edit',
    title: '기둥 옮기기',
    provider: 'claude-cli',
    model: 'opus',
    targets: ['link-a'],
  });
  assert.equal(c.state, 'open');
  assert.equal(c.mode, 'session');
  assert.deepEqual(c.targets, ['link-a']);
  assert.throws(() => conversations.get(other.id, c.id), { code: 'NOT_FOUND' });
  assert.throws(() =>
    conversations.create('missing', { kind: 'ask', title: 'x', provider: 'claude-cli' }),
  );
  assert.throws(() =>
    conversations.create(p.id, { kind: 'chat', title: 'x', provider: 'claude-cli' }),
  );
  assert.equal(conversations.update(p.id, c.id, { effort: 'high', targets: null }).effort, 'high');
  const key = {
    conversationId: c.id,
    provider: 'claude-cli',
    accountProfileId: 'a1',
    sessionId: 's1',
  };
  conversations.addSession({ ...key, promptMode: 'neutral', cliVersion: '2.1.0' });
  conversations.recordTurn(key, 1200);
  conversations.recordTurn(key, 800);
  const q = conversations.addLedgerItem(c.id, { kind: 'question', body: { text: '층고?' } });
  const a = conversations.addLedgerItem(c.id, {
    kind: 'answer',
    body: { text: '4.2 m' },
    requestId: 'r1',
  });
  conversations.supersede(c.id, q.id, a.id);
  // Requests carry their conversation in the input; the others are the default conversation.
  const insert = s.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)');
  insert.run('r0', p.id, '{}', 'succeeded', null, 't0');
  insert.run('r1', p.id, JSON.stringify({ conversationId: c.id }), 'succeeded', null, 't1');
  s.close();
  s = f.open();
  conversations = new ConversationStore(s.db);
  const saved = conversations.get(p.id, c.id);
  assert.equal(saved.effort, 'high');
  assert.equal(saved.targets, null);
  assert.equal(conversations.setState(p.id, c.id, 'closed').state, 'closed');
  assert.ok(conversations.get(p.id, c.id).closedAt);
  assert.deepEqual(conversations.list(p.id, 'open'), []);
  assert.equal(conversations.list(other.id).length, 0);
  const session = conversations.session(key);
  assert.equal(session.turns, 2);
  assert.equal(session.inputTokens, 2000);
  assert.equal(conversations.setSessionState(key, 'handed-off').state, 'handed-off');
  assert.deepEqual(conversations.sessions(c.id, 'active'), []);
  assert.deepEqual(
    conversations.ledger(c.id, { current: true }).map((item) => item.body),
    [{ text: '4.2 m' }],
  );
  assert.equal(conversations.ledger(c.id).length, 2);
  assert.deepEqual(conversations.requestIds(p.id, c.id), ['r1']);
  assert.deepEqual(conversations.requestIds(p.id, null), ['r0']);
  assert.throws(() => conversations.addLedgerItem('missing', { kind: 'code', body: '' }));
});

test('jig 설치·고정·작업본·설정값 기록·단계·읽기·만들기 기록 행을 읽고 쓴다', async (t) => {
  const { JigStore } = await import('../../src/core/jig-store.ts');
  const f = fixture(t);
  let s = f.open();
  const p = s.createProject('jig'),
    other = s.createProject('다른');
  let jigs = new JigStore(s.db);
  const pack = {
    id: 'project/s06-frame',
    version: '0.1.0',
    stage: 'project',
    source: 'dev-pack',
    digest: 'a'.repeat(64),
    path: 'jigs/installed/project/s06-frame@0.1.0',
    approvedCaps: ['host.read'],
  };
  jigs.addPackage(pack);
  assert.throws(() => jigs.addPackage({ ...pack, digest: 'b'.repeat(64) }), {
    code: 'JIG_VERSION_EXISTS',
  });
  jigs.pin(p.id, 'project/s06-frame', '0.1.0');
  assert.equal(jigs.pin(p.id, 'project/s06-frame', '0.1.1').version, '0.1.1');
  assert.equal(jigs.pinned(p.id).length, 1);
  const draft = jigs.createDraft(p.id, { path: 'jigs/drafts/d1', conversationId: 'c1' });
  assert.equal(jigs.updateDraft(p.id, draft.id, { state: 'archived' }).state, 'archived');
  const instance = jigs.createInstance(p.id, {
    jigId: 'project/s06-frame',
    version: '0.1.1',
    title: '골조',
    body: { layerRoot: 'VIDE', params: { spanMax: { value: 12, by: 'default' } } },
  });
  assert.equal(instance.status, 'new');
  assert.throws(() => jigs.instance(other.id, instance.id), { code: 'NOT_FOUND' });
  const first = jigs.appendParam(instance.id, { key: 'spanMax', old: 12, new: 10, by: 'user' });
  const second = jigs.appendParam(instance.id, {
    key: 'spanMax',
    old: 10,
    new: 9,
    by: 'ai',
    reason: '근거',
    requestId: 'r1',
  });
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  jigs.saveRun(instance.id, 'grid', { inputHash: 'h1', status: 'done', ms: 12, gates: [] });
  jigs.saveRun(instance.id, 'grid', { inputHash: 'h2', status: 'done', outputRef: 'o2' });
  jigs.saveRun(instance.id, 'columns', { inputHash: 'h3', status: 'done' });
  jigs.setRunStatus(instance.id, ['grid', 'columns'], 'stale');
  const read = jigs.addRead(instance.id, {
    linkId: 'link-a',
    revisionKey: 'rhino:1|1|7',
    layers: ['구조::기둥'],
    includeHidden: false,
    purpose: 'assembly',
    ref: 'jigs/reads/x.json.gz',
  });
  const bake = jigs.addBake(instance.id, {
    bakeId: 'columns',
    linkId: 'link-a',
    requestId: 'r2',
    runId: 'run-1',
    items: {
      'col:1-A': { nativeId: null, hash: null, layer: '기둥', runId: 'run-1', state: 'jig' },
    },
  });
  jigs.updateBake(instance.id, bake.id, { appliedAt: 't9', baselineReadId: read.id });
  jigs.updateInstance(p.id, instance.id, { status: 'computed', body: { layerRoot: 'VIDE' } });
  s.close();
  s = f.open();
  jigs = new JigStore(s.db);
  assert.deepEqual(jigs.package('project/s06-frame', '0.1.0').approvedCaps, ['host.read']);
  const saved = jigs.instance(p.id, instance.id);
  assert.equal(saved.status, 'computed');
  assert.deepEqual(saved.body, { layerRoot: 'VIDE' });
  assert.deepEqual(
    jigs.paramLog(instance.id).map((entry) => [entry.seq, entry.old, entry.new, entry.by]),
    [
      [1, 12, 10, 'user'],
      [2, 10, 9, 'ai'],
    ],
  );
  assert.equal(jigs.paramEntry(instance.id, 2).reason, '근거');
  assert.deepEqual(
    jigs.runs(instance.id).map((run) => [run.stepId, run.inputHash, run.status]),
    [
      ['grid', 'h2', 'stale'],
      ['columns', 'h3', 'stale'],
    ],
  );
  assert.equal(jigs.run(instance.id, 'grid').gates, null);
  const savedRead = jigs.read(instance.id, read.id);
  assert.equal(savedRead.includeHidden, false);
  assert.deepEqual(savedRead.layers, ['구조::기둥']);
  assert.equal(jigs.reads(instance.id, 'link-b').length, 0);
  const [savedBake] = jigs.bakes(instance.id, 'columns', 'link-a');
  assert.equal(savedBake.appliedAt, 't9');
  assert.equal(savedBake.baselineReadId, read.id);
  assert.equal(savedBake.items['col:1-A'].state, 'jig');
  assert.equal(jigs.drafts(p.id, 'archived').length, 1);
  assert.equal(jigs.instances(other.id).length, 0);
  // Rows of a missing instance or project are refused by the schema.
  assert.throws(() => jigs.appendParam('missing', { key: 'k', new: 1, by: 'user' }));
  assert.throws(() =>
    jigs.createInstance('missing', { jigId: 'j', version: '1', title: 't', body: {} }),
  );
  jigs.unpin(p.id, 'project/s06-frame');
  assert.deepEqual(jigs.pinned(p.id), []);
});

test('자료 검토·제외 규칙·프로젝트 루트는 프로젝트별 한 행이다', async (t) => {
  const { KnowledgeReviewStore } = await import('../../src/core/knowledge-review-store.ts');
  const s = fixture(t).open();
  const p = s.createProject('자료'),
    other = s.createProject('다른');
  const reviews = new KnowledgeReviewStore(s.db);
  reviews.setReview(p.id, 17, { verdict: 'confirmed', by: 'user' });
  const replaced = reviews.setReview(p.id, 17, {
    verdict: 'contaminated',
    reason: '다른 프로젝트 자료',
    by: 'user',
  });
  assert.equal(replaced.verdict, 'contaminated');
  reviews.setReview(p.id, 18, { verdict: 'superseded', supersededBy: 19, by: 'user' });
  assert.throws(() => reviews.setReview(p.id, 20, { verdict: 'maybe', by: 'user' }));
  assert.deepEqual(
    reviews.reviews(p.id).map((row) => [row.statementId, row.verdict]),
    [
      [17, 'contaminated'],
      [18, 'superseded'],
    ],
  );
  assert.equal(reviews.reviews(p.id, 'superseded')[0].supersededBy, 19);
  assert.throws(() => reviews.review(other.id, 17), { code: 'NOT_FOUND' });
  reviews.removeReview(p.id, 18);
  assert.equal(reviews.reviews(p.id).length, 1);
  reviews.addSourceRule(p.id, '*/archive/*', '옛 자료');
  reviews.addSourceRule(p.id, '*/archive/*', '보관');
  assert.deepEqual(reviews.sourceRules(p.id), [{ pattern: '*/archive/*', reason: '보관' }]);
  reviews.removeSourceRule(p.id, '*/archive/*');
  assert.deepEqual(reviews.sourceRules(p.id), []);
  assert.equal(reviews.roots(p.id), null);
  reviews.setRoots(p.id, { kdbRoot: 'D:/kdb' });
  assert.deepEqual(reviews.setRoots(p.id, { localRoot: 'D:/local' }), {
    kdbRoot: 'D:/kdb',
    localRoot: 'D:/local',
  });
  assert.equal(reviews.roots(other.id), null);
});

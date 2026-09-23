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

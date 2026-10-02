// 대시보드의 할 일 (SPEC-01.14, ARCH-01 §3, PLAN-26 T-098): the store and the routes, with
// [되돌리기] of a recorded AI write. Synthetic projects only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Agenda } from '../../src/core/agenda.ts';
import { startServer } from '../../src/server/server.ts';

async function storeOf(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-agenda-'));
  const store = new Store(join(directory, 'data.sqlite'));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

test('add, edit, finish, order and remove; stale revisions and other projects are refused', async (t) => {
  const store = await storeOf(t);
  const agenda = new Agenda(store, { now: () => new Date(2026, 9, 1, 10, 0) });
  const project = store.createProject('할 일'),
    other = store.createProject('다른');
  const a = agenda.add(project.id, { text: ' 구조 회의 ', date: '2026-10-02', time: '15:00' });
  assert.deepEqual(
    [a.text, a.date, a.time, a.done, a.source, a.revision],
    ['구조 회의', '2026-10-02', '15:00', false, 'user', 1],
  );
  // A time without a date is today's (the PC's local day).
  const b = agenda.add(project.id, { text: '자료 회신', time: '16:30' }, 'ai');
  assert.deepEqual([b.date, b.source], ['2026-10-01', 'ai']);
  const c = agenda.add(project.id, { text: '도면 정리' });
  assert.deepEqual(
    agenda.list(project.id).map((item) => item.text),
    ['구조 회의', '자료 회신', '도면 정리'],
  );
  for (const bad of [
    { text: '  ' },
    { text: 'x', date: '2026-02-30' },
    { text: 'x', time: '24:00' },
  ])
    assert.throws(() => agenda.add(project.id, bad), { code: 'INVALID_INPUT' });

  // Finishing keeps the item; a second edit with the old revision is a conflict.
  const done = agenda.set(project.id, c.id, { revision: 1, done: true });
  assert.equal(done.done, true);
  assert.equal(done.revision, 2);
  assert.ok(done.doneAt);
  assert.throws(() => agenda.set(project.id, c.id, { revision: 1, text: 'y' }), {
    code: 'REVISION_CONFLICT',
  });
  const reopened = agenda.set(project.id, c.id, { revision: 2, done: false, text: '도면 정리 2' });
  assert.deepEqual([reopened.done, reopened.doneAt, reopened.text], [false, null, '도면 정리 2']);
  // Clearing the date clears the time too.
  const undated = agenda.set(project.id, a.id, { revision: 1, date: null });
  assert.deepEqual([undated.date, undated.time], [null, null]);

  // Reordering a subset keeps the places of the others and does not move revisions.
  const ordered = agenda.order(project.id, { ids: [c.id, a.id] });
  assert.deepEqual(
    ordered.map((item) => item.text),
    ['도면 정리 2', '자료 회신', '구조 회의'],
  );
  assert.equal(ordered[0].revision, reopened.revision);
  assert.throws(() => agenda.order(project.id, { ids: [a.id, a.id] }), { code: 'INVALID_INPUT' });
  assert.throws(() => agenda.order(other.id, { ids: [a.id] }), { code: 'NOT_FOUND' });
  assert.throws(() => agenda.get(other.id, a.id), { code: 'NOT_FOUND' });

  assert.throws(() => agenda.remove(project.id, a.id, 1), { code: 'REVISION_CONFLICT' });
  assert.equal(agenda.remove(project.id, a.id).length, 2);
  agenda.set(project.id, b.id, { revision: 1, done: true });
  assert.deepEqual(
    agenda.removeDone(project.id).map((item) => item.text),
    ['도면 정리 2'],
  );

  // Deleting the project deletes its 할 일 (SPEC-01.1).
  agenda.add(other.id, { text: '남는 것' });
  store.deleteProject(project.id);
  assert.equal(
    store.db.prepare('SELECT count(*) AS n FROM agenda_items WHERE projectId=?').get(project.id).n,
    0,
  );
  assert.equal(agenda.list(other.id).length, 1);
});

test('over HTTP: the dashboard routes, and [되돌리기] of a recorded AI write once', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-agenda-http-'));
  const app = await startServer({ filename: join(directory, 'store.sqlite') });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
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
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const project = (await api('/projects', 'POST', { name: '할 일' })).json;
  const base = `/projects/${project.id}/agenda`;
  assert.deepEqual((await api(base)).json, { items: [] });
  const first = await api(base, 'POST', { text: '도면 제출', date: '2026-10-03' });
  assert.equal(first.status, 200);
  const second = (await api(base, 'POST', { text: '회의록 정리' })).json.item;
  const order = await api(`${base}/order`, 'POST', { ids: [second.id, first.json.item.id] });
  assert.deepEqual(
    order.json.items.map((item) => item.text),
    ['회의록 정리', '도면 제출'],
  );
  const checked = await api(`${base}/${second.id}`, 'PUT', { revision: 1, done: true });
  assert.equal(checked.json.item.done, true);
  assert.equal((await api(`${base}/${second.id}`, 'PUT', { revision: 1, text: 'x' })).status, 409);
  assert.equal((await api(`${base}/nope`, 'PUT', { revision: 1, text: 'x' })).status, 404);
  assert.equal((await api(base, 'POST', { text: '' })).status, 400);
  // No DELETE: removing is a POST like the folders.
  assert.equal((await api(`${base}/${second.id}`, 'DELETE')).status, 405);
  assert.deepEqual(
    (await api(`${base}/remove-done`, 'POST', {})).json.items.map((item) => item.text),
    ['도면 제출'],
  );
  assert.equal(
    (await api(`${base}/${first.json.item.id}/remove`, 'POST', {})).json.items.length,
    0,
  );

  // An AI write recorded in a conversation's ledger is taken back once.
  const conversation = (
    await api(`/projects/${project.id}/conversations`, 'POST', {
      kind: 'general',
      title: '일정',
      provider: 'codex-cli',
    })
  ).json;
  const added = (await api(base, 'POST', { text: '구조 회의', time: '15:00' })).json.item;
  const record = (
    await api(`/projects/${project.id}/conversations/${conversation.id}/ledger`, 'POST', {
      kind: 'result-ref',
      body: {
        appAction: 'agenda',
        by: 'ai',
        changes: [
          {
            op: 'add',
            id: added.id,
            text: added.text,
            date: added.date,
            time: '15:00',
            revision: 1,
          },
        ],
      },
    })
  ).json;
  const undo = await api(`${base}/undo`, 'POST', {
    conversationId: conversation.id,
    ledgerId: record.id,
  });
  assert.deepEqual([undo.status, undo.json.reverted, undo.json.items.length], [200, 1, 0]);
  const again = await api(`${base}/undo`, 'POST', {
    conversationId: conversation.id,
    ledgerId: record.id,
  });
  assert.deepEqual([again.status, again.json.code], [409, 'AGENDA_UNDONE']);
  const after = (await api(`/projects/${project.id}/conversations/${conversation.id}`)).json;
  assert.ok(!after.ledger.some((item) => item.id === record.id));
  assert.ok(after.ledger.some((item) => item.body?.appAction === 'agenda-undo'));
  // A ledger item that is not an agenda write is not undone here.
  const other = (
    await api(`/projects/${project.id}/conversations/${conversation.id}/ledger`, 'POST', {
      kind: 'result-ref',
      body: { appAction: 'ui_go', stage: 'model', by: 'ai' },
    })
  ).json;
  assert.equal(
    (await api(`${base}/undo`, 'POST', { conversationId: conversation.id, ledgerId: other.id }))
      .status,
    404,
  );

  // One turn's writes (two ledger items) go back with one [되돌리기], newest first.
  const write = async (changes) =>
    (
      await api(`/projects/${project.id}/conversations/${conversation.id}/ledger`, 'POST', {
        kind: 'result-ref',
        requestId: 'turn-b',
        body: { appAction: 'agenda', by: 'ai', changes },
      })
    ).json;
  const drawn = (await api(base, 'POST', { text: '도면 제출' })).json.item;
  const firstWrite = await write([
    { op: 'add', id: drawn.id, text: drawn.text, date: null, time: null, revision: 1 },
  ]);
  const changedNow = (
    await api(`${base}/${drawn.id}`, 'PUT', { revision: 1, text: '도면 제출 — 3장' })
  ).json.item;
  const secondWrite = await write([
    {
      op: 'set',
      id: drawn.id,
      text: changedNow.text,
      revision: changedNow.revision,
      before: { text: '도면 제출', date: null, time: null, doneAt: null },
    },
  ]);
  const both = await api(`${base}/undo`, 'POST', {
    conversationId: conversation.id,
    ledgerIds: [firstWrite.id, secondWrite.id],
  });
  assert.deepEqual(
    [both.status, both.json.reverted, both.json.skipped, both.json.items.length],
    [200, 2, 0, 0],
  );
  const twice = await api(`${base}/undo`, 'POST', {
    conversationId: conversation.id,
    ledgerIds: [firstWrite.id, secondWrite.id],
  });
  assert.deepEqual([twice.status, twice.json.code], [409, 'AGENDA_UNDONE']);
});

test('kinds (schema 8): 할 일 by default, 회의 and 마감 kept, and a date-only move keeps the time', async (t) => {
  const store = await storeOf(t);
  const agenda = new Agenda(store, { now: () => new Date(2026, 9, 1, 10, 0) });
  const project = store.createProject('달력');
  const plain = agenda.add(project.id, { text: '도면 정리' });
  assert.equal(plain.kind, 'task');
  const meeting = agenda.add(project.id, {
    text: '구조 회의',
    date: '2026-10-02',
    time: '15:00',
    kind: 'meeting',
  });
  assert.equal(meeting.kind, 'meeting');
  assert.throws(() => agenda.add(project.id, { text: 'x', kind: 'party' }), {
    code: 'INVALID_INPUT',
  });
  // The calendar's drag sends only the date: the time and kind stay.
  const moved = agenda.set(project.id, meeting.id, { revision: 1, date: '2026-10-05' });
  assert.deepEqual([moved.date, moved.time, moved.kind], ['2026-10-05', '15:00', 'meeting']);
  const due = agenda.set(project.id, plain.id, { revision: 1, kind: 'deadline' });
  assert.deepEqual([due.kind, due.text], ['deadline', '도면 정리']);
  // [되돌리기] restores a recorded kind; an older record without one leaves the kind as it is.
  agenda.revert(project.id, [
    {
      op: 'set',
      id: plain.id,
      text: due.text,
      revision: due.revision,
      before: { text: '도면 정리', date: null, time: null, doneAt: null, kind: 'task' },
    },
  ]);
  assert.equal(agenda.get(project.id, plain.id).kind, 'task');
  const again = agenda.set(project.id, plain.id, { revision: 3, kind: 'deadline' });
  agenda.revert(project.id, [
    {
      op: 'set',
      id: plain.id,
      text: again.text,
      revision: again.revision,
      before: { text: '도면 정리 이전', date: null, time: null, doneAt: null },
    },
  ]);
  assert.deepEqual(
    [agenda.get(project.id, plain.id).text, agenda.get(project.id, plain.id).kind],
    ['도면 정리 이전', 'deadline'],
  );
});

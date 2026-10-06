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

import { soleDb } from '../fixtures/store.mjs';
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
    soleDb(store)
      .prepare('SELECT count(*) AS n FROM agenda_items WHERE projectId=?')
      .get(project.id).n,
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

test('퇴근하기 (schema 10): today’s finished items go to the day log; again the same day adds to it', async (t) => {
  const store = await storeOf(t);
  let now = new Date(2026, 9, 5, 17, 0);
  const agenda = new Agenda(store, { now: () => now });
  const project = store.createProject('퇴근'),
    other = store.createProject('다른');
  // Finished yesterday: stays in the 완료 fold.
  const old = agenda.add(project.id, { text: '어제 끝낸 일', date: '2026-10-05' });
  agenda.set(project.id, old.id, { revision: 1, done: true });
  now = new Date(2026, 9, 6, 9, 0);
  const a = agenda.add(project.id, { text: '도면 정리', date: '2026-10-06' });
  const b = agenda.add(project.id, { text: '회의록 검토' });
  const later = agenda.add(project.id, {
    text: '설비 회의',
    date: '2026-10-07',
    time: '10:00',
    kind: 'meeting',
  });
  const loose = agenda.add(project.id, { text: '자료 찾기' });
  agenda.set(project.id, a.id, { revision: 1, done: true });
  agenda.set(project.id, b.id, { revision: 1, done: true });
  now = new Date(2026, 9, 6, 18, 30);
  const first = agenda.dayEnd(project.id);
  assert.equal(first.entry.date, '2026-10-06');
  assert.equal(first.entry.kind, 'day-end');
  assert.equal(first.entry.text, '2026-10-06 · 완료 2 · 도면 정리, 회의록 검토');
  assert.deepEqual(
    first.entry.body.done.map((item) => [item.id, item.text, item.kind]),
    [
      [a.id, '도면 정리', 'task'],
      [b.id, '회의록 검토', 'task'],
    ],
  );
  // Off the list: yesterday's finished one, tomorrow's and the open undated one stay.
  assert.deepEqual(
    first.items.map((item) => item.text),
    ['어제 끝낸 일', '설비 회의', '자료 찾기'],
  );
  assert.equal(agenda.get(project.id, later.id).time, '10:00');
  // Finishing one more and leaving again: the same day's entry grows.
  agenda.set(project.id, loose.id, { revision: 1, done: true });
  const second = agenda.dayEnd(project.id);
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(second.entry.text, '2026-10-06 · 완료 3 · 도면 정리, 회의록 검토, 자료 찾기');
  // Leaving with nothing new finished keeps the entry as it is.
  assert.equal(agenda.dayEnd(project.id).entry.body.done.length, 3);
  // The log by date, newest first; a bad date is refused.
  now = new Date(2026, 9, 7, 19, 0);
  agenda.set(project.id, later.id, { revision: 1, done: true });
  agenda.dayEnd(project.id);
  assert.deepEqual(
    agenda.log(project.id).map((entry) => entry.date),
    ['2026-10-07', '2026-10-06'],
  );
  assert.deepEqual(
    agenda.log(project.id, { from: '2026-10-07', to: '2026-10-07' }).map((entry) => entry.text),
    ['2026-10-07 · 완료 1 · 설비 회의'],
  );
  assert.deepEqual(agenda.log(other.id), []);
  assert.throws(() => agenda.log(project.id, { from: '10/7' }), { code: 'INVALID_INPUT' });
  // Deleting the project deletes its day log (SPEC-01.1).
  store.deleteProject(project.id);
  assert.equal(
    soleDb(store).prepare('SELECT count(*) AS n FROM day_log WHERE projectId=?').get(project.id).n,
    0,
  );
});

test('over HTTP: 퇴근하기 and the day log', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-agenda-dayend-'));
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
  const project = (await api('/projects', 'POST', { name: '퇴근' })).json;
  const base = `/projects/${project.id}/agenda`;
  const item = (await api(base, 'POST', { text: '도면 정리' })).json.item;
  await api(`${base}/${item.id}`, 'PUT', { revision: 1, done: true });
  const ended = await api(`${base}/day-end`, 'POST', {});
  assert.equal(ended.status, 200);
  assert.deepEqual(ended.json.items, []);
  assert.match(ended.json.entry.text, /^\d{4}-\d{2}-\d{2} · 완료 1 · 도면 정리$/);
  const day = ended.json.entry.date;
  const log = await api(`${base}/log?from=${day}&to=${day}`);
  assert.deepEqual(
    log.json.entries.map((entry) => entry.text),
    [ended.json.entry.text],
  );
  assert.equal((await api(`${base}/log?from=x`)).status, 400);
});

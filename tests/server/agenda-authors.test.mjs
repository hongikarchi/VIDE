// 할 일 작성자 (SPEC-01.14 12, SPEC-04.10 2, ARCH-01 §3, schema 17): every write is stamped with the
// VIDE account this engine is signed in to (never a request body), site edits keep the site
// account, earlier items stay without an author, and an id learnt later fills name-only records.
// Synthetic projects and a fake account site only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { Store } from '../../src/core/store.ts';
import { Agenda, setAgendaActor } from '../../src/core/agenda.ts';
import { agendaHandlers } from '../../src/server/agent-tools.ts';
import { agendaShare, applyAgendaEdit } from '../../src/server/offline-summary.ts';
import { startServer } from '../../src/server/server.ts';
import { RemoteAccess } from '../../src/server/remote-access.ts';
import { authorLine, avatarIndex, avatarInitial } from '../../src/contracts/account-avatar.ts';

async function storeOf(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-agenda-authors-'));
  const store = new Store(join(directory, 'data.sqlite'));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}
const kim = { id: null, name: 'kim' };

test('add, set and undo stamp the signed-in account; order, 퇴근하기 and an engine with no account do not', async (t) => {
  const store = await storeOf(t);
  let account = null;
  setAgendaActor(store, () => account);
  const agenda = new Agenda(store, { now: () => new Date(2026, 9, 8, 10, 0) });
  const project = store.createProject('작성자');
  // Signed in to no account (dev server, tests): nothing is recorded, never a guess.
  const none = agenda.add(project.id, { text: '이전 방식' });
  assert.deepEqual([none.createdBy, none.updatedBy], [null, null]);
  account = kim;
  const a = agenda.add(project.id, { text: '구조 회의', date: '2026-10-09' });
  assert.deepEqual(a.createdBy, kim);
  assert.deepEqual(a.updatedBy, kim);
  // Another account changes it: the editor moves, the author stays.
  account = { id: 'u-lee', name: 'lee' };
  const b = agenda.set(project.id, a.id, { revision: a.revision, time: '15:00' });
  assert.deepEqual(b.createdBy, kim);
  assert.deepEqual(b.updatedBy, { id: 'u-lee', name: 'lee' });
  // Reordering and 퇴근하기 leave both alone.
  account = { id: 'u-park', name: 'park' };
  agenda.order(project.id, { ids: [a.id, none.id] });
  assert.deepEqual(agenda.get(project.id, a.id).updatedBy, { id: 'u-lee', name: 'lee' });
  // The item made with no account gets an editor once someone known changes it, no author.
  const c = agenda.set(project.id, none.id, { revision: none.revision, done: true });
  assert.equal(c.createdBy, null);
  assert.deepEqual(c.updatedBy, { id: 'u-park', name: 'park' });
  agenda.dayEnd(project.id);
  // [되돌리기] of an AI write: whoever pressed it is the editor.
  account = kim;
  const ai = agenda.add(project.id, { text: '도면 제출' }, 'ai');
  const changed = agenda.set(project.id, ai.id, { revision: ai.revision, text: '도면 접수' });
  account = { id: 'u-lee', name: 'lee' };
  agenda.revert(project.id, [
    {
      op: 'set',
      id: ai.id,
      text: changed.text,
      revision: changed.revision,
      before: { text: '도면 제출', date: null, time: null, doneAt: null },
    },
  ]);
  const back = agenda.get(project.id, ai.id);
  assert.equal(back.text, '도면 제출');
  assert.deepEqual(back.createdBy, kim);
  assert.deepEqual(back.updatedBy, { id: 'u-lee', name: 'lee' });
  // The engine signed out: a change keeps the editor known before.
  account = null;
  const kept = agenda.set(project.id, ai.id, { revision: back.revision, text: '도면 접수 확인' });
  assert.deepEqual(kept.updatedBy, { id: 'u-lee', name: 'lee' });
});

test('an id learnt later fills only name-only records; earlier items stay empty', async (t) => {
  const store = await storeOf(t);
  let account = null;
  setAgendaActor(store, () => account);
  const agenda = new Agenda(store);
  const project = store.createProject('채우기');
  const before = agenda.add(project.id, { text: '이전 항목' });
  account = { id: null, name: 'Kim' };
  const offline = agenda.add(project.id, { text: '연결 끊긴 때' });
  account = { id: 'u-lee', name: 'lee' };
  const other = agenda.add(project.id, { text: '다른 계정' });
  agenda.fillAccountId(project.id, { id: 'u-kim', name: 'kim' });
  assert.deepEqual(agenda.get(project.id, offline.id).createdBy, { id: 'u-kim', name: 'Kim' });
  assert.deepEqual(agenda.get(project.id, offline.id).updatedBy, { id: 'u-kim', name: 'Kim' });
  assert.equal(agenda.get(project.id, before.id).createdBy, null);
  assert.deepEqual(agenda.get(project.id, other.id).createdBy, { id: 'u-lee', name: 'lee' });
  // The copy for the site carries the accounts and goes up again once an id is filled in.
  const share = agendaShare(store, agenda, project.id);
  assert.deepEqual(
    share.items().map((item) => item.createdBy?.name ?? null),
    [null, 'Kim', 'lee'],
  );
  account = { id: null, name: 'park' };
  agenda.add(project.id, { text: '박' });
  const key = agendaShare(store, agenda, project.id).key;
  store
    .db(project.id)
    .prepare("UPDATE agenda_items SET createdBy='u-park' WHERE createdByName='park'")
    .run();
  assert.notEqual(agendaShare(store, agenda, project.id).key, key);
});

test('site edits keep the site account: author, a later editor of a waiting add, and none from an older site', async (t) => {
  const store = await storeOf(t);
  // This PC is signed in as kim; a site edit is never recorded as kim.
  setAgendaActor(store, () => kim);
  const agenda = new Agenda(store);
  const project = store.createProject('사이트');
  const lee = { id: 'u-lee', name: 'lee' },
    park = { id: 'u-park', name: 'park' };
  const edit = (fields) => ({
    id: crypto.randomUUID(),
    projectId: project.id,
    itemId: 'site-1',
    baseRevision: null,
    editedAt: Date.now() + 1000,
    ...fields,
  });
  const added = applyAgendaEdit(
    agenda,
    edit({ op: 'add', fields: { text: '현장 점검' }, user: lee, editor: park }),
  );
  const item = agenda.get(project.id, added.itemId);
  assert.deepEqual([item.createdBy, item.updatedBy], [lee, park]);
  applyAgendaEdit(
    agenda,
    edit({
      op: 'set',
      itemId: item.id,
      baseRevision: item.revision,
      fields: { date: '2026-10-10' },
      user: lee,
    }),
  );
  assert.deepEqual(agenda.get(project.id, item.id).updatedBy, lee);
  // An older site names nobody: no author, and a change leaves the editor as it was.
  const old = applyAgendaEdit(agenda, edit({ op: 'add', fields: { text: '옛 사이트' } }));
  assert.deepEqual(agenda.get(project.id, old.itemId).createdBy, null);
  const now = agenda.get(project.id, item.id);
  applyAgendaEdit(
    agenda,
    edit({ op: 'set', itemId: item.id, baseRevision: now.revision, fields: { done: true } }),
  );
  assert.deepEqual(agenda.get(project.id, item.id).updatedBy, lee);
});

test('agenda_list gives the AI the author name', async (t) => {
  const store = await storeOf(t);
  setAgendaActor(store, () => kim);
  const agenda = new Agenda(store);
  const project = store.createProject('AI');
  agenda.add(project.id, { text: '구조 회의' });
  const handlers = agendaHandlers({ projectId: project.id, agenda });
  const listed = JSON.stringify(await handlers.agenda_list({}));
  assert.match(listed, /"author":"kim"/);
});

test('the avatar color and letter are fixed by the ID; the line names author and editor', () => {
  assert.equal(avatarIndex('kim'), avatarIndex('kim'));
  assert.ok([...'abcdefghij'].map(avatarIndex).every((index) => index >= 0 && index < 8));
  assert.ok(new Set(['kim', 'lee', 'park', 'choi', 'jung', 'kang'].map(avatarIndex)).size > 1);
  // FNV-1a 32-bit of '' is the offset basis 0x811c9dc5 (2166136261 % 8 = 5).
  assert.equal(avatarIndex(''), 5);
  assert.equal(avatarInitial(' kim'), 'K');
  assert.equal(authorLine(null, null), '작성자 정보 없음');
  assert.equal(authorLine({ name: 'kim' }, { name: 'kim' }), '작성 kim');
  assert.equal(authorLine({ name: 'kim' }, { name: 'lee' }), '작성 kim · 고침 lee');
  // An item older than authors keeps saying so after an edit; the editor is not shown as author.
  assert.equal(authorLine(null, { name: 'lee' }), '작성자 정보 없음 · 고침 lee');
});

function call(port, path, { method = 'GET', body, cookie, origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(data ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
          ...(origin ? { origin } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

test('over HTTP: a signed-in PC stamps its account, a body cannot name one, and the heartbeat id fills records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-agenda-authors-http-'));
  await writeFile(
    join(directory, 'remote-host.json'),
    JSON.stringify({
      workerOrigin: 'https://sharing.example',
      hostId: '356ff01d-b586-460c-8e2b-8c9f3c083e96',
      secret: randomBytes(32).toString('hex'),
      name: 'Studio PC',
      username: 'studio',
      remote: false,
    }),
  );
  // The site names the account only once `named` is set (a site before 0015 names nobody).
  let beats = 0,
    named = false;
  const app = await startServer({
    filename: join(directory, 'workspace.sqlite'),
    remoteOptions: {
      heartbeatMs: 40,
      fetcher: async (url) => {
        if (String(url).endsWith('/heartbeat')) beats++;
        return new Response(
          JSON.stringify({
            ok: true,
            projects: [],
            ...(named ? { account: { id: 'u-studio', username: 'studio' } } : {}),
          }),
          { status: 200 },
        );
      },
    },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const launch = new URL(app.launchUrl),
    port = Number(launch.port);
  const session = await call(port, '/api/v1/session', {
    method: 'POST',
    origin: launch.origin,
    body: { token: launch.hash.slice(1) },
  });
  const cookie = session.headers['set-cookie'][0].split(';')[0];
  const at = { cookie, origin: launch.origin };
  while (!beats) await new Promise((resolve) => setTimeout(resolve, 10));
  const created = await call(port, '/api/v1/projects', {
    ...at,
    method: 'POST',
    body: { name: '작성자' },
  });
  assert.equal(created.status < 300, true, created.text);
  const reply = JSON.parse(created.text);
  const projectId = reply.id ?? reply.project?.id;
  const base = `/api/v1/projects/${projectId}/agenda`;
  // A client cannot name the author.
  const forged = await call(port, base, {
    ...at,
    method: 'POST',
    body: { text: '위조', createdBy: { id: 'x', name: 'mallory' } },
  });
  assert.equal(forged.status, 400);
  const made = JSON.parse(
    (await call(port, base, { ...at, method: 'POST', body: { text: '구조 회의' } })).text,
  ).item;
  assert.deepEqual(made.createdBy, { id: null, name: 'studio' });
  // A heartbeat names the account id: it is kept on this PC and the record gets it.
  named = true;
  let state;
  do {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = JSON.parse((await call(port, '/api/v1/remote', at)).text);
  } while (!state.userId);
  assert.equal(state.userId, 'u-studio');
  const saved = JSON.parse(await readFile(join(directory, 'remote-host.json'), 'utf8'));
  assert.equal(saved.userId, 'u-studio');
  const items = JSON.parse((await call(port, base, at)).text).items;
  assert.deepEqual(items.find((item) => item.id === made.id).createdBy, {
    id: 'u-studio',
    name: 'studio',
  });
});

test('name-only records get the id again at the next start and heartbeat until every project is filled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-agenda-authors-fill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // This PC learnt the id at an earlier heartbeat, when one project could not be opened.
  await writeFile(
    join(directory, 'remote-host.json'),
    JSON.stringify({
      workerOrigin: 'https://sharing.example',
      hostId: '356ff01d-b586-460c-8e2b-8c9f3c083e96',
      secret: randomBytes(32).toString('hex'),
      name: 'Studio PC',
      username: 'studio',
      userId: 'u-studio',
      remote: false,
    }),
  );
  const fills = [];
  let opened = false;
  const remote = new RemoteAccess({
    directory,
    port: () => 1234,
    status: async () => ({}),
    heartbeatMs: 3_600_000,
    fetcher: async () =>
      new Response(
        JSON.stringify({ ok: true, projects: [], account: { id: 'u-studio', username: 'studio' } }),
        { status: 200 },
      ),
    onAccountId: (account) => {
      fills.push(account.id);
      return opened;
    },
  });
  t.after(() => remote.close());
  // The start tries again although the saved id already matches the site's.
  await remote.init();
  assert.equal(fills[0], 'u-studio');
  // …and so does the start's own first heartbeat.
  while (fills.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  const started = fills.length;
  // Still not filled: the next heartbeat tries again; once filled, later heartbeats do not.
  await remote.heartbeat();
  assert.equal(fills.length, started + 1);
  opened = true;
  await remote.heartbeat();
  assert.equal(fills.length, started + 2);
  await remote.heartbeat();
  assert.equal(fills.length, started + 2);
});

// Link choice, follow notice, cleanup and the link id stored in the document (SPEC-01.11 1,
// T-107, T-108, ADR-030). The ZWCAD connection list and its setLinkId answer are faked, several
// windows at once; the routes and DocumentLinks are real. One Rhino case runs the real editor
// channel with a faked attachedStatus that reports the stored id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { editorMethods } from '../../hosts/rhino/editor-channel.ts';
import { AttachedZwcadDocuments } from '../../hosts/zwcad/attached-documents.ts';
import { DocumentLinks, matchOpenDocuments } from '../../src/core/document-links.ts';
import { Store } from '../../src/core/store.ts';

const W1 = '11:22:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const W2 = '11:22:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function session(app) {
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
  return async (path, method = 'GET', data) => {
    const reply = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    const value = await reply.json();
    return Object.defineProperty(value, 'status', { value: reply.status, enumerable: false });
  };
}

/** ZWCAD windows the fake reports open: { instance, name, path, linkIds }. */
async function zwcadEngine(t, windows) {
  const root = await mkdtemp(join(tmpdir(), 'vide-link-choice-'));
  const executable = join(root, 'Rhino.exe');
  await writeFile(executable, '');
  const original = {
    list: AttachedZwcadDocuments.prototype.list,
    has: AttachedZwcadDocuments.prototype.has,
    setLinkId: AttachedZwcadDocuments.prototype.setLinkId,
  };
  const written = [];
  AttachedZwcadDocuments.prototype.list = async () =>
    windows.map((window) => ({
      instance: window.instance,
      id: 1,
      host: 'zwcad',
      connection: 'attached-editor',
      name: window.name,
      path: window.path,
      units: 'Millimeters',
      objectCount: 2,
      modified: false,
      generation: 1,
      live: false,
      hostBusy: false,
      ...(window.linkIds ? { linkIds: window.linkIds } : {}),
    }));
  AttachedZwcadDocuments.prototype.has = async (instance) =>
    windows.some((window) => window.instance === instance);
  AttachedZwcadDocuments.prototype.setLinkId = async (target, projectId, linkId) => {
    written.push({ ...target, projectId, linkId });
    const window = windows.find((item) => item.instance === target.instance);
    window.linkIds = [linkId];
    return { ok: true, linkIds: [linkId] };
  };
  const app = await startServer({
    filename: join(root, 'vide.db'),
    host: { status: async () => ({ available: true }) },
    sdkOptions: {
      directory: join(root, 'sdk-models'),
      executable,
      plugin: executable,
      bootstrap: executable,
      connectionDirectory: join(root, 'rhino-connections'),
    },
  });
  t.after(async () => {
    Object.assign(AttachedZwcadDocuments.prototype, original);
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const api = await session(app);
  const project = await api('/projects', 'POST', { name: 'p' });
  const insert = (id, name, path, instance, secondsAgo = 3600) => {
    const at = new Date(Date.now() - secondsAgo * 1000).toISOString();
    app.store.db
      .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
      .run(id, project.id, 'zwcad', name, path, instance, 1, at, at);
  };
  const sync = (id, linkId, state = 'succeeded') =>
    app.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
      id,
      project.id,
      JSON.stringify({
        id,
        linkId,
        provider: 'codex-cli',
        host: 'zwcad',
        source: 'document',
        permission: 'candidate',
        body: 'Sync',
        pins: [],
        sketches: [],
        files: [],
      }),
      state,
      JSON.stringify({ hostExecuted: true, host: 'zwcad' }),
      new Date().toISOString(),
    );
  return { app, api, project, insert, sync, written, base: `/projects/${project.id}/links` };
}

test('Link asks only when closed rows could be this drawing; the answer picks the row or a new one', async (t) => {
  const windows = [{ instance: W1, name: 'plan.dwg', path: 'D:\\w\\plan.dwg' }];
  const { app, api, insert, sync, base } = await zwcadEngine(t, windows);
  // Day 1's row of the same file, closed, with a Sync; an older unrelated row is no candidate.
  insert('day1', 'plan.dwg', 'D:\\w\\plan.dwg', '1:1:day-one');
  insert('other', 'site.dwg', 'D:\\w\\site.dwg', '1:1:day-zero', 86_400 * 3);
  sync('s1', 'day1');
  const asked = await api(base, 'POST', { host: 'zwcad', instance: W1, documentId: 1, ask: true });
  assert.equal(asked.status, 409);
  assert.equal(asked.code, 'LINK_CHOICE');
  assert.equal(asked.reason, 'closed');
  assert.equal(asked.default, 'day1');
  assert.deepEqual(
    asked.choices.map((choice) => [choice.id, choice.match, choice.syncs]),
    [['day1', 'path', 1]],
  );
  // Nothing changed before the answer (read directly: the list's own poll would reconnect day1
  // by path and say so, which the next test covers).
  assert.equal(
    app.store.db.prepare('SELECT instance FROM document_links WHERE id=?').get('day1').instance,
    '1:1:day-one',
  );
  const replaced = await api(base, 'POST', {
    host: 'zwcad',
    instance: W1,
    documentId: 1,
    ask: true,
    replace: 'day1',
  });
  assert.equal(replaced.status, 201);
  assert.equal(replaced.id, 'day1');
  assert.equal(replaced.instance, W1);
  const list = await api(base);
  assert.equal(list.find((row) => row.id === 'day1').lastSync.requestId, 's1');
  // The plugin now stores the id: the list says so once.
  assert.deepEqual(list.find((row) => row.id === 'day1').notice, { kind: 'stored' });
  await api(`${base}/day1/dismiss`, 'POST', {});
  assert.equal((await api(base)).find((row) => row.id === 'day1').notice, undefined);
  // The same window again: its own row, no question.
  const again = await api(base, 'POST', {
    host: 'zwcad',
    instance: W1,
    documentId: 1,
    ask: true,
    storedId: 'day1',
  });
  assert.equal(again.status, 201);
  assert.equal(again.id, 'day1');
});

test('[새 연결 파일로 추가] leaves the closed row and its history alone', async (t) => {
  const windows = [{ instance: W1, name: 'plan.dwg', path: 'D:\\w\\plan.dwg' }];
  const { api, insert, sync, base } = await zwcadEngine(t, windows);
  insert('day1', 'plan.dwg', 'D:\\w\\plan.dwg', '1:1:day-one');
  sync('s1', 'day1');
  const created = await api(base, 'POST', {
    host: 'zwcad',
    instance: W1,
    documentId: 1,
    ask: true,
    replace: 'new',
  });
  assert.equal(created.status, 201);
  assert.notEqual(created.id, 'day1');
  const list = await api(base);
  assert.deepEqual(
    list.map((row) => [row.id === 'day1' ? 'day1' : 'new', !!row.connection, !!row.lastSync]),
    [
      ['day1', false, true],
      ['new', true, false],
    ],
  );
});

test('unambiguous Links are unchanged; older plugins (no ask) still reconnect by path', async (t) => {
  const windows = [{ instance: W1, name: 'plan.dwg', path: 'D:\\w\\plan.dwg' }];
  const { api, insert, base } = await zwcadEngine(t, windows);
  const first = await api(base, 'POST', { host: 'zwcad', instance: W1, documentId: 1, ask: true });
  assert.equal(first.status, 201);
  // Nothing stored yet: the plugin stores the id and the list says so once.
  assert.deepEqual((await api(base))[0].notice, { kind: 'stored' });
  await api(`${base}/${first.id}/remove`, 'POST', {});
  insert('day1', 'plan.dwg', 'D:\\w\\plan.dwg', '1:1:day-one');
  const legacy = await api(base, 'POST', { host: 'zwcad', instance: W1, documentId: 1 });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.id, 'day1');
});

test('the id stored in the drawing wins over path and name: moved, renamed and restarted', async (t) => {
  // Day 2: the file was renamed and moved while closed; ZWCAD reports the stored id.
  const windows = [
    { instance: W1, name: 'plan-final.dwg', path: 'E:\\new\\plan-final.dwg', linkIds: ['day1'] },
  ];
  const { api, insert, base } = await zwcadEngine(t, windows);
  insert('day1', 'plan.dwg', 'D:\\w\\plan.dwg', '1:1:day-one');
  // A closed row of the new path exists too: the stored id still decides.
  insert('stray', 'plan-final.dwg', 'E:\\new\\plan-final.dwg', '1:1:day-zero');
  const list = await api(base);
  const day1 = list.find((row) => row.id === 'day1');
  assert.equal(!!day1.connection, true);
  assert.equal(day1.path, 'E:\\new\\plan-final.dwg');
  assert.equal(!!list.find((row) => row.id === 'stray').connection, false);
  // Matched by the stored id: no "따라감" notice for the reopen itself, only for the new file.
  assert.equal(day1.notice?.reason, 'renamed');
  // Link with the stored id: no question even though a closed row has this path.
  const linked = await api(base, 'POST', {
    host: 'zwcad',
    instance: W1,
    documentId: 1,
    ask: true,
    storedId: 'day1',
  });
  assert.equal(linked.status, 201);
  assert.equal(linked.id, 'day1');
});

test('a copy open in a second window with the same stored id is asked about, default new', async (t) => {
  const windows = [
    { instance: W1, name: 'plan.dwg', path: 'D:\\w\\plan.dwg', linkIds: [] },
    { instance: W2, name: 'plan-copy.dwg', path: 'D:\\w\\plan-copy.dwg', linkIds: [] },
  ];
  const { api, base } = await zwcadEngine(t, windows);
  const first = await api(base, 'POST', { host: 'zwcad', instance: W1, documentId: 1, ask: true });
  windows[0].linkIds = windows[1].linkIds = [first.id];
  // The second window's own GET does not take the row: its window is open.
  assert.deepEqual(
    (await api(base)).map((row) => [row.id, row.connection?.instance]),
    [[first.id, W1]],
  );
  const asked = await api(base, 'POST', {
    host: 'zwcad',
    instance: W2,
    documentId: 1,
    ask: true,
    storedId: first.id,
  });
  assert.equal(asked.status, 409);
  assert.equal(asked.reason, 'copy');
  assert.equal(asked.default, 'new');
  assert.deepEqual(
    asked.choices.map((choice) => [choice.id, choice.match]),
    [[first.id, 'stored']],
  );
  const second = await api(base, 'POST', {
    host: 'zwcad',
    instance: W2,
    documentId: 1,
    ask: true,
    storedId: first.id,
    replace: 'new',
  });
  assert.equal(second.status, 201);
  assert.notEqual(second.id, first.id);
  windows[1].linkIds = [second.id];
  assert.deepEqual(
    (await api(base)).map((row) => [row.name, row.connection?.instance]),
    [
      ['plan.dwg', W1],
      ['plan-copy.dwg', W2],
    ],
  );
});

test('a Save As shows "따라감" once; [새 항목으로 분리] gives the window a new row and keeps history', async (t) => {
  const windows = [{ instance: W1, name: 'A.dwg', path: 'D:\\w\\A.dwg' }];
  const { api, sync, base, written, project } = await zwcadEngine(t, windows);
  const linked = await api(base, 'POST', { host: 'zwcad', instance: W1, documentId: 1 });
  sync('s1', linked.id);
  Object.assign(windows[0], { name: 'B.dwg', path: 'D:\\w\\B.dwg', linkIds: [linked.id] });
  const followed = (await api(base))[0];
  assert.equal(followed.name, 'B.dwg');
  assert.deepEqual(followed.notice, {
    kind: 'followed',
    reason: 'renamed',
    from: 'A.dwg',
    to: 'B.dwg',
  });
  // A second Save As keeps where it came from.
  Object.assign(windows[0], { name: 'C.dwg', path: 'D:\\w\\C.dwg' });
  assert.equal((await api(base))[0].notice.from, 'A.dwg');
  const split = await api(`${base}/${linked.id}/split`, 'POST', {});
  assert.equal(split.status, 201);
  assert.equal(split.name, 'C.dwg');
  assert.equal(split.stored, true);
  assert.deepEqual(written, [
    { instance: W1, documentId: 1, projectId: project.id, linkId: split.id },
  ]);
  const list = await api(base);
  assert.deepEqual(
    list.map((row) => [row.id === linked.id ? 'old' : 'new', row.name, !!row.connection]),
    [
      ['old', 'A.dwg', false],
      ['new', 'C.dwg', true],
    ],
  );
  assert.equal(list.find((row) => row.id === linked.id).lastSync.requestId, 's1');
  assert.equal(
    list.every((row) => !row.notice && !row.cleanup?.kind?.startsWith('merge')),
    true,
  );
  // The notice is gone: splitting again is refused.
  assert.equal((await api(`${base}/${linked.id}/split`, 'POST', {})).status, 409);
});

test('a row reconnected by path to a reopened window says so once', async (t) => {
  const windows = [{ instance: W1, name: 'plan.dwg', path: 'D:\\w\\plan.dwg' }];
  const { api, insert, base } = await zwcadEngine(t, windows);
  insert('day1', 'plan.dwg', 'D:\\w\\plan.dwg', '1:1:day-one');
  const [row] = await api(base);
  assert.equal(row.connection?.instance, W1);
  assert.deepEqual(row.notice, {
    kind: 'followed',
    reason: 'reopened',
    from: 'plan.dwg',
    to: 'plan.dwg',
  });
  // [새 항목으로 분리]: the reopened window gets its own row, day1 goes back to its old window.
  const split = await api(`${base}/day1/split`, 'POST', {});
  const list = await api(base);
  assert.deepEqual(
    list.map((item) => [item.id, item.instance, !!item.connection]),
    [
      ['day1', '1:1:day-one', false],
      [split.id, W1, true],
    ],
  );
});

test('a closed duplicate of an open window merges into it; an empty closed row is offered out', async (t) => {
  const windows = [{ instance: W1, name: 'plan.dwg', path: 'D:\\w\\plan.dwg' }];
  const { app, api, insert, sync, base } = await zwcadEngine(t, windows);
  insert('day1', 'plan.dwg', 'D:\\w\\plan.dwg', '1:1:day-one');
  // A closed duplicate of this window (an earlier re-link) with history, and an empty closed row.
  insert('dup', 'plan-old.dwg', 'D:\\w\\plan-old.dwg', W1, 7200);
  insert('empty', 'x.dwg', 'D:\\w\\x.dwg', '1:1:gone', 7200);
  sync('s-dup', 'dup');
  sync('s-day1', 'day1');
  let list = await api(base);
  const byId = (id) => list.find((row) => row.id === id);
  // `dup` is this window's own row (session), so `day1` is not reattached by path.
  assert.equal(byId('dup').connection?.instance, W1);
  assert.equal(byId('day1').connection, null);
  assert.equal(byId('dup').notice?.reason, 'renamed');
  assert.equal(byId('empty').cleanup?.kind, 'empty');
  assert.equal(byId('day1').cleanup, undefined);
  // The window continues day1 (the answer at Link): Link detaches dup, a closed row with history
  // and no cleanup offer.
  await api(base, 'POST', { host: 'zwcad', instance: W1, documentId: 1, replace: 'day1' });
  list = await api(base);
  assert.equal(byId('day1').connection?.instance, W1);
  assert.equal(byId('dup').connection, null);
  assert.equal(byId('dup').cleanup, undefined);
  // An old duplicate of the same window (from before T-107) offers 합치기 into the open row.
  app.store.db
    .prepare('UPDATE document_links SET instance=?, path=? WHERE id=?')
    .run(W1, 'D:\\w\\plan-old.dwg', 'dup');
  list = await api(base);
  assert.deepEqual(byId('dup').cleanup, { kind: 'merge', into: 'day1', intoName: 'plan.dwg' });
  const merged = await api(`${base}/dup/merge`, 'POST', { into: 'day1' });
  assert.equal(merged.status, 200);
  assert.equal(merged.moved, 1);
  list = await api(base);
  assert.deepEqual(list.map((row) => row.id).sort(), ['day1', 'empty']);
  const requests = app.store.db
    .prepare("SELECT id FROM workspace_requests WHERE json_extract(input,'$.linkId')='day1'")
    .all()
    .map((row) => row.id)
    .sort();
  assert.deepEqual(requests, ['s-day1', 's-dup']);
  // A running request of the source refuses the merge.
  insert('dup2', 'p2.dwg', 'D:\\w\\p2.dwg', W1, 9000);
  sync('s-run', 'dup2', 'running');
  assert.equal((await api(`${base}/dup2/merge`, 'POST', { into: 'day1' })).status, 409);
});

test('matcher: session, then the stored id, then path; one row per open document', () => {
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  const row = (id, path, instance) => ({
    id,
    projectId: 'p',
    host: 'rhino',
    name: id,
    path,
    instance,
    documentId: 1,
    hidden: false,
    linkedAt: at(10),
    updatedAt: at(10),
  });
  const matched = matchOpenDocuments(
    [row('stored', 'C:\\old.3dm', 'gone'), row('byPath', 'C:\\new.3dm', 'gone2')],
    [
      {
        host: 'rhino',
        instance: 'w',
        id: 1,
        name: 'new.3dm',
        path: 'C:\\new.3dm',
        linkIds: ['stored'],
      },
    ],
  );
  assert.deepEqual(
    [...matched].map(([id, entry]) => [id, entry.how]),
    [['stored', 'stored']],
  );
  // The same id open in two windows: only the first one takes the row.
  const two = matchOpenDocuments(
    [row('x', 'C:\\x.3dm', 'gone')],
    [
      { host: 'rhino', instance: 'a', id: 1, name: 'x.3dm', linkIds: ['x'] },
      { host: 'rhino', instance: 'b', id: 1, name: 'x.3dm', linkIds: ['x'] },
    ],
  );
  assert.deepEqual(
    [...two.values()].map((entry) => entry.document.instance),
    ['a'],
  );
});

test('DocumentLinks: replace with an unknown row is NOT_FOUND; split needs a follow notice', () => {
  const store = new Store(':memory:');
  const p = store.createProject('P').id;
  const links = new DocumentLinks(store.db);
  assert.throws(
    () =>
      links.link(p, {
        host: 'rhino',
        name: 'a.3dm',
        instance: 'i',
        documentId: 1,
        replace: 'nope',
      }),
    /NOT_FOUND/,
  );
  const row = links.link(p, { host: 'rhino', name: 'a.3dm', instance: 'i', documentId: 1 });
  assert.throws(() => links.split(p, row.id), /STALE_REFERENCE/);
  // A first save (no earlier path) is no "따라감" notice.
  links.follow(p, row.id, {
    host: 'rhino',
    instance: 'i',
    id: 1,
    name: 'a.3dm',
    path: 'C:\\a.3dm',
  });
  assert.equal(links.notice(row.id), undefined);
});

test('Rhino: the stored id comes through attachedStatus and [분리] writes the new id with setLinkId', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vide-link-choice-rhino-'));
  const connections = join(root, 'rhino-connections');
  await mkdir(connections, { recursive: true });
  const executable = join(root, 'Rhino.exe');
  await writeFile(executable, '');
  const document = { name: 'A.3dm', path: 'C:\\p\\A.3dm', linkIds: [] };
  const calls = [];
  const call = async (method, params) => {
    calls.push([method, params]);
    if (method === 'setLinkId') {
      document.linkIds = [params.linkId];
      return { ok: true, linkIds: document.linkIds };
    }
    return method === 'attachedStatus'
      ? {
          ok: true,
          documentId: 7,
          name: document.name,
          path: document.path,
          units: 'Meters',
          objectCount: 3,
          modified: false,
          generation: 1,
          live: false,
          busy: false,
          linkIds: document.linkIds,
        }
      : { ok: false, code: 'UNSUPPORTED_METHOD' };
  };
  const identity = {
    port: 45123,
    pid: 4321,
    startTicks: '99',
    sessionId: randomUUID(),
    documentId: 7,
    revision: 0,
  };
  await writeFile(
    join(connections, identity.sessionId + '.json'),
    JSON.stringify({ identity, token: 'b'.repeat(64), executable }),
  );
  const app = await startServer({
    filename: join(root, 'vide.db'),
    host: { status: async () => ({ available: true }) },
    sdkOptions: {
      directory: join(root, 'sdk-models'),
      executable,
      plugin: executable,
      bootstrap: executable,
      connectionDirectory: connections,
      resume: (connection) => ({
        ...editorMethods(call),
        identity: connection.identity,
        editorConnection: connection,
      }),
    },
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const api = await session(app);
  const project = await api('/projects', 'POST', { name: 'p' });
  const base = `/projects/${project.id}/links`;
  const instance = `${identity.pid}:${identity.startTicks}:${identity.sessionId}`;
  // A closed row from yesterday whose id the document stores, under another path.
  const at = new Date(Date.now() - 86_400_000).toISOString();
  app.store.db
    .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
    .run('kept', project.id, 'rhino', 'Old.3dm', 'C:\\old\\Old.3dm', '1:1:gone', 7, at, at);
  document.linkIds = ['kept'];
  const list = await api(base);
  assert.deepEqual(
    list.map((row) => [row.id, row.name, row.connection?.instance]),
    [['kept', 'A.3dm', instance]],
  );
  const split = await api(`${base}/kept/split`, 'POST', {});
  assert.equal(split.stored, true);
  assert.deepEqual(
    calls.filter(([method]) => method === 'setLinkId').map(([, params]) => params),
    [{ projectId: project.id, linkId: split.id }],
  );
  assert.deepEqual(
    (await api(base)).map((row) => [row.name, !!row.connection]),
    [
      ['Old.3dm', false],
      ['A.3dm', true],
    ],
  );
});

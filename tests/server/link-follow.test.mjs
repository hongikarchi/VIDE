// A linked window saved under another name (SPEC-01.11 1, T-095): the link follows the window, a
// second Link of the same window updates its row, and one open window shows as one connected row.
// The Rhino worker's attachedStatus reply and the ZWCAD connection list are faked; the routes,
// EditorSessions and the editor channel are real.
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

async function rhinoEngine(t, document) {
  const root = await mkdtemp(join(tmpdir(), 'vide-link-follow-'));
  const connections = join(root, 'rhino-connections');
  await mkdir(connections, { recursive: true });
  const executable = join(root, 'Rhino.exe'),
    plugin = join(root, 'vide.rhp'),
    bootstrap = join(root, 'bootstrap.exe');
  for (const file of [executable, plugin, bootstrap]) await writeFile(file, '');
  const call = async (method) =>
    method === 'attachedStatus'
      ? {
          ok: true,
          documentId: 7,
          name: document.name,
          path: document.path,
          units: 'Meters',
          objectCount: 3,
          modified: false,
          generation: document.generation,
          live: true,
          busy: false,
        }
      : { ok: false, code: 'UNSUPPORTED_METHOD' };
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
      plugin,
      bootstrap,
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
  return {
    app,
    api: await session(app),
    instance: `${identity.pid}:${identity.startTicks}:${identity.sessionId}`,
  };
}
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
    return reply.json();
  };
}
const rows = (list) =>
  list.map((row) => [row.name, row.path, !!row.connection]).sort((a, b) => (a[0] < b[0] ? -1 : 1));

test('Save As: the linked row follows the window, keeps its Sync and a second Link adds no row', async (t) => {
  const document = { name: 'A.3dm', path: 'C:\\p\\A.3dm', generation: 1 };
  const { app, api, instance } = await rhinoEngine(t, document);
  const project = await api('/projects', 'POST', { name: 'p' });
  const linked = await api(`/projects/${project.id}/links`, 'POST', {
    host: 'rhino',
    instance,
    documentId: 7,
  });
  assert.equal(linked.path, 'C:\\p\\A.3dm');
  // Its Sync stays with the row after the rename.
  app.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
    'sync-a',
    project.id,
    JSON.stringify({
      id: 'sync-a',
      linkId: linked.id,
      provider: 'codex-cli',
      host: 'rhino',
      source: 'document',
      permission: 'candidate',
      body: 'Sync',
      pins: [],
      sketches: [],
      files: [],
    }),
    'succeeded',
    JSON.stringify({ hostExecuted: true, host: 'rhino' }),
    new Date().toISOString(),
  );
  Object.assign(document, { name: 'B.3dm', path: 'C:\\p\\B.3dm', generation: 2 });
  const after = await api(`/projects/${project.id}/links`);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, linked.id);
  assert.equal(after[0].name, 'B.3dm');
  assert.equal(after[0].path, 'C:\\p\\B.3dm');
  assert.equal(after[0].connection?.generation, 2);
  assert.equal(after[0].lastSync?.requestId, 'sync-a');
  // Kept in the row, not only in the reply.
  assert.equal(new DocumentLinks(app.store.db).get(project.id, linked.id).path, 'C:\\p\\B.3dm');
  const again = await api(`/projects/${project.id}/links`, 'POST', {
    host: 'rhino',
    instance,
    documentId: 7,
  });
  assert.equal(again.id, linked.id);
  assert.deepEqual(rows(await api(`/projects/${project.id}/links`)), [
    ['B.3dm', 'C:\\p\\B.3dm', true],
  ]);
});

test('first save of an untitled document names the row after the file; a plain Save changes nothing', async (t) => {
  const document = { name: 'Untitled', path: '', generation: 1 };
  const { api, instance } = await rhinoEngine(t, document);
  const project = await api('/projects', 'POST', { name: 'p' });
  const target = { host: 'rhino', instance, documentId: 7 };
  const linked = await api(`/projects/${project.id}/links`, 'POST', target);
  assert.equal(linked.path, null);
  Object.assign(document, { name: 'C.3dm', path: 'C:\\p\\C.3dm', generation: 2 });
  assert.deepEqual(rows(await api(`/projects/${project.id}/links`)), [
    ['C.3dm', 'C:\\p\\C.3dm', true],
  ]);
  await api(`/projects/${project.id}/links`, 'POST', target);
  document.generation = 3;
  const list = await api(`/projects/${project.id}/links`);
  assert.deepEqual(rows(list), [['C.3dm', 'C:\\p\\C.3dm', true]]);
  assert.equal(list[0].id, linked.id);
});

test('duplicate rows of one window from earlier re-links: one connected row, the rest closed', async (t) => {
  const document = { name: 'B.3dm', path: 'C:\\p\\B.3dm', generation: 4 };
  const { app, api, instance } = await rhinoEngine(t, document);
  const project = await api('/projects', 'POST', { name: 'p' });
  const insert = (id, name, path, s) => {
    const at = new Date(Date.now() - s * 1000).toISOString();
    app.store.db
      .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
      .run(id, project.id, 'rhino', name, path, instance, 7, at, at);
  };
  // Before this fix: Link of A.3dm, Save As B.3dm, Link again (a second row, same window).
  insert('old', 'A.3dm', 'C:\\p\\A.3dm', 60);
  insert('new', 'B.3dm', 'C:\\p\\B.3dm', 30);
  // Untitled then saved and linked again: both rows of one window, neither path matches yet.
  const list = await api(`/projects/${project.id}/links`);
  assert.deepEqual(
    list.map((row) => [row.id, row.name, !!row.connection]),
    [
      ['old', 'A.3dm', false],
      ['new', 'B.3dm', true],
    ],
  );
  // A further Save As moves the live row only; the closed one keeps its old file.
  Object.assign(document, { name: 'D.3dm', path: 'C:\\p\\D.3dm' });
  assert.deepEqual(
    (await api(`/projects/${project.id}/links`)).map((row) => [row.id, row.name, !!row.connection]),
    [
      ['old', 'A.3dm', false],
      ['new', 'D.3dm', true],
    ],
  );
});

test('a closed row reconnects by path only when no row of that window exists', () => {
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  const row = (id, path, instance, s = 10) => ({
    id,
    projectId: 'p',
    host: 'rhino',
    name: id,
    path,
    instance,
    documentId: 1,
    hidden: false,
    linkedAt: at(s),
    updatedAt: at(s),
  });
  // The file reopened in a new Rhino window (new session): its old row is that file again.
  const reopened = matchOpenDocuments(
    [row('a', 'C:\\p\\a.3dm', 'old-session')],
    [{ host: 'rhino', instance: 'new-session', id: 1, name: 'a.3dm', path: 'c:\\P\\A.3dm' }],
  );
  assert.equal(reopened.get('a')?.session, false);
  // A row whose own window is still open is not taken by another window of the same path.
  const taken = matchOpenDocuments(
    [row('a', 'C:\\p\\a.3dm', 'one'), row('b', 'C:\\p\\b.3dm', 'two')],
    [
      { host: 'rhino', instance: 'one', id: 1, name: 'b.3dm', path: 'C:\\p\\b.3dm' },
      { host: 'rhino', instance: 'two', id: 1, name: 'c.3dm', path: 'C:\\p\\c.3dm' },
    ],
  );
  assert.deepEqual(
    [...taken].map(([id, entry]) => [id, entry.document.instance, entry.session]),
    [
      ['a', 'one', true],
      ['b', 'two', true],
    ],
  );
  // Same window, two rows: the one with the current path wins over the newer one.
  const pick = matchOpenDocuments(
    [row('x', 'C:\\p\\x.3dm', 'w', 5), row('y', 'C:\\p\\y.3dm', 'w', 50)],
    [{ host: 'rhino', instance: 'w', id: 1, name: 'y.3dm', path: 'C:\\p\\y.3dm' }],
  );
  assert.deepEqual([...pick.keys()], ['y']);
  // File items ("파일에서 열기") never take an open window.
  assert.equal(
    matchOpenDocuments(
      [{ ...row('f', null, 'file:a.3dm'), name: 'a.3dm' }],
      [{ host: 'rhino', instance: 'file:a.3dm', id: 1, name: 'a.3dm' }],
    ).size,
    0,
  );
});

test('DocumentLinks: Link looks up the window first and never renames a file item', () => {
  const store = new Store(':memory:');
  const p = store.createProject('P').id;
  const links = new DocumentLinks(store.db);
  const first = links.link(p, {
    host: 'zwcad',
    name: 'Drawing1.dwg',
    path: 'Drawing1.dwg',
    instance: 'i',
    documentId: 1,
  });
  // An unsaved ZWCAD drawing has a name but no folder: no path.
  assert.equal(first.path, null);
  const saved = links.link(p, {
    host: 'zwcad',
    name: 'plan.dwg',
    path: 'D:\\w\\plan.dwg',
    instance: 'i',
    documentId: 1,
  });
  assert.equal(saved.id, first.id);
  assert.equal(saved.path, 'D:\\w\\plan.dwg');
  const file = links.fileLink(p, 'rhino', 'site.3dm');
  assert.equal(links.follow(p, file.id, { name: 'x.3dm', path: 'C:\\x.3dm' }).name, 'site.3dm');
  assert.equal(links.list(p).length, 2);
});

test('ZWCAD Save As and first save follow the window as well', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vide-link-follow-cad-'));
  const executable = join(root, 'Rhino.exe');
  await writeFile(executable, '');
  const drawing = { name: 'Drawing1.dwg', path: 'Drawing1.dwg' };
  const original = {
    list: AttachedZwcadDocuments.prototype.list,
    has: AttachedZwcadDocuments.prototype.has,
  };
  AttachedZwcadDocuments.prototype.list = async () => [
    {
      instance: '11:22:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      id: 1,
      host: 'zwcad',
      connection: 'attached-editor',
      name: drawing.name,
      path: drawing.path,
      units: 'Millimeters',
      objectCount: 2,
      modified: false,
      generation: 1,
      live: false,
      hostBusy: false,
    },
  ];
  AttachedZwcadDocuments.prototype.has = async (instance) =>
    instance === '11:22:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
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
  const target = {
    host: 'zwcad',
    instance: '11:22:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    documentId: 1,
  };
  const linked = await api(`/projects/${project.id}/links`, 'POST', target);
  assert.equal(linked.path, null);
  Object.assign(drawing, { name: 'plan.dwg', path: 'D:\\w\\plan.dwg' });
  assert.deepEqual(rows(await api(`/projects/${project.id}/links`)), [
    ['plan.dwg', 'D:\\w\\plan.dwg', true],
  ]);
  Object.assign(drawing, { name: 'plan-b.dwg', path: 'D:\\w\\plan-b.dwg' });
  await api(`/projects/${project.id}/links`, 'POST', target);
  const list = await api(`/projects/${project.id}/links`);
  assert.deepEqual(rows(list), [['plan-b.dwg', 'D:\\w\\plan-b.dwg', true]]);
  assert.equal(list[0].id, linked.id);
});

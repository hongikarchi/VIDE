// Files opened in VIDE ("파일에서 열기") are linked files too (SPEC-01.11): listed with kind "file",
// the same name updates the same entry, older imports join once (hidden), and removing one keeps it
// removed: its records and VIDE's copies are deleted, the user's file is not (SPEC-01.11 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { importModel } from '../../src/server/import-model.ts';
import { startServer } from '../../src/server/server.ts';
import { removeLink } from '../../src/server/link-removal.ts';

import { soleDb } from '../fixtures/store.mjs';
const upload = (bytes) =>
  Object.assign(Readable.from([bytes]), {
    headers: { 'content-type': 'application/octet-stream' },
  });

test('opening a file lists it as a linked file; the same name reuses the entry', async () => {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    links = new DocumentLinks(store),
    project = store.createProject('P');
  const directory = await mkdtemp(join(tmpdir(), 'vide-file-link-'));
  const cad = { directory, importFile: async () => ({ objects: [], scene: [], verified: true }) };
  try {
    const first = await importModel(
      upload(Buffer.from('AC1032x')),
      project.id,
      'Plan.dwg',
      workspace,
      {},
      cad,
      links,
    );
    const [link] = links.list(project.id);
    assert.equal(link.name, 'Plan.dwg');
    assert.equal(link.host, 'zwcad');
    assert.equal(first.input.linkId, link.id);
    links.setHidden(project.id, link.id, true);
    const again = await importModel(
      upload(Buffer.from('AC1032x')),
      project.id,
      'plan.DWG',
      workspace,
      {},
      cad,
      links,
    );
    assert.equal(links.list(project.id).length, 1);
    assert.equal(again.input.linkId, link.id);
    // Opening it again shows it.
    assert.equal(links.get(project.id, link.id).hidden, false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('older imports join the list hidden once; removing a file deletes its records and copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-file-link-http-'));
  const app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  try {
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
      const reply = await fetch(app.origin + '/api/v1' + path, {
        method,
        headers,
        body: data ? JSON.stringify(data) : undefined,
      });
      return reply.json();
    };
    const project = await api('/projects', 'POST', { name: 'A' });
    // An import from before files were listed (no linkId).
    const input = (id) => ({
      id,
      provider: 'codex-cli',
      host: 'rhino',
      source: 'file',
      permission: 'candidate',
      body: 'old.3dm 불러오기',
      pins: [],
      sketches: [],
      files: [],
    });
    // VIDE's own copies of the import: its work folder and the upload.
    const work = join(directory, 'rhino-sdk', 'old-work');
    await mkdir(work, { recursive: true });
    await writeFile(join(work, 'model.3dm'), 'copy');
    const uploads = join(directory, 'models', project.id);
    await mkdir(uploads, { recursive: true });
    await writeFile(join(uploads, 'old-import.upload.3dm'), 'upload');
    const insert = (id, workerDirectory) =>
      soleDb(app.store)
        .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
        .run(
          id,
          project.id,
          JSON.stringify(input(id)),
          'succeeded',
          JSON.stringify({
            host: 'rhino',
            hostExecuted: true,
            objects: [],
            scene: [],
            ...(workerDirectory ? { workerDirectory } : {}),
          }),
          new Date().toISOString(),
        );
    insert('published-import');
    insert('old-import', work);
    // A web publication points at one import: that record is kept (hidden), not deleted.
    soleDb(app.store)
      .prepare('INSERT INTO publication_exports VALUES(?,?,?,?,?)')
      .run('pub', project.id, 'published-import', 'm', 's');
    const [file] = await api(`/projects/${project.id}/links`);
    assert.equal(file.kind, 'file');
    assert.equal(file.name, 'old.3dm');
    assert.equal(file.hidden, true);
    assert.equal(file.lastSync.requestId, 'old-import');
    assert.equal(file.connection, null);
    // Listing again does not add it twice.
    assert.equal((await api(`/projects/${project.id}/links`)).length, 1);
    const removed = await api(`/projects/${project.id}/links/${file.id}/remove`, 'POST', {});
    assert.deepEqual(removed.requestIds.sort(), ['old-import', 'published-import']);
    assert.equal(removed.deleted, 1);
    assert.deepEqual(await api(`/projects/${project.id}/links`), []);
    const rows = soleDb(app.store)
      .prepare('SELECT id FROM workspace_requests WHERE projectId=?')
      .all(project.id)
      .map((row) => row.id);
    assert.deepEqual(rows, ['published-import']);
    assert.equal(existsSync(work), false);
    assert.equal(existsSync(join(uploads, 'old-import.upload.3dm')), false);
    const history = await api(`/projects/${project.id}/requests`);
    assert.equal(
      history.some((row) => ['old-import', 'published-import'].includes(row.id)),
      false,
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a file whose Sync is running is not removed', async () => {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    links = new DocumentLinks(store),
    project = store.createProject('P');
  try {
    const link = links.fileLink(project.id, 'rhino', 'a.3dm');
    soleDb(store)
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        'running',
        project.id,
        JSON.stringify({
          id: 'running',
          linkId: link.id,
          provider: 'codex-cli',
          host: 'rhino',
          source: 'file',
          permission: 'candidate',
          body: 'a.3dm 불러오기',
          pins: [],
          sketches: [],
          files: [],
        }),
        'running',
        null,
        new Date().toISOString(),
      );
    await assert.rejects(
      removeLink({
        projectId: project.id,
        linkId: link.id,
        links,
        workspace,
        importDirectories: [],
        projects: () => store.listProjects(),
      }),
      { code: 'PROJECT_BUSY' },
    );
    assert.equal(links.list(project.id).length, 1);
    assert.equal(workspace.list(project.id).length, 1);
  } finally {
    store.close();
  }
});

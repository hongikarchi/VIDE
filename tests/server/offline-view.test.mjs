// PLAN-20: the PC side of the offline view — uploads only for projects the owner turned on, only
// when a linked file has a newer Sync (at most every 10 minutes), removal when turned off, and an
// inbox for requests left on the site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { OfflineView } from '../../src/server/offline-view.ts';
import { decodeSnapshot } from '../../src/contracts/offline-snapshot.ts';

import { soleDb } from '../fixtures/store.mjs';
test('offline view uploads changed linked files of enabled projects and keeps an inbox', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-offline-'));
  const app = await startServer({ filename: join(directory, 'test.sqlite') });
  try {
    const store = app.store;
    const project = store.createProject('Tower');
    const links = new DocumentLinks(store);
    const link = links.link(project.id, {
      host: 'zwcad',
      name: 'plan.dwg',
      path: 'C:/work/plan.dwg',
      instance: '1:1',
      documentId: 1,
    });
    let clock = Date.parse('2026-09-29T00:00:00Z');
    const uploads = [],
      removed = [];
    const offline = new OfflineView({
      directory,
      store,
      workspace: new Workspace(store),
      links,
      remote: {
        hostId: 'host-1',
        uploadSnapshot: async (projectId, linkId, meta, bytes) => {
          uploads.push({ projectId, linkId, meta, bytes });
          return undefined;
        },
        deleteSnapshot: async (projectId, linkId) => {
          removed.push({ projectId, linkId });
          return true;
        },
      },
      now: () => clock,
    });
    const sync = (id, x) => {
      const input = {
        id,
        provider: 'codex-cli',
        host: 'zwcad',
        source: 'document',
        permission: 'candidate',
        body: 'sync',
        pins: [],
        sketches: [],
        files: [],
        linkId: link.id,
      };
      const result = {
        host: 'zwcad',
        hostExecuted: true,
        displayOnly: true,
        objects: [{ id: 'a' }],
        scene: [{ id: 'a', segments: [x, 0, 0, x + 1, 0, 0], layer64: 'QQ==' }],
        sourceDocument: { name: 'plan.dwg', capturedAt: new Date(clock).toISOString() },
      };
      soleDb(store)
        .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
        .run(
          id,
          project.id,
          JSON.stringify(input),
          'succeeded',
          JSON.stringify(result),
          new Date(clock).toISOString(),
        );
    };
    sync('s1', 0);
    // Off by default: nothing leaves the PC.
    await offline.tick();
    assert.equal(uploads.length, 0);
    assert.equal((await offline.status(project.id)).enabled, false);
    await offline.setEnabled(project.id, true);
    await offline.tick(true);
    assert.equal(uploads.length, 1);
    const snapshot = decodeSnapshot(gunzipSync(uploads[0].bytes));
    assert.equal(snapshot.name, 'plan.dwg');
    assert.equal(snapshot.groups[0].layer, 'A');
    let status = await offline.status(project.id);
    assert.equal(status.files[0].upToDate, true);
    // The same Sync is not sent again; a newer one waits for the 10-minute interval.
    await offline.tick();
    sync('s2', 5);
    await offline.tick();
    assert.equal(uploads.length, 1);
    assert.equal((await offline.status(project.id)).files[0].upToDate, false);
    clock += 11 * 60_000;
    await offline.tick();
    assert.equal(uploads.length, 2);
    // A Live Sync fixes s2 in place (same id, a higher list revision): sent again after the interval.
    const manifest = store
      .db(project.id)
      .prepare(
        'INSERT INTO sync_manifests(requestId,projectId,revision,updatedAt) VALUES(?,?,?,?) ON CONFLICT(requestId) DO UPDATE SET revision=excluded.revision',
      );
    manifest.run('s2', project.id, 2, new Date(clock).toISOString());
    assert.equal((await offline.status(project.id)).files[0].upToDate, false);
    clock += 11 * 60_000;
    await offline.tick();
    assert.equal(uploads.length, 3);
    assert.equal((await offline.status(project.id)).files[0].upToDate, true);
    // Requests from the site: kept once, dismissed by the user.
    const item = {
      id: crypto.randomUUID(),
      projectId: project.id,
      linkId: link.id,
      body: '보 단면 바꿔줘',
      createdAt: clock,
    };
    assert.deepEqual(await offline.receive([item]), [item.id]);
    await offline.receive([item]);
    status = await offline.status(project.id);
    assert.equal(status.inbox.length, 1);
    await offline.dismiss(project.id, item.id);
    assert.equal((await offline.status(project.id)).inbox.length, 0);
    // Turning it off removes the site copy.
    await offline.setEnabled(project.id, false);
    assert.deepEqual(removed, [{ projectId: project.id, linkId: link.id }]);
    assert.equal((await offline.status(project.id)).files[0].uploadedAt, null);
    // The setting survives a restart (state file next to the database).
    const again = new OfflineView({
      directory,
      store,
      workspace: new Workspace(store),
      links,
      remote: {
        hostId: 'host-1',
        uploadSnapshot: async () => undefined,
        deleteSnapshot: async () => true,
      },
    });
    assert.equal((await again.status(project.id)).enabled, false);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';

// The HTTP sequence a host plugin uses for Link (SPEC-01.9): a session from the launch token with an
// Origin header, the project list, and Link; then the project's list, visibility and removal.
test('plugins link documents to a chosen project; links stay per project with their last Sync', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-links-http-'));
  const app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  try {
    const login = await fetch(app.origin + '/api/v1/session', {
      method: 'POST',
      headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
    });
    assert.equal(login.status, 200);
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
      return { status: reply.status, body: await reply.json() };
    };
    const a = (await api('/projects', 'POST', { name: 'A' })).body;
    const b = (await api('/projects', 'POST', { name: 'B' })).body;
    const list = (await api('/projects')).body;
    assert.deepEqual(list.map((project) => project.name).sort(), ['A', 'B']);
    // A document that is not open (no plugin connection) cannot be linked.
    const stale = await api(`/projects/${a.id}/links`, 'POST', {
      host: 'rhino',
      instance: '1:2:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 1,
    });
    assert.equal(stale.body.code, 'STALE_CONNECTION');
    assert.equal(
      (
        await api(`/projects/${a.id}/links`, 'POST', {
          host: 'rhino',
          instance: 'x',
          documentId: 1,
        })
      ).status,
      400,
    );
    // A linked file (as the plugin would register it) lists with its last Sync.
    const now = new Date().toISOString();
    app.store.db
      .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
      .run('l1', a.id, 'zwcad', 'plan.dwg', 'C:\\p\\plan.dwg', '1:2:x', 1, now, now);
    const sync = {
      id: 'sync-1',
      linkId: 'l1',
      provider: 'codex-cli',
      host: 'zwcad',
      source: 'document',
      permission: 'candidate',
      body: 'Sync',
      pins: [],
      sketches: [],
      files: [],
    };
    app.store.db
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        sync.id,
        a.id,
        JSON.stringify(sync),
        'succeeded',
        JSON.stringify({ hostExecuted: true, host: 'zwcad' }),
        now,
      );
    const links = (await api(`/projects/${a.id}/links`)).body;
    assert.equal(links.length, 1);
    assert.equal(links[0].lastSync.requestId, 'sync-1');
    assert.equal(links[0].connection, null);
    assert.deepEqual((await api(`/projects/${b.id}/links`)).body, []);
    // Visibility and removal act only within the link's project.
    assert.equal(
      (await api(`/projects/${a.id}/links/l1`, 'PUT', { hidden: true })).body.hidden,
      true,
    );
    assert.equal((await api(`/projects/${b.id}/links/l1`, 'PUT', { hidden: false })).status, 404);
    assert.equal((await api(`/projects/${b.id}/links/l1/remove`, 'POST', {})).status, 404);
    assert.equal((await api(`/projects/${a.id}/links/l1/remove`, 'POST', {})).status, 200);
    assert.deepEqual((await api(`/projects/${a.id}/links`)).body, []);
    // The Sync record stays.
    assert.equal((await api(`/projects/${a.id}/requests/sync-1`)).status, 200);
    // A Sync can only name a link of its own project.
    const foreign = await api(`/projects/${b.id}/capture`, 'POST', {
      id: 'c1',
      instance: '1:2',
      documentId: 1,
      linkId: '00000000-0000-4000-8000-000000000000',
    });
    assert.equal(foreign.status, 404);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

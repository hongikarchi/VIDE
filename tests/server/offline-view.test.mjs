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

// PLAN-33: 할 일 and the work history summary go to the site without the snapshot switch, the
// summary carries no model or attachments, site edits are applied once (last write wins, conflicts
// noted in the item), and turning it off removes the site copy.
test('offline summary shares 할 일 and history without snapshots and applies site edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-offline-summary-'));
  const app = await startServer({ filename: join(directory, 'test.sqlite') });
  try {
    const { Agenda } = await import('../../src/core/agenda.ts');
    const store = app.store;
    const project = store.createProject('Summary');
    const links = new DocumentLinks(store);
    const link = links.link(project.id, {
      host: 'rhino',
      name: 'tower.3dm',
      path: 'C:/work/tower.3dm',
      instance: '1:1',
      documentId: 1,
    });
    let clock = Date.parse('2026-10-06T00:00:00Z');
    const agenda = new Agenda(store, { now: () => new Date(clock) });
    const uploads = [],
      removed = [];
    const offline = new OfflineView({
      directory,
      store,
      workspace: new Workspace(store),
      links,
      agenda,
      remote: {
        hostId: 'host-1',
        uploadSnapshot: async () => {
          throw new Error('snapshots are off');
        },
        deleteSnapshot: async () => true,
        uploadSummary: async (projectId, part, items) => {
          uploads.push({ projectId, part, items: JSON.parse(JSON.stringify(items)) });
          return undefined;
        },
        deleteSummary: async (projectId) => {
          removed.push(projectId);
          return true;
        },
      },
      now: () => clock,
    });
    const first = agenda.add(project.id, { text: '구조 검토 회의', date: '2026-10-07' });
    // A request with attachments, pins and a model in its result; and a Sync (not history).
    const insert = soleDb(store, project.id).prepare(
      'INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)',
    );
    insert.run(
      'r1',
      project.id,
      JSON.stringify({
        id: 'r1',
        provider: 'claude-cli',
        model: 'secret-model',
        body: '2층 보를 H-400으로 바꿔줘',
        pins: [{ id: 'p', basis: 'b', role: 'target' }],
        sketches: [],
        files: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'private.pdf',
            size: 10,
            type: 'application/pdf',
            kind: 'document',
            path: 'C:/secret/private.pdf',
            copied: true,
          },
        ],
        linkId: link.id,
      }),
      'succeeded',
      JSON.stringify({
        text: '바꿨습니다.\n\n보 12개를 H-400으로 바꿈\n자세한 내용\n넷째 줄',
        scene: [{ id: 'a', segments: [0, 0, 0, 1, 0, 0] }],
        objects: [{ id: 'a' }],
      }),
      new Date(clock).toISOString(),
    );
    insert.run(
      's1',
      project.id,
      JSON.stringify({ id: 's1', source: 'document', body: 'sync', linkId: link.id }),
      'succeeded',
      '{}',
      new Date(clock).toISOString(),
    );
    // Snapshots stay off; the summary still goes.
    await offline.tick();
    assert.equal((await offline.status(project.id)).enabled, false);
    assert.equal((await offline.status(project.id)).summary, true);
    const agendaUpload = uploads.find((u) => u.part === 'agenda');
    assert.deepEqual(
      agendaUpload.items.map((item) => item.text),
      ['구조 검토 회의'],
    );
    const history = uploads.find((u) => u.part === 'history').items;
    assert.equal(history.length, 1, 'the Sync is not history');
    assert.deepEqual(Object.keys(history[0]).sort(), [
      'answer',
      'body',
      'createdAt',
      'files',
      'id',
      'state',
    ]);
    assert.equal(history[0].answer, '바꿨습니다.\n보 12개를 H-400으로 바꿈\n자세한 내용');
    assert.deepEqual(history[0].files, ['tower.3dm']);
    const text = JSON.stringify(history);
    for (const secret of ['private.pdf', 'C:/secret', 'secret-model', 'segments', 'pins', 'claude'])
      assert.ok(!text.includes(secret), secret);
    // Nothing changed: nothing is sent again.
    uploads.length = 0;
    clock += 2 * 60_000;
    await offline.tick();
    assert.equal(uploads.length, 0);

    // Site edits: an add, a set on an unchanged item, applied once each.
    const add = {
      id: crypto.randomUUID(),
      projectId: project.id,
      itemId: 'site-x',
      op: 'add',
      fields: { text: '현장 사진 정리', date: '2026-10-08' },
      baseRevision: null,
      editedAt: clock,
    };
    const check = {
      id: crypto.randomUUID(),
      projectId: project.id,
      itemId: first.id,
      op: 'set',
      fields: { done: true },
      baseRevision: first.revision,
      editedAt: clock + 1,
    };
    const results = await offline.applyEdits([add, check]);
    assert.deepEqual(
      results.map((r) => r.outcome),
      ['applied', 'applied'],
    );
    let items = agenda.list(project.id);
    assert.deepEqual(
      items.map((item) => [item.text, item.done]),
      [
        ['구조 검토 회의', true],
        ['현장 사진 정리', false],
      ],
    );
    // The new list went to the site before the results were confirmed.
    assert.equal(uploads.at(-1).part, 'agenda');
    assert.equal(uploads.at(-1).items.length, 2);
    // Delivered again (no confirmation reached the site): nothing is done twice.
    await offline.applyEdits([add, check]);
    assert.equal(agenda.list(project.id).length, 2);
    // The add changed on the site before it was confirmed: the item it made takes the change.
    await offline.applyEdits([
      { ...add, fields: { text: '현장 사진 정리·업로드' }, editedAt: clock + 5 },
    ]);
    assert.deepEqual(
      agenda.list(project.id).map((item) => item.text),
      ['구조 검토 회의', '현장 사진 정리·업로드'],
    );

    // Conflicts. Changed here after the site read it, the site edit later: the site wins, noted.
    const second = agenda.list(project.id)[1];
    clock += 60_000;
    const changed = agenda.set(project.id, second.id, {
      revision: second.revision,
      text: 'PC에서 고침',
    });
    const [later] = await offline.applyEdits([
      {
        id: crypto.randomUUID(),
        projectId: project.id,
        itemId: second.id,
        op: 'set',
        fields: { text: '사이트에서 고침' },
        baseRevision: second.revision,
        editedAt: clock + 30_000,
      },
    ]);
    assert.equal(later.outcome, 'conflict');
    let item = agenda.get(project.id, second.id);
    assert.ok(item.text.startsWith('사이트에서 고침 [사이트 수정 충돌'), item.text);
    assert.ok(item.text.includes('PC에서 고침'));
    // The change here is later: it stays, and the item notes what the site wanted.
    clock += 120_000;
    const now = agenda.set(project.id, second.id, { revision: item.revision, text: 'PC 최종' });
    const [earlier] = await offline.applyEdits([
      {
        id: crypto.randomUUID(),
        projectId: project.id,
        itemId: second.id,
        op: 'remove',
        fields: {},
        baseRevision: changed.revision,
        editedAt: clock - 60_000,
      },
    ]);
    assert.equal(earlier.outcome, 'conflict');
    item = agenda.get(project.id, second.id);
    assert.ok(item.text.startsWith('PC 최종 [사이트 수정 충돌'), item.text);
    assert.ok(item.text.includes('삭제'));
    assert.ok(item.revision > now.revision);
    // An item removed here: the edit is reported, nothing else changes.
    const [missing] = await offline.applyEdits([
      {
        id: crypto.randomUUID(),
        projectId: project.id,
        itemId: 'gone',
        op: 'set',
        fields: { done: true },
        baseRevision: 1,
        editedAt: clock,
      },
    ]);
    assert.equal(missing.outcome, 'missing');

    // Turning it off removes the site copy and stops uploads.
    await offline.setSummary(project.id, false);
    assert.deepEqual(removed, [project.id]);
    uploads.length = 0;
    agenda.add(project.id, { text: '올라가지 않음' });
    clock += 10 * 60_000;
    await offline.tick(true);
    assert.equal(uploads.length, 0);
    assert.equal((await offline.status(project.id)).summary, false);
    items = agenda.list(project.id);
    assert.equal(items.length, 3);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

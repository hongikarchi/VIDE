// T-128: ZWCAD drawings follow Live Sync like Rhino documents. The connection plugin reports the
// model space entities changed after a revision (`displayChanges`) with its own counts of the whole
// drawing; an older plugin (no such method) keeps the full read. Fake plugin and host only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AttachedZwcadDocuments } from '../../hosts/zwcad/attached-documents.ts';
import { ZwcadSdkExecution } from '../../src/server/zwcad-sdk-execution.ts';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { LiveSync } from '../../src/server/live-sync.ts';
import { SyncCoalescer } from '../../src/server/sync-coalesce.ts';
import { runUserSync } from '../../src/server/document-sync.ts';
import { captureInput } from '../../src/server/import-model.ts';

const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const instance = `1:2:${session}`;
const target = { instance, documentId: 1 };
const row = (handle, x = 0) => ({
  object: { id: `cad-${handle}`, nativeId: handle, name: `0 / ${handle}`, kind: 'polyline' },
  scene: {
    id: `cad-${handle}`,
    nativeId: handle,
    nativeType: 'Line',
    segments: [x, 0, 0, x + 1, 0, 0],
    layer64: Buffer.from('0').toString('base64'),
    colorIndex: 7,
    lineWeight: 0.25,
    valid: true,
  },
});
const status = (revision, extra = {}) => ({
  ok: true,
  name: 'A.dwg',
  path: 'C:/d/A.dwg',
  units: 'Millimeters',
  objectCount: 3,
  modified: false,
  documentHash: String(revision).padStart(64, '0'),
  revision,
  generation: 1,
  live: true,
  hostBusy: false,
  ...extra,
});

/** A connection record and a loopback plugin answering `answer(method, params)`. */
async function plugin(t, answer) {
  const calls = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE(0)) return;
      const { params } = JSON.parse(buffer.subarray(4).toString('utf8'));
      calls.push(params);
      const body = Buffer.from(
        JSON.stringify({ status: 'success', result: answer(params.method, params) }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      socket.end(Buffer.concat([header, body]));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'vide-cad-live-'));
  t.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    join(directory, session + '.json'),
    JSON.stringify({
      attached: true,
      identity: {
        pid: 1,
        startTicks: '2',
        sessionId: session,
        documentId: session,
        port: server.address().port,
      },
      token: '0'.repeat(64),
      executable: 'C:/ZWCAD.exe',
    }),
  );
  return { adapter: new AttachedZwcadDocuments(directory), calls };
}

test('a ZWCAD change read pages the changed entities and takes the drawing counts', async (t) => {
  const changed = [row('1A', 5), row('2B', 6)];
  const coverage = {
    total: 3,
    displayed: 2,
    omitted: 1,
    omittedTypes: { Hidden: 1 },
    displayWarnings: { Solid3d: 1 },
  };
  const { adapter, calls } = await plugin(t, (method, params) => {
    if (method === 'attachedStatus') return status(12, { liveChanges: true });
    // Two pages: one changed row, then one row and one removed handle with the counts.
    const first = params.cursor === 0;
    return {
      ok: true,
      cursor: params.cursor,
      next: first ? 1 : 3,
      changes: 3,
      revision: 12,
      objects: [changed[first ? 0 : 1].object],
      scene: [changed[first ? 0 : 1].scene],
      removed: first ? [] : ['3C'],
      coverage: first ? null : coverage,
    };
  });
  const delta = await adapter.changes(target, 9);
  assert.deepEqual(
    delta.scene.map((item) => item.nativeId),
    ['1A', '2B'],
  );
  assert.deepEqual(delta.removed, ['3C']);
  assert.equal(delta.revision, 12);
  assert.deepEqual(delta.displayCoverage, {
    total: 3,
    displayed: 2,
    omitted: 1,
    omittedTypes: { Hidden: 1 },
  });
  assert.deepEqual(delta.displayWarnings, { Solid3d: 1 });
  const asked = calls.filter((call) => call.method === 'displayChanges');
  assert.deepEqual(
    asked.map((call) => [call.since, call.cursor, call.revision]),
    [
      [9, 0, undefined],
      [9, 1, 12],
    ],
  );
});

test('an older ZWCAD plugin or a moved drawing falls back as Rhino does', async (t) => {
  const old = await plugin(t, (method) =>
    method === 'attachedStatus' ? status(4) : { ok: false, code: 'UNSUPPORTED_METHOD' },
  );
  await assert.rejects(old.adapter.changes(target, 3), { code: 'RESYNC_REQUIRED' });
  const moved = await plugin(t, (method, params) =>
    method === 'attachedStatus'
      ? status(13, { liveChanges: true })
      : {
          ok: true,
          cursor: params.cursor,
          next: 0,
          changes: 0,
          revision: 12,
          objects: [],
          scene: [],
          removed: [],
          coverage: { total: 3, displayed: 3, omitted: 0, omittedTypes: {}, displayWarnings: {} },
        },
  );
  await assert.rejects(moved.adapter.changes(target, 9), { code: 'SOURCE_CHANGED' });
});

test('a ZWCAD Sync is a Live basis only when its plugin reports changes', async () => {
  for (const liveChanges of [true, undefined]) {
    const adapter = new AttachedZwcadDocuments('unused');
    adapter.discover = async () => {};
    adapter.call = async (_target, method, params) =>
      method === 'attachedStatus'
        ? status(6, liveChanges ? { liveChanges } : {})
        : {
            ok: true,
            offset: params.offset,
            total: 3,
            next: 3,
            revision: 6,
            objects: [row('1A').object],
            scene: [row('1A').scene],
            displayed: 1,
            omitted: 2,
            omittedTypes: { Hidden: 2 },
            displayWarnings: {},
          };
    const captured = await adapter.capture(target);
    assert.equal(captured.sourceDocument.revision, liveChanges ? 6 : undefined);
  }
});

function setup(t, changes) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const project = store.createProject('cad live');
  const rows = [row('1A'), row('2B'), row('3C')];
  workspace.submit(project.id, captureInput({ id: 'shown', ...target }, 'zwcad'));
  workspace.update(project.id, 'shown', 'succeeded', {
    host: 'zwcad',
    executionMode: 'sdk',
    displayOnly: true,
    hostExecuted: true,
    referenceOnly: true,
    objects: rows.map((r) => r.object),
    scene: rows.map((r) => r.scene),
    displayWarnings: {},
    displayCoverage: { total: 4, displayed: 3, omitted: 1, omittedTypes: { Hidden: 1 } },
    sourceDocument: {
      ...target,
      connection: 'attached-editor',
      documentHash: '0'.repeat(64),
      revision: 6,
      name: 'A.dwg',
      units: 'Millimeters',
      capturedAt: new Date().toISOString(),
      selectedIds: [],
    },
  });
  const zwcad = new ZwcadSdkExecution({ directory: 'unused', tools: {}, origin: () => '' });
  const asked = [];
  zwcad.editors.attached.changes = async (where, since) => {
    asked.push(since);
    return changes(since);
  };
  const live = new LiveSync(workspace, zwcad);
  return { workspace, project, live, asked };
}

test('a ZWCAD Live Sync updates the stored drawing with the plugin counts', async (t) => {
  const moved = row('1A', 9);
  const { workspace, project, live, asked } = setup(t, () => ({
    objects: [moved.object],
    scene: [moved.scene],
    removed: ['2B'],
    revision: 8,
    displayCoverage: { total: 4, displayed: 2, omitted: 2, omittedTypes: { Hidden: 2 } },
    displayWarnings: { Solid3d: 1 },
    source: status(8, { liveChanges: true }),
  }));
  const reply = await live.run(project.id, { ...target, basisId: 'shown', revision: 6 });
  assert.equal(reply.requestId, 'shown');
  assert.deepEqual(asked, [6]);
  const stored = workspace.get(project.id, 'shown').result;
  assert.deepEqual(
    stored.scene.map((item) => item.nativeId),
    ['1A', '3C'],
  );
  assert.deepEqual(stored.scene[0].segments, moved.scene.segments);
  assert.deepEqual(stored.displayCoverage, {
    total: 4,
    displayed: 2,
    omitted: 2,
    omittedTypes: { Hidden: 2 },
  });
  assert.deepEqual(stored.displayWarnings, { Solid3d: 1 });
  assert.equal(stored.sourceDocument.revision, 8);
  assert.equal(stored.host, 'zwcad');
});

test('⟳ on a ZWCAD drawing goes Live; a basis it cannot continue reads in full', async (t) => {
  const { workspace, project, live } = setup(t, () => ({
    objects: [],
    scene: [],
    removed: [],
    revision: 7,
    displayCoverage: { total: 4, displayed: 3, omitted: 1, omittedTypes: { Hidden: 1 } },
    displayWarnings: {},
    source: status(7, { liveChanges: true }),
  }));
  const context = {
    workspace,
    rhinoImport: {},
    host: {},
    documentSyncs: new SyncCoalescer(),
    diagnostics: { write: () => {} },
    liveSync: live,
    live: (projectId, input) => live.run(projectId, input),
  };
  const { action } = await runUserSync(context, project.id, { id: 'next', ...target });
  assert.equal(action, 'live');
  // When the plugin cannot tell (an older plugin, a layer changed) the Live Sync asks for a full read.
  const resync = setup(t, () => {
    throw Object.assign(new Error('RESYNC_REQUIRED'), { code: 'RESYNC_REQUIRED' });
  });
  const reply = await resync.live.run(resync.project.id, {
    ...target,
    basisId: 'shown',
    revision: 6,
  });
  assert.deepEqual(reply, { resync: true });
});

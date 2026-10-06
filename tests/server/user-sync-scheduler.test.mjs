// ⟳ next to the engine's Sync (PLAN-28 T-123 review, SPEC-01.11 6·10): the user's Live Sync goes
// through the real LiveSync and SyncScheduler. A ⟳ that succeeds ends the wait shown on the row even
// though a Live Sync in place keeps the Sync's id, and a draft holding the file keeps its shown Sync
// as it is (the Live Sync writes into a copy). Synthetic models only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { SyncScheduler } from '../../src/server/sync-scheduler.ts';
import { LiveSync } from '../../src/server/live-sync.ts';
import { SyncCoalescer } from '../../src/server/sync-coalesce.ts';
import { runUserSync } from '../../src/server/document-sync.ts';
import { captureInput } from '../../src/server/import-model.ts';

const instance = '1:2:356ff01d-b586-460c-8e2b-8c9f3c083e96';
const target = { instance, documentId: 7 };
const item = (nativeId, hash) => ({
  object: { id: nativeId, nativeId, kind: 'native', name: nativeId, origin: [0, 0, 0] },
  scene: {
    id: nativeId,
    nativeId,
    nativeType: 'Brep',
    geometryHash: hash,
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    line: [],
    valid: true,
  },
});
const sourceDocument = (revision) => ({
  ...target,
  connection: 'attached-editor',
  documentHash: String(revision).padStart(64, '0'),
  revision,
  name: 'Doc',
  capturedAt: new Date().toISOString(),
});

function setup(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const links = new DocumentLinks(store);
  const project = store.createProject('user sync');
  const link = links.link(project.id, { host: 'rhino', name: 'A.3dm', ...target });
  const a = item('a', 'a1');
  workspace.submit(project.id, captureInput({ id: 'shown', ...target, linkId: link.id }));
  workspace.update(project.id, 'shown', 'succeeded', {
    hostExecuted: true,
    displayOnly: true,
    executionMode: 'sdk',
    host: 'rhino',
    objects: [a.object],
    scene: [a.scene],
    sourceDocument: sourceDocument(4),
  });
  // Rhino: the document moves (SOURCE_CHANGED) until `settle()`, then reports `a` moved.
  let moving = true;
  const sdk = {
    async liveSync(where, basis, since) {
      if (moving) throw Object.assign(new Error('moving'), { code: 'SOURCE_CHANGED' });
      const next = item('a', `a-${since + 1}`);
      return {
        delta: { objects: [next.object], scene: [next.scene], removed: [] },
        survey: {},
        result: { sourceDocument: sourceDocument(since + 1) },
      };
    },
  };
  const live = new LiveSync(workspace, sdk);
  let now = 1_000_000;
  const document = {
    host: 'rhino',
    ...target,
    id: 7,
    name: 'A.3dm',
    connection: 'attached-editor',
    generation: 0,
    live: true,
    hostBusy: false,
  };
  const full = [];
  const scheduler = new SyncScheduler({
    workspace,
    links,
    projects: () => store.listProjects(),
    open: async () => [document],
    fullSync: async () => {
      full.push('full');
      throw Object.assign(new Error('no full Sync here'), { code: 'HOST_BUSY' });
    },
    liveSync: (projectId, input) => live.run(projectId, input),
    now: () => now,
  });
  const context = {
    workspace,
    rhinoImport: {},
    host: {},
    documentSyncs: new SyncCoalescer(),
    diagnostics: { write: () => {} },
    liveSync: live,
    live: (projectId, input) => live.run(projectId, input),
    // As the capture route wires them (server.ts).
    holds: (projectId, where) => scheduler.holds(projectId, where),
    heldBases: (projectId) => scheduler.heldBases(projectId),
    synced: (projectId, where) => scheduler.userSynced(projectId, where),
  };
  return {
    workspace,
    project,
    link,
    scheduler,
    context,
    full,
    settle: () => (moving = false),
    advance: (ms) => (now += ms),
    tick: async () => {
      await scheduler.tick();
      await scheduler.settled();
    },
    status: () => scheduler.status(project.id, document),
  };
}

test('a Live ⟳ that succeeds ends the engine wait on the row, though the Sync keeps its id', async (t) => {
  const s = setup(t);
  // The engine catches up the reopened Live file; the document is moving: the row waits.
  await s.tick();
  assert.equal(s.status().state, 'waiting');
  assert.equal(s.status().code, 'SOURCE_CHANGED');
  // Retried until 30 s pass, then it waits for the next change or ⟳.
  for (let i = 0; i < 8; i++) {
    s.advance(10_000);
    await s.tick();
  }
  assert.equal(s.status().state, 'waiting');
  s.settle();
  const { result, action } = await runUserSync(s.context, s.project.id, {
    id: 'press',
    ...target,
    linkId: s.link.id,
    fresh: true,
  });
  assert.equal(action, 'live');
  // In place: the shown Sync keeps its id (nothing holds it).
  assert.equal(result.id, 'shown');
  assert.equal(s.status().state, 'idle');
  assert.equal(s.status().code, undefined);
  await s.tick();
  assert.equal(s.status().state, 'idle');
  assert.deepEqual(s.full, []);
});

test('⟳ while a draft holds the file writes the Live Sync into a copy; the shown Sync stays', async (t) => {
  const s = setup(t);
  s.settle();
  // A page's draft pins an object of the shown Sync (the lease is not in the database).
  s.scheduler.hold(s.project.id, 'window', [s.link.id]);
  const { result, action } = await runUserSync(s.context, s.project.id, {
    id: 'press',
    ...target,
    linkId: s.link.id,
    fresh: true,
  });
  assert.equal(action, 'live');
  assert.notEqual(result.id, 'shown');
  // The draft's basis is as it was; the copy carries the change.
  const shown = s.workspace.get(s.project.id, 'shown').result;
  assert.equal(shown.sourceDocument.revision, 4);
  assert.equal(shown.scene[0].geometryHash, 'a1');
  const copy = s.workspace.get(s.project.id, result.id).result;
  assert.equal(copy.sourceDocument.revision, 5);
  assert.equal(copy.scene[0].geometryHash, 'a-5');
  assert.equal(s.workspace.get(s.project.id, result.id).input.linkId, s.link.id);
  // While the draft still holds the file, the next ⟳ updates that copy in place (T-127): one copy
  // per held Sync, not one per ⟳.
  s.scheduler.hold(s.project.id, 'window', [s.link.id], ['shown']);
  const held = await runUserSync(s.context, s.project.id, {
    id: 'press-again',
    ...target,
    linkId: s.link.id,
    fresh: true,
  });
  assert.equal(held.action, 'live');
  assert.equal(held.result.id, result.id);
  assert.equal(s.workspace.get(s.project.id, 'shown').result.sourceDocument.revision, 4);
  // A draft that now uses the copy (a pin on it) keeps it as well: the change goes to a new copy.
  s.scheduler.hold(s.project.id, 'window', [s.link.id], ['shown', result.id]);
  const pinned = await runUserSync(s.context, s.project.id, {
    id: 'press-pinned',
    ...target,
    linkId: s.link.id,
    fresh: true,
  });
  assert.notEqual(pinned.result.id, result.id);
  s.scheduler.hold(s.project.id, 'window', []);
  // Without the draft the next ⟳ continues the copy in place.
  s.advance(6000);
  assert.equal(s.scheduler.holds(s.project.id, { ...target, linkId: s.link.id }), false);
  const next = await runUserSync(s.context, s.project.id, {
    id: 'again',
    ...target,
    linkId: s.link.id,
    fresh: true,
  });
  assert.equal(next.result.id, pinned.result.id);
});

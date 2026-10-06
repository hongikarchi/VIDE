// The engine's own Sync of linked files (T-084, ARCH-01 §7 「엔진 주관 Sync」), with a fake list of
// open documents: one Sync per change whatever pages are open, holds, retries and waits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { SyncScheduler } from '../../src/server/sync-scheduler.ts';
import { captureInput } from '../../src/server/import-model.ts';

const instance = '1:2:356ff01d-b586-460c-8e2b-8c9f3c083e96';
function setup(t, { live } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const links = new DocumentLinks(store);
  const project = store.createProject('scheduler');
  const link = links.link(project.id, { host: 'rhino', name: 'A.3dm', instance, documentId: 7 });
  const document = {
    host: 'rhino',
    instance,
    id: 7,
    name: 'A.3dm',
    connection: 'attached-editor',
    generation: 0,
    live: true,
    hostBusy: false,
  };
  let now = 1_000_000;
  const calls = [];
  let liveReply = (input) => ({ requestId: input.basisId });
  const fullSync = async (projectId, target) => {
    calls.push('full');
    workspace.submit(projectId, captureInput(target));
    const result = workspace.update(projectId, target.id, 'succeeded', {
      hostExecuted: true,
      displayOnly: true,
      host: 'rhino',
      executionMode: 'sdk',
      objects: [],
      scene: [],
      sourceDocument: { instance, documentId: 7, connection: 'attached-editor', revision: 3 },
    });
    return { result };
  };
  const scheduler = new SyncScheduler({
    workspace,
    links,
    projects: () => store.listProjects(),
    open: async () => [document],
    fullSync,
    liveSync: async (projectId, input) => {
      calls.push('live');
      return liveReply(input);
    },
    now: () => now,
    ...(live === false ? { liveSync: undefined } : {}),
  });
  // A pass and the Sync it started.
  const tick = async () => {
    await scheduler.tick();
    await scheduler.settled();
  };
  return {
    store,
    workspace,
    project,
    link,
    document,
    calls,
    scheduler,
    tick,
    advance: (ms) => (now += ms),
    setLive: (reply) => (liveReply = reply),
    status: () => scheduler.status(project.id, document),
  };
}

test('a new link is Synced once; each change after it is one Live Sync', async (t) => {
  const s = setup(t);
  await s.tick();
  assert.deepEqual(s.calls, ['full']);
  await s.tick();
  await s.tick();
  assert.deepEqual(s.calls, ['full']);
  s.document.generation = 1;
  await s.tick();
  await s.tick();
  assert.deepEqual(s.calls, ['full', 'live']);
  assert.equal(s.status().state, 'idle');
  // A Live Sync the plugin cannot continue falls back to a full Sync.
  s.setLive(() => ({ resync: true }));
  s.document.generation = 2;
  await s.tick();
  assert.deepEqual(s.calls, ['full', 'live', 'live', 'full']);
});

test('pages make no difference: the engine Syncs with none open and draft leases hold it', async (t) => {
  const s = setup(t);
  await s.tick();
  // Three pages report drafts on this file; a change waits while any lease is fresh.
  for (const page of ['window', 'panel', 'tab']) s.scheduler.hold(s.project.id, page, [s.link.id]);
  s.document.generation = 1;
  await s.tick();
  assert.deepEqual(s.calls, ['full']);
  assert.equal(s.status().state, 'held');
  s.scheduler.hold(s.project.id, 'window', []);
  s.scheduler.hold(s.project.id, 'panel', []);
  s.advance(3000);
  s.scheduler.hold(s.project.id, 'tab', [s.link.id]);
  await s.tick();
  assert.deepEqual(s.calls, ['full']);
  // The last page stops renewing: after 5 s the held changes are one Sync.
  s.document.generation = 3;
  s.advance(6000);
  await s.tick();
  await s.tick();
  assert.deepEqual(s.calls, ['full', 'live']);
});

test('work on the file and AI writes on the document hold its Syncs until they end', async (t) => {
  const s = setup(t);
  await s.tick();
  const basis = s.workspace.list(s.project.id).at(-1).id;
  s.workspace.submit(s.project.id, {
    id: 'edit',
    body: '벽 올리기',
    permission: 'candidate',
    provider: 'codex-cli',
    host: 'rhino',
    pins: [],
    sketches: [],
    files: [],
    baseRequestId: basis,
  });
  s.document.generation = 1;
  await s.tick();
  assert.equal(s.status().state, 'held');
  s.workspace.update(s.project.id, 'edit', 'succeeded', { text: 'done' });
  const release = s.workspace.holdWrite(s.project.id, { host: 'rhino', instance, documentId: 7 });
  await s.tick();
  assert.deepEqual(s.calls, ['full']);
  release();
  await s.tick();
  assert.deepEqual(s.calls, ['full', 'live']);
});

test('a moving document is retried 1, 2, 4, 8 s up to 30 s, then waits for the next change', async (t) => {
  const s = setup(t);
  await s.tick();
  s.setLive(() => ({ retry: 'SOURCE_CHANGED' }));
  s.document.generation = 1;
  await s.tick();
  assert.equal(s.status().state, 'waiting');
  assert.equal(s.status().code, 'SOURCE_CHANGED');
  const tries = () => s.calls.filter((call) => call === 'live').length;
  assert.equal(tries(), 1);
  await s.tick(); // too early
  assert.equal(tries(), 1);
  for (const wait of [1000, 2000, 4000, 8000]) {
    s.advance(wait);
    await s.tick();
  }
  assert.equal(tries(), 5);
  // 1 + 2 + 4 + 8 = 15 s; the next delay would pass 30 s: it waits for a change.
  s.advance(60_000);
  await s.tick();
  assert.equal(tries(), 5);
  assert.equal(s.status().state, 'waiting');
  // ⟳ (a fresh Sync the user asked for) brings a newer Sync: the wait is over.
  s.workspace.submit(
    s.project.id,
    captureInput({ id: 'manual', instance, documentId: 7, linkId: s.link.id }),
  );
  s.workspace.update(s.project.id, 'manual', 'succeeded', {
    hostExecuted: true,
    displayOnly: true,
    host: 'rhino',
    objects: [],
    scene: [],
    sourceDocument: { instance, documentId: 7, connection: 'attached-editor', revision: 9 },
  });
  await s.tick();
  assert.equal(s.status().state, 'idle');
  assert.equal(tries(), 5);
  s.setLive((input) => ({ requestId: input.basisId }));
  s.document.generation = 2;
  await s.tick();
  assert.equal(tries(), 6);
  assert.equal(s.status().state, 'idle');
});

test('a busy host is left alone; without Live Sync every change is a full Sync', async (t) => {
  const s = setup(t, { live: false });
  await s.tick();
  s.document.hostBusy = true;
  s.document.generation = 1;
  await s.tick();
  assert.deepEqual(s.calls, ['full']);
  s.document.hostBusy = false;
  await s.tick();
  assert.deepEqual(s.calls, ['full', 'full']);
});

test('a work copy VIDE opened gets its first Sync once; later changes wait for ⟳', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const links = new DocumentLinks(store);
  const project = store.createProject('copy');
  links.link(project.id, { host: 'rhino', name: 'copy.3dm', instance, documentId: 7 });
  const calls = [];
  const scheduler = new SyncScheduler({
    workspace,
    links,
    projects: () => store.listProjects(),
    open: async () => [],
    isOwnedOpen: async () => true,
    fullSync: async (projectId, target) => {
      calls.push(target.instance);
      workspace.submit(projectId, captureInput(target));
      return { result: workspace.update(projectId, target.id, 'failed', { code: 'X' }) };
    },
  });
  for (let i = 0; i < 3; i++) {
    await scheduler.tick();
    await scheduler.settled();
  }
  assert.deepEqual(calls, [instance]);
});

test('a reconnected non-live file gets a full Sync instead of its old session display', async (t) => {
  const s = setup(t);
  s.document.live = false;
  s.workspace.submit(
    s.project.id,
    captureInput({ id: 'old-session', instance, documentId: 7, linkId: s.link.id }),
  );
  s.workspace.update(s.project.id, 'old-session', 'succeeded', {
    hostExecuted: true,
    displayOnly: true,
    host: 'rhino',
    objects: [],
    scene: [],
    sourceDocument: {
      instance: 'old:session',
      documentId: 7,
      revision: 30,
      connection: 'attached-editor',
    },
  });
  await s.tick();
  await s.tick();
  assert.deepEqual(s.calls, ['full']);
});

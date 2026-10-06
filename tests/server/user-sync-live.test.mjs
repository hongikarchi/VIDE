// ⟳ as a Live Sync (PLAN-28 T-123, ARCH-01 §7 「사용자 Sync」): the user's Sync asks the host only for
// what changed when the document's shown Sync can be continued; the first Sync, a Sync a Live Sync
// cannot continue and `full` read the whole document. Synthetic models only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { SyncCoalescer } from '../../src/server/sync-coalesce.ts';
import { runUserSync } from '../../src/server/document-sync.ts';
import { captureInput } from '../../src/server/import-model.ts';

const target = { instance: '1:2:356ff01d-b586-460c-8e2b-8c9f3c083e96', documentId: 7 };
const display = (revision) => ({
  hostExecuted: true,
  displayOnly: true,
  executionMode: 'sdk',
  host: 'rhino',
  objects: [{ id: 'a', nativeId: 'a', kind: 'native', name: 'a' }],
  scene: [{ id: 'a', nativeId: 'a', nativeType: 'Brep', vertices: [0, 0, 0], valid: true }],
  sourceDocument: {
    ...target,
    connection: 'attached-editor',
    documentHash: 'd'.repeat(64),
    revision,
  },
});

function setup(t, live) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const project = store.createProject('user sync');
  const reads = [];
  const lives = [];
  const written = [];
  const context = {
    workspace,
    // The whole-document read: a ZWCAD-style capture that the test counts (it fails on purpose).
    zwcadSdk: {
      editors: {
        has: async () => true,
        capture: async () => {
          reads.push('full');
          throw Object.assign(new Error('read'), { code: 'HOST_BUSY' });
        },
      },
    },
    rhinoImport: {},
    host: {},
    documentSyncs: new SyncCoalescer(),
    diagnostics: { write: (event, fields) => written.push({ event, ...fields }) },
    // Short waits between Live Sync attempts after a transient refusal (T-127).
    liveRetryMs: [1, 1],
    live: async (projectId, input) => {
      lives.push(input);
      return live(input);
    },
  };
  return { workspace, project, reads, lives, written, context };
}

test('⟳ continues the shown display Sync with a Live Sync and reads nothing whole', async (t) => {
  const { workspace, project, reads, lives, written, context } = setup(t, (input) => ({
    requestId: input.basisId,
  }));
  workspace.submit(project.id, captureInput({ id: 's1', ...target }));
  workspace.update(project.id, 's1', 'succeeded', display(4));
  const { result, action } = await runUserSync(context, project.id, { id: 'new', ...target });
  assert.equal(action, 'live');
  assert.equal(result.id, 's1');
  assert.deepEqual(reads, []);
  assert.deepEqual(lives, [{ ...target, basisId: 's1', revision: 4 }]);
  assert.equal(written.find((line) => line.event === 'user-sync').action, 'live');
  // The engine-internal summary keeps object rows; the HTTP answer strips them (request-objects).
  assert.equal(result.result.sceneOmitted, true);
});

test('⟳ reads the whole document the first time, when Live cannot continue, and when asked', async (t) => {
  let reply = { resync: true };
  const { workspace, project, reads, lives, context } = setup(t, () => reply);
  // No basis yet: the whole document, no Live Sync asked.
  let synced = await runUserSync(context, project.id, { id: 'first', ...target });
  assert.equal(synced.action, 'full');
  assert.deepEqual(lives, []);
  assert.equal(reads.length, 1);
  workspace.submit(project.id, captureInput({ id: 's1', ...target }));
  workspace.update(project.id, 's1', 'succeeded', display(2));
  // The plugin cannot tell the changes: a full read.
  synced = await runUserSync(context, project.id, { id: 'second', ...target });
  assert.equal(synced.action, 'full');
  assert.equal(lives.length, 1);
  assert.equal(reads.length, 2);
  // A transient code (the document moves) is asked again as a Live Sync a few times, then read
  // whole (T-127).
  reply = { retry: 'SOURCE_CHANGED' };
  synced = await runUserSync(context, project.id, { id: 'third', ...target });
  assert.equal(synced.action, 'full');
  assert.equal(lives.length, 4);
  assert.equal(reads.length, 3);
  // `full` never tries a Live Sync.
  synced = await runUserSync(context, project.id, { id: 'fourth', ...target, full: true });
  assert.equal(synced.action, 'full');
  assert.equal(lives.length, 4);
  // Another document's Sync is no basis.
  synced = await runUserSync(context, project.id, { id: 'fifth', ...target, documentId: 8 });
  assert.equal(synced.action, 'full');
  assert.equal(lives.length, 4);
});

test('⟳ asks the Live Sync again after a transient refusal before reading whole (T-127)', async (t) => {
  const replies = [{ retry: 'HOST_BUSY' }, { retry: 'SOURCE_CHANGED' }];
  const { workspace, project, reads, lives, written, context } = setup(
    t,
    (input) => replies.shift() ?? { requestId: input.basisId },
  );
  workspace.submit(project.id, captureInput({ id: 's1', ...target }));
  workspace.update(project.id, 's1', 'succeeded', display(4));
  const synced = await runUserSync(context, project.id, { id: 'new', ...target });
  assert.equal(synced.action, 'live');
  assert.equal(lives.length, 3);
  assert.deepEqual(reads, []);
  assert.equal(written.find((line) => line.event === 'user-sync').attempts, 3);
  // A code that does not pass on its own reads whole at once.
  replies.push({ retry: 'PROJECT_BUSY' });
  lives.length = 0;
  assert.equal((await runUserSync(context, project.id, { id: 'next', ...target })).action, 'full');
  assert.equal(lives.length, 1);
  assert.equal(reads.length, 1);
});

test('⟳ on a held file names the Syncs the drafts use (T-127)', async (t) => {
  const { workspace, project, lives, context } = setup(t, (input) => ({
    requestId: input.basisId,
  }));
  workspace.submit(project.id, captureInput({ id: 's1', ...target }));
  workspace.update(project.id, 's1', 'succeeded', display(4));
  context.holds = () => true;
  context.heldBases = () => ['s0'];
  await runUserSync(context, project.id, { id: 'new', ...target });
  assert.deepEqual(lives, [{ ...target, basisId: 's1', revision: 4, keep: true, held: ['s0'] }]);
});

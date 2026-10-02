import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { LiveSync } from '../../src/server/live-sync.ts';
import { captureInput } from '../../src/server/import-model.ts';

const target = { instance: '1:2:356ff01d-b586-460c-8e2b-8c9f3c083e96', documentId: 7 };
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
function setup(t, liveSync) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store),
    project = store.createProject('live');
  const a = item('a', 'h1'),
    b = item('b', 'h2');
  workspace.submit(project.id, captureInput({ id: 'sync', ...target }));
  const sync = workspace.update(project.id, 'sync', 'succeeded', {
    hostExecuted: true,
    displayOnly: true,
    executionMode: 'sdk',
    host: 'rhino',
    objects: [a.object, b.object],
    scene: [a.scene, b.scene],
    sourceDocument: {
      ...target,
      connection: 'attached-editor',
      documentHash: 'r'.repeat(64),
      revision: 4,
      name: 'Doc',
      capturedAt: new Date().toISOString(),
    },
  });
  const calls = [];
  const sdk = {
    async liveSync(where, basis, since) {
      calls.push(since);
      return liveSync(where, basis, since);
    },
  };
  const live = new LiveSync(workspace, sdk);
  live.record(project.id, sync);
  return { workspace, project, live, calls };
}
const moved = (where, basis, since) => {
  const next = item('b', 'h2-moved');
  return {
    delta: { objects: [next.object], scene: [next.scene], removed: ['a'] },
    survey: {},
    // Only the change page and small fields come back (PLAN-27 1단계): no merged model.
    result: {
      sourceDocument: {
        ...basis.sourceDocument,
        documentHash: 's'.repeat(64),
        revision: since + 3,
      },
    },
  };
};

test('live sync updates an unreferenced display Sync in place and returns only the delta', async (t) => {
  const { workspace, project, live, calls } = setup(t, moved);
  const reply = await live.run(project.id, { ...target, basisId: 'sync', revision: 4 });
  assert.equal(reply.requestId, 'sync');
  assert.equal(reply.created, false);
  assert.deepEqual(calls, [4]);
  assert.equal(reply.request.result.objects, undefined);
  assert.equal(reply.request.result.scene, undefined);
  assert.deepEqual(reply.delta.removed, ['a']);
  const saved = workspace.get(project.id, 'sync');
  assert.equal(saved.result.sourceDocument.revision, 7);
  assert.equal(saved.result.scene[0].geometryHash, 'h2-moved');
  assert.equal(saved.result.displayOnly, true);
});

test('a display Sync referenced by another request is kept; the merge becomes a new basis', async (t) => {
  const { workspace, project, live, calls } = setup(t, moved);
  workspace.submit(project.id, {
    id: 'edit',
    body: 'raise the wall',
    permission: 'candidate',
    provider: 'codex-cli',
    host: 'rhino',
    pins: [],
    sketches: [],
    files: [],
    baseRequestId: 'sync',
    applyToSource: true,
  });
  // While a source apply of that document is queued, the update waits instead of racing it
  // (SPEC-02.9 2: a read waits only for a write to the same user document).
  assert.deepEqual(await live.run(project.id, { ...target, basisId: 'sync', revision: 2 }), {
    retry: 'PROJECT_BUSY',
  });
  calls.length = 0;
  workspace.update(project.id, 'edit', 'failed', { code: 'PROVIDER_FAILED' });
  const reply = await live.run(project.id, { ...target, basisId: 'sync', revision: 2 });
  assert.equal(reply.created, true);
  assert.notEqual(reply.requestId, 'sync');
  // The caller's older display determines where the delta starts.
  assert.deepEqual(calls, [2]);
  assert.equal(workspace.get(project.id, 'sync').result.sourceDocument.revision, 4);
  assert.equal(workspace.get(project.id, reply.requestId).result.sourceDocument.revision, 5);
  // The next Live Sync continues from the new basis, not the referenced one.
  await live.run(project.id, { ...target, basisId: 'sync', revision: 4 });
  assert.deepEqual(calls, [2, 4]);
});

test('unknown connection state falls back to a full Sync; a moving document retries', async (t) => {
  const failing = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };
  const resync = setup(t, failing('RESYNC_REQUIRED'));
  assert.deepEqual(
    await resync.live.run(resync.project.id, { ...target, basisId: 'sync', revision: 4 }),
    { resync: true },
  );
  const moving = setup(t, failing('SOURCE_CHANGED'));
  assert.deepEqual(
    await moving.live.run(moving.project.id, { ...target, basisId: 'sync', revision: 4 }),
    { retry: 'SOURCE_CHANGED' },
  );
  const other = setup(t, moved);
  assert.deepEqual(
    await other.live.run(other.project.id, {
      ...target,
      documentId: 8,
      basisId: 'sync',
      revision: 4,
    }),
    { resync: true },
  );
});

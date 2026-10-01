import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { applyAttachedCandidate } from '../../src/server/attached-application.ts';
import { interventionInput } from '../../src/core/intervention.ts';

function setup(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store),
    project = store.createProject('attached');
  const sourceDocument = {
    connection: 'attached-editor',
    instance: '1:2',
    documentId: 7,
    documentHash: 'before',
  };
  const input = {
    id: 'basis',
    body: 'sync',
    permission: 'candidate',
    provider: 'codex-cli',
    pins: [],
    sketches: [],
    files: [],
    host: 'rhino',
  };
  const candidate = {
    hostExecuted: true,
    verified: true,
    executionMode: 'sdk',
    host: 'rhino',
    sourceDocument,
    objects: [],
    fileHash: 'candidate',
  };
  workspace.submit(project.id, input);
  workspace.update(project.id, 'basis', 'succeeded', candidate);
  const request = workspace.submit(project.id, {
    ...input,
    id: 'edit',
    baseRequestId: 'basis',
    applyToSource: true,
  }).request;
  return { store, workspace, project, input, request, candidate };
}

test('attached authority requires a verified attached basis and cannot be broadened by intervention', (t) => {
  const f = setup(t);
  for (const patch of [{ permission: 'review' }, { host: 'zwcad' }, { baseRequestId: null }])
    assert.throws(() =>
      f.workspace.submit(f.project.id, { ...f.request.input, id: 'bad', ...patch }),
    );
  assert.throws(
    () =>
      interventionInput(
        { ...f.request.input, applyToSource: false },
        { ...f.request.input, id: 'next' },
      ),
    { code: 'TARGET_MISMATCH' },
  );
  f.workspace.update(f.project.id, 'basis', 'succeeded', {
    ...f.candidate,
    sourceDocument: { ...f.candidate.sourceDocument, connection: 'owned-editor' },
  });
  assert.throws(() => f.workspace.submit(f.project.id, { ...f.request.input, id: 'bad' }), {
    code: 'STALE_REFERENCE',
  });
});

test('explicit attached edit accepts a display basis for deferred native preparation', (t) => {
  const f = setup(t);
  f.workspace.update(f.project.id, 'edit', 'cancelled', null);
  f.workspace.update(f.project.id, 'basis', 'succeeded', {
    ...f.candidate,
    verified: false,
    displayOnly: true,
  });
  assert.equal(
    f.workspace.submit(f.project.id, { ...f.request.input, id: 'from-display' }).created,
    true,
  );
});

for (const scenario of [
  'success',
  'conflict',
  'unknown',
  'sync-failure',
  'cancelled',
  'target-mismatch',
]) {
  test(`attached execution preserves native outcome: ${scenario}`, async (t) => {
    const f = setup(t),
      controller = new AbortController();
    let writes = 0,
      reads = 0;
    const app = {
      prepare: async () => {
        if (scenario === 'conflict') throw { code: 'SOURCE_CHANGED' };
        if (scenario === 'cancelled') controller.abort();
        return { id: 'application' };
      },
      confirm: async () => {
        writes++;
        assert.equal(f.workspace.get(f.project.id, 'edit').result.applicationId, 'application');
        return { state: scenario === 'unknown' ? 'unknown' : 'succeeded' };
      },
    };
    const released = [];
    const sdk = {
      // The candidate's capture goes once the application settled either way (PLAN-27 T-087).
      copies: { removeCapture: async (path, parts) => released.push({ path, parts }) },
      captureEditor: async () => {
        reads++;
        if (scenario === 'sync-failure') throw Error('offline');
        return {
          ...f.candidate,
          sourceDocument: { ...f.candidate.sourceDocument, documentHash: 'after' },
        };
      },
    };
    const candidate =
      scenario === 'target-mismatch'
        ? { ...f.candidate, sourceDocument: { ...f.candidate.sourceDocument, documentId: 9 } }
        : f.candidate;
    const result = await applyAttachedCandidate(
      f.workspace,
      app,
      sdk,
      f.request,
      candidate,
      controller.signal,
    );
    if (['conflict', 'cancelled', 'target-mismatch'].includes(scenario)) {
      assert.equal(writes, 0);
      assert.equal(reads, 0);
      assert.equal(result.state, scenario === 'cancelled' ? 'cancelled' : 'failed');
    } else {
      assert.equal(writes, 1);
      assert.equal(result.state, scenario === 'unknown' ? 'unknown' : 'succeeded');
      assert.equal(reads, scenario === 'unknown' ? 0 : 1);
      if (scenario === 'success') assert.equal(result.result.sourceDocument.documentHash, 'after');
      if (scenario === 'sync-failure') assert.equal(result.result.code, 'APPLIED_SYNC_FAILED');
    }
    assert.equal(result.result.hostExecuted, true);
    assert.equal(released.length, ['unknown', 'cancelled'].includes(scenario) ? 0 : 1);
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { hostUse, requestAdmission, unresolvedFor } from '../../src/contracts/request-scope.ts';

const instance = '1:2:356ff01d-b586-460c-8e2b-8c9f3c083e96';

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  const workspace = new Workspace(store),
    project = store.createProject('scope');
  const submit = (id, fields = {}) =>
    workspace.submit(project.id, {
      id,
      body: 'inspect',
      provider: 'claude-cli',
      permission: 'candidate',
      host: 'rhino',
      pins: [],
      sketches: [],
      files: [],
      baseRequestId: null,
      ...fields,
    }).request;
  const finish = (id, result = {}, state = 'succeeded') =>
    workspace.update(project.id, id, state, {
      host: 'rhino',
      hostExecuted: true,
      verified: true,
      executionMode: 'sdk',
      ...result,
    });
  /** A Sync of an open document, as the capture route stores it. */
  const sync = (id, documentId, host = 'rhino') => {
    submit(id, {
      provider: 'codex-cli',
      host,
      source: 'document',
      baseRequestId: undefined,
      sourceDocument: { instance, documentId },
    });
    return finish(id, {
      host,
      displayOnly: true,
      sourceDocument: {
        connection: 'attached-editor',
        instance,
        documentId,
        documentHash: 'r'.repeat(64),
      },
    });
  };
  const run = (id) => workspace.update(project.id, id, 'running');
  return { workspace, project, submit, finish, sync, run, store };
}

test('three AI turns run at once; the fourth waits for a free turn; retries stay idempotent', (t) => {
  const { workspace, project, submit, finish } = fixture(t);
  for (const id of ['a', 'b', 'c']) assert.equal(submit(id).result, null);
  assert.equal(submit('a').id, 'a');
  const d = submit('d');
  assert.equal(d.state, 'queued');
  assert.deepEqual(d.result, {
    phase: 'queue',
    waitingFor: { kind: 'project', key: 'ai-turns', limit: 3, position: 1 },
  });
  assert.equal(submit('e').result.waitingFor.position, 2);
  finish('a');
  // The earliest waiting request takes the free turn; the next one moves up.
  assert.deepEqual(
    workspace.release(project.id).map((row) => row.id),
    ['d'],
  );
  workspace.update(project.id, 'd', 'running');
  assert.equal(workspace.get(project.id, 'e').result.waitingFor.position, 1);
  // The limit is a setting between 2 and 4.
  workspace.aiTurns = 4;
  assert.deepEqual(
    workspace.release(project.id).map((row) => row.id),
    ['e'],
  );
});

test('two writes to one document queue in order; another document runs at once', (t) => {
  const { workspace, project, submit, sync, finish } = fixture(t);
  sync('a', 1);
  sync('b', 1);
  sync('c', 2);
  assert.equal(submit('edit-a', { baseRequestId: 'a' }).result, null);
  // A newer Sync of the same document is the same document.
  const second = submit('edit-b', { baseRequestId: 'b' });
  assert.equal(second.state, 'queued');
  assert.deepEqual(second.result.waitingFor, {
    kind: 'document',
    key: JSON.stringify(['document', instance, 1]),
    host: 'rhino',
    after: 'edit-a',
    position: 1,
  });
  assert.equal(submit('edit-c', { baseRequestId: 'c' }).result, null);
  assert.equal(submit('edit-a2', { baseRequestId: 'a' }).result.waitingFor.position, 2);
  // The document stays held while the first write runs.
  assert.deepEqual(workspace.release(project.id), []);
  finish('edit-a');
  assert.deepEqual(
    workspace.release(project.id).map((row) => row.id),
    ['edit-b'],
  );
  workspace.update(project.id, 'edit-b', 'running');
  assert.deepEqual(workspace.get(project.id, 'edit-a2').result.waitingFor.after, 'edit-b');
  assert.equal(workspace.get(project.id, 'edit-a2').result.waitingFor.position, 1);
});

test('reads and turns without a host are not held back by an edit and use no AI turn for a Sync', (t) => {
  const { workspace, project, submit, sync } = fixture(t);
  sync('doc-1', 1);
  submit('edit', { baseRequestId: 'doc-1' });
  // A Sync of the edited document or another one (a work-copy edit does not write the original).
  sync('same-doc', 1);
  sync('other-doc', 2);
  // A question that uses no host and a review of the edited model.
  assert.equal(submit('question', { hostUse: 'none', permission: 'review' }).result, null);
  assert.equal(submit('review', { baseRequestId: 'doc-1', permission: 'review' }).result, null);
  // A jig input read is not a stored request (ARCH-03 §8); its route checks it like a Sync.
  const jigRead = {
    id: 'jig-read',
    host: 'rhino',
    permission: 'review',
    source: 'document',
    sourceDocument: { instance, documentId: 1 },
  };
  assert.deepEqual(requestAdmission(jigRead, workspace.list(project.id)), {});
  // Three AI turns now run; a Sync still runs, the next AI turn waits.
  sync('third-doc', 3);
  assert.equal(submit('more', { hostUse: 'none' }).result.waitingFor.kind, 'project');
});

test('a Sync waits only for a source apply of the same document and is refused at once', (t) => {
  const { submit, sync } = fixture(t);
  sync('doc-1', 1);
  submit('apply', { baseRequestId: 'doc-1', applyToSource: true });
  assert.throws(() => sync('again', 1), { code: 'PROJECT_BUSY' });
  sync('other', 2);
  // A later edit of that document stands behind the apply.
  assert.equal(submit('edit', { baseRequestId: 'doc-1' }).result.waitingFor.after, 'apply');
});

test('an unresolved result never refuses or stops a later write; it is named to that turn (T-102)', (t) => {
  const { workspace, project, submit, finish } = fixture(t);
  submit('root');
  finish('root');
  submit('child', { baseRequestId: 'root' });
  finish('child');
  submit('edit-child', { baseRequestId: 'child' });
  // Candidate descendants share the lock of their lineage.
  assert.equal(
    submit('edit-root', { baseRequestId: 'root' }).result.waitingFor.after,
    'edit-child',
  );
  finish('edit-child', { phase: 'host' }, 'unknown');
  // The waiting write's turn has come: the unknown one ahead does not stop it.
  assert.deepEqual(
    workspace.release(project.id).map((row) => row.id),
    ['edit-root'],
  );
  workspace.update(project.id, 'edit-root', 'succeeded', { host: 'rhino', hostExecuted: true });
  assert.equal(submit('edit-root-2', { baseRequestId: 'root' }).result, null);
  assert.deepEqual(
    unresolvedFor(workspace.get(project.id, 'edit-root-2').input, workspace.list(project.id)).map(
      (row) => row.id,
    ),
    ['edit-child'],
  );
  assert.equal(submit('independent').result, null);
  assert.equal(submit('inspect', { baseRequestId: 'root', permission: 'review' }).state, 'queued');
});

test('an unresolved result without any document (null key) does not refuse a write of its host', (t) => {
  const { workspace, project, submit, finish } = fixture(t);
  // The user's case: a lost read-only execute, no sourceDocument, no documents, no targetRef.
  submit('lost', { baseRequestId: undefined });
  workspace.update(project.id, 'lost', 'unknown', { code: 'HOST_RESULT_UNKNOWN', executions: [] });
  const next = submit('next');
  assert.equal(next.state, 'queued');
  assert.equal(next.result, null);
  assert.deepEqual(
    unresolvedFor(next.input, workspace.list(project.id)).map((row) => row.id),
    ['lost'],
  );
  // A ZWCAD write is not about that Rhino result.
  assert.deepEqual(
    unresolvedFor(submit('cad', { host: 'zwcad' }).input, workspace.list(project.id)),
    [],
  );
  finish('next');
});

test('a request without an identified document stands behind every write of its host only', (t) => {
  const { submit } = fixture(t);
  submit('legacy', { baseRequestId: undefined });
  assert.deepEqual(submit('rhino-new').result.waitingFor, {
    kind: 'document',
    key: 'host:rhino',
    host: 'rhino',
    after: 'legacy',
    position: 1,
  });
  assert.equal(submit('cad-new', { host: 'zwcad' }).result, null);
});

test('linked parent reserves both targets without counting its internal child twice', (t) => {
  const { workspace, project, submit, finish } = fixture(t);
  submit('a');
  finish('a');
  submit('b');
  finish('b');
  const parent = submit('pair', {
    linkedTargets: [
      { host: 'rhino', baseRequestId: 'a' },
      { host: 'rhino', baseRequestId: 'b' },
    ],
    coordinateBasis: 'shared-metre-axes',
  });
  workspace.update(project.id, parent.id, 'running');
  workspace.createLinkedChild(parent, 'pair-child', 0);
  assert.equal(submit('conflict', { baseRequestId: 'b' }).result.waitingFor.after, 'pair');
  assert.equal(submit('independent').result, null);
  assert.equal(submit('another').result, null);
});

test('a host use declaration cannot let a write skip write contention', (t) => {
  const { submit, sync } = fixture(t);
  sync('doc-1', 1);
  for (const fields of [
    { hostUse: 'read' },
    { hostUse: 'none', baseRequestId: 'doc-1', applyToSource: true },
    { hostUse: 'bogus' },
  ])
    assert.throws(() => submit('bad', fields), { code: 'INVALID_INPUT' });
  const base = { id: 'x', permission: 'candidate' };
  assert.equal(hostUse(base), 'write');
  assert.equal(hostUse({ ...base, permission: 'review' }), 'read');
  assert.equal(hostUse({ ...base, source: 'document' }), 'read');
  assert.equal(hostUse({ ...base, provider: 'extension', permission: 'review' }), 'none');
  assert.equal(hostUse({ ...base, jig: { kind: 'sync-review' } }), 'none');
  assert.equal(hostUse({ ...base, permission: 'review', hostUse: 'write' }), 'write');
});

test('restart keeps a waiting request with its place and reason but does not run it', (t) => {
  const { store, project, submit, sync } = fixture(t);
  sync('doc-1', 1);
  submit('first', { baseRequestId: 'doc-1' });
  submit('second', { baseRequestId: 'doc-1', body: 'keep this condition' });
  const restored = new Workspace(store).get(project.id, 'second');
  assert.equal(restored.state, 'interrupted');
  assert.equal(restored.input.body, 'keep this condition');
  assert.equal(restored.result.waitingFor.after, 'first');
});

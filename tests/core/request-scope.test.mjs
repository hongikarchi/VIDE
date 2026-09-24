import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';

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
  return { workspace, project, submit, finish };
}

test('two independent candidates run; third is bounded and same-id retries remain idempotent', (t) => {
  const { submit, finish } = fixture(t);
  submit('a');
  submit('b');
  assert.equal(submit('a').id, 'a');
  assert.throws(() => submit('c'), { code: 'WORKSPACE_CAPACITY' });
  finish('a');
  assert.equal(submit('c').state, 'queued');
});

test('different captures of one native document conflict; another document remains independent', (t) => {
  const { submit, finish } = fixture(t);
  for (const [id, documentId] of [
    ['a', 1],
    ['b', 1],
    ['c', 2],
  ]) {
    submit(id);
    finish(id, { sourceDocument: { instance: 'rhino-process', documentId } });
  }
  submit('edit-a', { baseRequestId: 'a' });
  assert.throws(() => submit('edit-b', { baseRequestId: 'b' }), { code: 'PROJECT_BUSY' });
  assert.equal(submit('edit-c', { baseRequestId: 'c' }).state, 'queued');
});

test('candidate descendants retain the same lock and unknown blocks only related writes', (t) => {
  const { submit, finish } = fixture(t);
  submit('root');
  finish('root');
  submit('child', { baseRequestId: 'root' });
  finish('child');
  submit('edit-child', { baseRequestId: 'child' });
  assert.throws(() => submit('edit-root', { baseRequestId: 'root' }), { code: 'PROJECT_BUSY' });
  finish('edit-child', { phase: 'host' }, 'unknown');
  assert.throws(() => submit('edit-root', { baseRequestId: 'root' }), {
    code: 'HOST_RESULT_UNRESOLVED',
  });
  assert.equal(submit('independent').state, 'queued');
  assert.equal(submit('inspect', { baseRequestId: 'root', permission: 'review' }).state, 'queued');
});

test('implicit legacy target remains host-wide and does not block another host', (t) => {
  const { submit } = fixture(t);
  submit('legacy', { baseRequestId: undefined });
  assert.throws(() => submit('rhino-new'), { code: 'PROJECT_BUSY' });
  assert.equal(submit('cad-new', { host: 'zwcad' }).state, 'queued');
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
  assert.throws(() => submit('conflict', { baseRequestId: 'b' }), { code: 'PROJECT_BUSY' });
  assert.equal(submit('independent').state, 'queued');
});

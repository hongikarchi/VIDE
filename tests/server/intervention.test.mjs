import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { interventionInput } from '../../src/core/intervention.ts';
import { requestConflict } from '../../src/contracts/request-scope.ts';

function fixture(t, code = 'CANCELLED') {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('intervention');
  const input = {
    id: 'first',
    host: 'rhino',
    baseRequestId: null,
    provider: 'claude-cli',
    permission: 'review',
    body: 'Keep the boundary',
    pins: [],
    sketches: [],
    files: [],
  };
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const received = [];
  const execution = new Execution(workspace, {
    host: {},
    providerFactory: () => ({
      run: async (context) => {
        received.push(context);
        if (received.length === 1) {
          await gate;
          throw { code };
        }
        return { text: JSON.stringify({ message: 'Updated review', operations: [] }) };
      },
    }),
  });
  t.after(async () => {
    release();
    await execution.close();
    store.db.close();
  });
  const first = workspace.submit(project.id, input).request;
  execution.start(first);
  const next = {
    ...input,
    id: 'second',
    body: 'Use height 4.5 m',
    sketches: [
      {
        plane: 'XY',
        unit: 'm',
        role: 'reference',
        points: [
          [0, 0],
          [1, 1],
        ],
      },
    ],
  };
  return { store, workspace, project, execution, input, next, release, received };
}

test('intervention persists first, waits for actual termination and preserves conditions/sketches', async (t) => {
  const { workspace, project, execution, next, release, received } = fixture(t);
  const saved = execution.intervene(project.id, 'first', next);
  assert.equal(saved.state, 'queued');
  assert.equal(saved.result.phase, 'waiting');
  assert.equal(received.length, 1);
  assert.match(saved.input.body, /Keep the boundary[\s\S]*Use height 4.5 m/);
  assert.equal(saved.input.sketches.length, 1);
  assert.equal(execution.intervene(project.id, 'first', next).id, saved.id);
  assert.throws(() => execution.intervene(project.id, 'first', { ...next, body: 'changed' }), {
    code: 'REVISION_CONFLICT',
  });
  release();
  await execution.active.get(saved.id).completion;
  assert.equal(received.length, 2);
  assert.equal(workspace.get(project.id, 'first').state, 'cancelled');
  assert.equal(workspace.get(project.id, saved.id).state, 'succeeded');
  assert.match(JSON.stringify(received[1]), /Use height 4.5 m/);
});

test('uncertain predecessor preserves new conditions without replay', async (t) => {
  const { workspace, project, execution, next, release, received } = fixture(
    t,
    'HOST_RESULT_UNKNOWN',
  );
  execution.intervene(project.id, 'first', next);
  release();
  await execution.active.get('second').completion;
  assert.equal(received.length, 1);
  const saved = workspace.get(project.id, 'second');
  assert.equal(saved.state, 'interrupted');
  assert.equal(saved.result.code, 'INTERVENTION_REVIEW_REQUIRED');
});

test('cancelling waiting intervention does not launch it after predecessor exits', async (t) => {
  const { workspace, project, execution, next, release, received } = fixture(t);
  execution.intervene(project.id, 'first', next);
  assert.equal(execution.cancel(project.id, 'second').state, 'queued');
  release();
  await execution.active.get('second').completion;
  assert.equal(received.length, 1);
  assert.equal(workspace.get(project.id, 'second').state, 'cancelled');
});

test('intervention cannot switch host/permission, overwrite reserved fields, or attach to foreign project', (t) => {
  const { store, workspace, project, execution, next } = fixture(t);
  assert.throws(() => execution.intervene(project.id, 'first', { ...next, host: 'zwcad' }), {
    code: 'TARGET_MISMATCH',
  });
  assert.throws(
    () => execution.intervene(project.id, 'first', { ...next, permission: 'candidate' }),
    { code: 'TARGET_MISMATCH' },
  );
  assert.throws(() => workspace.submit(project.id, { ...next, supersedesRequestId: 'first' }), {
    code: 'INVALID_INPUT',
  });
  assert.throws(() => execution.intervene(store.createProject('other').id, 'first', next), {
    code: 'NOT_FOUND',
  });
});

test('recreated workspace retains queued condition but never auto-runs it', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  const workspace = new Workspace(store),
    project = store.createProject('restart');
  const input = {
    id: 'first',
    body: 'Original',
    host: 'rhino',
    baseRequestId: null,
    provider: 'claude-cli',
    permission: 'review',
    pins: [],
    sketches: [],
    files: [],
  };
  workspace.submit(project.id, input);
  workspace.intervene(project.id, 'first', { ...input, id: 'second', body: 'New condition' });
  const restored = new Workspace(store).get(project.id, 'second');
  assert.equal(restored.state, 'interrupted');
  assert.match(restored.input.body, /New condition/);
});

test('an intervention never silently downgrades a preservation pin', () => {
  const original = {
    id: 'first',
    body: 'Keep',
    host: 'rhino',
    baseRequestId: 'basis',
    provider: 'claude-cli',
    permission: 'candidate',
    pins: [{ id: 'object', basis: 'basis', role: 'preserve' }],
    sketches: [],
    files: [],
  };
  assert.throws(
    () =>
      interventionInput(original, {
        ...original,
        id: 'second',
        body: 'Change',
        pins: [{ id: 'object', basis: 'basis', role: 'target' }],
      }),
    { code: 'REVISION_CONFLICT' },
  );
  assert.equal(
    interventionInput(original, { ...original, id: 'second', body: 'More' }).pins.length,
    1,
  );
});

test('waiting intervention does not consume a third independent slot', (t) => {
  const { workspace, project, execution, next } = fixture(t);
  execution.intervene(project.id, 'first', next);
  const other = { ...next, id: 'independent', host: 'zwcad' };
  assert.equal(requestConflict(other, workspace.list(project.id)), undefined);
  assert.equal(workspace.submit(project.id, other).created, true);
  assert.equal(
    requestConflict({ ...other, id: 'third' }, workspace.list(project.id)),
    'WORKSPACE_CAPACITY',
  );
});

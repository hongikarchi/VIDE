import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { captureInput } from '../../src/server/import-model.ts';
import { requestConflict } from '../../src/contracts/request-scope.ts';

import { soleDb } from '../fixtures/store.mjs';
// SPEC-02.9 concurrent intake with the executor (PLAN-24 T-060).
const instance = '1:2:356ff01d-b586-460c-8e2b-8c9f3c083e96';

function setup(t) {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('concurrent');
  const gates = new Map();
  const log = [];
  const gate = (key) => {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    gates.set(key, { promise, release });
  };
  const release = (key) => gates.get(key).release();
  const hold = async (key, signal) => {
    log.push(`start ${key}`);
    await Promise.race([
      gates.get(key)?.promise,
      new Promise((resolve) => signal?.addEventListener('abort', resolve)),
    ]);
    if (signal?.aborted) {
      log.push(`stop ${key}`);
      throw { code: 'CANCELLED' };
    }
    log.push(`end ${key}`);
  };
  const sdk = {
    run: async ({ input, signal }) => {
      await hold(input.id, signal);
      return { text: '완료', hostExecuted: false };
    },
  };
  const execution = new Execution(workspace, {
    sdk,
    zwcadSdk: sdk,
    // A turn without a host reaches the provider with its request text as the goal.
    providerFactory: () => ({
      run: async (context, { signal }) => {
        await hold(context.goal, signal);
        return { text: '답변' };
      },
    }),
  });
  t.after(async () => {
    for (const entry of gates.values()) entry.release();
    await execution.close();
    store.close();
  });
  const submit = (id, fields = {}) =>
    workspace.submit(project.id, {
      id,
      body: id,
      provider: 'claude-cli',
      permission: 'candidate',
      host: 'rhino',
      pins: [],
      sketches: [],
      files: [],
      baseRequestId: null,
      ...fields,
    }).request;
  const send = (id, fields) => {
    const request = submit(id, fields);
    execution.start(request);
    return request;
  };
  const sync = (id, documentId, host = 'rhino') => {
    workspace.submit(project.id, captureInput({ id, instance, documentId }, host));
    workspace.update(project.id, id, 'succeeded', {
      host,
      hostExecuted: true,
      verified: true,
      displayOnly: true,
      executionMode: 'sdk',
      objects: [],
      scene: [],
      sourceDocument: {
        connection: 'attached-editor',
        instance,
        documentId,
        documentHash: 'r'.repeat(64),
        name: `문서 ${documentId}`,
        capturedAt: new Date().toISOString(),
      },
    });
  };
  const state = (id) => workspace.get(project.id, id).state;
  const settled = async () => {
    while (execution.active.size)
      await Promise.all([...execution.active.values()].map((entry) => entry.completion));
  };
  return { workspace, project, execution, gate, release, log, submit, send, sync, state, settled };
}

test('three conversations (model edit, CAD edit, question) are accepted and complete together', async (t) => {
  const { gate, release, log, send, sync, state, settled } = setup(t);
  sync('model', 1);
  sync('drawing', 5, 'zwcad');
  for (const key of ['model-edit', 'cad-edit', '법규 질문']) gate(key);
  send('model-edit', { baseRequestId: 'model' });
  send('cad-edit', { host: 'zwcad', baseRequestId: 'drawing' });
  const question = send('question', {
    hostUse: 'none',
    permission: 'review',
    body: '법규 질문',
  });
  assert.equal(question.result, null);
  assert.deepEqual(['model-edit', 'cad-edit', 'question'].map(state), [
    'running',
    'running',
    'running',
  ]);
  for (const key of ['model-edit', 'cad-edit', '법규 질문']) release(key);
  await settled();
  assert.deepEqual(['model-edit', 'cad-edit', 'question'].map(state), [
    'succeeded',
    'succeeded',
    'succeeded',
  ]);
  // The question used no host: it never reached a host SDK run.
  assert.equal(log.filter((line) => line.startsWith('start ')).length, 3);
  assert.ok(log.includes('start 법규 질문'));
  assert.ok(!log.includes('start question'));
});

test('two turn-level writers to one drawing: the second waits in line, then runs after the first', async (t) => {
  const { workspace, project, execution, gate, release, log, send, sync, state, settled } =
    setup(t);
  sync('model', 1, 'zwcad');
  gate('first');
  send('first', { host: 'zwcad', baseRequestId: 'model' });
  const second = send('second', { host: 'zwcad', baseRequestId: 'model' });
  assert.equal(second.state, 'queued');
  assert.equal(second.result.phase, 'queue');
  assert.deepEqual(second.result.waitingFor, {
    kind: 'document',
    key: JSON.stringify(['document', instance, 1]),
    host: 'zwcad',
    after: 'first',
    position: 1,
  });
  assert.equal(execution.active.has('second'), false);
  assert.equal(state('second'), 'queued');
  release('first');
  await settled();
  assert.deepEqual(log, ['start first', 'end first', 'start second', 'end second']);
  assert.equal(state('second'), 'succeeded');
  assert.equal(workspace.get(project.id, 'second').result.waitingFor, undefined);
});

test('reads, jig reads and reviews are not refused while a document is edited', async (t) => {
  const { workspace, project, execution, gate, send, sync, state } = setup(t);
  sync('model', 1);
  sync('other', 2);
  gate('edit');
  send('edit', { baseRequestId: 'model' });
  // A Sync of another file and of the edited file (the edit writes a working copy).
  sync('sync-other', 2);
  sync('sync-same', 1);
  // The check a jig input read makes (ARCH-03 §8: not a stored request).
  assert.equal(
    requestConflict(
      {
        id: 'jig-read',
        host: 'rhino',
        permission: 'review',
        source: 'document',
        sourceDocument: { instance, documentId: 1 },
      },
      workspace.list(project.id),
    ),
    undefined,
  );
  send('review', { baseRequestId: 'model', permission: 'review' });
  assert.equal(execution.active.has('review'), true);
  assert.equal(state('review'), 'running');
  assert.equal(state('edit'), 'running');
});

test('a waiting request can be cancelled and the next one moves up', async (t) => {
  const { workspace, project, execution, gate, release, log, send, sync, state, settled } =
    setup(t);
  sync('model', 1, 'zwcad');
  gate('a');
  send('a', { host: 'zwcad', baseRequestId: 'model' });
  send('b', { host: 'zwcad', baseRequestId: 'model' });
  assert.equal(send('c', { host: 'zwcad', baseRequestId: 'model' }).result.waitingFor.position, 2);
  assert.equal(execution.cancel(project.id, 'b').state, 'cancelled');
  assert.deepEqual(workspace.get(project.id, 'c').result.waitingFor, {
    kind: 'document',
    key: JSON.stringify(['document', instance, 1]),
    host: 'zwcad',
    after: 'a',
    position: 1,
  });
  release('a');
  await settled();
  assert.deepEqual(log, ['start a', 'end a', 'start c', 'end c']);
  assert.equal(state('b'), 'cancelled');
  assert.equal(state('c'), 'succeeded');
});

test('the fourth AI turn waits for a free turn and starts when one ends', async (t) => {
  const { execution, gate, release, send, state, settled } = setup(t);
  for (const key of ['q1', 'q2', 'q3', 'q4']) gate(key);
  for (const key of ['q1', 'q2', 'q3']) send(key, { hostUse: 'none', permission: 'review' });
  const fourth = send('q4', { hostUse: 'none', permission: 'review' });
  assert.deepEqual(fourth.result.waitingFor, {
    kind: 'project',
    key: 'ai-turns',
    limit: 3,
    position: 1,
  });
  release('q2');
  await execution.completion('q2');
  assert.equal(state('q4'), 'running');
  for (const key of ['q1', 'q3', 'q4']) release(key);
  await settled();
  assert.deepEqual(['q1', 'q2', 'q3', 'q4'].map(state), [
    'succeeded',
    'succeeded',
    'succeeded',
    'succeeded',
  ]);
});

test('[멈추고 이걸로] keeps the stopped request’s place ahead of the ones waiting behind it', async (t) => {
  const { execution, project, gate, log, send, sync, state, settled } = setup(t);
  sync('model', 1, 'zwcad');
  gate('a');
  send('a', { host: 'zwcad', baseRequestId: 'model' });
  send('b', { host: 'zwcad', baseRequestId: 'model' });
  execution.intervene(project.id, 'a', {
    id: 'a2',
    body: 'a2',
    provider: 'claude-cli',
    permission: 'candidate',
    host: 'zwcad',
    pins: [],
    sketches: [],
    files: [],
    baseRequestId: 'model',
  });
  await settled();
  assert.deepEqual(log, ['start a', 'stop a', 'start a2', 'end a2', 'start b', 'end b']);
  assert.deepEqual(['a', 'a2', 'b'].map(state), ['cancelled', 'succeeded', 'succeeded']);
});

test('replacing a request that is still waiting withdraws it and keeps its place', async (t) => {
  const { workspace, project, execution, gate, release, log, send, sync, state, settled } =
    setup(t);
  sync('model', 1, 'zwcad');
  gate('a');
  send('a', { host: 'zwcad', baseRequestId: 'model' });
  send('b', { host: 'zwcad', baseRequestId: 'model' });
  send('c', { host: 'zwcad', baseRequestId: 'model' });
  const replaced = execution.intervene(project.id, 'b', {
    id: 'b2',
    body: 'b2',
    provider: 'claude-cli',
    permission: 'candidate',
    host: 'zwcad',
    pins: [],
    sketches: [],
    files: [],
    baseRequestId: 'model',
  });
  assert.equal(state('b'), 'cancelled');
  assert.equal(replaced.result.waitingFor.after, 'a');
  assert.equal(replaced.result.waitingFor.position, 1);
  assert.equal(workspace.get(project.id, 'c').result.waitingFor.position, 2);
  release('a');
  await settled();
  assert.deepEqual(log, ['start a', 'end a', 'start b2', 'end b2', 'start c', 'end c']);
  assert.deepEqual(['b2', 'c'].map(state), ['succeeded', 'succeeded']);
});

test('two direct turns on one open Rhino document start together (executes take turns, SPEC-02.9 3)', async (t) => {
  const { gate, release, send, sync, state, settled } = setup(t);
  sync('model', 1);
  gate('first');
  gate('second');
  send('first', { baseRequestId: 'model' });
  const second = send('second', { baseRequestId: 'model' });
  assert.equal(second.result, null);
  assert.deepEqual(['first', 'second'].map(state), ['running', 'running']);
  release('first');
  release('second');
  await settled();
  assert.deepEqual(['first', 'second'].map(state), ['succeeded', 'succeeded']);
});

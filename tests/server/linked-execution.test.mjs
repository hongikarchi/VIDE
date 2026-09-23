import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { AgentTools } from '../../src/server/agent-tools.ts';
import { runLinked } from '../../src/server/linked-execution.ts';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-linked-'));
  const store = new Store(join(directory, 'test.sqlite')),
    workspace = new Workspace(store),
    tools = new AgentTools();
  t.after(async () => {
    tools.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = store.createProject('Linked test');
  const input = {
    body: 'test',
    permission: 'candidate',
    provider: 'codex-cli',
    pins: [],
    sketches: [],
    files: [],
  };
  for (const [id, host] of [
    ['a', 'zwcad'],
    ['b', 'rhino'],
  ]) {
    workspace.submit(project.id, { ...input, id, host, baseRequestId: null });
    workspace.update(project.id, id, 'succeeded', {
      host,
      verified: true,
      hostExecuted: true,
      executionMode: 'sdk',
      objects: [],
    });
  }
  const request = {
    ...input,
    id: 'parent',
    linkedTargets: [
      { host: 'zwcad', baseRequestId: 'a' },
      { host: 'rhino', baseRequestId: 'b' },
    ],
    coordinateBasis: 'shared-metre-axes',
  };
  return { store, workspace, tools, project, request };
}
const payload = (result) => JSON.parse(result.content[0].text);
test('multiple target scope accepts exactly its explicit set and internal dispatch shares expiry and limits', async () => {
  let now = 1,
    calls = 0;
  const tools = new AgentTools({ now: () => now });
  const scope = tools.issue({
    targetRef: ['one', 'two'],
    isCurrent: () => true,
    maxCalls: 2,
    ttlMs: 10,
    handlers: { query: () => ++calls },
  });
  assert.equal(
    payload(await tools.call(scope.token, 'query', { targetRef: 'third' })).code,
    'TARGET_MISMATCH',
  );
  assert.equal(payload(await tools.call(scope.token, 'query', { targetRef: 'one' })), 1);
  assert.equal(payload(await tools.call(scope.token, 'query', { targetRef: 'two' })), 2);
  assert.equal(
    payload(await tools.call(scope.token, 'query', { targetRef: 'one' })).code,
    'AGENT_CALL_LIMIT',
  );
  now = 20;
  assert.equal(
    payload(await tools.call(scope.token, 'query', { targetRef: 'one' })).code,
    'AGENT_SCOPE_EXPIRED',
  );
  assert.equal(calls, 2);
  scope.revoke();
  tools.close();
});
test('linked inputs reject unconfirmed coordinates, duplicate bases and cross-project targets', async (t) => {
  const { workspace, project, request, store } = await fixture(t);
  assert.throws(() => workspace.submit(project.id, { ...request, coordinateBasis: undefined }), {
    code: 'INVALID_INPUT',
  });
  assert.throws(
    () =>
      workspace.submit(project.id, {
        ...request,
        linkedTargets: [request.linkedTargets[0], request.linkedTargets[0]],
      }),
    { code: 'INVALID_INPUT' },
  );
  assert.throws(() => workspace.submit(project.id, { ...request, parentRequestId: 'forged' }), {
    code: 'INVALID_INPUT',
  });
  const other = store.createProject('Other');
  assert.throws(() => workspace.submit(other.id, request), { code: 'NOT_FOUND' });
  assert.throws(
    () =>
      workspace.submit(project.id, {
        ...request,
        linkedTargets: [request.linkedTargets[0], { host: 'zwcad', baseRequestId: 'b' }],
      }),
    { code: 'TARGET_MISMATCH' },
  );
});
for (const uncertain of [false, true])
  test(`one agent preserves per-target results, uncertain second=${uncertain}`, async (t) => {
    const { workspace, tools, project, request } = await fixture(t);
    const parent = workspace.submit(project.id, request).request;
    workspace.update(project.id, parent.id, 'running');
    const writes = { a: 0, b: 0 };
    let providerCalls = 0;
    const driver = {
      run: async (task) => {
        const key = task.previous.id,
          targetRef = 'target-' + key;
        let unknown = false;
        const scope = tools.issue({
          targetRef,
          isCurrent: () => !unknown,
          handlers: {
            query: () => ({ writes: writes[key] }),
            execute: () => {
              writes[key]++;
              task.update({ phase: 'host', operationId: key });
              if (uncertain && key === 'b') {
                unknown = true;
                throw Object.assign(Error('lost'), { code: 'HOST_RESULT_UNKNOWN' });
              }
              return { ok: true };
            },
          },
        });
        try {
          const response = await task
            .provider({
              url: 'http://127.0.0.1:1/mcp',
              token: scope.token,
              targetRef,
              tools: ['query', 'execute'],
            })
            .run(
              { goal: targetRef, revision: 1, items: [], includedIds: [] },
              { signal: task.signal, onProgress: () => {} },
            );
          if (unknown)
            throw Object.assign(Error('lost'), {
              code: 'HOST_RESULT_UNKNOWN',
              intent: { phase: 'host', operationId: key },
            });
          return {
            ...response,
            hostExecuted: true,
            verified: true,
            host: task.input.host,
            objects: [],
          };
        } finally {
          scope.revoke();
        }
      },
    };
    await runLinked({
      request: parent,
      workspace,
      tools,
      drivers: { rhino: driver, zwcad: driver },
      items: [],
      signal: new AbortController().signal,
      provider: (connection) => ({
        run: async () => {
          providerCalls++;
          assert.equal(
            payload(
              await tools.call(connection.token, 'execute', {
                targetRef: 'target-a',
                code: 'edit',
              }),
            ).ok,
            true,
          );
          const second = await tools.call(connection.token, 'execute', {
            targetRef: 'target-b',
            code: 'edit',
          });
          assert.equal(Boolean(second.isError), uncertain);
          return { text: 'target outcomes' };
        },
      }),
    });
    assert.equal(providerCalls, 1);
    assert.deepEqual(writes, { a: 1, b: 1 });
    const result = workspace.get(project.id, parent.id);
    assert.equal(result.state, uncertain ? 'failed' : 'succeeded');
    assert.deepEqual(
      result.result.targetResults.map((row) => row.state),
      ['succeeded', uncertain ? 'unknown' : 'succeeded'],
    );
    const success = workspace.get(project.id, result.result.targetResults[0].requestId);
    assert.equal(success.result.verified, true);
    if (uncertain) {
      const reopened = new Workspace(workspace.store);
      assert.equal(
        reopened.get(project.id, result.result.targetResults[1].requestId).state,
        'unknown',
      );
      assert.deepEqual(writes, { a: 1, b: 1 });
      const recoveredId = result.result.targetResults[1].requestId;
      reopened.update(project.id, recoveredId, 'succeeded', { hostExecuted: true, verified: true });
      const parentAfterRecovery = reopened.get(project.id, parent.id);
      assert.equal(parentAfterRecovery.state, 'failed');
      assert.equal(parentAfterRecovery.result.targetResults[1].state, 'succeeded');
      assert.equal(parentAfterRecovery.result.targetResults[1].candidate, true);
    }
  });

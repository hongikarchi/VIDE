import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZwcadSdkExecution } from '../../src/server/zwcad-sdk-execution.ts';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-cad-sdk-'));
  let scope,
    stopped = 0,
    revoked = 0;
  const model = {
    objects: [
      {
        id: 'cad-44',
        nativeId: '44',
        kind: 'polyline',
        name: 'boundary',
        points: [
          [0, 0, 0],
          [20, 0, 0],
        ],
      },
    ],
    scene: [{ id: 'cad-44', area: 200 }],
  };
  const worker = {
    identity: { sessionId: 'owned' },
    query: async () => ({ model }),
    exportModel: async () => model,
    execute: async (operationId) => ({
      ok: true,
      operationId,
      revision: 1,
      filename: 'saved.dwg',
      fileHash: 'a'.repeat(64),
      model,
      readbackVerified: true,
    }),
    stop: async () => {
      stopped++;
    },
  };
  const sdk = new ZwcadSdkExecution({
    directory,
    launch: async () => worker,
    origin: () => 'http://127.0.0.1:1234',
    tools: {
      issue: (options) => {
        scope = options;
        return {
          token: 'secret',
          revoke: () => {
            revoked++;
          },
        };
      },
    },
  });
  const task = {
    input: { body: 'test', permission: 'candidate', pins: [] },
    items: [],
    signal: new AbortController().signal,
    update: () => {},
  };
  try {
    await run({
      sdk,
      task,
      worker,
      model,
      scope: () => scope,
      counts: () => ({ stopped, revoked }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('ZWCAD SDK review never exposes execution', () =>
  fixture(async ({ sdk, task, scope, counts }) => {
    const result = await sdk.run({
      ...task,
      input: { ...task.input, permission: 'review' },
      provider: (connection) => ({
        run: async () => {
          assert.deepEqual(connection.tools, ['query']);
          assert.equal(scope().handlers.execute, undefined);
          return { text: 'review' };
        },
      }),
    });
    assert.equal(result.hostExecuted, false);
    assert.deepEqual(counts(), { stopped: 1, revoked: 1 });
  }));
test('ZWCAD SDK correctable compile failure and post-write unknown have different retry behavior', () =>
  fixture(async ({ sdk, task, worker, scope }) => {
    let calls = 0;
    worker.execute = async () =>
      ++calls === 1
        ? { ok: false, code: 'COMPILE_ERROR', diagnostics: ['bad code'] }
        : { ok: false, code: 'HOST_RESULT_UNKNOWN', diagnosticId: 'local-id' };
    await assert.rejects(
      sdk.run({
        ...task,
        provider: () => ({
          run: async () => {
            assert.equal((await scope().handlers.execute({ code: 'bad' })).code, 'COMPILE_ERROR');
            await assert.rejects(scope().handlers.execute({ code: 'runtime error' }), {
              code: 'HOST_RESULT_UNKNOWN',
            });
            await assert.rejects(scope().handlers.execute({ code: 'retry' }), {
              code: 'HOST_RESULT_UNKNOWN',
            });
            return { text: 'done' };
          },
        }),
      }),
      (error) => error.code === 'HOST_RESULT_UNKNOWN' && error.intent.diagnosticId === 'local-id',
    );
    assert.equal(calls, 2);
  }));
test('ZWCAD SDK refuses a candidate that changed a protected object', () =>
  fixture(async ({ sdk, task, worker, model, scope }) => {
    const original = structuredClone(model);
    model.scene[0].area = 240;
    await assert.rejects(
      sdk.run({
        ...task,
        input: { ...task.input, pins: [{ id: 'cad-44', basis: 'base', role: 'preserve' }] },
        previous: {
          id: 'base',
          result: { ...original, filename: 'source.dwg', fileHash: 'a'.repeat(64) },
        },
        provider: () => ({
          run: async () => {
            await scope().handlers.execute({ code: 'edit' });
            return { text: 'done' };
          },
        }),
      }),
      (error) =>
        error.code === 'HOST_RESULT_UNKNOWN' && error.intent.protection[0].scene.area === 200,
    );
  }));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
      directory,
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
test('ZWCAD oversized write summary preserves verified success and complete candidate', () =>
  fixture(async ({ sdk, task, scope, model }) => {
    model.objects[0].name = '가'.repeat(65536);
    const result = await sdk.run({
      ...task,
      provider: () => ({
        run: async () => {
          const reply = await scope().handlers.execute({ code: 'synthetic' });
          assert.equal(reply.ok, true);
          assert.equal(reply.readbackVerified, true);
          assert.equal(reply.objectsOmitted, true);
          assert.equal(reply.reason, 'QUERY_RESULT_TOO_LARGE');
          assert.match(reply.instruction, /Do not replay/);
          assert.ok(JSON.stringify(reply).length < 1024);
          return { text: 'Saved' };
        },
      }),
    });
    assert.equal(result.objects[0].name.length, 65536);
  }));

test('ZWCAD receipt recovery preserves the source document and observed progress without replay', () =>
  fixture(async ({ sdk, directory, model, worker }) => {
    const operationId = randomUUID();
    const workerDirectory = join(directory, randomUUID());
    await mkdir(workerDirectory);
    const filename = join(workerDirectory, operationId + '.dwg');
    await writeFile(
      join(workerDirectory, operationId + '.receipt.json'),
      JSON.stringify({
        result: {
          ok: true,
          operationId,
          revision: 2,
          filename,
          fileHash: 'a'.repeat(64),
          model,
          readbackVerified: true,
        },
      }),
    );
    let writes = 0;
    worker.execute = async () => {
      writes++;
      throw Error('Must not replay');
    };
    const sourceDocument = {
      instance: 'owned-editor',
      documentId: 42,
      documentHash: 'b'.repeat(64),
    };
    const progress = { queries: 3, attempts: 3, completed: 2 };
    const recovered = await sdk.recover({
      operationId,
      workerDirectory,
      sourceDocument,
      progress,
      baseRequestId: 'base',
    });
    assert.deepEqual(recovered.sourceDocument, sourceDocument);
    assert.deepEqual(recovered.progress, progress);
    assert.equal(recovered.baseRequestId, 'base');
    assert.equal(recovered.recovered, true);
    assert.equal(writes, 0);
  }));
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

for (const failAfterWrite of [false, true])
  test(
    'ZWCAD progress counts observed queries, attempts and verified writes; fail=' + failAfterWrite,
    () =>
      fixture(async ({ sdk, task, worker, scope }) => {
        const updates = [];
        let calls = 0;
        const original = worker.execute;
        worker.execute = async (...args) => {
          calls++;
          if (calls === 1) return { ok: false, code: 'COMPILE_ERROR', diagnostics: ['fixture'] };
          return { ...(await original(...args)), revision: calls - 1 };
        };
        const running = sdk.run({
          ...task,
          update: (value) => updates.push(value),
          provider: () => ({
            run: async (_context, callbacks) => {
              await scope().handlers.query();
              assert.deepEqual(updates.at(-1).progress, { queries: 1, attempts: 0, completed: 0 });
              await scope().handlers.execute({ code: 'invalid' });
              assert.deepEqual(updates.at(-1).progress, { queries: 1, attempts: 1, completed: 0 });
              await scope().handlers.execute({ code: 'first' });
              await scope().handlers.query();
              await scope().handlers.execute({ code: 'second' });
              callbacks.onProgress({ state: 'running' });
              assert.equal(
                updates.at(-1).phase,
                'host',
                'Confirmed writes must remain recoverable after restart',
              );
              assert.deepEqual(updates.at(-1).progress, { queries: 2, attempts: 3, completed: 2 });
              if (failAfterWrite) throw new Error('provider stopped after write');
              return { text: 'done' };
            },
          }),
        });
        if (failAfterWrite)
          await assert.rejects(running, (error) => {
            assert.equal(error.code, 'HOST_RESULT_UNKNOWN');
            assert.deepEqual(error.intent.progress, { queries: 2, attempts: 3, completed: 2 });
            return true;
          });
        else assert.deepEqual((await running).progress, { queries: 2, attempts: 3, completed: 2 });
      }),
  );

test('request command cap refuses an extra native write and preserves recovery intent', () =>
  fixture(async ({ sdk, task, worker, scope }) => {
    let calls = 0;
    const original = worker.execute;
    worker.execute = async (...args) => {
      calls++;
      return original(...args);
    };
    await assert.rejects(
      sdk.run({
        ...task,
        input: {
          ...task.input,
          executionLimits: { maxToolCalls: 3, maxHostCommands: 1, timeoutSeconds: 30 },
        },
        provider: () => ({
          run: async () => {
            assert.equal(scope().maxCalls, 3);
            assert.equal(scope().ttlMs, 90000);
            await scope().handlers.execute({ code: 'one' });
            await scope().handlers.execute({ code: 'must not execute' });
            return { text: 'unreachable' };
          },
        }),
      }),
      (error) => error.code === 'HOST_RESULT_UNKNOWN' && error.cause.code === 'HOST_COMMAND_LIMIT',
    );
    assert.equal(calls, 1);
  }));

test('linked unchanged target retains a verified source without an empty write', () =>
  fixture(async ({ sdk, task, scope, worker }) => {
    worker.execute = async () => {
      throw Error('No write expected');
    };
    const source = {
      ...(await worker.exportModel()),
      filename: 'basis.model',
      fileHash: 'b'.repeat(64),
      verified: true,
      hostExecuted: true,
      executionMode: 'sdk',
    };
    const run = async (input, query = true, previous = source) =>
      sdk.run({
        ...task,
        input: { ...task.input, parentRequestId: 'parent', ...input },
        previous: { id: 'basis', result: previous },
        provider: () => ({
          run: async () => {
            if (query) await scope().handlers.query({});
            return { text: 'Keep this target unchanged' };
          },
        }),
      });
    const result = await run({});
    assert.equal(result.unchanged, true);
    assert.equal(result.filename, source.filename);
    assert.equal(result.fileHash, source.fileHash);
    assert.equal(result.baseRequestId, 'basis');
    assert.equal(result.hostExecuted, true);
    assert.equal(result.progress.attempts, 0);
    assert.equal(result.progress.completed, 0);
    assert.deepEqual(result.changes, { added: [], removed: [], modified: [] });
    assert.equal((await run({}, false)).hostExecuted, false);
    assert.equal((await run({ permission: 'review' })).hostExecuted, false);
    assert.equal((await run({ parentRequestId: undefined })).hostExecuted, false);
    assert.equal((await run({}, true, { ...source, verified: false })).hostExecuted, false);
    worker.execute = async () => ({ ok: false, code: 'COMPILE_ERROR', revision: 0 });
    const refused = await sdk.run({
      ...task,
      input: { ...task.input, parentRequestId: 'parent' },
      previous: { id: 'basis', result: source },
      provider: () => ({
        run: async () => {
          await scope().handlers.query({});
          await scope().handlers.execute({ code: 'invalid' });
          return { text: 'Failed compilation' };
        },
      }),
    });
    assert.equal(refused.hostExecuted, false);
    assert.equal(refused.unchanged, undefined);
  }));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SdkExecution } from '../../src/server/sdk-execution.ts';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-sdk-'));
  let scope,
    stopped = 0,
    revoked = 0,
    calls = 0;
  const launches = [];
  const worker = {
    identity: { sessionId: 'owned' },
    query: async () => ({ objects: [] }),
    execute: async () => {
      calls++;
      return {
        ok: true,
        revision: 1,
        operationId: 'write-1',
        filename: 'saved.3dm',
        fileHash: 'a'.repeat(64),
        snapshot: { objects: [] },
        readbackVerified: true,
      };
    },
    exportModel: async () => ({ objects: [], scene: [] }),
    stop: async () => {
      stopped++;
    },
  };
  const sdk = new SdkExecution({
    directory,
    executable: 'rhino',
    plugin: 'plugin',
    bootstrap: 'bootstrap',
    origin: () => 'http://127.0.0.1:1234',
    launch: async (options) => {
      launches.push(options);
      return worker;
    },
    tools: {
      issue: (options) => {
        scope = options;
        return {
          token: 'token',
          revoke: () => {
            revoked++;
          },
        };
      },
    },
  });
  const input = {
      id: 'request',
      body: 'task',
      provider: 'codex-cli',
      permission: 'candidate',
      pins: [],
      sketches: [],
      files: [],
    },
    updates = [];
  const task = {
    input,
    items: [],
    signal: new AbortController().signal,
    update: (value) => updates.push(value),
  };
  try {
    await run({
      sdk,
      task,
      worker,
      updates,
      launches,
      scope: () => scope,
      counts: () => ({ stopped, revoked, calls }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('SDK review cannot acquire execute and closes its owned worker', () =>
  fixture(async ({ sdk, task, scope, counts }) => {
    const result = await sdk.run({
      ...task,
      input: { ...task.input, permission: 'review' },
      provider: (connection) => ({
        run: async () => {
          // Review keeps the read tools: query and the AI's eyes (PLAN-24), never execute.
          assert.deepEqual(connection.tools, ['query', 'capture_view', 'measure']);
          assert.equal(scope().handlers.execute, undefined);
          return { text: 'Review' };
        },
      }),
    });
    assert.equal(result.hostExecuted, false);
    assert.deepEqual(counts(), { stopped: 1, revoked: 1, calls: 0 });
  }));
test('display-only basis prepares a fresh native copy before AI, also after Rhino moved on', () =>
  fixture(async ({ sdk, task, launches, scope }) => {
    const sourceDocument = {
      instance: '1:2',
      documentId: 7,
      documentHash: 'before',
      connection: 'attached-editor',
    };
    const previous = {
      id: 'display',
      result: { displayOnly: true, verified: false, sourceDocument },
    };
    let prepared = 0;
    sdk.editors.inspect = async () => ({ documentHash: 'before' });
    sdk.captureEditor = async () => {
      prepared++;
      return { filename: 'prepared.3dm', fileHash: 'a'.repeat(64), sourceDocument, verified: true };
    };
    await sdk.run({
      ...task,
      previous,
      provider: () => ({
        run: async () => {
          assert.equal(prepared, 1);
          assert.equal(launches.at(-1).source.filename, 'prepared.3dm');
          await scope().handlers.query();
          return { text: 'Reviewed' };
        },
      }),
    });
    // Rhino's revision moves on material/property events and ongoing work; the request edits the
    // document as it is now (application checks each changed object against this capture).
    sdk.editors.inspect = async () => ({ documentHash: 'changed' });
    await sdk.run({
      ...task,
      previous,
      provider: () => ({ run: async () => ({ text: 'Reviewed again' }) }),
    });
    assert.equal(prepared, 2);
    assert.equal(previous.result.displayOnly, true);
  }));

test('Rhino agent sees a bounded write summary while final candidate retains every change', () =>
  fixture(async ({ sdk, task, scope, worker }) => {
    const objects = Array.from({ length: 10000 }, (_, i) => ({ id: String(i) }));
    const changes = { added: objects.map((o) => o.id), removed: [], modified: [] };
    worker.execute = async () => ({
      ok: true,
      revision: 1,
      operationId: 'write-1',
      filename: 'saved.3dm',
      fileHash: 'a'.repeat(64),
      readbackVerified: true,
      snapshot: { objects, revision: 1 },
      changes,
    });
    worker.exportModel = async () => ({ objects, scene: [] });
    const result = await sdk.run({
      ...task,
      provider: () => ({
        run: async () => {
          const reply = await scope().handlers.execute({ code: 'synthetic' });
          assert.equal(reply.snapshot.objects.length, 50);
          assert.equal(reply.snapshot.page.total, 10000);
          assert.equal(reply.changes.added.length, 50);
          assert.equal(reply.changes.counts.added, 10000);
          assert.equal(reply.changes.complete, false);
          assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 65536);
          return { text: 'Saved' };
        },
      }),
    });
    assert.equal(result.objects.length, 10000);
    assert.equal(result.changes.added.length, 10000);
  }));

test('SDK saves host intent before execution and preserves protected IDs', () =>
  fixture(async ({ sdk, task, scope, worker, updates }) => {
    const changes = {
      added: [],
      removed: ['deleted'],
      modified: [{ id: 'changed', geometry: true, attributes: false, nativeIdentity: false }],
    };
    let protectedIds;
    worker.execute = async (id, revision, code, ids) => {
      assert.equal(updates.at(-1).phase, 'host');
      assert.equal(updates.at(-1).operationId, id);
      protectedIds = ids;
      return {
        ok: true,
        operationId: id,
        revision: 1,
        filename: 'saved.3dm',
        fileHash: 'a'.repeat(64),
        snapshot: {},
        changes,
        readbackVerified: true,
      };
    };
    const result = await sdk.run({
      ...task,
      previous: { id: 'basis', result: { filename: 'source.3dm', fileHash: 'b'.repeat(64) } },
      input: { ...task.input, pins: [{ id: 'keep', basis: 'basis', role: 'preserve' }] },
      provider: () => ({
        run: async () => {
          await scope().handlers.execute({ code: 'SDK code' });
          return { text: 'Saved' };
        },
      }),
    });
    assert.deepEqual(protectedIds, ['keep']);
    assert.equal(result.hostExecuted, true);
    assert.equal(result.baseRequestId, 'basis');
    assert.equal(result.executionMode, 'sdk');
    assert.deepEqual(result.changes, changes);
  }));
test('SDK compile rejection allows correction but lost write blocks subsequent writes', () =>
  fixture(async ({ sdk, task, scope, worker, counts }) => {
    let count = 0;
    worker.execute = async () => {
      count++;
      if (count === 1) return { ok: false, code: 'COMPILE_ERROR', diagnostics: ['fix'] };
      throw Error('lost response');
    };
    await assert.rejects(
      sdk.run({
        ...task,
        provider: () => ({
          run: async () => {
            assert.equal(
              (await scope().handlers.execute({ code: 'invalid' })).code,
              'COMPILE_ERROR',
            );
            await assert.rejects(scope().handlers.execute({ code: 'corrected' }));
            assert.equal(await scope().isCurrent(), false);
            await assert.rejects(scope().handlers.execute({ code: 'duplicate' }), {
              code: 'HOST_RESULT_UNKNOWN',
            });
            return { text: 'Not successful' };
          },
        }),
      }),
      { code: 'HOST_RESULT_UNKNOWN' },
    );
    assert.equal(count, 2);
    assert.equal(counts().stopped, 1);
  }));
test('SDK provider failure after successful write remains recoverable uncertainty', () =>
  fixture(async ({ sdk, task, scope, counts }) => {
    await assert.rejects(
      sdk.run({
        ...task,
        provider: () => ({
          run: async () => {
            await scope().handlers.execute({ code: 'SDK' });
            throw Error('CLI response lost');
          },
        }),
      }),
      (error) =>
        error.code === 'HOST_RESULT_UNKNOWN' && typeof error.intent.operationId === 'string',
    );
    assert.equal(counts().stopped, 1);
  }));

test('measurement reuse requires the matching SDK calculation version and validated source model', () =>
  fixture(async ({ sdk, task, launches }) => {
    const nativeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      point = [0, 0, 0];
    const result = {
      executionMode: 'sdk',
      measurementVersion: 1,
      filename: 'source.3dm',
      fileHash: 'a'.repeat(64),
      objects: [{ id: 'object', nativeId, kind: 'native', name: 'Box', origin: point }],
      scene: [
        {
          id: 'object',
          nativeId,
          nativeType: 'Brep',
          name64: '',
          origin: point,
          boundsSize: [1, 1, 1],
          vertices: [],
          indices: [],
          line: [],
          area: 6,
          volume: 1,
          length: null,
          layer64: '',
          attributes64: [],
          attributesComplete: true,
          valid: true,
        },
      ],
    };
    const execute = async (value) =>
      sdk.run({
        ...task,
        previous: { id: 'basis', result: value },
        input: { ...task.input, permission: 'review' },
        provider: () => ({ run: async () => ({ text: 'Reviewed' }) }),
      });
    await execute(result);
    assert.deepEqual(launches.at(-1).source.measurements, [
      { id: 'object', area: 6, volume: 1, length: null },
    ]);
    await execute({ ...result, measurementVersion: undefined });
    assert.equal(launches.at(-1).source.measurements, undefined);
    await execute({ ...result, scene: [{ ...result.scene[0], volume: -1 }] });
    assert.equal(launches.at(-1).source.measurements, undefined);
  }));

test('SDK returns bounded computed data to the agent without hiding successful large-result edits', () =>
  fixture(async ({ sdk, task, scope, worker }) => {
    const execute = worker.execute;
    let value = { height: 8, level: 'L02' };
    worker.execute = async (...args) => ({ ...(await execute(...args)), value });
    await sdk.run({
      ...task,
      provider: () => ({
        run: async () => {
          const small = await scope().handlers.execute({ code: 'return summary;' });
          assert.deepEqual(small.value, value);
          value = 'x'.repeat(17000);
          const large = await scope().handlers.execute({ code: 'return large;' });
          assert.equal(large.ok, true);
          assert.equal(large.value, undefined);
          assert.equal(large.valueOmitted, true);
          return { text: 'Saved' };
        },
      }),
    });
  }));

test('SDK policy rejection permits correction but runtime diagnostic remains unknown without replay', () =>
  fixture(async ({ sdk, task, worker, scope, updates }) => {
    let calls = 0;
    const diagnosticId = '11111111-1111-4111-8111-111111111111';
    worker.execute = async () =>
      ++calls === 1
        ? {
            ok: false,
            code: 'CODE_POLICY_REJECTED',
            revision: 0,
            diagnostics: ['API not permitted'],
          }
        : {
            ok: false,
            code: 'HOST_RESULT_UNKNOWN',
            diagnosticId,
            exceptionType: 'System.InvalidOperationException',
          };
    await assert.rejects(
      sdk.run({
        ...task,
        provider: () => ({
          run: async () => {
            assert.equal(
              (await scope().handlers.execute({ code: 'disallowed' })).code,
              'CODE_POLICY_REJECTED',
            );
            await assert.rejects(scope().handlers.execute({ code: 'throws' }), {
              code: 'HOST_RESULT_UNKNOWN',
            });
            await assert.rejects(scope().handlers.execute({ code: 'must not replay' }), {
              code: 'HOST_RESULT_UNKNOWN',
            });
            return { text: 'failed' };
          },
        }),
      }),
      (error) => error.code === 'HOST_RESULT_UNKNOWN' && error.intent.diagnosticId === diagnosticId,
    );
    assert.equal(calls, 2);
    assert.equal(updates.at(-1).diagnosticId, diagnosticId);
  }));

for (const failAfterWrite of [false, true])
  test(
    'Rhino progress counts observed queries, attempts and verified writes; fail=' + failAfterWrite,
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

test('the work-copy turn offers the project read tools beside its host tools (T-062)', () =>
  fixture(async ({ sdk, task, scope }) => {
    const projectTools = {
      links_layers: async () => ({ links: [] }),
      sync_sample: async () => ({ items: [] }),
    };
    for (const permission of ['review', 'candidate'])
      await sdk.run({
        ...task,
        input: { ...task.input, permission },
        projectTools,
        provider: (connection) => ({
          run: async () => {
            assert.ok(connection.tools.includes('links_layers'), permission);
            assert.ok(connection.tools.includes('sync_sample'), permission);
            assert.equal(connection.tools.includes('execute'), permission === 'candidate');
            assert.equal(scope().handlers.links_layers, projectTools.links_layers);
            return { text: permission };
          },
        }),
      });
  }));

// Several linked files in one request (ADR-027): a direct Rhino turn reads the project's other
// open linked files live through `linkId`. Mock editor channels for two documents, a closed link,
// and a scripted provider over the turn's MCP scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { AgentTools } from '../../src/server/agent-tools.ts';
import { documentHolder } from '../../src/contracts/request-scope.ts';

const hash = 'a'.repeat(64);
const sourceDocument = (instance, name) => ({
  instance,
  documentId: 7,
  documentHash: hash,
  connection: 'attached-editor',
  name,
  capturedAt: '2026-10-01T00:00:00.000Z',
});

/** One attached document: an undo stack answering direct-execute/direct-undo like the worker. */
export function mockDocument(name, instance, { vision = true } = {}) {
  const calls = { execute: [], undo: [], query: 0, capture: 0, measure: 0 };
  const records = [];
  let serial = 10;
  // Per-call overrides: the next execute (or undo) answers this instead.
  const next = { execute: [], undo: [] };
  const driver = {
    host: 'rhino',
    target: { instance, documentId: 7 },
    async execute(command) {
      calls.execute.push(command);
      const scripted = next.execute.shift();
      if (scripted) return scripted(command);
      if (command.code.startsWith('bad'))
        return { ok: false, code: 'COMPILE_ERROR', diagnostics: ['CS1002: ; expected'] };
      const undoId = `${name}-${++serial}`;
      records.push({ undoId, undone: false });
      return {
        ok: true,
        undoId,
        changes: {
          added: [{ nativeId: `${name}-obj-${serial}`, hash, layer: 'Walls' }],
          changed: [],
          removed: [],
        },
        log: '',
      };
    },
    async undo(undoId) {
      calls.undo.push(undoId);
      const scripted = next.undo.shift();
      if (scripted) return scripted(undoId);
      const record = records.find((entry) => entry.undoId === undoId);
      if (!record) return { ok: false, reason: 'unknown' };
      if (record.undone) return { ok: true, already: true };
      if (records.filter((entry) => !entry.undone).at(-1) !== record)
        return { ok: false, reason: 'not-latest' };
      record.undone = true;
      return { ok: true };
    },
    async query() {
      calls.query++;
      return { objects: [{ id: `${name}-1` }], page: { total: 1 }, units: 'Millimeters' };
    },
    ...(vision
      ? {
          vision: async () => ({
            captureView: async () => {
              calls.capture++;
              return { mimeType: 'image/png', data: 'iVBORw0KGgo=', width: 64, height: 64, name };
            },
            measure: async (options) => {
              calls.measure++;
              return { objects: (options.ids ?? []).map((id) => ({ id, length: 1, file: name })) };
            },
          }),
        }
      : {}),
  };
  /** A later edit by the user in this document (makes earlier records not the latest). */
  const userEdit = () => records.push({ undoId: `${name}-user-${records.length}`, undone: false });
  return { driver, calls, records, next, userEdit, name };
}

/** A provider whose turn is a script over the MCP scope it was given (called in-process). */
function scripted(tools, script) {
  const seen = [];
  const providerFactory = ({ agent }) => ({
    async run(context, options) {
      seen.push({ agent, context });
      const call = async (name, args = {}) => {
        const result = await tools.call(agent.token, name, { targetRef: agent.targetRef, ...args });
        return { error: result.isError === true, value: JSON.parse(result.content.at(-1).text) };
      };
      return script({ agent, context, call, signal: options.signal, turn: seen.length });
    },
    async status() {
      return { available: true };
    },
  });
  return { providerFactory, seen };
}

export function setup(t, script, { documents, links } = {}) {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('multi');
  const tools = new AgentTools({ origin: 'http://127.0.0.1:9' });
  const a = documents?.a ?? mockDocument('A', 'win-a');
  const b = documents?.b ?? mockDocument('B', 'win-b');
  const all = [a, b, ...(documents?.more ?? [])];
  const { providerFactory, seen } = scripted(tools, script);
  const execution = new Execution(workspace, {
    tools,
    providerFactory,
    directDriver: (kind, source) =>
      all.find(
        (entry) => entry.driver.host === kind && entry.driver.target.instance === source?.instance,
      )?.driver,
    liveLinks: async () =>
      links ?? [
        { id: 'link-a', host: 'rhino', name: 'A.3dm', open: { instance: 'win-a', documentId: 7 } },
        { id: 'link-b', host: 'rhino', name: 'B.3dm', open: { instance: 'win-b', documentId: 7 } },
        { id: 'link-c', host: 'rhino', name: 'C.3dm', open: null },
      ],
  });
  t.after(async () => {
    await execution.close();
    tools.close();
    store.close();
  });
  const base = {
    body: '두 파일 맞추기',
    provider: 'claude-cli',
    pins: [],
    sketches: [],
    files: [],
  };
  const sync = (id, instance, name) => {
    workspace.submit(project.id, { ...base, id, body: 'Sync', mode: 'plan' });
    workspace.update(project.id, id, 'succeeded', {
      host: 'rhino',
      hostExecuted: true,
      displayOnly: true,
      objects: [],
      scene: [],
      sourceDocument: sourceDocument(instance, name),
    });
  };
  sync('sync-a', 'win-a', 'A.3dm');
  sync('sync-b', 'win-b', 'B.3dm');
  const submit = (id, fields = {}) =>
    workspace.submit(project.id, { ...base, id, baseRequestId: 'sync-a', ...fields }).request;
  const send = (id, fields = {}) => {
    const request = submit(id, fields);
    execution.start(request);
    return request;
  };
  const settled = async () => {
    while (execution.active.size)
      await Promise.all([...execution.active.values()].map((entry) => entry.completion));
  };
  const state = (id) => workspace.get(project.id, id);
  return {
    store,
    workspace,
    project,
    execution,
    tools,
    a,
    b,
    seen,
    submit,
    send,
    settled,
    state,
  };
}

test('A direct turn reads another open linked file live with linkId (Auto and Plan)', async (t) => {
  const answers = [];
  const { a, b, seen, send, settled, state } = setup(t, async ({ call }) => {
    answers.push(await call('query', { linkId: 'link-b' }));
    answers.push(await call('measure', { linkId: 'link-b', ids: ['B-1'] }));
    answers.push(await call('capture_view', { linkId: 'link-b' }));
    // The target itself, by its own link id or with none.
    answers.push(await call('query', { linkId: 'link-a' }));
    answers.push(await call('query'));
    return { text: 'B 파일을 읽었습니다.' };
  });
  send('auto-1', { mode: 'auto' });
  await settled();
  send('plan-1', { mode: 'plan' });
  await settled();
  for (const id of ['auto-1', 'plan-1'])
    assert.equal(state(id).state, 'succeeded', JSON.stringify(state(id).result));
  assert.ok(
    answers.every((answer) => !answer.error),
    JSON.stringify(answers),
  );
  assert.equal(answers[0].value.objects[0].id, 'B-1');
  assert.equal(answers[1].value.objects[0].file, 'B');
  assert.equal(answers[2].value.name, 'B');
  assert.equal(answers[3].value.objects[0].id, 'A-1');
  assert.equal(answers[4].value.objects[0].id, 'A-1');
  assert.deepEqual([b.calls.query, b.calls.measure, b.calls.capture], [2, 2, 2]);
  assert.equal(a.calls.query, 4);
  // Reads never write: no execute reached either document.
  assert.equal(a.calls.execute.length + b.calls.execute.length, 0);
  // The goal lists the linked files: the target, the open one, the closed one.
  const goal = seen[0].context.goal;
  assert.match(goal, /link-a · A\.3dm \(Rhino\) · the target/);
  assert.match(goal, /link-b · B\.3dm \(Rhino\) · open: read it live/);
  assert.match(goal, /link-c · C\.3dm \(Rhino\) · closed: stored Sync only/);
  // The activity names the other file.
  const texts = state('auto-1').result.activity.map((entry) => entry.text);
  assert.ok(
    texts.some((text) => /^B\.3dm · 문서 조회/.test(text)),
    texts.join('\n'),
  );
  assert.ok(texts.includes('B.3dm · 모델 치수 재기'));
});

test('A closed or unknown link answers LINK_NOT_LIVE / NOT_FOUND and points to the stored Sync', async (t) => {
  const answers = [];
  const { b, send, settled, state } = setup(t, async ({ call }) => {
    answers.push(await call('query', { linkId: 'link-c' }));
    answers.push(await call('capture_view', { linkId: 'link-c' }));
    answers.push(await call('query', { linkId: 'link-zz' }));
    answers.push(await call('execute', { linkId: 'link-c', code: 'add wall' }));
    return { text: 'C 파일은 닫혀 있어 저장된 Sync로만 읽었습니다.' };
  });
  send('auto-1', { mode: 'auto' });
  await settled();
  assert.equal(state('auto-1').state, 'succeeded');
  assert.deepEqual(
    answers.map((answer) => answer.value.code),
    ['LINK_NOT_LIVE', 'LINK_NOT_LIVE', 'NOT_FOUND', 'LINK_NOT_LIVE'],
  );
  assert.match(answers[0].value.next, /links_layers and sync_sample/);
  assert.equal(b.calls.query, 0);
});

test('A file without view methods answers NO_VIEW; ZWCAD-style reads still work', async (t) => {
  const answers = [];
  const cad = mockDocument('CAD', 'win-cad', { vision: false });
  const { send, settled, state } = setup(
    t,
    async ({ call }) => {
      answers.push(await call('query', { linkId: 'link-cad' }));
      answers.push(await call('measure', { linkId: 'link-cad', ids: ['x'] }));
      return { text: '도면을 읽었습니다.' };
    },
    {
      documents: { more: [cad] },
      links: [
        { id: 'link-a', host: 'rhino', name: 'A.3dm', open: { instance: 'win-a', documentId: 7 } },
        {
          id: 'link-cad',
          host: 'rhino',
          name: '평면.dwg',
          open: { instance: 'win-cad', documentId: 7 },
        },
      ],
    },
  );
  send('plan-1', { mode: 'plan' });
  await settled();
  assert.equal(state('plan-1').state, 'succeeded');
  assert.equal(answers[0].value.objects[0].id, 'CAD-1');
  assert.equal(answers[1].value.code, 'NO_VIEW');
});

test('A scope that does not resolve linkId refuses it instead of reading the target', async () => {
  const tools = new AgentTools({ origin: 'http://127.0.0.1:9' });
  let reads = 0;
  const scope = tools.issue({
    targetRef: 'rhino-copy:1',
    handlers: {
      query: async () => {
        reads++;
        return { objects: [] };
      },
    },
    isCurrent: () => true,
  });
  const refused = await tools.call(scope.token, 'query', {
    targetRef: 'rhino-copy:1',
    linkId: 'link-b',
  });
  assert.equal(refused.isError, true);
  assert.equal(JSON.parse(refused.content[0].text).code, 'LINK_NOT_LIVE');
  assert.match(JSON.parse(refused.content[0].text).next, /stored Sync/);
  assert.equal(reads, 0);
  const plain = await tools.call(scope.token, 'query', { targetRef: 'rhino-copy:1' });
  assert.equal(plain.isError, undefined);
  assert.equal(reads, 1);
  tools.close();
});

// --- writing several files in one request (T-093) -----------------------------------------------

const fail = (code) => Object.assign(new Error(code), { code });
const applied = (result) => result.executions.filter((entry) => entry.state === 'applied');

test('Auto edits two files; one [되돌리기] undoes the whole request in both, last first', async (t) => {
  const answers = [];
  const { a, b, execution, project, seen, send, settled, state } = setup(t, async ({ call }) => {
    answers.push(await call('execute', { code: 'add wall' }));
    answers.push(await call('execute', { linkId: 'link-b', code: 'add column' }));
    answers.push(await call('execute', { linkId: 'link-a', code: 'add slab' }));
    return { text: '두 파일을 맞췄습니다.' };
  });
  send('auto-1', { mode: 'auto' });
  await settled();
  const done = state('auto-1');
  assert.equal(done.state, 'succeeded', JSON.stringify(done.result));
  assert.ok(
    answers.every((answer) => answer.value.ok),
    JSON.stringify(answers),
  );
  assert.equal(done.result.multiFile, true);
  assert.deepEqual(
    done.result.executions.map((entry) => [entry.file.name, entry.undoId, entry.state]),
    [
      ['A.3dm', 'A-11', 'applied'],
      ['B.3dm', 'B-11', 'applied'],
      ['A.3dm', 'A-12', 'applied'],
    ],
  );
  assert.deepEqual(done.result.executions[1].target, { instance: 'win-b', documentId: 7 });
  // The other file is held by this request while it runs (the result keeps it).
  assert.deepEqual(
    done.result.documents.map((entry) => [entry.instance, entry.linkId]),
    [['win-b', 'link-b']],
  );
  assert.match(seen[0].context.goal, /execute with an open file's linkId edits that file/);
  assert.deepEqual(b.calls.execute[0].guard, { confirmed: false, maxDeletes: 50 });

  const undone = await execution.undoRequest(project.id, 'auto-1');
  assert.equal(undone.ok, true);
  assert.deepEqual(a.calls.undo.concat(b.calls.undo), ['A-12', 'A-11', 'B-11']);
  assert.ok(
    [...a.records, ...b.records].every((record) => record.undone),
    'every record is undone',
  );
  assert.deepEqual(
    undone.files.map((file) => [file.name, file.state, file.undone, file.kept]),
    [
      ['A.3dm', 'undone', 2, 0],
      ['B.3dm', 'undone', 1, 0],
    ],
  );
  assert.ok(undone.request.result.executions.every((entry) => entry.state === 'undone'));
  assert.equal(undone.request.result.undo.files.length, 2);
  // Nothing left: a second press is a no-op.
  assert.equal((await execution.undoRequest(project.id, 'auto-1')).already, true);
});

test('[되돌리기] of the request: a file edited after it keeps its executions and is named', async (t) => {
  const { a, b, execution, project, send, settled } = setup(t, async ({ call }) => {
    await call('execute', { code: 'add wall' });
    await call('execute', { linkId: 'link-b', code: 'add column' });
    return { text: '완료' };
  });
  send('auto-1', { mode: 'auto' });
  await settled();
  b.userEdit();
  const undone = await execution.undoRequest(project.id, 'auto-1');
  assert.equal(undone.ok, false);
  assert.deepEqual(
    undone.files.map((file) => [file.name, file.state, file.reason ?? null]),
    [
      ['A.3dm', 'undone', null],
      ['B.3dm', 'refused', 'not-latest'],
    ],
  );
  assert.equal(a.records[0].undone, true);
  assert.equal(b.records[0].undone, false);
  assert.deepEqual(
    undone.request.result.executions.map((entry) => entry.state),
    ['undone', 'applied'],
  );
  // The request itself stays succeeded: the document states are known.
  assert.equal(undone.request.state, 'succeeded');
});

test('All or nothing: the second file fails the request and the first file is rolled back', async (t) => {
  const { a, b, send, settled, state } = setup(t, async ({ call }) => {
    await call('execute', { code: 'add wall' });
    // A compile error in B is the AI's to fix, not a failure of the request,
    const bad = await call('execute', { linkId: 'link-b', code: 'bad body' });
    assert.equal(bad.value.code, 'COMPILE_ERROR');
    await call('execute', { linkId: 'link-b', code: 'add column' });
    // but the request ending failed is.
    throw fail('PROVIDER_TIMEOUT');
  });
  send('auto-1', { mode: 'auto' });
  await settled();
  const done = state('auto-1');
  assert.equal(done.state, 'failed');
  assert.equal(done.result.code, 'PROVIDER_TIMEOUT');
  assert.deepEqual(b.calls.undo.concat(a.calls.undo), ['B-11', 'A-11']);
  assert.ok([...a.records, ...b.records].every((record) => record.undone));
  assert.equal(done.result.rollback.reason, 'failed');
  assert.deepEqual(
    done.result.rollback.files.map((file) => [file.name, file.state, file.undone]),
    [
      ['A.3dm', 'undone', 1],
      ['B.3dm', 'undone', 1],
    ],
  );
  assert.equal(applied(done.result).length, 0);
  assert.ok(done.result.activity.some((entry) => /실패해서 자동으로 되돌림/.test(entry.text)));
});

test('All or nothing: an execute refused before it ran is not applied; a single-file failure is unchanged', async (t) => {
  const { a, b, send, settled, state } = setup(t, async ({ call, turn }) => {
    await call('execute', { code: 'add wall' });
    if (turn === 1) {
      b.next.execute.push(() => ({ ok: false, code: 'DOCUMENT_READ_ONLY' }));
      const refused = await call('execute', { linkId: 'link-b', code: 'add column' });
      assert.equal(refused.value.executed, false);
    }
    throw fail('PROVIDER_TIMEOUT');
  });
  send('two-files', { mode: 'auto' });
  await settled();
  const two = state('two-files');
  assert.equal(two.state, 'failed');
  assert.equal(two.result.multiFile, true);
  // A's execute is rolled back; B never ran, so it has nothing to undo.
  assert.deepEqual(
    two.result.rollback.files.map((file) => file.name),
    ['A.3dm'],
  );
  assert.deepEqual(b.calls.undo, []);
  assert.equal(two.result.refused.code, 'DOCUMENT_READ_ONLY');
  assert.equal(two.result.refused.file, 'B.3dm');

  // One file only: the failed turn keeps its execute ([되돌리기] still works), as before.
  send('one-file', { mode: 'auto' });
  await settled();
  const one = state('one-file');
  assert.equal(one.state, 'failed');
  assert.equal(one.result.rollback, undefined);
  assert.equal(applied(one.result).length, 1);
  assert.equal(a.records.at(-1).undone, false);
});

test('A rollback the host refuses is shown per file; a lost undo answer leaves the request unknown', async (t) => {
  const { a, b, execution, project, workspace, send, submit, settled, state } = setup(
    t,
    async ({ call, turn }) => {
      await call('execute', { code: 'add wall' });
      await call('execute', { linkId: 'link-b', code: 'add column' });
      if (turn === 1) a.userEdit();
      else b.next.undo.push(() => Promise.reject(fail('TIMEOUT')));
      throw fail('PROVIDER_TIMEOUT');
    },
  );
  const holderOf = (instance) =>
    documentHolder('probe', { host: 'rhino', instance, documentId: 7 }, workspace.list(project.id));
  send('refused', { mode: 'auto' });

  await settled();
  const refused = state('refused');
  assert.equal(refused.state, 'failed');
  assert.deepEqual(
    refused.result.rollback.files.map((file) => [file.name, file.state, file.reason ?? null]),
    [
      ['A.3dm', 'refused', 'not-latest'],
      ['B.3dm', 'undone', null],
    ],
  );
  // A's execute stays applied and undoable from the host.
  assert.deepEqual(
    refused.result.executions.map((entry) => [entry.file.name, entry.state]),
    [
      ['A.3dm', 'applied'],
      ['B.3dm', 'undone'],
    ],
  );

  send('lost', { mode: 'auto' });
  await settled();
  const lost = state('lost');
  assert.equal(lost.state, 'unknown');
  assert.equal(lost.result.code, 'HOST_RESULT_UNKNOWN');
  assert.deepEqual(
    lost.result.rollback.files.map((file) => [file.name, file.state]),
    [
      ['A.3dm', 'undone'],
      ['B.3dm', 'unknown'],
    ],
  );
  // While unresolved, only the file that needs attention stays held.
  assert.deepEqual(
    lost.result.documents.map((entry) => [entry.instance, entry.pending]),
    [['win-b', 'undo']],
  );
  assert.equal(lost.result.heldOnly, true);
  // A, rolled back and known, takes new writes; B stays refused until it is settled.
  assert.equal(holderOf('win-a'), undefined);
  assert.equal(holderOf('win-b')?.code, 'HOST_RESULT_UNRESOLVED');
  assert.equal(submit('after-a', { mode: 'auto' }).state, 'queued');
  assert.throws(() => submit('after-b', { mode: 'auto', baseRequestId: 'sync-b' }), {
    code: 'HOST_RESULT_UNRESOLVED',
  });
  // [되돌리기] whose answer arrives in B settles it: the request is the failure it was.
  const settled2 = await execution.undoRequest(project.id, 'lost');
  assert.equal(settled2.ok, true);
  assert.equal(settled2.request.state, 'failed');
  assert.equal(settled2.request.result.code, 'PROVIDER_TIMEOUT');
  assert.equal(settled2.request.result.heldOnly, undefined);
  assert.equal(settled2.request.result.settles, undefined);
  assert.equal(submit('after-b2', { mode: 'auto', baseRequestId: 'sync-b' }).state, 'queued');
});

test('A stopped multi-file request is rolled back; the guard of another file waits on its card', async (t) => {
  let release;
  const reached = new Promise((resolve) => (release = resolve));
  const { a, b, execution, project, send, settled, state } = setup(
    t,
    async ({ call, signal, turn }) => {
      if (turn === 1) {
        await call('execute', { code: 'add wall' });
        await call('execute', { linkId: 'link-b', code: 'add column' });
        release();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        throw fail('CANCELLED');
      }
      b.next.execute.push(() => ({
        ok: false,
        reverted: true,
        guarded: { kind: 'bulk-delete', detail: '객체 60개를 지웁니다 (기준 50개).' },
      }));
      const held = await call('execute', { linkId: 'link-b', code: 'wipe old' });
      assert.equal(held.value.guarded.kind, 'bulk-delete');
      return { text: '확인이 필요합니다.' };
    },
  );
  send('stop-1', { mode: 'auto' });
  await reached;
  execution.cancel(project.id, 'stop-1');
  await settled();
  const stopped = state('stop-1');
  assert.equal(stopped.state, 'cancelled');
  assert.equal(stopped.result.rollback.reason, 'cancelled');
  assert.ok([...a.records, ...b.records].every((record) => record.undone));

  send('guard-1', { mode: 'auto' });
  await settled();
  const waiting = state('guard-1');
  assert.equal(waiting.state, 'needs-confirmation');
  const [held] = waiting.result.executions;
  assert.equal(held.file.name, 'B.3dm');
  // [진행] re-runs the held body in B with the guard released.
  const confirmed = await execution.confirm(project.id, 'guard-1', held.executionId);
  assert.equal(confirmed.state, 'succeeded');
  assert.equal(b.calls.execute.at(-1).code, 'wipe old');
  assert.deepEqual(b.calls.execute.at(-1).guard, { confirmed: true, maxDeletes: 50 });
});

/** A promise and its resolver. */
const gate = () => {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
};

test('Another request writing the file: DOCUMENT_LOCKED at once, never a wait', async (t) => {
  const holdB = gate(),
    runningB = gate(),
    holdA = gate(),
    aWrote = gate();
  const answers = {};
  const { b, execution, send, settled, state } = setup(t, async ({ call, agent }) => {
    if (agent.targetRef === 'rhino-open:win-b') {
      runningB.open();
      await holdB.promise;
      return { text: 'B 작업 끝' };
    }
    // A's turn: B is being written by the other request, so nothing runs there.
    answers.locked = await call('execute', { linkId: 'link-b', code: 'add column' });
    answers.own = await call('execute', { code: 'add wall' });
    aWrote.open();
    await holdA.promise;
    // The refusal is final for that file in this turn.
    answers.again = await call('execute', { linkId: 'link-b', code: 'add column' });
    return { text: '완료' };
  });
  send('writes-b', { mode: 'auto', baseRequestId: 'sync-b' });
  await runningB.promise;
  send('writes-a', { mode: 'auto' });
  await aWrote.promise;
  assert.equal(answers.locked.value.code, 'DOCUMENT_LOCKED');
  assert.equal(answers.locked.value.executed, false);
  assert.match(answers.locked.value.reason, /B\.3dm/);
  assert.equal(answers.own.value.ok, true);
  assert.equal(b.calls.execute.length, 0);
  holdB.open();
  await execution.completion('writes-b');
  holdA.open();
  await settled();
  assert.equal(answers.again.value.code, 'DOCUMENT_LOCKED');
  const done = state('writes-a');
  assert.equal(done.state, 'succeeded');
  assert.equal(done.result.refused.file, 'B.3dm');
  // An execute was tried in B (refused by the lock): the request is one unit across files
  // (ADR-027 6, SPEC-02.13 6), as with a host's refusal before execution.
  assert.equal(done.result.multiFile, true);
});

test('A file a running turn locked holds new writes to it until the turn ends', async (t) => {
  const holdA = gate(),
    aLocked = gate();
  const { send, settled, state } = setup(t, async ({ call, agent }) => {
    if (agent.targetRef === 'rhino-open:win-b') return { text: 'B 작업' };
    const done = await call('execute', { linkId: 'link-b', code: 'add column' });
    assert.equal(done.value.ok, true);
    aLocked.open();
    await holdA.promise;
    return { text: '완료' };
  });
  send('locks-b', { mode: 'auto' });
  await aLocked.promise;
  const queued = send('then-b', { mode: 'auto', baseRequestId: 'sync-b' });
  const waiting = state(queued.id);
  assert.equal(waiting.state, 'queued');
  assert.equal(waiting.result.waitingFor.kind, 'document');
  assert.equal(waiting.result.waitingFor.after, 'locks-b');
  holdA.open();
  await settled();
  assert.equal(state('then-b').state, 'succeeded');
});

test('ZWCAD drawings through the engine driver: entity pages by handle, unknown failures stay unknown', async () => {
  const store = new Store(':memory:');
  const calls = [];
  const attached = {
    query: async (target, params) => {
      calls.push(['query', target, params]);
      return { objects: [] };
    },
    directExecute: async (target, command) => {
      calls.push(['execute', target, command.code]);
      if (command.code === 'slow') return { ok: false, code: 'HOST_READ_FAILED' };
      if (command.code === 'bad') return { ok: false, code: 'COMPILE_ERROR', diagnostics: [] };
      return { ok: false, code: 'DOCUMENT_READ_ONLY' };
    },
    directUndo: async () => ({ ok: true }),
    fingerprint: async () => ({ documentHash: hash }),
  };
  const execution = new Execution(new Workspace(store), {
    zwcadSdk: { editors: { attached } },
  });
  const driver = execution.directDriverFor('zwcad', { instance: '4321:99', documentId: 1 }, false);
  await driver.query({ objectIds: ['cad-1A2', '3F'] });
  assert.deepEqual(calls[0][2], { offset: 0, limit: 100, handles: ['1A2', '3F'] });
  const guard = { confirmed: false, maxDeletes: 50 };
  const run = async (code) =>
    (await driver.execute({ requestId: 'r', code, label: 'x', guard })).code;
  assert.equal(await run('slow'), 'HOST_RESULT_UNKNOWN');
  assert.equal(await run('bad'), 'COMPILE_ERROR');
  assert.equal(await run('ro'), 'DOCUMENT_READ_ONLY');
  await execution.close();
  store.close();
});

// --- unresolved files, late answers and stops (review fixes, 2026-10-01) -------------------------

/** Who holds a document now (the lock check of a turn's first write there). */
const holder = (workspace, project) => (instance) =>
  documentHolder('probe', { host: 'rhino', instance, documentId: 7 }, workspace.list(project.id));

test('[되돌리기] whose answer is lost in one file: a later one that the host answers settles the request', async (t) => {
  const { a, b, execution, project, workspace, submit, send, settled, state } = setup(
    t,
    async ({ call }) => {
      await call('execute', { code: 'add wall' });
      await call('execute', { linkId: 'link-b', code: 'add column' });
      return { text: '두 파일을 맞췄습니다.' };
    },
  );
  const holderOf = holder(workspace, project);
  send('auto-1', { mode: 'auto' });
  await settled();
  const lockList = state('auto-1').result.documents;
  b.next.undo.push(() => Promise.reject(fail('TIMEOUT')));
  const first = await execution.undoRequest(project.id, 'auto-1');
  assert.equal(first.ok, false);
  assert.equal(first.request.state, 'unknown');
  assert.deepEqual(
    first.files.map((file) => [file.name, file.state]),
    [
      ['A.3dm', 'undone'],
      ['B.3dm', 'unknown'],
    ],
  );
  assert.deepEqual(
    first.request.result.documents.map((entry) => [entry.name, entry.pending]),
    [['B.3dm', 'undo']],
  );
  // A is known (undone): only B is held meanwhile.
  assert.equal(holderOf('win-a'), undefined);
  assert.equal(holderOf('win-b')?.code, 'HOST_RESULT_UNRESOLVED');
  const second = await execution.undoRequest(project.id, 'auto-1');
  assert.equal(second.ok, true);
  assert.ok([...a.records, ...b.records].every((record) => record.undone));
  const back = second.request;
  assert.equal(back.state, 'succeeded');
  assert.equal(back.result.code, undefined);
  assert.equal(back.result.heldOnly, undefined);
  assert.equal(back.result.settles, undefined);
  assert.deepEqual(back.result.documents, lockList);
  assert.equal(holderOf('win-a'), undefined);
  assert.equal(holderOf('win-b'), undefined);
  assert.equal(submit('next-a', { mode: 'auto' }).state, 'queued');
  assert.equal(submit('next-b', { mode: 'auto', baseRequestId: 'sync-b' }).state, 'queued');
});

test('A file whose execute answer was lost stays held through a later [되돌리기] of the others', async (t) => {
  const { a, b, execution, project, workspace, send, settled, state } = setup(
    t,
    async ({ call }) => {
      await call('execute', { code: 'add wall' });
      b.next.execute.push(() => Promise.reject(fail('TIMEOUT')));
      await call('execute', { linkId: 'link-b', code: 'add column' });
      // The user edits A meanwhile: its rollback is refused (not the latest record).
      a.userEdit();
      return { text: '끝' };
    },
  );
  const holderOf = holder(workspace, project);
  send('auto-1', { mode: 'auto' });
  await settled();
  const lost = state('auto-1');
  assert.equal(lost.state, 'unknown');
  assert.deepEqual(
    lost.result.documents.map((entry) => [entry.name, entry.pending]),
    [['B.3dm', 'execute']],
  );
  assert.deepEqual(b.calls.undo, []);
  assert.equal(holderOf('win-a'), undefined);
  assert.equal(holderOf('win-b')?.code, 'HOST_RESULT_UNRESOLVED');
  // The user undoes their own edit; then the request's [되돌리기] loses A's answer.
  a.records.at(-1).undone = true;
  a.next.undo.push(() => Promise.reject(fail('TIMEOUT')));
  const undone = await execution.undoRequest(project.id, 'auto-1');
  assert.equal(undone.request.state, 'unknown');
  assert.deepEqual(
    undone.request.result.documents.map((entry) => [entry.name, entry.pending]),
    [
      ['B.3dm', 'execute'],
      ['A.3dm', 'undo'],
    ],
  );
  assert.equal(holderOf('win-a')?.code, 'HOST_RESULT_UNRESOLVED');
  assert.equal(holderOf('win-b')?.code, 'HOST_RESULT_UNRESOLVED');
  // A settles with the next answer; B, whose execute answer was lost, stays unknown.
  const again = await execution.undoRequest(project.id, 'auto-1');
  assert.equal(again.request.state, 'unknown');
  assert.deepEqual(
    again.request.result.documents.map((entry) => entry.name),
    ['B.3dm'],
  );
  assert.equal(holderOf('win-a'), undefined);
  assert.equal(holderOf('win-b')?.code, 'HOST_RESULT_UNRESOLVED');
});

test('A stop while another file has an execute in flight: no rollback around it, it stays held, its late answer changes nothing', async (t) => {
  const reachedB = gate(),
    answerB = gate();
  const { a, b, execution, project, workspace, send, settled, state } = setup(
    t,
    async ({ call, signal }) => {
      await call('execute', { code: 'add wall' });
      b.next.execute.push(async () => {
        reachedB.open();
        await answerB.promise;
        return { ok: true, undoId: 'B-late', changes: { added: [], changed: [], removed: [] } };
      });
      // The provider gives up on abort without waiting for the tool call (claude-cli, codex).
      void call('execute', { linkId: 'link-b', code: 'add column' });
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw fail('CANCELLED');
    },
  );
  send('stop-1', { mode: 'auto' });
  await reachedB.promise;
  execution.cancel(project.id, 'stop-1');
  await settled();
  const stopped = state('stop-1');
  assert.equal(stopped.state, 'unknown');
  assert.equal(stopped.result.rollback.reason, 'cancelled');
  assert.deepEqual(
    stopped.result.rollback.files.map((file) => [file.name, file.state]),
    [
      ['A.3dm', 'undone'],
      ['B.3dm', 'unknown'],
    ],
  );
  assert.deepEqual(b.calls.undo, []);
  assert.deepEqual(
    stopped.result.documents.map((entry) => [entry.name, entry.pending]),
    [['B.3dm', 'execute']],
  );
  assert.equal(a.records[0].undone, true);
  const holderOf = holder(workspace, project);
  assert.equal(holderOf('win-a'), undefined);
  assert.equal(holderOf('win-b')?.code, 'HOST_RESULT_UNRESOLVED');
  answerB.open();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const late = state('stop-1');
  assert.equal(late.state, 'unknown');
  assert.ok(!late.result.executions.some((entry) => entry.undoId === 'B-late'));
});

test('A one-file stop with its execute in flight stays unknown after the late answer, as before', async (t) => {
  const reached = gate(),
    answer = gate();
  const { a, execution, project, send, settled, state } = setup(t, async ({ call, signal }) => {
    a.next.execute.push(async () => {
      reached.open();
      await answer.promise;
      return { ok: true, undoId: 'A-late', changes: { added: [], changed: [], removed: [] } };
    });
    void call('execute', { code: 'add wall' });
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw fail('CANCELLED');
  });
  send('one', { mode: 'auto' });
  await reached.promise;
  execution.cancel(project.id, 'one');
  await settled();
  assert.equal(state('one').state, 'unknown');
  assert.deepEqual(state('one').result.documents, []);
  assert.equal(state('one').result.heldOnly, undefined);
  answer.open();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Before, the late answer wrote the request back to 'running' with no run behind it.
  assert.equal(state('one').state, 'unknown');
  assert.deepEqual(state('one').result.executions, []);
});

test('A stop the provider ends STOP_UNCONFIRMED is a cancellation; an intervention keeps the changes', async (t) => {
  let reached = gate();
  const { a, b, execution, project, send, settled, state } = setup(
    t,
    async ({ call, signal, context }) => {
      if (/대신 이렇게/.test(context.goal)) return { text: '새 조건으로 이어 갑니다.' };
      await call('execute', { code: 'add wall' });
      await call('execute', { linkId: 'link-b', code: 'add column' });
      reached.open();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      // The CLI did not exit within the grace time after the stop.
      throw fail('STOP_UNCONFIRMED');
    },
  );
  send('plain', { mode: 'auto' });
  await reached.promise;
  execution.cancel(project.id, 'plain');
  await settled();
  assert.equal(state('plain').result.rollback.reason, 'cancelled');
  assert.ok([...a.records, ...b.records].every((record) => record.undone));

  // [멈추고 이걸로]: the cut turn's changes stay for the next condition (SPEC-02.8).
  reached = gate();
  send('cut', { mode: 'auto', permission: 'candidate' });
  await reached.promise;
  execution.intervene(project.id, 'cut', {
    ...state('cut').input,
    id: 'cut-next',
    body: '대신 이렇게',
  });
  await settled();
  const kept = state('cut');
  assert.equal(kept.result.rollback, undefined);
  assert.deepEqual(
    kept.result.executions.map((entry) => entry.state),
    ['applied', 'applied'],
  );
  assert.equal(a.records.at(-1).undone, false);
  assert.equal(b.records.at(-1).undone, false);
});

test('An unresolved request that does not name every unknown document keeps its target held', () => {
  const doc = (instance) => ({ host: 'rhino', instance, documentId: 7 });
  const sync = {
    id: 'sync-a',
    input: { id: 'sync-a', body: 'Sync', mode: 'plan' },
    state: 'succeeded',
    result: { sourceDocument: { ...doc('win-a'), connection: 'attached-editor' } },
  };
  // A multi-file turn the engine restart left unknown: its lock list, not an attention list.
  const recovered = {
    id: 'turn',
    input: { id: 'turn', body: 'x', mode: 'auto', baseRequestId: 'sync-a' },
    state: 'unknown',
    result: { documents: [{ ...doc('win-b'), name: 'B.3dm' }] },
  };
  const holderOf = (rows, instance) => documentHolder('probe', doc(instance), rows)?.code;
  assert.equal(holderOf([sync, recovered], 'win-a'), 'HOST_RESULT_UNRESOLVED');
  assert.equal(holderOf([sync, recovered], 'win-b'), 'HOST_RESULT_UNRESOLVED');
  // Naming every unknown document (heldOnly), it holds only those.
  const named = { ...recovered, result: { ...recovered.result, heldOnly: true } };
  assert.equal(holderOf([sync, named], 'win-a'), undefined);
  assert.equal(holderOf([sync, named], 'win-b'), 'HOST_RESULT_UNRESOLVED');
  // While it runs, it holds its target and the documents it locked.
  const running = { ...named, state: 'running' };
  assert.equal(holderOf([sync, running], 'win-a'), 'DOCUMENT_LOCKED');
});

// --- the guard card's [진행] in a multi-file request ---------------------------------------------

const guardOnce = (doc) =>
  doc.next.execute.push(() => ({
    ok: false,
    reverted: true,
    guarded: { kind: 'bulk-delete', detail: '객체 60개를 지웁니다 (기준 50개).' },
  }));
/** A applied, then B's execute held by the guard: the request waits on its card. */
const appliedThenGuarded =
  (a, b) =>
  async ({ call, agent }) => {
    if (agent.targetRef === 'rhino-open:win-b') return { text: 'B 작업' };
    await call('execute', { code: 'add wall' });
    guardOnce(b);
    await call('execute', { linkId: 'link-b', code: 'wipe old' });
    return { text: '확인이 필요합니다.' };
  };

test('[진행] in a file another request is writing is refused DOCUMENT_LOCKED and runs nothing', async (t) => {
  const holdB = gate(),
    runningB = gate();
  let b;
  const { execution, project, send, settled, state, ...rest } = setup(t, async (turn) => {
    if (turn.agent.targetRef === 'rhino-open:win-b') {
      runningB.open();
      await holdB.promise;
      return { text: 'B 작업 끝' };
    }
    return appliedThenGuarded(rest.a, b)(turn);
  });
  b = rest.b;
  send('guard-1', { mode: 'auto' });
  await settled();
  const waiting = state('guard-1');
  assert.equal(waiting.state, 'needs-confirmation');
  assert.equal(waiting.result.multiFile, true);
  send('writes-b', { mode: 'auto', baseRequestId: 'sync-b' });
  await runningB.promise;
  const calls = b.calls.execute.length;
  const refused = await execution.confirm(project.id, 'guard-1');
  assert.equal(refused.state, 'needs-confirmation');
  assert.equal(refused.result.refused.code, 'DOCUMENT_LOCKED');
  assert.equal(refused.result.refused.file, 'B.3dm');
  assert.equal(b.calls.execute.length, calls);
  holdB.open();
  await settled();
  // Once B is free the card runs.
  const confirmed = await execution.confirm(project.id, 'guard-1');
  assert.equal(confirmed.state, 'succeeded');
  assert.equal(confirmed.result.refused, undefined);
});

test('[진행] that fails in another file rolls the request back in every file', async (t) => {
  let a, b;
  const ctx = setup(t, (turn) => appliedThenGuarded(a, b)(turn));
  ({ a, b } = ctx);
  const { execution, project, workspace, send, submit, settled, state } = ctx;
  send('guard-1', { mode: 'auto' });
  await settled();
  b.next.execute.push(() => ({ ok: false, code: 'RUNTIME_ERROR', diagnostics: ['boom'] }));
  const failed = await execution.confirm(project.id, 'guard-1');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.result.code, 'RUNTIME_ERROR');
  assert.equal(failed.result.rollback.reason, 'failed');
  assert.deepEqual(
    failed.result.rollback.files.map((file) => [file.name, file.state]),
    [['A.3dm', 'undone']],
  );
  assert.deepEqual(a.calls.undo, ['A-11']);
  assert.equal(a.records[0].undone, true);
  assert.equal(applied(failed.result).length, 0);
  assert.ok(failed.result.activity.some((entry) => /실패해서 자동으로 되돌림/.test(entry.text)));

  // The re-run's answer is lost: B is left alone and stays unknown; A is rolled back and free.
  send('guard-2', { mode: 'auto' });
  await settled();
  b.next.execute.push(() => Promise.reject(fail('TIMEOUT')));
  const lost = await execution.confirm(project.id, 'guard-2');
  assert.equal(lost.state, 'unknown');
  assert.deepEqual(
    lost.result.rollback.files.map((file) => [file.name, file.state]),
    [
      ['A.3dm', 'undone'],
      ['B.3dm', 'unknown'],
    ],
  );
  assert.deepEqual(
    lost.result.documents.map((entry) => [entry.name, entry.pending]),
    [['B.3dm', 'execute']],
  );
  const holderOf = holder(workspace, project);
  assert.equal(holderOf('win-a'), undefined);
  assert.equal(holderOf('win-b')?.code, 'HOST_RESULT_UNRESOLVED');
  assert.equal(submit('next-a', { mode: 'auto' }).state, 'queued');
});

test('A one-file [진행] that fails keeps the turn’s executes, as before', async (t) => {
  const { a, execution, project, send, settled, state } = setup(t, async ({ call }) => {
    await call('execute', { code: 'add wall' });
    guardOnce(a);
    await call('execute', { code: 'wipe old' });
    return { text: '확인이 필요합니다.' };
  });
  send('guard-1', { mode: 'auto' });
  await settled();
  assert.equal(state('guard-1').state, 'needs-confirmation');
  a.next.execute.push(() => ({ ok: false, code: 'RUNTIME_ERROR' }));
  const failed = await execution.confirm(project.id, 'guard-1');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.result.rollback, undefined);
  assert.equal(applied(failed.result).length, 1);
  assert.deepEqual(a.calls.undo, []);
});

test('A confirmed re-run names its file, so the request [되돌리기] names it too', async (t) => {
  let a, b;
  const ctx = setup(t, (turn) => appliedThenGuarded(a, b)(turn));
  ({ a, b } = ctx);
  const { execution, project, send, settled } = ctx;
  send('guard-1', { mode: 'auto' });
  await settled();
  const confirmed = await execution.confirm(project.id, 'guard-1');
  assert.equal(confirmed.state, 'succeeded');
  const rerun = confirmed.result.executions.at(-1);
  assert.deepEqual(rerun.file, { linkId: 'link-b', name: 'B.3dm' });
  b.userEdit();
  const undone = await execution.undoRequest(project.id, 'guard-1');
  assert.deepEqual(
    undone.files.map((file) => [file.name, file.linkId ?? null, file.state]),
    [
      ['A.3dm', 'link-a', 'undone'],
      ['B.3dm', 'link-b', 'refused'],
    ],
  );
});

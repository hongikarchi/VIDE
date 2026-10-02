// Several linked files in one request (ADR-027): a direct Rhino turn reads the project's other
// open linked files live through `linkId`. Mock editor channels for two documents, a closed link,
// and a scripted provider over the turn's MCP scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { AgentTools } from '../../src/server/agent-tools.ts';
import { documentHolder, unresolvedFor } from '../../src/contracts/request-scope.ts';
import { ExecuteQueue, displayQuery, executeWaitText } from '../../src/server/direct-mode.ts';
import { executeWaitOf, guardOpen, heldRowLabel, waitingText } from '../../src/ui/request-scope.ts';

/**
 * What a document meets from other requests: a write holding it (DOCUMENT_LOCKED), else an
 * unresolved result there, which never refuses but is named to the next turn (T-102).
 */
const concernOf = (rows, instance) => {
  const doc = { host: 'rhino', instance, documentId: 7 };
  const held = documentHolder('probe', doc, rows);
  if (held) return held;
  const probe = { id: 'probe', host: 'rhino', source: 'document', sourceDocument: doc };
  if (unresolvedFor(probe, rows).length) return { code: 'UNRESOLVED_NOTE' };
};
import { hostProjectNote } from '../../src/ai/agent-connection.ts';
import { liveLinksOf, matchLinks } from '../../src/server/live-links.ts';
import { DocumentLinks, matchOpenDocuments } from '../../src/core/document-links.ts';
import { undoReason } from '../../src/contracts/direct-refusal.ts';

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
export function mockDocument(name, instance, { vision = true, fingerprint = false } = {}) {
  const calls = { execute: [], undo: [], query: 0, capture: 0, measure: 0 };
  const records = [];
  let serial = 10;
  // The document's change token (`fingerprint: true`): moves on every change, like the worker's.
  let revision = 0;
  /** The default answer of an execute (scripted overrides may call it after waiting). */
  const apply = (command) => {
    if (command.code.startsWith('bad'))
      return { ok: false, code: 'COMPILE_ERROR', diagnostics: ['CS1002: ; expected'] };
    const undoId = `${name}-${++serial}`;
    records.push({ undoId, undone: false });
    revision++;
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
  };
  // Per-call overrides: the next execute (or undo) answers this instead.
  const next = { execute: [], undo: [] };
  const driver = {
    host: 'rhino',
    target: { instance, documentId: 7 },
    async execute(command) {
      calls.execute.push(command);
      const scripted = next.execute.shift();
      if (scripted) return scripted(command);
      return apply(command);
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
      revision++;
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
    ...(fingerprint
      ? { fingerprint: async () => ({ documentHash: `${name}-rev-${revision}`, revision }) }
      : {}),
  };
  /** A later edit by the user in this document (makes earlier records not the latest). */
  const userEdit = () => {
    records.push({ undoId: `${name}-user-${records.length}`, undone: false });
    revision++;
  };
  return { driver, calls, records, next, userEdit, name, apply };
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
  // The goal lists the linked files: the starting document, the open one, the closed one.
  const goal = seen[0].context.goal;
  assert.match(goal, /link-a · A\.3dm \(Rhino\) · starting document/);
  // Every open file is the AI's to pick; the starting document is only the default (T-103).
  assert.match(goal, /Every open linked file is yours to work on \(read and edit\)/);
  assert.match(goal, /The user does not choose a target file/);
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
  // Such a turn cannot reach other files live: the AI is not told to ask the user to open them.
  assert.match(JSON.parse(refused.content[0].text).next, /stored Sync/);
  assert.match(JSON.parse(refused.content[0].text).next, /cannot reach other linked files live/);
  assert.doesNotMatch(JSON.parse(refused.content[0].text).next, /must be open/);
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
  assert.deepEqual(b.calls.execute[0].guard, { confirmed: false, maxDeletes: 500 });

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
  const holderOf = (instance) => concernOf(workspace.list(project.id), instance);
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
  // A, rolled back, is known; B is still unknown and named to the next turn there, but a write to
  // B is taken too (T-102).
  assert.equal(holderOf('win-a'), undefined);
  assert.equal(holderOf('win-b')?.code, 'UNRESOLVED_NOTE');
  assert.equal(submit('after-a', { mode: 'auto' }).state, 'queued');
  assert.equal(submit('after-b', { mode: 'auto', baseRequestId: 'sync-b' }).state, 'queued');
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
        guarded: { kind: 'bulk-delete', detail: '객체 600개를 지웁니다 (기준 500개).' },
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
  assert.deepEqual(b.calls.execute.at(-1).guard, { confirmed: true, maxDeletes: 500 });
});

/** A promise and its resolver. */
const gate = () => {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
};

test('Another conversation editing the file directly: the executes take turns, no DOCUMENT_LOCKED', async (t) => {
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
    // A's turn writes B while B's own turn is still thinking (SPEC-02.9 3).
    answers.other = await call('execute', { linkId: 'link-b', code: 'add column' });
    answers.own = await call('execute', { code: 'add wall' });
    aWrote.open();
    await holdA.promise;
    return { text: '완료' };
  });
  send('writes-b', { mode: 'auto', baseRequestId: 'sync-b' });
  await runningB.promise;
  send('writes-a', { mode: 'auto' });
  assert.equal(state('writes-a').state, 'running');
  await aWrote.promise;
  assert.equal(answers.other.value.ok, true);
  assert.equal(answers.own.value.ok, true);
  assert.equal(b.calls.execute.length, 1);
  holdB.open();
  holdA.open();
  await settled();
  const done = state('writes-a');
  assert.equal(done.state, 'succeeded');
  assert.equal(done.result.multiFile, true);
  assert.equal(done.result.refused, undefined);
});

test('A file a turn-level write holds: DOCUMENT_LOCKED at once, never a wait', async (t) => {
  const answers = {};
  const { b, workspace, project, send, settled, state } = setup(t, async ({ call }) => {
    answers.locked = await call('execute', { linkId: 'link-b', code: 'add column' });
    answers.own = await call('execute', { code: 'add wall' });
    // The refusal is final for that file in this turn.
    answers.again = await call('execute', { linkId: 'link-b', code: 'add column' });
    return { text: '완료' };
  });
  // A jig's direct bake writes B (a write that does not take turns per execute).
  const release = workspace.holdWrite(project.id, {
    host: 'rhino',
    instance: 'win-b',
    documentId: 7,
  });
  send('writes-a', { mode: 'auto' });
  await settled();
  release();
  assert.equal(answers.locked.value.code, 'DOCUMENT_LOCKED');
  assert.equal(answers.locked.value.executed, false);
  assert.match(answers.locked.value.reason, /B\.3dm/);
  assert.equal(answers.own.value.ok, true);
  assert.equal(answers.again.value.code, 'DOCUMENT_LOCKED');
  assert.equal(b.calls.execute.length, 0);
  const done = state('writes-a');
  assert.equal(done.state, 'succeeded');
  assert.equal(done.result.refused.file, 'B.3dm');
  // An execute was tried in B (refused by the lock): the request is one unit across files
  // (ADR-027 6, SPEC-02.13 6), as with a host's refusal before execution.
  assert.equal(done.result.multiFile, true);
});

test('A file a running turn locked: another direct turn runs at once, a jig bake is refused', async (t) => {
  const holdA = gate(),
    aLocked = gate();
  const { send, settled, state, workspace, project } = setup(t, async ({ call, agent }) => {
    if (agent.targetRef === 'rhino-open:win-b') return { text: 'B 작업' };
    const done = await call('execute', { linkId: 'link-b', code: 'add column' });
    assert.equal(done.value.ok, true);
    aLocked.open();
    await holdA.promise;
    return { text: '완료' };
  });
  send('locks-b', { mode: 'auto' });
  await aLocked.promise;
  try {
    send('then-b', { mode: 'auto', baseRequestId: 'sync-b' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state('then-b').state, 'succeeded');
    // A jig's direct bake does not take turns per execute: the locked file refuses it.
    const rows = workspace.claimRows(project.id);
    const doc = { host: 'rhino', instance: 'win-b', documentId: 7 };
    assert.deepEqual(documentHolder('bake', doc, rows), { code: 'DOCUMENT_LOCKED', by: 'locks-b' });
  } finally {
    holdA.open();
  }
  await settled();
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
  const guard = { confirmed: false, maxDeletes: 500 };
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
  concernOf(workspace.list(project.id), instance);

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
  assert.equal(holderOf('win-b')?.code, 'UNRESOLVED_NOTE');
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
  assert.equal(holderOf('win-b')?.code, 'UNRESOLVED_NOTE');
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
  assert.equal(holderOf('win-a')?.code, 'UNRESOLVED_NOTE');
  assert.equal(holderOf('win-b')?.code, 'UNRESOLVED_NOTE');
  // A settles with the next answer; B, whose execute answer was lost, stays unknown.
  const again = await execution.undoRequest(project.id, 'auto-1');
  assert.equal(again.request.state, 'unknown');
  assert.deepEqual(
    again.request.result.documents.map((entry) => entry.name),
    ['B.3dm'],
  );
  assert.equal(holderOf('win-a'), undefined);
  assert.equal(holderOf('win-b')?.code, 'UNRESOLVED_NOTE');
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
  assert.equal(holderOf('win-b')?.code, 'UNRESOLVED_NOTE');
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

test('An unresolved request that does not name every unknown document keeps its target named', () => {
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
  const holderOf = (rows, instance) => concernOf(rows, instance)?.code;
  assert.equal(holderOf([sync, recovered], 'win-a'), 'UNRESOLVED_NOTE');
  assert.equal(holderOf([sync, recovered], 'win-b'), 'UNRESOLVED_NOTE');
  // Naming every unknown document (heldOnly), it concerns only those.
  const named = { ...recovered, result: { ...recovered.result, heldOnly: true } };
  assert.equal(holderOf([sync, named], 'win-a'), undefined);
  assert.equal(holderOf([sync, named], 'win-b'), 'UNRESOLVED_NOTE');
  // While it runs, it holds its target and the documents it locked.
  const running = { ...named, state: 'running' };
  assert.equal(holderOf([sync, running], 'win-a'), 'DOCUMENT_LOCKED');
});

// --- the guard card's [진행] in a multi-file request ---------------------------------------------

const guardOnce = (doc) =>
  doc.next.execute.push(() => ({
    ok: false,
    reverted: true,
    guarded: { kind: 'bulk-delete', detail: '객체 600개를 지웁니다 (기준 500개).' },
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

test('[진행] in a file a turn-level write holds is refused DOCUMENT_LOCKED and runs nothing', async (t) => {
  let b;
  const { execution, project, workspace, send, settled, state, ...rest } = setup(t, (turn) =>
    appliedThenGuarded(rest.a, b)(turn),
  );
  b = rest.b;
  send('guard-1', { mode: 'auto' });
  await settled();
  const waiting = state('guard-1');
  assert.equal(waiting.state, 'needs-confirmation');
  assert.equal(waiting.result.multiFile, true);
  const release = workspace.holdWrite(project.id, {
    host: 'rhino',
    instance: 'win-b',
    documentId: 7,
  });
  const calls = b.calls.execute.length;
  const refused = await execution.confirm(project.id, 'guard-1');
  assert.equal(refused.state, 'needs-confirmation');
  assert.equal(refused.result.refused.code, 'DOCUMENT_LOCKED');
  assert.equal(refused.result.refused.file, 'B.3dm');
  assert.equal(b.calls.execute.length, calls);
  release();
  // Once B is free the card runs.
  const confirmed = await execution.confirm(project.id, 'guard-1');
  assert.equal(confirmed.state, 'succeeded');
  assert.equal(confirmed.result.refused, undefined);
});

test('[진행] whose file was reopened as another window runs nothing and never re-runs the turn', async (t) => {
  let a,
    b,
    turns = 0;
  const ctx = setup(t, (turn) => {
    turns++;
    return appliedThenGuarded(a, b)(turn);
  });
  ({ a, b } = ctx);
  const { execution, project, send, settled, state } = ctx;
  send('guard-1', { mode: 'auto' });
  await settled();
  assert.equal(state('guard-1').state, 'needs-confirmation');
  const before = { turns, a: a.calls.execute.length, b: b.calls.execute.length };
  // B closed and reopened: a new window, so the held body's document has no driver now.
  b.driver.target.instance = 'win-b2';
  const refused = await execution.confirm(project.id, 'guard-1');
  await settled();
  assert.equal(refused.state, 'needs-confirmation');
  assert.equal(refused.result.refused.code, 'STALE_CONNECTION');
  assert.equal(refused.result.refused.file, 'B.3dm');
  assert.match(refused.result.refused.reason, /다시 연결/);
  // Nothing ran: no blanket re-run of the turn with every guard released.
  assert.equal(turns, before.turns);
  assert.equal(a.calls.execute.length, before.a);
  assert.equal(b.calls.execute.length, before.b);
  assert.equal(state('guard-1').input.guardConfirmed, undefined);
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
  assert.equal(holderOf('win-b')?.code, 'UNRESOLVED_NOTE');
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
  // The held row ends with the request: no card is left to press (SPEC-02.13 4).
  assert.equal(failed.result.guarded, undefined);
  assert.deepEqual(
    failed.result.executions.filter((entry) => entry.state === 'guarded'),
    [],
  );
  const ended = failed.result.executions.find((entry) => entry.state === 'failed');
  assert.ok(ended);
  assert.equal(ended.code, undefined);
  // A late [진행] on the ended request answers REVISION_CONFLICT (the screen re-reads it).
  await assert.rejects(execution.confirm(project.id, 'guard-1'), { code: 'REVISION_CONFLICT' });
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

// --- what a turn is told about other files, and how links are matched ---------------------------

test('A Rhino Auto turn with an open ZWCAD drawing is told the ZWCAD execute wrapper; others are not', async (t) => {
  const cadLinks = [
    { id: 'link-a', host: 'rhino', name: 'A.3dm', open: { instance: 'win-a', documentId: 7 } },
    { id: 'link-cad', host: 'zwcad', name: '평면.dwg', open: { instance: 'cad-1', documentId: 1 } },
  ];
  const withCad = setup(t, async () => ({ text: '읽었습니다.' }), { links: cadLinks });
  withCad.send('auto-cad', { mode: 'auto' });
  withCad.send('plan-cad', { mode: 'plan' });
  await withCad.settled();
  const [auto, plan] = withCad.seen.map((entry) => entry.context.goal);
  assert.match(auto, /ZWCAD file's linkId takes a C# method body for ZWCAD, not RhinoCommon/);
  assert.match(auto, /supplies Database db and Transaction tr/);
  assert.match(auto, /AddNewlyCreatedDBObject/);
  assert.match(auto, /never call Commit\/Abort/);
  assert.doesNotMatch(plan, /Transaction tr/);
  // Only Rhino files open (or none): the goal is as before.
  const rhinoOnly = setup(t, async () => ({ text: '읽었습니다.' }));
  rhinoOnly.send('auto-rhino', { mode: 'auto' });
  await rhinoOnly.settled();
  assert.doesNotMatch(rhinoOnly.seen[0].context.goal, /Transaction tr|ZwSoft/);
});

test('The host project note no longer promises live reads to turns that cannot make them', () => {
  const note = hostProjectNote(['query', 'execute', 'links_layers', 'sync_sample']);
  assert.match(note, /links_layers lists the project's linked files/);
  assert.match(note, /stored Sync/);
  assert.doesNotMatch(note, /execute with that linkId|read live/);
});

test('Linked files: a file opened in VIDE is listed but never live; a file open twice resolves to the target', () => {
  const link = (fields) => ({
    projectId: 'p',
    hidden: false,
    linkedAt: '',
    updatedAt: '',
    path: null,
    ...fields,
  });
  const links = [
    link({
      id: 'l-a',
      host: 'rhino',
      name: 'A.3dm',
      path: 'C:\\w\\A.3dm',
      instance: 'w1',
      documentId: 7,
    }),
    link({ id: 'l-f', host: 'rhino', name: 'F.3dm', instance: 'file:f.3dm', documentId: 1 }),
  ];
  // The same path open in two windows, the other one listed first.
  const open = [
    { instance: 'w2', id: 3, host: 'rhino', path: 'c:\\w\\a.3dm' },
    { instance: 'w9', id: 7, host: 'rhino', path: 'C:\\w\\A.3dm' },
  ];
  const target = { host: 'rhino', instance: 'w9', documentId: 7 };
  const listed = liveLinksOf(links, matchLinks(links, open, target));
  assert.deepEqual(listed, [
    { id: 'l-a', host: 'rhino', name: 'A.3dm', open: { instance: 'w9', documentId: 7 } },
    { id: 'l-f', host: 'rhino', name: 'F.3dm', open: null },
  ]);
  const windowOf = (documents, prefer) =>
    matchLinks(links, documents, prefer).get('l-a')?.document.instance;
  // The window the link was made from wins over the target, as in the links list.
  const own = [...open, { instance: 'w1', id: 7, host: 'rhino', path: 'C:\\w\\A.3dm' }];
  assert.equal(windowOf(own, target), 'w1');
  // Without a target: the first listed.
  assert.equal(windowOf(open), 'w2');
  // A window that is not plugin-attached (a work copy VIDE opened) is never live.
  assert.equal(
    liveLinksOf(links, matchLinks(links, [{ ...open[1], connection: 'owned' }]))[0].open,
    null,
  );
});

test('A file opened in VIDE answers LINK_NOT_LIVE (stored Sync), an unknown id NOT_FOUND', async (t) => {
  const answers = [];
  const { send, settled } = setup(
    t,
    async ({ call }) => {
      answers.push(await call('query', { linkId: 'link-f' }));
      answers.push(await call('query', { linkId: 'nope' }));
      return { text: '끝' };
    },
    {
      links: [
        { id: 'link-a', host: 'rhino', name: 'A.3dm', open: { instance: 'win-a', documentId: 7 } },
        { id: 'link-f', host: 'rhino', name: 'F.3dm', open: null },
      ],
    },
  );
  send('auto-1', { mode: 'auto' });
  await settled();
  assert.deepEqual(
    answers.map((answer) => answer.value.code),
    ['LINK_NOT_LIVE', 'NOT_FOUND'],
  );
  assert.match(answers[0].value.next, /stored Sync/);
});

test('Live links ask only the hosts the project links, at the same time', async (t) => {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('links');
  const calls = { rhino: 0, zwcad: 0 };
  const execution = new Execution(workspace, {
    sdk: {
      editors: {
        list: async () => {
          calls.rhino++;
          return { documents: [{ instance: 'w1', id: 7, host: 'rhino', path: 'C:\\A.3dm' }] };
        },
      },
    },
    zwcadSdk: {
      editors: {
        attached: {
          list: async () => {
            calls.zwcad++;
            return [];
          },
        },
      },
    },
  });
  t.after(async () => {
    await execution.close();
    store.close();
  });
  // No links at all (a one-file request): no host is asked.
  assert.deepEqual(await execution.liveLinks(project.id), []);
  assert.deepEqual(calls, { rhino: 0, zwcad: 0 });
  // A file opened in VIDE: still nothing to ask.
  const links = new DocumentLinks(store.db);
  links.fileLink(project.id, 'rhino', 'F.3dm');
  assert.equal((await execution.liveLinks(project.id))[0].open, null);
  assert.deepEqual(calls, { rhino: 0, zwcad: 0 });
  // A Rhino link: Rhino only.
  links.link(project.id, {
    host: 'rhino',
    name: 'A.3dm',
    path: 'C:\\A.3dm',
    instance: 'w1',
    documentId: 7,
  });
  const live = await execution.liveLinks(project.id);
  assert.deepEqual(
    live.map((entry) => [entry.name, entry.open?.instance ?? null]),
    [
      ['F.3dm', null],
      ['A.3dm', 'w1'],
    ],
  );
  assert.deepEqual(calls, { rhino: 1, zwcad: 0 });
});

/** An Execution whose Rhino reports `documents` open (attached), over a real store. */
function linkedRhino(t, documents, owned = new Set()) {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('links');
  const execution = new Execution(workspace, {
    sdk: {
      editors: {
        list: async () => ({ documents: documents() }),
        has: async (instance) => owned.has(instance),
      },
    },
  });
  t.after(async () => {
    await execution.close();
    store.close();
  });
  return { store, project, execution, links: new DocumentLinks(store.db) };
}
const window1 = (path) => ({
  instance: 'I1',
  id: 1,
  host: 'rhino',
  name: path.split('/').at(-1),
  path,
  connection: 'attached-editor',
});

test("A turn and the links list agree: Save As onto an older link's path leaves one live row, the window's own (T-095)", async (t) => {
  let open = [window1('C:/p/a.3dm')];
  const { project, execution, links } = linkedRhino(t, () => open);
  // Monday: b.3dm from a window that is closed now. Today: a.3dm from window I1.
  const older = links.link(project.id, {
    host: 'rhino',
    name: 'b.3dm',
    path: 'C:/p/b.3dm',
    instance: 'I0',
    documentId: 3,
  });
  const own = links.link(project.id, {
    host: 'rhino',
    name: 'a.3dm',
    path: 'C:/p/a.3dm',
    instance: 'I1',
    documentId: 1,
  });
  // I1 saves as b.3dm; the list's matcher runs on the next poll (GET …/links).
  open = [window1('C:/p/b.3dm')];
  for (const [id, { document, session }] of matchOpenDocuments(links.list(project.id), open))
    if (session) links.follow(project.id, id, document);
  const listed = [...matchOpenDocuments(links.list(project.id), open).keys()];
  assert.deepEqual(listed, [own.id]);
  const live = (
    await execution.liveLinks(project.id, { host: 'rhino', instance: 'I1', documentId: 1 })
  )
    .filter((link) => link.open)
    .map((link) => [link.id, link.name, link.open]);
  assert.deepEqual(live, [[own.id, 'b.3dm', { instance: 'I1', documentId: 1 }]]);
  assert.notEqual(older.id, own.id);
});

test('A turn right after Save As (before the next links poll) sees the window under its new name', async (t) => {
  let open = [window1('C:/p/a.3dm')];
  const { project, execution, links } = linkedRhino(t, () => open);
  const own = links.link(project.id, {
    host: 'rhino',
    name: 'a.3dm',
    path: 'C:/p/a.3dm',
    instance: 'I1',
    documentId: 1,
  });
  open = [window1('C:/p/b.3dm')];
  const live = await execution.liveLinks(project.id);
  assert.deepEqual(
    live.map((link) => [link.id, link.name, link.open]),
    [[own.id, 'b.3dm', { instance: 'I1', documentId: 1 }]],
  );
  // The row followed the window, as the list would on its next poll.
  assert.equal(links.get(project.id, own.id).path, 'C:/p/b.3dm');
});

test('A file the host did not undo is named with a Korean reason, never the raw host code', () => {
  for (const reason of [
    'HOST_BUSY',
    'unknown',
    'undo-failed',
    'DOCUMENT_READ_ONLY',
    'UNDO_UNAVAILABLE',
    'HOST_OWNERSHIP_MISMATCH',
    'SOMETHING_NEW',
    undefined,
  ]) {
    const text = undoReason(reason);
    assert.match(text, /[가-힣]/, String(reason));
    assert.doesNotMatch(text, /[A-Z_]{4,}|undo-failed|^unknown$/, String(reason));
  }
  assert.equal(undoReason('not-latest'), '그 뒤에 문서가 더 바뀜');
  assert.equal(undoReason('SOMETHING_NEW'), '호스트가 거절함');
});

// SPEC-02.13 7 (T-102, T-103): an earlier answer lost in another linked file is told to the turn
// the first time it reads or writes that file, not only for the starting document. Since ADR-031 8
// (T-122) it is a notice on the answer: the execute runs.
test('An unresolved result in another linked file is told when the turn first writes or reads it there', async (t) => {
  const answers = {};
  const { workspace, project, b, send, settled, state, seen } = setup(t, async ({ call, turn }) => {
    if (turn === 1) {
      answers.first = await call('execute', { linkId: 'link-b', code: 'add column' });
      answers.second = await call('execute', { linkId: 'link-b', code: 'add column' });
    } else {
      answers.query = await call('query', { linkId: 'link-b' });
      answers.again = await call('query', { linkId: 'link-b' });
      answers.write = await call('execute', { linkId: 'link-b', code: 'add column' });
    }
    return { text: '완료' };
  });
  workspace.submit(project.id, {
    id: 'lost-b',
    body: 'B의 보도 옮겨줘',
    provider: 'claude-cli',
    mode: 'auto',
    baseRequestId: 'sync-a',
    pins: [],
    sketches: [],
    files: [],
  });
  workspace.update(project.id, 'lost-b', 'unknown', {
    host: 'rhino',
    hostExecuted: false,
    code: 'HOST_RESULT_UNKNOWN',
    heldOnly: true,
    documents: [
      { host: 'rhino', instance: 'win-b', documentId: 7, name: 'B.3dm', pending: 'execute' },
    ],
  });
  send('again', { mode: 'auto' });
  await settled();
  // The turn starts in A: no note at the start, since nothing is unresolved there.
  assert.ok(!seen[0].context.items.some((item) => item.id === 'unresolved-results'));
  assert.equal(answers.first.value.ok, true);
  assert.equal(answers.first.value.notices[0].code, 'HOST_RESULT_UNRESOLVED');
  assert.equal(answers.first.value.notices[0].unresolved.requests[0].requestId, 'lost-b');
  assert.equal(answers.second.value.ok, true);
  assert.equal(answers.second.value.notices, undefined);
  assert.equal(b.calls.execute.length, 2);
  assert.equal(state('again').state, 'succeeded');
  // Read first: the query carries the note once, and the write then runs.
  send('read-first', { mode: 'auto' });
  await settled();
  assert.equal(answers.query.value.unresolved.requests[0].requestId, 'lost-b');
  assert.equal(answers.again.value.unresolved, undefined);
  assert.equal(answers.write.value.ok, true);
  assert.equal(b.calls.execute.length, 3);
});

// --- Execute-only turns on one file (SPEC-02.9 3, 2026-10-02 user decision) -----------------------

const until = async (check) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check());
};
const whoOf = (context) => /User request: (\S+)/.exec(context.goal)?.[1];

test('Two conversations on one file query side by side; executes take turns; a stale execute runs with a notice; a Plan read is not held', async (t) => {
  const a = mockDocument('A', 'win-a', { fingerprint: true });
  const t1InHost = gate(),
    letHost = gate(),
    bothQueried = gate(),
    planRead = gate();
  const answers = {};
  const queriedBy = new Set();
  const { send, settled, state } = setup(
    t,
    async ({ call, context }) => {
      const who = whoOf(context);
      if (who === 'P') {
        answers.plan = await call('query', {});
        planRead.open();
        return { text: '계획' };
      }
      await call('query', {});
      queriedBy.add(who);
      if (queriedBy.size === 2) bothQueried.open();
      // Both turns have read the file before either executes: they ran side by side.
      await bothQueried.promise;
      if (who === 'T1') {
        answers.t1 = await call('execute', { code: 'add wall' });
        return { text: 'T1 끝' };
      }
      await t1InHost.promise;
      answers.stale = await call('execute', { code: 'add column' });
      await call('query', {});
      answers.retry = await call('execute', { code: 'add column' });
      return { text: 'T2 끝' };
    },
    { documents: { a } },
  );
  a.next.execute.push(async (command) => {
    t1InHost.open();
    await letHost.promise;
    return a.apply(command);
  });
  send('t1', { mode: 'auto', body: 'T1' });
  send('t2', { mode: 'auto', body: 'T2' });
  try {
    await t1InHost.promise;
    // T2's execute waits for T1's (nothing more reached the host) and says so.
    await until(() => executeWaitOf(state('t2').result));
    const wait = executeWaitOf(state('t2').result);
    assert.equal(wait.kind, 'execute');
    assert.equal(waitingText(wait), '다른 대화가 이 파일을 고치는 중 · 대기');
    assert.equal(a.calls.execute.length, 1);
    // A Plan turn reads the file while T1's execute is in the host.
    send('plan', { mode: 'plan', body: 'P' });
    await planRead.promise;
    assert.ok(answers.plan.value.objects);
  } finally {
    letHost.open();
  }
  await settled();
  assert.equal(answers.t1.value.ok, true);
  // The document changed under T2 (ADR-031 8): its execute runs and says so.
  assert.equal(answers.stale.value.ok, true);
  assert.equal(answers.stale.value.notices[0].code, 'DOCUMENT_CHANGED');
  assert.match(answers.stale.value.notices[0].next, /query it again/);
  assert.equal(answers.retry.value.ok, true);
  assert.equal(answers.retry.value.notices, undefined);
  assert.equal(a.calls.execute.length, 3);
  assert.equal(state('t1').state, 'succeeded');
  const t2 = state('t2');
  assert.equal(t2.state, 'succeeded');
  // The refusal is gone once the retry ran; the wait text is gone once it got its turn.
  assert.equal(t2.result.refused, undefined);
  assert.equal(t2.result.executeWait, undefined);
});

test("A person's edit after the turn read the file is told on its execute, which runs", async (t) => {
  const a = mockDocument('A', 'win-a', { fingerprint: true });
  const queried = gate(),
    edited = gate();
  const answers = {};
  const { send, settled, state } = setup(
    t,
    async ({ call }) => {
      await call('query', {});
      queried.open();
      await edited.promise;
      answers.stale = await call('execute', { code: 'add wall' });
      await call('query', {});
      answers.ok = await call('execute', { code: 'add wall' });
      return { text: '완료' };
    },
    { documents: { a } },
  );
  send('edit', { mode: 'auto' });
  await queried.promise;
  a.userEdit();
  edited.open();
  await settled();
  assert.equal(answers.stale.value.ok, true);
  assert.equal(answers.stale.value.notices[0].code, 'DOCUMENT_CHANGED');
  assert.equal(answers.ok.value.ok, true);
  assert.equal(answers.ok.value.notices, undefined);
  assert.equal(a.calls.execute.length, 2);
  assert.equal(state('edit').state, 'succeeded');
});

test('An execute right after a fresh start runs at once; its own executes never make the next stale', async (t) => {
  const a = mockDocument('A', 'win-a', { fingerprint: true });
  const answers = {};
  const { send, settled } = setup(
    t,
    async ({ call }) => {
      answers.first = await call('execute', { code: 'add wall' });
      answers.second = await call('execute', { code: 'add door' });
      return { text: '완료' };
    },
    { documents: { a } },
  );
  send('edit', { mode: 'auto' });
  await settled();
  assert.equal(answers.first.value.ok, true);
  assert.equal(answers.second.value.ok, true);
  assert.equal(a.calls.execute.length, 2);
});

test('ExecuteQueue: one at a time in arrival order; a stopped wait leaves the line; the wait names the one ahead', async () => {
  const queue = new ExecuteQueue();
  const order = [];
  const first = await queue.acquire('doc', { requestId: 'r1', title: '레이어 정리' });
  const heard = [];
  const controller = new AbortController();
  const second = queue.acquire(
    'doc',
    { requestId: 'r2' },
    { onWait: (ahead) => heard.push(ahead) },
  );
  const stopped = queue.acquire('doc', { requestId: 'r3' }, { signal: controller.signal });
  const third = queue.acquire('doc', { requestId: 'r4' });
  void second.then(() => order.push('r2'));
  void third.then(() => order.push('r4'));
  assert.deepEqual(
    heard.map((entry) => entry.title),
    ['레이어 정리'],
  );
  assert.equal(executeWaitText(heard[0]), '«레이어 정리» 대화가 이 파일을 고치는 중 · 대기');
  controller.abort();
  await assert.rejects(stopped, { code: 'CANCELLED' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, []);
  first();
  (await second)();
  (await third)();
  assert.deepEqual(order, ['r2', 'r4']);
  assert.deepEqual(queue.line('doc'), []);
  // Another document never waits.
  (await queue.acquire('other', { requestId: 'r5' }))();
});

test('Query pages are read again when the document token moved', async () => {
  let reads = 0;
  const pages = displayQuery(async () => ({
    objects: [{ id: String(++reads) }],
    units: 'Millimeters',
  }));
  await pages.page({}, 'rev-1');
  await pages.page({}, 'rev-1');
  assert.equal(reads, 1);
  await pages.page({}, 'rev-2');
  assert.equal(reads, 2);
});

test('A held row offers [진행] only while its request waits; an ended request shows it not run', () => {
  assert.equal(guardOpen('guarded', 'needs-confirmation'), true);
  for (const state of ['failed', 'interrupted', 'cancelled', 'succeeded', 'unknown', 'running'])
    assert.equal(guardOpen('guarded', state), false);
  assert.equal(heldRowLabel('guarded', 'failed'), '진행하지 않음 (요청 종료)');
  assert.equal(heldRowLabel('guarded', 'interrupted'), '진행하지 않음 (요청 종료)');
  assert.equal(heldRowLabel('guarded', 'needs-confirmation'), undefined);
  assert.equal(heldRowLabel('guarded', 'running'), undefined);
  assert.equal(heldRowLabel('applied', 'failed'), undefined);
  assert.equal(
    waitingText({ kind: 'execute', key: 'k', position: 1, title: '레이어 정리' }),
    '«레이어 정리» 대화가 이 파일을 고치는 중 · 대기',
  );
});

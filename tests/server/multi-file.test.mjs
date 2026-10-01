// Several linked files in one request (ADR-027): a direct Rhino turn reads the project's other
// open linked files live through `linkId`. Mock editor channels for two documents, a closed link,
// and a scripted provider over the turn's MCP scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { AgentTools } from '../../src/server/agent-tools.ts';

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

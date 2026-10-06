// Grasshopper in VIDE (ADR-033, PLAN-29): thin gh_* tools over the user's Grasshopper. A fake host
// keeps a canvas the way the Rhino plugin answers: gh_apply applies a batch as one Grasshopper undo
// record, an op on a missing object fails alone, gh_state `since` returns only what changed, and
// [되돌리기] undoes a record only while it is the newest. No lock: two conversations apply at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { AgentTools, PLAN_MODE_TOOLS, planModeHandlers } from '../../src/server/agent-tools.ts';
import { ConversationService } from '../../src/server/conversations.ts';
import {
  grasshopperHandlers,
  grasshopperLabel,
  insideWorkFolder,
  GH_READ_TOOLS,
  GH_WRITE_TOOLS,
} from '../../src/server/grasshopper-tools.ts';
import { agentToolNames } from '../../src/ai/agent-connection.ts';
import { bundleFor } from '../../src/ai/instructions/index.ts';

const hash = 'a'.repeat(64);
const sourceDocument = {
  instance: '1234:1',
  documentId: 7,
  documentHash: hash,
  connection: 'attached-editor',
  name: 'model.3dm',
  capturedAt: '2026-10-06T00:00:00.000Z',
};
const DOC = '00000000-0000-4000-8000-000000000001';

/** A Grasshopper canvas as the plugin answers it (hosts/rhino/worker/Grasshopper). */
function fakeCanvas({ applyGate } = {}) {
  const objects = new Map();
  const changed = new Map();
  const removed = new Map();
  const undo = []; // newest last
  const redo = [];
  const calls = [];
  let revision = 1;
  const touch = (id) => changed.set(id, ++revision);
  const add = (nickname, extra = {}) => {
    const id = randomUUID();
    objects.set(id, { id, nickname, sources: [], ...extra });
    touch(id);
    return id;
  };
  const slider = add('L', { kind: 'slider', value: 1 });
  const apply = async (params) => {
    if (applyGate) await applyGate(params);
    const before = revision;
    const refs = {};
    const touched = new Set();
    const gone = [];
    const results = params.ops.map((op, index) => {
      const find = (text) => {
        const id = text?.startsWith('$') ? refs[text.slice(1)] : text;
        const obj = objects.get(id);
        if (!obj) throw Object.assign(new Error('gone'), { code: 'GH_OBJECT_NOT_FOUND' });
        return obj;
      };
      try {
        if (op.op === 'add') {
          const id = add(op.nickname ?? op.name ?? 'C', {
            kind: op.script ? 'script' : 'component',
          });
          if (op.ref) refs[op.ref] = id;
          touched.add(id);
          return { index, op: op.op, ok: true, id };
        }
        if (op.op === 'delete') {
          const obj = find(op.id);
          objects.delete(obj.id);
          removed.set(obj.id, ++revision);
          gone.push(obj.id);
          return { index, op: op.op, ok: true, id: obj.id };
        }
        if (op.op === 'connect') {
          const from = find(op.from.id);
          const to = find(op.to.id);
          to.sources.push({ id: from.id, param: op.from.param });
          touched.add(to.id);
          return { index, op: op.op, ok: true };
        }
        if (op.op === 'set') {
          const obj = find(op.id);
          obj.value = op.value;
          touched.add(obj.id);
          return { index, op: op.op, ok: true, id: obj.id };
        }
        return { index, op: op.op, ok: false, code: 'INVALID_INPUT' };
      } catch (error) {
        return { index, op: op.op, ok: false, code: error.code ?? 'GH_OP_FAILED' };
      }
    });
    const others =
      params.since === undefined
        ? []
        : [...touched].filter((id) => {
            const at = changed.get(id);
            return at > params.since && at <= before;
          });
    for (const id of touched) touch(id);
    const record = touched.size || gone.length ? randomUUID() : undefined;
    if (record) {
      undo.push({ record, label: params.label, ids: [...touched], gone });
      redo.length = 0;
    }
    return {
      ok: results.some((row) => row.ok),
      undoId: record ? `gh:${DOC}:${record}` : null,
      revision,
      results,
      created: refs,
      changed: [...touched],
      removed: gone,
      notices: others.length ? [{ code: 'GH_CHANGED_BY_OTHERS', ids: others }] : [],
    };
  };
  const host = {
    calls,
    objects,
    undo,
    slider,
    /** The user edits the canvas by hand (one Grasshopper undo record of their own). */
    userEdit(id) {
      objects.get(id).value = 99;
      touch(id);
      undo.push({ record: randomUUID(), label: 'Slider', ids: [id], gone: [] });
    },
    revision: () => revision,
    async grasshopper(method, params = {}) {
      calls.push({ method, params });
      if (method === 'gh-state') {
        const since = params.since;
        const rows = [...objects.values()].filter(
          (obj) => since === undefined || (changed.get(obj.id) ?? 0) > since,
        );
        if (params.big)
          for (let i = 0; i < 3000; i++)
            rows.push({ id: `pad-${i}`, nickname: 'x'.repeat(40), kind: 'component' });
        return {
          ok: true,
          loaded: true,
          document: { id: DOC, name: 'def.gh' },
          revision,
          total: rows.length,
          offset: params.offset ?? 0,
          objects: rows,
          ...(since === undefined
            ? {}
            : { removed: [...removed].filter(([, at]) => at > since).map(([id]) => id) }),
          documents: [{ id: DOC, name: 'def.gh' }],
        };
      }
      if (method === 'gh-apply') return apply(params);
      if (method === 'gh-components')
        return { ok: true, components: [{ guid: randomUUID(), name: 'Addition' }] };
      if (method === 'gh-outputs') return { ok: true, outputs: [{ count: 1, items: ['3'] }] };
      if (method === 'gh-open' || method === 'gh-save') return { ok: true, path: params.path };
      throw Object.assign(new Error(method), { code: 'UNKNOWN_METHOD' });
    },
    /** direct-undo of a `gh:` record: only the newest one. */
    undoRecord(undoId) {
      const record = undoId.split(':')[2];
      if (redo.includes(record)) return { ok: true, already: true };
      const at = undo.findIndex((entry) => entry.record === record);
      if (at < 0) return { ok: false, reason: 'unknown' };
      if (at !== undo.length - 1) return { ok: false, reason: 'gh-not-latest' };
      undo.pop();
      redo.push(record);
      return { ok: true };
    },
  };
  return host;
}

function mockDriver(canvas) {
  const calls = { execute: [], undo: [] };
  const driver = {
    host: 'rhino',
    target: { instance: sourceDocument.instance, documentId: sourceDocument.documentId },
    async execute(command) {
      calls.execute.push(command);
      return {
        ok: true,
        undoId: '21',
        changes: {
          added: [{ nativeId: 'baked-1', hash, layer: 'Grasshopper' }],
          changed: [],
          removed: [],
        },
        log: 'L.out: 1 baked',
      };
    },
    async undo(undoId) {
      calls.undo.push(undoId);
      if (undoId.startsWith('gh:')) return canvas.undoRecord(undoId);
      return { ok: true };
    },
    async query() {
      return { objects: [], page: { total: 0 } };
    },
    grasshopper: (method, params) => canvas.grasshopper(method, params),
  };
  return { driver, calls };
}

function scripted(tools, script) {
  const seen = [];
  const providerFactory = ({ agent }) => ({
    async run(context) {
      seen.push({ agent, context });
      const call = async (name, args = {}) => {
        const result = await tools.call(agent.token, name, { targetRef: agent.targetRef, ...args });
        return { error: result.isError === true, value: JSON.parse(result.content.at(-1).text) };
      };
      return script({ agent, context, call });
    },
    async status() {
      return { available: true };
    },
  });
  return { providerFactory, seen };
}

function setup(t, script, { canvas = fakeCanvas() } = {}) {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('gh');
  const tools = new AgentTools({ origin: 'http://127.0.0.1:9' });
  const host = mockDriver(canvas);
  const { providerFactory, seen } = scripted(tools, script);
  const conversations = new ConversationService(store);
  const execution = new Execution(workspace, {
    tools,
    providerFactory,
    conversations,
    directDriver: (kind, source) =>
      kind === 'rhino' && source && typeof source === 'object' ? host.driver : undefined,
  });
  t.after(async () => {
    await execution.close();
    tools.close();
    store.close();
  });
  const base = { body: '격자 만들기', provider: 'claude-cli', pins: [], sketches: [], files: [] };
  workspace.submit(project.id, { ...base, id: 'sync-1', body: 'Sync', mode: 'plan' });
  workspace.update(project.id, 'sync-1', 'succeeded', {
    host: 'rhino',
    hostExecuted: true,
    displayOnly: true,
    objects: [],
    scene: [],
    sourceDocument,
  });
  const send = (id, fields = {}) => {
    const request = workspace.submit(project.id, {
      ...base,
      id,
      baseRequestId: 'sync-1',
      mode: 'auto',
      ...fields,
    }).request;
    execution.start(request);
    return request;
  };
  const settled = async () => {
    while (execution.active.size)
      await Promise.all([...execution.active.values()].map((entry) => entry.completion));
  };
  const state = (id) => workspace.get(project.id, id);
  return { project, execution, host, canvas, seen, send, settled, state, conversations };
}

test('the gh tools are one registry: names, Plan keeps the reads only, writes take turns', () => {
  for (const name of [...GH_READ_TOOLS, ...GH_WRITE_TOOLS])
    assert.ok(agentToolNames.includes(name));
  for (const name of GH_READ_TOOLS) assert.ok(PLAN_MODE_TOOLS.has(name), name);
  for (const name of GH_WRITE_TOOLS) assert.ok(!PLAN_MODE_TOOLS.has(name), name);
  const all = Object.fromEntries(
    [...GH_READ_TOOLS, ...GH_WRITE_TOOLS].map((name) => [name, () => {}]),
  );
  assert.deepEqual(Object.keys(planModeHandlers(all)).sort(), [...GH_READ_TOOLS].sort());
  assert.equal(grasshopperLabel('  기둥  격자\n', 3), 'VIDE: 기둥 격자 · 3 ops');
  // The Rhino modeling rules carry the Grasshopper rules; the CAD ones do not.
  assert.match(bundleFor('modeling', undefined, { host: 'rhino' }), /# Grasshopper/);
  assert.doesNotMatch(bundleFor('modeling', undefined, { host: 'zwcad' }), /# Grasshopper/);
});

test('Auto: one gh_apply batch is one record; [되돌리기] undoes it while it is the newest', async (t) => {
  const answers = [];
  const { execution, host, canvas, seen, send, settled, state, project } = setup(
    t,
    async ({ call }) => {
      const read = await call('gh_state');
      answers.push(read);
      answers.push(
        await call('gh_apply', {
          since: read.value.revision,
          ops: [
            { op: 'add', name: 'Addition', x: 200, y: 0, ref: 'sum' },
            { op: 'connect', from: { id: canvas.slider }, to: { id: '$sum', param: 'A' } },
            { op: 'set', id: canvas.slider, value: 5 },
          ],
        }),
      );
      return { text: '더하기를 놓고 연결했습니다.' };
    },
  );
  send('gh-1');
  await settled();
  assert.ok(seen[0].agent.tools.includes('gh_apply'));
  assert.match(seen[0].context.goal, /Grasshopper in this Rhino/);
  const [read, applied] = answers;
  assert.equal(read.value.objects.length, 1);
  assert.equal(applied.value.ok, true);
  assert.deepEqual(
    applied.value.results.map((row) => row.ok),
    [true, true, true],
  );
  // The label names the request; the host got the ops as they were sent.
  const sent = canvas.calls.find((entry) => entry.method === 'gh-apply').params;
  assert.equal(sent.label, 'VIDE: 격자 만들기 · 3 ops');
  assert.equal(sent.ops.length, 3);
  assert.equal(canvas.undo.length, 1);
  const done = state('gh-1');
  assert.equal(done.state, 'succeeded');
  const [record] = done.result.executions;
  assert.equal(record.kind, 'grasshopper');
  assert.match(record.undoId, /^gh:/);
  assert.equal(record.changes.added.length, 1);
  assert.ok(record.body.includes('Addition'));
  assert.ok(
    done.result.activity.some((line) => /Grasshopper에 반영 · 작업 3\/3개/.test(line.text)),
  );

  const undone = await execution.undo(project.id, 'gh-1', record.executionId);
  assert.equal(undone.ok, true);
  assert.equal(host.calls.undo[0], record.undoId);
  assert.equal(canvas.undo.length, 0);
  assert.equal(state('gh-1').result.executions[0].state, 'undone');
});

test('an op on a deleted object fails alone and the rest of the batch applies', async (t) => {
  let answer;
  const canvas = fakeCanvas();
  const gone = canvas.slider;
  canvas.objects.delete(gone); // the user deleted it after the AI read the canvas
  const { settled, send, state } = setup(
    t,
    async ({ call }) => {
      answer = await call('gh_apply', {
        ops: [
          { op: 'add', name: 'Panel', ref: 'p' },
          { op: 'set', id: gone, value: 3 },
          { op: 'set', id: '$p', value: 1 },
        ],
      });
      return { text: '하나는 실패' };
    },
    { canvas },
  );
  send('gh-2');
  await settled();
  assert.equal(answer.error, false);
  assert.deepEqual(
    answer.value.results.map((row) => [row.ok, row.code ?? null]),
    [
      [true, null],
      [false, 'GH_OBJECT_NOT_FOUND'],
      [true, null],
    ],
  );
  const done = state('gh-2');
  assert.equal(done.state, 'succeeded');
  assert.equal(done.result.executions.length, 1);
  assert.ok(done.result.activity.some((line) => /작업 2\/3개/.test(line.text)));
});

test('gh_state since returns only what changed; gh_apply notes someone else’s edit', async (t) => {
  const answers = [];
  const canvas = fakeCanvas();
  const { send, settled } = setup(
    t,
    async ({ call }) => {
      const first = await call('gh_state');
      canvas.userEdit(canvas.slider); // the user drags the slider meanwhile
      const since = await call('gh_state', { since: first.value.revision });
      const edit = await call('gh_apply', {
        since: first.value.revision,
        ops: [{ op: 'set', id: canvas.slider, value: 2 }],
      });
      answers.push(first, since, edit);
      return { text: 'ok' };
    },
    { canvas },
  );
  send('gh-3');
  await settled();
  const [first, since, edit] = answers;
  assert.equal(first.value.objects.length, 1);
  assert.deepEqual(
    since.value.objects.map((row) => row.id),
    [canvas.slider],
  );
  assert.ok(since.value.revision > first.value.revision);
  assert.equal(edit.value.notices[0].code, 'GH_CHANGED_BY_OTHERS');
  assert.deepEqual(edit.value.notices[0].ids, [canvas.slider]);
});

test('[되돌리기] of a gh_apply after a later canvas edit answers gh-not-latest', async (t) => {
  const { execution, canvas, send, settled, state, project } = setup(t, async ({ call }) => {
    await call('gh_apply', { ops: [{ op: 'set', id: canvas.slider, value: 4 }] });
    return { text: 'ok' };
  });
  send('gh-4');
  await settled();
  canvas.userEdit(canvas.slider); // a newer Grasshopper record above VIDE's
  const [record] = state('gh-4').result.executions;
  const answer = await execution.undo(project.id, 'gh-4', record.executionId);
  assert.deepEqual([answer.ok, answer.reason], [false, 'gh-not-latest']);
  assert.equal(state('gh-4').result.executions[0].state, 'applied');
  assert.equal(canvas.undo.length, 2);
});

test('two conversations apply batches to the same canvas at once (no document lock)', async (t) => {
  // Each gh-apply waits until the other has arrived: a lock or a queue would never let both in.
  let arrived = 0;
  let release;
  const both = new Promise((resolve) => (release = resolve));
  const canvas = fakeCanvas({
    applyGate: async () => {
      if (++arrived === 2) release();
      await Promise.race([
        both,
        new Promise((_, reject) => setTimeout(() => reject(new Error('serialized')), 3000)),
      ]);
    },
  });
  const answers = {};
  const { conversations, project, send, settled, state } = setup(
    t,
    async ({ context, call }) => {
      const mine = context.goal.includes('왼쪽') ? 'left' : 'right';
      answers[mine] = await call('gh_apply', {
        ops: [{ op: 'add', name: 'Point', nickname: mine }],
      });
      return { text: mine };
    },
    { canvas },
  );
  const a = conversations.create(project.id, {
    kind: 'ask',
    title: '왼쪽',
    provider: 'claude-cli',
  });
  const b = conversations.create(project.id, {
    kind: 'ask',
    title: '오른쪽',
    provider: 'claude-cli',
  });
  send('left', { conversationId: a.id, body: '왼쪽 점' });
  send('right', { conversationId: b.id, body: '오른쪽 점' });
  await settled();
  assert.equal(arrived, 2);
  assert.equal(answers.left.value.ok, true);
  assert.equal(answers.right.value.ok, true);
  assert.equal(state('left').state, 'succeeded');
  assert.equal(state('right').state, 'succeeded');
  assert.equal(canvas.undo.length, 2);
});

test('gh_bake runs as an execute (one Rhino undo record); Plan offers the reads only', async (t) => {
  let baked;
  const { host, send, settled, state, seen } = setup(t, async ({ agent, call }) => {
    if (agent.tools.includes('gh_bake'))
      baked = await call('gh_bake', { params: [{ id: 'abc', param: 'R' }], layer: 'GH::Out' });
    else await call('gh_state');
    return { text: 'ok' };
  });
  send('bake-1');
  await settled();
  assert.equal(baked.value.ok, true);
  assert.equal(host.calls.execute[0].language, 'gh-bake');
  assert.deepEqual(JSON.parse(host.calls.execute[0].code), {
    params: [{ id: 'abc', param: 'R' }],
    layer: 'GH::Out',
  });
  const [record] = state('bake-1').result.executions;
  assert.equal(record.language, 'gh-bake');
  assert.equal(record.undoId, '21');
  send('plan-1', { mode: 'plan' });
  await settled();
  const plan = seen.at(-1).agent.tools;
  assert.ok(plan.includes('gh_state') && plan.includes('gh_capture'));
  assert.ok(!plan.includes('gh_apply') && !plan.includes('gh_bake'));
});

test('a large canvas read is cut with nextOffset, not refused', async () => {
  const canvas = fakeCanvas();
  const handlers = grasshopperHandlers({
    mode: 'plan',
    resolve: async () => ({ driver: mockDriver(canvas).driver, file: { name: 'm.3dm' } }),
    signal: new AbortController().signal,
    title: 't',
    bake: async () => ({}),
    onUse: () => {},
    onRecord: () => {},
  });
  assert.deepEqual(Object.keys(handlers).sort(), [...GH_READ_TOOLS].sort());
  const page = await handlers.gh_state({ big: true });
  assert.equal(page.truncated, true);
  assert.ok(page.objects.length < 3001);
  assert.equal(page.nextOffset, page.objects.length);
});

test('gh_open and gh_save reach only the project work folder', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'vide-gh-'));
  const outside = mkdtempSync(join(tmpdir(), 'vide-out-'));
  t.after(() => {
    rmSync(folder, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(join(folder, 'a.gh'), 'x');
  writeFileSync(join(outside, 'b.gh'), 'x');
  assert.ok(insideWorkFolder(join(folder, 'a.gh'), [folder], true));
  assert.equal(insideWorkFolder(join(outside, 'b.gh'), [folder], true), undefined);
  assert.equal(insideWorkFolder('a.gh', [folder], false), undefined);
  assert.ok(insideWorkFolder(join(folder, 'new.gh'), [folder], false));
  const canvas = fakeCanvas();
  const handlers = grasshopperHandlers({
    mode: 'auto',
    resolve: async () => ({ driver: mockDriver(canvas).driver, file: { name: 'm.3dm' } }),
    signal: new AbortController().signal,
    title: 't',
    workFolders: () => [folder],
    bake: async () => ({}),
    onUse: () => {},
    onRecord: () => {},
  });
  await assert.rejects(handlers.gh_open({ path: join(outside, 'b.gh') }), {
    code: 'GH_OUTSIDE_WORK_FOLDER',
  });
  await assert.rejects(handlers.gh_save({ path: join(outside, 'c.gh') }), {
    code: 'GH_OUTSIDE_WORK_FOLDER',
  });
  assert.equal((await handlers.gh_open({ path: join(folder, 'a.gh') })).ok, true);
  assert.equal((await handlers.gh_save({ path: join(folder, 'b.gh') })).ok, true);
  assert.equal(canvas.calls.filter((entry) => entry.method.startsWith('gh-open')).length, 1);
});

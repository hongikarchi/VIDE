import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { Execution } from '../../src/server/execution.ts';
import { AgentTools } from '../../src/server/agent-tools.ts';
import { instructionFor } from '../../src/ai/agent-connection.ts';
import { buildFactsDb } from '../core/knowledge-facts.test.mjs';

// PLAN-24 T-062 (2026-10-01 user decision: "도구를 만들어놓고 특정 작업에는 안 쓰게 하는 것도
// 이상하다"): every host modeling turn reads the project beside its target — other linked files'
// layers and Sync samples (links_layers, sync_sample) and the project's 자료 (project_*), in Plan
// and Auto. They read VIDE's own records, never a host.

const hash = 'a'.repeat(64);
const sourceDocument = {
  instance: '1234:1',
  documentId: 7,
  documentHash: hash,
  connection: 'attached-editor',
  name: 'model.3dm',
  capturedAt: '2026-10-01T00:00:00.000Z',
};
const layer64 = (name) => Buffer.from(name, 'utf8').toString('base64');

/** A project with a linked CAD file (one stored Sync), a facts DB and an attached Rhino document. */
function project(t, { sdk } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'vide-host-tools-'));
  const store = new Store(join(directory, 'vide.sqlite'));
  const workspace = new Workspace(store);
  const created = store.createProject('호스트 도구');
  mkdirSync(join(directory, 'knowledge'));
  buildFactsDb(join(directory, 'knowledge', created.id + '.sqlite'));
  const link = new DocumentLinks(store.db).link(created.id, {
    host: 'zwcad',
    name: 'plan.dwg',
    path: 'C:/work/plan.dwg',
    instance: '1:1',
    documentId: 1,
  });
  // The CAD file's stored Sync: two walls and a column, read from the record only.
  store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
    'cad-sync',
    created.id,
    JSON.stringify({
      id: 'cad-sync',
      provider: 'codex-cli',
      host: 'zwcad',
      source: 'document',
      permission: 'candidate',
      body: 'sync',
      pins: [],
      sketches: [],
      files: [],
      linkId: link.id,
    }),
    'succeeded',
    JSON.stringify({
      host: 'zwcad',
      hostExecuted: true,
      displayOnly: true,
      objects: [],
      scene: [
        { id: 'w1', type: 'line', length: 6, layer64: layer64('A-WALL') },
        { id: 'w2', type: 'line', length: 4, layer64: layer64('A-WALL') },
        { id: 'c1', type: 'polyline', area: 0.36, layer64: layer64('S-COLS') },
      ],
      sourceDocument: { name: 'plan.dwg', capturedAt: '2026-10-01T00:00:00.000Z' },
    }),
    '2026-10-01T00:00:00.000Z',
  );
  const tools = new AgentTools({ origin: 'http://127.0.0.1:9' });
  const seen = [];
  const answers = [];
  // The provider calls the tools it was given in-process, as the CLI would over MCP.
  const providerFactory = ({ agent }) => ({
    async run(context) {
      seen.push({ agent, context });
      const call = async (name, args = {}) => {
        const result = await tools.call(agent.token, name, args);
        return { error: result.isError === true, value: JSON.parse(result.content.at(-1).text) };
      };
      answers.push({
        layers: await call('links_layers'),
        sample: await call('sync_sample', { linkId: link.id, layer: 'A-WALL' }),
        search: await call('project_search', { query: '스팬' }),
      });
      return { text: '확인했습니다.' };
    },
    async status() {
      return { available: true };
    },
  });
  const driver = {
    host: 'rhino',
    target: { instance: sourceDocument.instance, documentId: sourceDocument.documentId },
    async execute() {
      return { ok: true, undoId: '1', changes: { added: [], changed: [], removed: [] } };
    },
    async undo() {
      return { ok: true };
    },
    async query() {
      return { objects: [], page: { total: 0 } };
    },
  };
  const execution = new Execution(workspace, {
    tools,
    providerFactory,
    sdk,
    directDriver: (kind, source) =>
      kind === 'rhino' && source && typeof source === 'object' ? driver : undefined,
  });
  t.after(async () => {
    await execution.close();
    tools.close();
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const base = { provider: 'claude-cli', pins: [], sketches: [], files: [] };
  const sync = (result) => {
    workspace.submit(created.id, { ...base, id: 'sync-1', body: 'Sync', mode: 'plan' });
    workspace.update(created.id, 'sync-1', 'succeeded', result);
  };
  const send = (id, fields = {}) => {
    const request = workspace.submit(created.id, {
      ...base,
      id,
      body: '벽 옆에 기둥 추가',
      baseRequestId: 'sync-1',
      ...fields,
    }).request;
    execution.start(request);
  };
  const settled = async () => {
    while (execution.active.size)
      await Promise.all([...execution.active.values()].map((entry) => entry.completion));
  };
  return {
    workspace,
    projectId: created.id,
    link,
    seen,
    answers,
    sync,
    send,
    settled,
    state: (id) => workspace.get(created.id, id),
  };
}

function assertReads(answer, link) {
  assert.equal(answer.layers.error, false, JSON.stringify(answer.layers.value));
  const [file] = answer.layers.value.links;
  assert.equal(file.linkId, link.id);
  assert.equal(file.syncId, 'cad-sync');
  assert.deepEqual(file.layers.map((row) => [row.fullPath, row.objectCount]).sort(), [
    ['A-WALL', 2],
    ['S-COLS', 1],
  ]);
  assert.equal(answer.sample.error, false, JSON.stringify(answer.sample.value));
  assert.equal(answer.sample.value.total, 2);
  assert.deepEqual(answer.sample.value.items.map((row) => row.id).sort(), ['w1', 'w2']);
  assert.equal(answer.search.error, false, JSON.stringify(answer.search.value));
  assert.ok(answer.search.value.items.some((item) => item.ref === 'S1'));
}

test('direct-mode Rhino turns offer and answer links_layers, sync_sample and project_search in Auto and Plan', async (t) => {
  const { sync, send, settled, seen, answers, state, link } = project(t);
  sync({
    host: 'rhino',
    hostExecuted: true,
    displayOnly: true,
    objects: [],
    scene: [],
    sourceDocument,
  });
  send('auto-1', { mode: 'auto' });
  await settled();
  send('plan-1', { mode: 'plan' });
  await settled();
  assert.equal(state('auto-1').state, 'succeeded', JSON.stringify(state('auto-1').result));
  assert.equal(state('plan-1').state, 'succeeded', JSON.stringify(state('plan-1').result));
  const [auto, plan] = seen;
  for (const name of ['links_layers', 'sync_sample', 'project_search', 'project_brief'])
    for (const turn of [auto, plan]) assert.ok(turn.agent.tools.includes(name), name);
  assert.ok(auto.agent.tools.includes('execute'));
  assert.ok(!plan.agent.tools.includes('execute'));
  // The rules the CLI gets describe the project reads; which other files a turn reads or edits
  // live is the goal's to say (ADR-027): the shared rules promise no live access.
  const rules = instructionFor(auto.agent);
  assert.match(rules, /links_layers lists the project's linked files/);
  assert.match(rules, /unless the task goal lists it as open with its linkId/);
  assert.doesNotMatch(rules, /take that linkId/);
  // A connection without view methods: the goal does not offer capture_view or measure.
  assert.doesNotMatch(auto.context.goal, /capture_view|measure for exact/);
  assert.doesNotMatch(plan.context.goal, /capture_view|measure for exact/);
  for (const answer of answers) assertReads(answer, link);
});

test('copy-path SDK turns get the same project read tools from Execution', async (t) => {
  let task;
  const sdk = {
    async run(given) {
      task = given;
      const handlers = given.projectTools;
      // Execution hands the handlers to the copy path; the driver spreads them into its scope.
      const signal = new AbortController().signal;
      const layers = await handlers.links_layers({}, { signal });
      const search = await handlers.project_search({ query: '스팬' }, { signal });
      return {
        text: `${layers.links.length} ${search.items.length}`,
        hostExecuted: false,
        executionMode: 'sdk',
      };
    },
  };
  const { sync, send, settled, state } = project(t, { sdk });
  // A stored work copy basis (not an attached document): the copy path.
  sync({ host: 'rhino', hostExecuted: true, objects: [], scene: [] });
  send('copy-1', { mode: 'auto' });
  await settled();
  assert.equal(state('copy-1').state, 'succeeded', JSON.stringify(state('copy-1').result));
  assert.deepEqual(Object.keys(task.projectTools).sort(), [
    'links_layers',
    'project_brief',
    'project_checks',
    'project_issue',
    'project_search',
    'project_statement',
    'sync_sample',
  ]);
  assert.match(state('copy-1').result.text, /^1 [1-9]/);
});

test('a linked turn of two targets may leave targetRef out for the project reads only', async () => {
  const tools = new AgentTools({ origin: 'http://127.0.0.1:9' });
  try {
    const scope = tools.issue({
      targetRef: ['rhino:a', 'zwcad:b'],
      handlers: {
        query: async () => ({ objects: [] }),
        links_layers: async () => ({ links: [] }),
      },
      isCurrent: () => true,
    });
    const code = async (name, args) => {
      const result = await tools.call(scope.token, name, args);
      return result.isError ? JSON.parse(result.content[0].text).code : 'ok';
    };
    assert.equal(await code('links_layers', {}), 'ok');
    assert.equal(await code('links_layers', { targetRef: 'zwcad:b' }), 'ok');
    assert.equal(await code('links_layers', { targetRef: 'other' }), 'TARGET_MISMATCH');
    // The host tools still name their target.
    assert.equal(await code('query', {}), 'INVALID_INPUT');
    assert.equal(await code('query', { targetRef: 'rhino:a' }), 'ok');
  } finally {
    tools.close();
  }
});

// Step times of a run in the diagnostic log (`request-stages`): numbers only, measured from the
// run's start; a direct turn's result carries its end time for [진행]'s last stage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { AgentTools } from '../../src/server/agent-tools.ts';
import { Diagnostics, requestStages } from '../../src/server/diagnostics.ts';

test('requestStages: offsets from the run start, and the time after the last host event', () => {
  const t0 = Date.parse('2026-09-30T06:00:00.000Z');
  const at = (ms) => new Date(t0 + ms).toISOString();
  const fields = requestStages(
    {
      receivedAt: t0 - 40,
      runAt: t0,
      contextMs: 0,
      providerAt: t0 + 12,
      provider: { authMs: 1, authCached: true, spawnAt: t0 + 60, firstOutputAt: t0 + 900 },
    },
    [
      { kind: 'host', text: '연결', at: at(5) },
      { kind: 'thinking', text: '생각', at: at(4000) },
      { kind: 'query', text: '조회', at: at(6000) },
      { kind: 'execute', text: '실행', at: at(9000) },
      { kind: 'result', text: '반영', at: at(9500) },
      { kind: 'message', text: '정리', at: at(12000) },
    ],
    t0 + 15000,
  );
  assert.deepEqual(fields, {
    queuedMs: 40,
    contextMs: 0,
    providerMs: 12,
    authMs: 1,
    authCached: true,
    spawnMs: 60,
    firstOutputMs: 900,
    firstNoteMs: 4000,
    firstToolMs: 6000,
    lastToolMs: 9500,
    answerMs: 5500,
    totalMs: 15000,
    queries: 1,
    executes: 1,
  });
  // Nothing but numbers: no text of the request or the activity.
  assert.ok(!JSON.stringify(fields).includes('반영'));
});

test('a direct turn writes its step times to the log and its end time to the result', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-stages-'));
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('stages');
  const tools = new AgentTools({ origin: 'http://127.0.0.1:9' });
  const sourceDocument = {
    instance: '1234:1',
    documentId: 7,
    documentHash: 'a'.repeat(64),
    connection: 'attached-editor',
    name: 'model.3dm',
    capturedAt: '2026-09-30T00:00:00.000Z',
  };
  const driver = {
    host: 'rhino',
    target: { instance: sourceDocument.instance, documentId: sourceDocument.documentId },
    async execute() {
      return {
        ok: true,
        undoId: '11',
        changes: { added: [{ nativeId: 'n-1', layer: 'Walls' }], changed: [], removed: [] },
        log: '',
      };
    },
    async undo() {
      return { ok: true };
    },
    async query() {
      return { objects: [], page: { total: 0 } };
    },
  };
  const providerFactory = ({ agent }) => {
    const provider = {
      timing: {},
      async run(_context, { onProgress }) {
        provider.timing = { authMs: 2, authCached: true, spawnAt: Date.now() };
        provider.timing.firstOutputAt = Date.now();
        onProgress({ state: 'running', kind: 'thinking', text: '벽을 추가한다' });
        const call = (name, args = {}) =>
          tools.call(agent.token, name, { targetRef: agent.targetRef, ...args });
        await call('query');
        await call('execute', { code: 'add wall' });
        onProgress({ state: 'running', kind: 'message', text: '정리' });
        return { text: '벽 1개를 추가했습니다.' };
      },
      async status() {
        return { available: true };
      },
    };
    return provider;
  };
  let diagnostics;
  const execution = new Execution(workspace, {
    tools,
    providerFactory,
    diagnostics: (diagnostics = new Diagnostics({ directory })),
    directDriver: () => driver,
  });
  t.after(async () => {
    await execution.close();
    tools.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = { body: '비밀 요청', provider: 'claude-cli', pins: [], sketches: [], files: [] };
  workspace.submit(project.id, { ...base, id: 'sync-1', body: 'Sync', mode: 'plan' });
  workspace.update(project.id, 'sync-1', 'succeeded', {
    host: 'rhino',
    hostExecuted: true,
    displayOnly: true,
    objects: [],
    scene: [],
    sourceDocument,
  });
  const request = workspace.submit(project.id, {
    ...base,
    id: 'auto-1',
    baseRequestId: 'sync-1',
    mode: 'auto',
  }).request;
  execution.start(request);
  while (execution.active.size)
    await Promise.all([...execution.active.values()].map((entry) => entry.completion));
  const done = workspace.get(project.id, 'auto-1');
  assert.equal(done.state, 'succeeded');
  assert.equal(done.result.appliedDirectly, true);
  assert.ok(Number.isFinite(Date.parse(done.result.endedAt)));
  diagnostics.flush();
  const day = new Date().toISOString().slice(0, 10);
  const log = (await readFile(join(directory, 'logs', `engine-${day}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const stages = log.find((line) => line.event === 'request-stages');
  assert.equal(stages.requestId, 'auto-1');
  assert.equal(stages.authMs, 2);
  assert.equal(stages.authCached, true);
  assert.equal(stages.queries, 1);
  assert.equal(stages.executes, 1);
  for (const key of ['providerMs', 'spawnMs', 'firstNoteMs', 'lastToolMs', 'answerMs', 'totalMs'])
    assert.equal(typeof stages[key], 'number', key);
  assert.ok(stages.firstNoteMs <= stages.lastToolMs && stages.lastToolMs <= stages.totalMs);
  assert.ok(!JSON.stringify(log).includes('비밀 요청'), 'request text is never logged');
});

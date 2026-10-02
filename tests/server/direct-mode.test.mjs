// Plan / Auto (ADR-022): Auto runs the AI's execute directly in the attached document (one undo
// record each, recorded in the result and the ledger), a tripped guard waits on its card, Plan has
// no execute and ends with a plan card whose [진행] starts an Auto turn. Mock host and provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { AgentTools } from '../../src/server/agent-tools.ts';
import { ConversationService } from '../../src/server/conversations.ts';
import { requestMode } from '../../src/contracts/workspace.ts';
import { takePlan, continueBody, DIRECT_MAX_DELETES } from '../../src/server/direct-mode.ts';

const hash = 'a'.repeat(64);
const sourceDocument = {
  instance: '1234:1',
  documentId: 7,
  documentHash: hash,
  connection: 'attached-editor',
  name: 'model.3dm',
  capturedAt: '2026-09-30T00:00:00.000Z',
};

/** A host that answers direct-execute by the body's first word. */
function mockHost() {
  const calls = { execute: [], undo: [] };
  let serial = 10;
  let latest;
  const driver = {
    host: 'rhino',
    target: { instance: sourceDocument.instance, documentId: sourceDocument.documentId },
    async execute(command) {
      calls.execute.push(command);
      if (command.code.startsWith('bad'))
        return { ok: false, code: 'COMPILE_ERROR', diagnostics: ['CS1002: ; expected'] };
      if (command.code.startsWith('wipe') && !command.guard.confirmed)
        return {
          ok: false,
          reverted: true,
          guarded: {
            kind: 'bulk-delete',
            detail: '객체 600개를 지웁니다 (기준 500개).',
            deletes: 60,
          },
          log: '',
        };
      latest = String(++serial);
      const removed = command.code.startsWith('wipe')
        ? Array.from({ length: 60 }, (_, i) => ({ nativeId: `r-${i}`, layer: 'Old' }))
        : [];
      return {
        ok: true,
        undoId: latest,
        changes: {
          added: removed.length ? [] : [{ nativeId: 'n-1', hash, layer: 'Walls' }],
          changed: [],
          removed,
        },
        log: 'done',
        value: { made: 1 },
      };
    },
    async undo(undoId) {
      calls.undo.push(undoId);
      return undoId === latest ? { ok: true } : { ok: false, reason: 'not-latest' };
    },
    async query() {
      return { objects: [{ id: 'n-1' }], page: { total: 1 } };
    },
  };
  return { driver, calls, bump: () => (latest = String(++serial)) };
}

/** A provider whose turn is a script over the MCP scope it was given (called in-process). */
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

function setup(t, script, { conversations: withConversations = false } = {}) {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('direct');
  const tools = new AgentTools({ origin: 'http://127.0.0.1:9' });
  const host = mockHost();
  const { providerFactory, seen } = scripted(tools, script);
  const conversations = withConversations ? new ConversationService(store) : undefined;
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
  const base = {
    body: '벽 추가',
    provider: 'claude-cli',
    pins: [],
    sketches: [],
    files: [],
  };
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
  return { store, workspace, project, execution, host, seen, send, settled, state, conversations };
}

test('Auto: execute runs in the attached document as undo records, changes go back to the model', async (t) => {
  const answers = [];
  const { execution, host, seen, send, settled, state, project } = setup(t, async ({ call }) => {
    answers.push(await call('query'));
    answers.push(await call('execute', { code: 'bad body' }));
    answers.push(await call('execute', { code: 'add wall' }));
    return { text: '벽 1개를 추가했습니다. Ctrl+Z로 되돌릴 수 있습니다.' };
  });
  send('auto-1', { mode: 'auto' });
  await settled();
  const done = state('auto-1');
  assert.equal(done.state, 'succeeded');
  assert.equal(requestMode(done.input), 'auto');
  assert.ok(seen[0].agent.tools.includes('execute'));
  assert.match(seen[0].context.goal, /ONE undo record/);
  // Compile diagnostics come back to the model; nothing is recorded for them.
  assert.equal(answers[1].value.code, 'COMPILE_ERROR');
  assert.deepEqual(answers[1].value.diagnostics, ['CS1002: ; expected']);
  // The applied execute returns its undo id and changes to the model.
  assert.equal(answers[2].value.ok, true);
  assert.equal(answers[2].value.undoId, '11');
  assert.deepEqual(answers[2].value.changes.counts, { added: 1, changed: 0, removed: 0 });
  assert.equal(host.calls.execute[1].guard.confirmed, false);
  assert.equal(host.calls.execute[1].guard.maxDeletes, DIRECT_MAX_DELETES);
  assert.match(host.calls.execute[1].label, /^VIDE AI 2: 벽 추가/);
  // The request result carries the execution; the Sync stays the basis (no candidate).
  assert.equal(done.result.mode, 'auto');
  assert.equal(done.result.appliedDirectly, true);
  assert.equal(done.result.hostExecuted, false);
  assert.equal(done.result.executionMode, 'direct');
  assert.equal(done.result.executions.length, 1);
  const [record] = done.result.executions;
  assert.equal(record.state, 'applied');
  assert.equal(record.undoId, '11');
  assert.equal(record.code, undefined);
  assert.equal(done.result.progress.completed, 1);

  // [되돌리기] undoes that record while it is the latest one.
  const undone = await execution.undo(project.id, 'auto-1', record.executionId);
  assert.equal(undone.ok, true);
  assert.deepEqual(host.calls.undo, ['11']);
  assert.equal(state('auto-1').result.executions[0].state, 'undone');
  assert.equal((await execution.undo(project.id, 'auto-1', record.executionId)).already, true);
  assert.equal(host.calls.undo.length, 1);
  await assert.rejects(execution.undo(project.id, 'auto-1', 'missing'), { code: 'NOT_FOUND' });
});

test('[되돌리기] after a later change answers not-latest', async (t) => {
  const { execution, host, send, settled, state, project } = setup(t, async ({ call }) => {
    await call('execute', { code: 'add wall' });
    return { text: '추가' };
  });
  send('auto-2');
  await settled();
  // The user kept working in Rhino: another undo record came after VIDE's.
  host.bump();
  const [record] = state('auto-2').result.executions;
  const answer = await execution.undo(project.id, 'auto-2', record.executionId);
  assert.deepEqual([answer.ok, answer.reason], [false, 'not-latest']);
  assert.equal(state('auto-2').result.executions[0].state, 'applied');
});

test('a guarded execute leaves the request waiting on its card; [진행] re-runs it released', async (t) => {
  const answers = [];
  const { execution, host, send, settled, state, project } = setup(t, async ({ call }) => {
    answers.push(await call('execute', { code: 'wipe old layer' }));
    return { text: '60개 삭제는 확인이 필요합니다.' };
  });
  send('guard-1');
  await settled();
  const waiting = state('guard-1');
  assert.equal(waiting.state, 'needs-confirmation');
  assert.equal(answers[0].value.ok, false);
  assert.equal(answers[0].value.guarded.kind, 'bulk-delete');
  assert.equal(waiting.result.guarded.kind, 'bulk-delete');
  const [held] = waiting.result.executions;
  assert.equal(held.state, 'guarded');
  assert.equal(waiting.result.guarded.executionId, held.executionId);
  assert.throws(() => execution.continuePlan(project.id, 'guard-1'), {
    code: 'REVISION_CONFLICT',
  });

  const confirmed = await execution.confirm(project.id, 'guard-1', held.executionId);
  assert.equal(confirmed.state, 'succeeded');
  const rerun = host.calls.execute.at(-1);
  assert.equal(rerun.code, 'wipe old layer');
  assert.equal(rerun.guard.confirmed, true);
  assert.equal(confirmed.result.guarded, undefined);
  const [first, applied] = confirmed.result.executions;
  assert.equal(first.state, 'confirmed');
  assert.equal(first.code, undefined);
  assert.equal(applied.state, 'applied');
  assert.equal(applied.confirms, held.executionId);
  assert.equal(applied.changes.removed.length, 60);
  // Only a request waiting on a card can be confirmed.
  await assert.rejects(execution.confirm(project.id, 'guard-1'), { code: 'REVISION_CONFLICT' });
});

test('Plan: read tools only, a plan card, and [진행] starts an Auto turn with the plan', async (t) => {
  const answers = [];
  let turn = 0;
  const { execution, seen, send, settled, state, project } = setup(t, async ({ call, agent }) => {
    turn++;
    if (turn === 1) {
      answers.push(await call('execute', { code: 'add wall' }));
      answers.push(await call('query'));
      return {
        text:
          '기둥 사이에 벽을 넣겠습니다.\n```json\n' +
          JSON.stringify({
            plan: {
              steps: [
                { title: '벽 레이어 확인', objects: ['n-1'] },
                { title: '벽 2개 추가', risk: '기존 창호와 겹칠 수 있음' },
              ],
              questions: ['벽 두께는 200mm로 할까요?'],
            },
          }) +
          '\n```',
      };
    }
    assert.ok(agent.tools.includes('execute'));
    return { text: '계획대로 추가했습니다.' };
  });
  // The old permission value still works: review is Plan.
  send('plan-1', { permission: 'review' });
  await settled();
  const planned = state('plan-1');
  assert.equal(planned.state, 'succeeded');
  // The stored input keeps what was submitted; the mode is derived from it.
  assert.equal(planned.input.mode, undefined);
  assert.equal(requestMode(planned.input), 'plan');
  assert.ok(!seen[0].agent.tools.includes('execute'));
  assert.ok(seen[0].agent.tools.includes('query'));
  assert.match(seen[0].context.goal, /Plan mode/);
  assert.equal(answers[0].value.code, 'AGENT_TOOL_UNAVAILABLE');
  assert.equal(planned.result.mode, 'plan');
  assert.equal(planned.result.plan.steps.length, 2);
  assert.equal(planned.result.plan.questions[0], '벽 두께는 200mm로 할까요?');
  assert.equal(planned.result.text, '기둥 사이에 벽을 넣겠습니다.');
  assert.equal(planned.result.executions.length, 0);

  const next = execution.continuePlan(project.id, 'plan-1');
  assert.equal(next.id, 'plan-1-go');
  assert.equal(next.input.mode, 'auto');
  assert.equal(next.input.continuesPlanId, 'plan-1');
  assert.equal(next.input.baseRequestId, 'sync-1');
  assert.match(
    next.input.body,
    /\[계획\]\n1\. 벽 레이어 확인 \(대상: n-1\)\n2\. 벽 2개 추가 · 위험:/,
  );
  // Idempotent: the same [진행] does not start a second turn.
  assert.equal(execution.continuePlan(project.id, 'plan-1').id, 'plan-1-go');
  await settled();
  assert.equal(state('plan-1-go').state, 'succeeded');
  assert.equal(seen.length, 2);
  // Only a finished Plan turn continues.
  assert.throws(() => execution.continuePlan(project.id, 'plan-1-go'), {
    code: 'REVISION_CONFLICT',
  });
});

test('ZWCAD: its own direct loop result settles by mode; a guard without a kept body re-runs the turn', async (t) => {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('zw');
  const runs = [];
  const execution = new Execution(workspace, {
    zwcadSdk: {
      run: async (task) => {
        runs.push(task.input);
        if (task.input.guardConfirmed !== true)
          return {
            text: '확인 필요',
            host: 'zwcad',
            executions: [],
            guarded: { kind: 'layer-delete', detail: '레이어 1개를 지웁니다: 옛 도면' },
          };
        return {
          text: '지웠습니다.',
          host: 'zwcad',
          executions: [{ executionId: '5', undoId: '5', label: 'VIDE AI 1회차', changes: {} }],
        };
      },
    },
  });
  t.after(async () => {
    await execution.close();
    store.close();
  });
  const base = {
    body: '옛 레이어 삭제',
    provider: 'claude-cli',
    pins: [],
    sketches: [],
    files: [],
  };
  workspace.submit(project.id, { ...base, id: 'zw-sync', mode: 'plan', host: 'zwcad' });
  workspace.update(project.id, 'zw-sync', 'succeeded', {
    host: 'zwcad',
    hostExecuted: true,
    displayOnly: true,
    objects: [],
    scene: [],
    sourceDocument: { ...sourceDocument, host: 'zwcad' },
  });
  execution.start(
    workspace.submit(project.id, {
      ...base,
      id: 'zw-1',
      host: 'zwcad',
      baseRequestId: 'zw-sync',
      permission: 'candidate',
    }).request,
  );
  const settled = async () => {
    while (execution.active.size)
      await Promise.all([...execution.active.values()].map((entry) => entry.completion));
  };
  await settled();
  assert.equal(workspace.get(project.id, 'zw-1').state, 'needs-confirmation');
  assert.equal(runs[0].mode, 'auto');
  await execution.confirm(project.id, 'zw-1');
  await settled();
  const done = workspace.get(project.id, 'zw-1');
  assert.equal(done.state, 'succeeded');
  assert.equal(runs[1].guardConfirmed, true);
  assert.equal(done.result.executions[0].undoId, '5');
});

test('executions go in the conversation ledger as code items (counts only)', async (t) => {
  const { conversations, send, settled, state, project } = setup(
    t,
    async ({ call }) => {
      await call('execute', { code: 'add wall' });
      return { text: '추가했습니다.' };
    },
    { conversations: true },
  );
  const conversation = conversations.create(project.id, {
    kind: 'ask',
    title: '벽',
    provider: 'claude-cli',
  });
  send('conv-1', { conversationId: conversation.id });
  await settled();
  assert.equal(state('conv-1').state, 'succeeded');
  const ledger = conversations.get(project.id, conversation.id).ledger;
  const item = ledger.find((entry) => entry.kind === 'code');
  assert.ok(item, 'an execution item');
  assert.equal(item.requestId, 'conv-1');
  assert.equal(item.body.execution.undoId, '11');
  assert.deepEqual(item.body.execution.changes, { added: 1, changed: 0, removed: 0 });
});

test('takePlan reads structured, top-level and fenced plans and leaves the rest', () => {
  const plan = { steps: [{ title: '확인' }] };
  assert.deepEqual(takePlan({ structured: { status: 'done', text: 't', plan } }).value.structured, {
    status: 'done',
    text: 't',
  });
  assert.equal(takePlan({ plan }).plan.steps[0].title, '확인');
  const whole = takePlan({ text: JSON.stringify({ status: 'done', text: 'x', plan }) });
  assert.equal(whole.plan.steps.length, 1);
  assert.deepEqual(JSON.parse(whole.value.text), { status: 'done', text: 'x' });
  // An invalid plan block stays in the text; no plan.
  const invalid = takePlan({ text: '```json\n{"plan":{"steps":[]}}\n```' });
  assert.equal(invalid.plan, undefined);
  assert.match(invalid.value.text, /steps/);
  assert.match(continueBody('요청', undefined), /^계획대로 진행하세요\.\n\n\[요청\]\n요청$/);
});

test('the default Rhino driver reads pages once per revision and passes undo to the editor connection', async () => {
  const store = new Store(':memory:');
  const calls = [];
  const sdk = {
    runDirect: async (target, code, guard, command) => {
      calls.push(['run', target, code, guard, command.label]);
      return { ok: true, undoId: '3', changes: { added: [], changed: [], removed: [] }, log: '' };
    },
    undoDirect: async (target, undoId) => {
      calls.push(['undo', target, undoId]);
      return { ok: true };
    },
    readLayers: async () => {
      calls.push(['read']);
      return {
        objects: [{ id: 'a' }, { id: 'b' }],
        scene: [],
        sourceDocument: { units: 'Millimeters' },
      };
    },
    directView: async () => ({ captureView: async () => ({}), measure: async () => ({}) }),
  };
  const execution = new Execution(new Workspace(store), { sdk });
  try {
    assert.equal(
      execution.directDriverFor('rhino', { ...sourceDocument, connection: 'owned' }),
      undefined,
    );
    const driver = execution.directDriverFor('rhino', sourceDocument);
    assert.deepEqual(driver.target, { instance: '1234:1', documentId: 7 });
    const first = await driver.query({ limit: 1 });
    assert.equal(first.model.objects.length, 1);
    assert.equal(first.units, 'Millimeters');
    assert.equal(first.page.total, 2);
    await driver.query({ objectIds: ['b'] });
    assert.equal(calls.filter(([kind]) => kind === 'read').length, 1);
    const guard = { confirmed: false, maxDeletes: 500 };
    await driver.execute({ requestId: 'r', code: 'x', label: 'L', guard });
    await driver.query({});
    assert.equal(calls.filter(([kind]) => kind === 'read').length, 2);
    assert.deepEqual(calls.find(([kind]) => kind === 'run').slice(1), [
      driver.target,
      'x',
      guard,
      'L',
    ]);
    await driver.undo('3');
    assert.deepEqual(calls.at(-1), ['undo', driver.target, '3']);
  } finally {
    await execution.close();
    store.close();
  }
});

test('a change the host could not revert makes the turn unknown and stops further executes', async (t) => {
  const answers = [];
  const { host, send, settled, state } = setup(t, async ({ call }) => {
    answers.push(await call('execute', { code: 'stuck' }));
    answers.push(await call('execute', { code: 'add wall' }));
    return { text: '끝' };
  });
  const execute = host.driver.execute;
  host.driver.execute = async (command) =>
    command.code === 'stuck'
      ? (host.calls.execute.push(command),
        { ok: false, code: 'HOST_RESULT_UNKNOWN', reverted: false, log: '' })
      : execute(command);
  send('unknown-1');
  await settled();
  const done = state('unknown-1');
  assert.equal(done.state, 'unknown');
  assert.equal(done.result.code, 'HOST_RESULT_UNKNOWN');
  assert.equal(answers[0].error, true);
  assert.equal(answers[1].error, true);
  assert.deepEqual(
    host.calls.execute.map((command) => command.code),
    ['stuck'],
  );
});

test('records keep the document token; [되돌리기] waits for a running request; guard flags are not request fields', async (t) => {
  const { execution, host, send, settled, state, workspace, project } = setup(
    t,
    async ({ call }) => {
      await call('execute', { code: 'add wall' });
      return { text: '추가' };
    },
  );
  host.driver.fingerprint = async () => ({ documentHash: hash, revision: 12 });
  send('token-1');
  await settled();
  const done = state('token-1');
  const [record] = done.result.executions;
  assert.deepEqual(record.document, { documentHash: hash, revision: 12 });
  workspace.update(project.id, 'token-1', 'running', done.result);
  await assert.rejects(execution.undo(project.id, 'token-1', record.executionId), {
    code: 'REVISION_CONFLICT',
  });
  assert.equal(host.calls.undo.length, 0);
  const base = { body: 'x', provider: 'claude-cli', pins: [], sketches: [], files: [] };
  assert.throws(
    () => workspace.submit(project.id, { ...base, id: 'forged-1', guardConfirmed: true }),
    { code: 'INVALID_INPUT' },
  );
  assert.throws(
    () => workspace.submit(project.id, { ...base, id: 'forged-2', guard: { confirmed: true } }),
    { code: 'INVALID_INPUT' },
  );
});

test('a confirmed re-run the host could not revert leaves the request unknown', async (t) => {
  const { execution, host, send, settled, state, project } = setup(t, async ({ call }) => {
    await call('execute', { code: 'wipe old layer' });
    return { text: '확인 필요' };
  });
  send('guard-2');
  await settled();
  const [held] = state('guard-2').result.executions;
  host.driver.execute = async () => ({
    ok: false,
    code: 'HOST_RESULT_UNKNOWN',
    reverted: false,
    log: '',
  });
  const after = await execution.confirm(project.id, 'guard-2', held.executionId);
  assert.equal(after.state, 'unknown');
  assert.equal(after.result.code, 'HOST_RESULT_UNKNOWN');
});

// User decision 2026-10-01: a refusal before execution (e.g. a read-only document) is "실행하지
// 않음" with its reason, not an unknown result. Only a lost answer stays unknown.
const thrown = (code) => Object.assign(new Error(code), { code });

test('a read-only document is not run: reason recorded, later executes answered without the host', async (t) => {
  const answers = [];
  const { host, send, settled, state } = setup(t, async ({ call }) => {
    answers.push(await call('execute', { code: 'add wall' }));
    answers.push(await call('execute', { code: 'add wall again' }));
    return { text: '읽기 전용 문서라 실행하지 않았습니다.' };
  });
  host.driver.execute = async (command) => {
    host.calls.execute.push(command);
    throw thrown('DOCUMENT_READ_ONLY');
  };
  send('readonly-1');
  await settled();
  const done = state('readonly-1');
  assert.equal(done.state, 'succeeded');
  assert.equal(done.result.code, undefined);
  assert.equal(done.result.appliedDirectly, false);
  assert.deepEqual(done.result.executions, []);
  assert.equal(done.result.refused.code, 'DOCUMENT_READ_ONLY');
  assert.match(done.result.refused.reason, /읽기 전용으로 열린 문서라 실행하지 않았습니다/);
  assert.match(done.result.refused.reason, /다른 이름으로 저장/);
  // The AI gets a plain answer: nothing ran, and no execute can work in this turn.
  for (const answer of answers) {
    assert.equal(answer.error, false);
    assert.equal(answer.value.executed, false);
    assert.equal(answer.value.code, 'DOCUMENT_READ_ONLY');
    assert.match(answer.value.next, /No execute can succeed/);
  }
  assert.equal(host.calls.execute.length, 1);
  const lines = done.result.activity.filter((entry) => entry.text.startsWith('실행하지 않음 · '));
  assert.equal(lines.length, 1);
});

test('a passing refusal (host busy) lets the next execute run and is not reported at the end', async (t) => {
  const answers = [];
  const { host, send, settled, state } = setup(t, async ({ call }) => {
    answers.push(await call('execute', { code: 'add wall' }));
    answers.push(await call('execute', { code: 'add wall' }));
    return { text: '추가' };
  });
  const execute = host.driver.execute;
  let busy = true;
  host.driver.execute = async (command) => {
    if (!busy) return execute(command);
    busy = false;
    host.calls.execute.push(command);
    throw thrown('HOST_BUSY');
  };
  send('busy-1');
  await settled();
  const done = state('busy-1');
  assert.equal(answers[0].value.executed, false);
  assert.match(answers[0].value.next, /Retry once/);
  assert.equal(answers[1].value.ok, true);
  assert.equal(done.state, 'succeeded');
  assert.equal(done.result.refused, undefined);
  assert.equal(done.result.executions.length, 1);
});

test('a lost execute answer still leaves the turn unknown', async (t) => {
  const answers = [];
  const { host, send, settled, state } = setup(t, async ({ call }) => {
    answers.push(await call('execute', { code: 'add wall' }));
    answers.push(await call('execute', { code: 'add wall' }));
    return { text: '끝' };
  });
  host.driver.execute = async (command) => {
    host.calls.execute.push(command);
    throw thrown('HOST_RESULT_UNKNOWN');
  };
  send('lost-1');
  await settled();
  const done = state('lost-1');
  assert.equal(done.state, 'unknown');
  assert.equal(done.result.code, 'HOST_RESULT_UNKNOWN');
  assert.equal(done.result.refused, undefined);
  assert.equal(answers[0].error, true);
  assert.equal(host.calls.execute.length, 1);
});

test('after a lost execute answer the turn still reads the document; only execute answers HOST_RESULT_UNKNOWN (ADR-031 8)', async (t) => {
  const answers = [];
  const { host, send, settled, state } = setup(t, async ({ call }) => {
    answers.push(await call('execute', { code: 'add wall' }));
    answers.push(await call('query', {}));
    answers.push(await call('execute', { code: 'add door' }));
    return { text: '끝' };
  });
  host.driver.execute = async (command) => {
    host.calls.execute.push(command);
    throw thrown('HOST_RESULT_UNKNOWN');
  };
  send('lost-read');
  await settled();
  assert.equal(state('lost-read').state, 'unknown');
  assert.equal(answers[1].error, false, JSON.stringify(answers[1].value));
  assert.equal(answers[2].error, true);
  assert.equal(answers[2].value.code, 'HOST_RESULT_UNKNOWN');
  assert.match(answers[2].value.next, /You may still read it/);
  assert.equal(host.calls.execute.length, 1);
});

test('a refused confirmed re-run keeps the guard card with the reason', async (t) => {
  const { execution, host, send, settled, state, project } = setup(t, async ({ call }) => {
    await call('execute', { code: 'wipe old layer' });
    return { text: '확인 필요' };
  });
  send('guard-3');
  await settled();
  const [held] = state('guard-3').result.executions;
  const execute = host.driver.execute;
  host.driver.execute = async () => {
    throw thrown('DOCUMENT_READ_ONLY');
  };
  const after = await execution.confirm(project.id, 'guard-3', held.executionId);
  assert.equal(after.state, 'needs-confirmation');
  assert.equal(after.result.refused.code, 'DOCUMENT_READ_ONLY');
  host.driver.execute = execute;
  const again = await execution.confirm(project.id, 'guard-3', held.executionId);
  assert.equal(again.state, 'succeeded');
  assert.equal(again.result.refused, undefined);
});

// ADR-029 (T-106): Rhino command macros and Python 3 scripts beside the C# body.
test('Auto: a Rhino command and a Python script run as their own undo records with their form', async (t) => {
  const answers = [];
  const { host, send, settled, state } = setup(t, async ({ call }) => {
    answers.push(await call('execute', { command: '_-SelDup _Enter' }));
    answers.push(
      await call('execute', { python: 'import rhinoscriptsyntax as rs\nrs.AddPoint((0,0,0))' }),
    );
    answers.push(await call('execute', { code: 'add wall', command: '_SelAll' }));
    answers.push(await call('execute', {}));
    return { text: '끝' };
  });
  send('forms-1');
  await settled();
  assert.equal(state('forms-1').state, 'succeeded');
  assert.deepEqual(
    host.calls.execute.map((c) => [c.language, c.code]),
    [
      ['command', '_-SelDup _Enter'],
      ['python', 'import rhinoscriptsyntax as rs\nrs.AddPoint((0,0,0))'],
    ],
  );
  assert.equal(answers[0].value.ok, true);
  assert.equal(answers[0].value.undoId, '11');
  assert.equal(answers[1].value.undoId, '12');
  // Two forms, or none, never reach the host.
  assert.equal(answers[2].value.code, 'EXECUTE_FORM_INVALID');
  assert.equal(answers[3].value.code, 'EXECUTE_FORM_INVALID');
  assert.deepEqual(
    state('forms-1').result.executions.map((r) => [r.state, r.undoId]),
    [
      ['applied', '11'],
      ['applied', '12'],
    ],
  );
});

test('a refused command or Python never reaches the host; the AI gets the diagnostics', async (t) => {
  const answers = [];
  const { host, send, settled, state } = setup(t, async ({ call }) => {
    answers.push(await call('execute', { command: '_-Open "C:\\x.3dm"' }));
    answers.push(await call('execute', { command: '_SelAll _-RunPythonScript (print 1)' }));
    answers.push(await call('execute', { python: 'import os\nos.remove("a")' }));
    answers.push(await call('execute', { python: 'f = open("a.txt")' }));
    return { text: '허용되지 않음' };
  });
  send('deny-1');
  await settled();
  assert.equal(host.calls.execute.length, 0);
  for (const answer of answers) {
    assert.equal(answer.value.ok, false);
    assert.equal(answer.value.executed, false);
    assert.equal(answer.value.code, 'CODE_POLICY_REJECTED');
  }
  assert.match(answers[0].value.diagnostics[0], /_open/);
  assert.match(answers[1].value.diagnostics[0], /_runpythonscript/);
  assert.match(answers[2].value.diagnostics[0], /import os/);
  const done = state('deny-1');
  assert.equal(done.state, 'succeeded');
  assert.equal(done.result.executions.length, 0);
});

test('a command that writes a file waits on the card before it runs; [진행] runs it with its form', async (t) => {
  const answers = [];
  const { execution, host, send, settled, state, project } = setup(t, async ({ call }) => {
    answers.push(await call('execute', { command: '_-Export "C:\\out.dwg" _Enter' }));
    return { text: '내보내기는 확인이 필요합니다.' };
  });
  send('cmd-guard');
  await settled();
  const waiting = state('cmd-guard');
  assert.equal(waiting.state, 'needs-confirmation');
  assert.equal(host.calls.execute.length, 0);
  assert.equal(answers[0].value.guarded.kind, 'export');
  const [held] = waiting.result.executions;
  assert.equal(held.state, 'guarded');
  assert.equal(held.language, 'command');

  const confirmed = await execution.confirm(project.id, 'cmd-guard', held.executionId);
  assert.equal(confirmed.state, 'succeeded');
  const rerun = host.calls.execute.at(-1);
  assert.equal(rerun.language, 'command');
  assert.equal(rerun.code, '_-Export "C:\\out.dwg" _Enter');
  assert.equal(rerun.guard.confirmed, true);
});

test('Python that purges waits on the card like the C# purge', async (t) => {
  const answers = [];
  const { host, send, settled, state } = setup(t, async ({ call }) => {
    answers.push(
      await call('execute', {
        python: 'import scriptcontext as sc\nsc.doc.Layers.Purge(3, True)',
      }),
    );
    return { text: '확인 필요' };
  });
  send('py-purge');
  await settled();
  assert.equal(host.calls.execute.length, 0);
  assert.equal(answers[0].value.guarded.kind, 'purge');
  assert.equal(state('py-purge').state, 'needs-confirmation');
});

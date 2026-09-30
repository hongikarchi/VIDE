import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { ClaudeCli } from '../../src/ai/claude-cli.ts';
import { CodexCli } from '../../src/ai/codex-cli.ts';
import {
  ConversationService,
  conversationRoutes,
  ledgerItem,
  kindOf,
  SESSION_MAX_TURNS,
} from '../../src/server/conversations.ts';
import { startServer } from '../../src/server/server.ts';

// Conversation threads and session execution (PLAN-24 T-061, SPEC-02.19, ADR-021): the CLI is a
// fake transport that records every spawn, so each turn's arguments and packet are asserted.

const init = { type: 'system', subtype: 'init', tools: [], mcp_servers: [] };
const answer = (text, usage = { input_tokens: 10, output_tokens: 3 }) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  usage,
});
const codexTurn = (text) => [
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text } },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
];
const ISOLATION = [
  '-p',
  '--safe-mode',
  '--strict-mcp-config',
  '--setting-sources',
  '--no-chrome',
  '--disable-slash-commands',
  '--permission-mode',
];

/** A fake CLI: `script(call)` gives the events (and optional stderr/exit) of each run, in order. */
function transport(script) {
  const calls = [];
  let runs = 0;
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.unref = () => {};
    const call = { executable, args, options, input: '' };
    calls.push(call);
    child.stdin.on('data', (data) => {
      call.input += data;
    });
    const close = (code = 0) => {
      child.exitCode = code;
      child.emit('exit', code);
      child.emit('close', code);
    };
    if (args[0] === '--version')
      queueMicrotask(() => {
        child.stdout.write(
          (/codex/i.test(executable) ? 'codex-cli 0.157.1' : '2.1.284 (Claude Code)') + '\n',
        );
        close();
      });
    else if (args[0] === 'auth')
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
        close();
      });
    else if (args[0] === 'login')
      queueMicrotask(() => {
        child.stderr.write('Logged in using ChatGPT\n');
        close();
      });
    else
      child.stdin.on('finish', () => {
        const step = script(runs++, call);
        for (const event of step.events ?? step) child.stdout.write(JSON.stringify(event) + '\n');
        if (step.stderr) child.stderr.write(step.stderr);
        setTimeout(() => close(step.exit ?? 0), 5);
      });
    return child;
  };
  const runs_ = () => calls.filter((call) => ['-p', 'exec'].includes(call.args[0]));
  const packet = (call) => JSON.parse(call.input);
  return { spawnProcess, calls, runs: runs_, packet };
}

function setup(t, script, { codex = false } = {}) {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('conversations');
  const removed = [];
  const conversations = new ConversationService(store, {
    removeTranscript: async (provider, directory, sessionId) => {
      removed.push({ provider, directory, sessionId });
      return 1;
    },
  });
  const fake = transport(script);
  const execution = new Execution(workspace, {
    conversations,
    providerFactory: ({ provider, ...options }) =>
      provider === 'codex-cli'
        ? new CodexCli({ ...options, spawnProcess: fake.spawnProcess })
        : new ClaudeCli({ ...options, spawnProcess: fake.spawnProcess }),
  });
  t.after(async () => {
    await execution.close();
    store.close();
  });
  const open = (fields = {}) =>
    conversations.create(project.id, {
      kind: 'ask',
      title: '법규 질문',
      provider: codex ? 'codex-cli' : 'claude-cli',
      accountProfileId: 'default',
      ...fields,
    });
  const send = (id, fields = {}) => {
    const request = workspace.submit(project.id, {
      id,
      body: id,
      provider: codex ? 'codex-cli' : 'claude-cli',
      permission: 'review',
      pins: [],
      sketches: [],
      files: [],
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
  return {
    store,
    workspace,
    project,
    conversations,
    execution,
    fake,
    removed,
    open,
    send,
    settled,
    state,
  };
}

test('a three-turn Claude conversation resumes one session and re-asserts isolation every turn', async (t) => {
  const { conversations, fake, open, send, settled, state } = setup(t, (turn) => [
    init,
    answer(`답 ${turn + 1}`, {
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: turn * 100,
    }),
  ]);
  const conversation = open();
  assert.equal(conversation.mode, 'session');
  for (const id of ['turn-1', 'turn-2', 'turn-3']) {
    send(id, { conversationId: conversation.id });
    await settled();
    assert.equal(state(id).state, 'succeeded', id);
  }
  const runs = fake.runs();
  assert.equal(runs.length, 3);
  const sessionId = runs[0].args[runs[0].args.indexOf('--session-id') + 1];
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  runs.forEach((call, index) => {
    // The same isolation arguments every turn; only the session flag changes.
    for (const flag of ISOLATION)
      assert.ok(call.args.includes(flag), `${flag} on turn ${index + 1}`);
    assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
    assert.equal(call.args[call.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    assert.ok(!call.args.includes('--no-session-persistence'));
    assert.equal(call.args[call.args.indexOf('--system-prompt-snapshot') + 1], 'off');
    assert.ok(!call.args.includes('--session-id') || index === 0);
    if (index > 0) assert.equal(call.args[call.args.indexOf('--resume') + 1], sessionId);
    // The neutral prompt names no tools; this turn's rules travel in the packet.
    const prompt = call.args[call.args.indexOf('--system-prompt') + 1];
    assert.ok(!/Do not use tools/.test(prompt));
    const packet = fake.packet(call);
    const rules = packet.items.find((item) => item.id === 'turn-rules');
    assert.match(rules.data, /No tools are available in this turn/);
    // The session remembers earlier turns: no re-sent exchanges, only the ledger.
    assert.equal(
      packet.items.find((item) => item.id === 'conversation'),
      undefined,
    );
  });
  // The whole ledger opens the session; a resumed turn gets what was recorded since the last one.
  const scopes = runs.map(
    (call) => fake.packet(call).items.find((item) => item.id === 'ledger').data,
  );
  assert.deepEqual(
    scopes.map((data) => [data.scope, data.items.map((item) => [item.kind, item.requestId])]),
    [
      ['all', []],
      ['since-last-turn', [['result-ref', 'turn-1']]],
      ['since-last-turn', [['result-ref', 'turn-2']]],
    ],
  );
  const saved = conversations.get(conversation.projectId, conversation.id);
  assert.equal(saved.session.turns, 3);
  assert.equal(saved.session.inputTokens, 30 + 100 + 200);
  assert.deepEqual(
    saved.ledger.map((item) => item.kind),
    ['result-ref', 'result-ref', 'result-ref'],
  );
  assert.equal(saved.requests, 3);
});

test('a turn whose start event lists a tool stops, and the session is still resumed afterwards', async (t) => {
  const { fake, open, send, settled, state, conversations } = setup(t, (turn) =>
    turn === 1 ? [{ ...init, tools: ['Bash'] }, answer('x')] : [init, answer('ok')],
  );
  const conversation = open();
  send('t1', { conversationId: conversation.id });
  await settled();
  send('t2', { conversationId: conversation.id });
  await settled();
  assert.equal(state('t2').state, 'failed');
  assert.equal(state('t2').result.code, 'UNEXPECTED_TOOL_ACCESS');
  send('t3', { conversationId: conversation.id });
  await settled();
  assert.equal(state('t3').state, 'succeeded');
  const runs = fake.runs();
  assert.equal(
    runs[2].args[runs[2].args.indexOf('--resume') + 1],
    runs[0].args[runs[0].args.indexOf('--session-id') + 1],
  );
  // The failed turn is not in the ledger and not counted on the session.
  const saved = conversations.get(conversation.projectId, conversation.id);
  assert.equal(saved.session.turns, 2);
  assert.deepEqual(
    saved.ledger.map((item) => item.requestId),
    ['t1', 't3'],
  );
});

test('an opening turn that fails is not resumed: the next turn opens a fresh session ID', async (t) => {
  const { fake, open, send, settled, state, conversations } = setup(t, (turn) =>
    turn === 0 ? [{ ...init, tools: ['Bash'] }, answer('x')] : [init, answer('ok')],
  );
  const conversation = open();
  send('f1', { conversationId: conversation.id });
  await settled();
  assert.equal(state('f1').state, 'failed');
  send('f2', { conversationId: conversation.id });
  await settled();
  assert.equal(state('f2').state, 'succeeded');
  const runs = fake.runs();
  const first = runs[0].args[runs[0].args.indexOf('--session-id') + 1];
  const second = runs[1].args[runs[1].args.indexOf('--session-id') + 1];
  assert.ok(second && second !== first);
  assert.ok(!runs[1].args.includes('--resume'));
  assert.deepEqual(
    conversations.get(conversation.projectId, conversation.id).sessions.map((s) => s.state),
    ['lost', 'active'],
  );
});

test('requests without a conversation belong to the default conversation and keep listing', async (t) => {
  const { conversations, project, fake, open, send, settled, state, workspace } = setup(t, () => [
    init,
    answer('답'),
  ]);
  const conversation = open();
  send('plain-1');
  await settled();
  send('own-1', { conversationId: conversation.id });
  await settled();
  send('plain-2');
  await settled();
  assert.deepEqual(
    ['plain-1', 'own-1', 'plain-2'].map((id) => state(id).state),
    ['succeeded', 'succeeded', 'succeeded'],
  );
  const list = conversations.list(project.id);
  assert.equal(list[0].id, null);
  assert.equal(list[0].requests, 2);
  assert.equal(list[1].id, conversation.id);
  assert.equal(list[1].requests, 1);
  assert.equal(workspace.list(project.id).length, 3);
  // The default conversation runs as before: no session flag, earlier exchanges of its own only.
  const plain = fake.runs()[2];
  assert.ok(plain.args.includes('--no-session-persistence'));
  assert.ok(!plain.args.includes('--resume'));
  const packet = fake.packet(plain);
  assert.deepEqual(
    packet.items.find((item) => item.id === 'conversation').data.map((entry) => entry.request),
    ['plain-1'],
  );
  assert.equal(
    packet.items.find((item) => item.id === 'turn-rules'),
    undefined,
  );
  assert.equal(conversations.get(project.id, null).session, null);
});

test('an account switch opens a new session with the hand-over packet', async (t) => {
  const { conversations, project, fake, open, send, settled, state } = setup(t, (turn) => [
    init,
    answer(`답 ${turn + 1}`),
  ]);
  const conversation = open();
  send('a1', { conversationId: conversation.id });
  await settled();
  conversations.addLedger(project.id, conversation.id, {
    kind: 'decision',
    body: { text: '층고 4.2 m로 본다' },
  });
  // The next turn arrives on another account (automatic switch after a limit, SPEC-02.19 5).
  send('a2', {
    conversationId: conversation.id,
    accountProfileId: '11111111-2222-4333-8444-555555555555',
  });
  await settled();
  assert.equal(state('a2').state, 'succeeded');
  const runs = fake.runs();
  const first = runs[0].args[runs[0].args.indexOf('--session-id') + 1];
  const second = runs[1].args[runs[1].args.indexOf('--session-id') + 1];
  assert.ok(second && second !== first);
  assert.ok(!runs[1].args.includes('--resume'));
  const packet = fake.packet(runs[1]);
  const handoff = packet.items.find((item) => item.id === 'handoff');
  assert.equal(handoff.data.reason, 'account');
  assert.deepEqual(handoff.data.recentTurns, [{ request: 'a1', response: '답 1' }]);
  const ledger = packet.items.find((item) => item.id === 'ledger');
  assert.deepEqual(
    ledger.data.items.map((item) => item.kind),
    ['result-ref', 'decision'],
  );
  const saved = conversations.get(project.id, conversation.id);
  assert.deepEqual(
    saved.sessions.map((session) => [session.accountProfileId, session.state, session.turns]),
    [
      ['default', 'handed-off', 1],
      ['11111111-2222-4333-8444-555555555555', 'active', 1],
    ],
  );
  assert.equal(saved.accountProfileId, '11111111-2222-4333-8444-555555555555');
  assert.deepEqual(
    saved.ledger.map((item) => item.kind),
    ['result-ref', 'decision', 'handoff', 'result-ref'],
  );
});

test('a lost session is retried once in a new session; the old one is never resumed', async (t) => {
  const { conversations, project, fake, open, send, settled, state } = setup(t, (turn, call) =>
    turn === 1 && call.args.includes('--resume')
      ? { events: [], stderr: 'No conversation found with session ID: x\n', exit: 1 }
      : [init, answer('ok')],
  );
  const conversation = open();
  send('l1', { conversationId: conversation.id });
  await settled();
  send('l2', { conversationId: conversation.id });
  await settled();
  assert.equal(state('l2').state, 'succeeded');
  const runs = fake.runs();
  assert.equal(runs.length, 3);
  assert.ok(runs[1].args.includes('--resume'));
  assert.ok(runs[2].args.includes('--session-id'));
  assert.equal(
    fake.packet(runs[2]).items.find((item) => item.id === 'handoff').data.reason,
    'lost',
  );
  const saved = conversations.get(project.id, conversation.id);
  assert.deepEqual(
    saved.sessions.map((session) => session.state),
    ['lost', 'active'],
  );
});

test('a Codex conversation runs the ledger method: fresh runs with the ledger and earlier exchanges', async (t) => {
  const { conversations, project, fake, open, send, settled, state } = setup(
    t,
    (turn) => codexTurn(`답 ${turn + 1}`),
    { codex: true },
  );
  const conversation = open();
  assert.equal(conversation.mode, 'ledger');
  send('c1', { conversationId: conversation.id });
  await settled();
  send('c2', { conversationId: conversation.id });
  await settled();
  assert.equal(state('c2').state, 'succeeded');
  const runs = fake.runs();
  for (const call of runs) {
    assert.equal(call.args[0], 'exec');
    assert.notEqual(call.args[1], 'resume');
    assert.ok(call.args.includes('--ephemeral'));
    assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
  }
  const packet = fake.packet(runs[1]);
  assert.equal(
    packet.items.find((item) => item.id === 'turn-rules'),
    undefined,
  );
  assert.deepEqual(packet.items.find((item) => item.id === 'conversation').data, [
    { request: 'c1', response: '답 1' },
  ]);
  assert.equal(packet.items.find((item) => item.id === 'ledger').data.items.length, 1);
  const saved = conversations.get(project.id, conversation.id);
  assert.equal(saved.session, null);
  assert.deepEqual(
    saved.ledger.map((item) => item.requestId),
    ['c1', 'c2'],
  );
});

test('one running turn per conversation: a later message waits in that line and can be withdrawn', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { conversations, project, execution, open, send, settled, state } = setup(t, () => [
    init,
    answer('ok'),
  ]);
  const conversation = open();
  const other = open({ title: '다른 대화' });
  const held = execution.conversations.beginTurn;
  execution.conversations.beginTurn = async (...args) => {
    execution.conversations.beginTurn = held;
    await gate;
    return held.apply(conversations, args);
  };
  send('q1', { conversationId: conversation.id });
  const second = send('q2', { conversationId: conversation.id });
  const third = send('q3', { conversationId: conversation.id });
  const elsewhere = send('o1', { conversationId: other.id });
  assert.equal(second.state, 'queued');
  assert.deepEqual(state('q2').result.waitingFor, {
    kind: 'conversation',
    key: conversation.id,
    after: 'q1',
    position: 1,
  });
  assert.equal(state('q3').result.waitingFor.position, 2);
  assert.equal(state('q3').result.waitingFor.after, 'q2');
  assert.equal(elsewhere.state, 'queued');
  assert.equal(state('o1').state, 'running');
  // Withdrawing a waiting message moves the one behind it up.
  execution.cancel(project.id, 'q2');
  assert.equal(state('q2').state, 'cancelled');
  assert.equal(state('q3').result.waitingFor.position, 1);
  assert.equal(state('q3').result.waitingFor.after, 'q1');
  release();
  await settled();
  assert.deepEqual(
    ['q1', 'q3', 'o1'].map((id) => state(id).state),
    ['succeeded', 'succeeded', 'succeeded'],
  );
  const runs = execution.workspace.list(project.id).map((row) => row.id);
  assert.deepEqual(runs, ['q1', 'q2', 'q3', 'o1']);
});

test('a session past its turn limit reopens from the ledger; closed conversations refuse turns', async (t) => {
  const { conversations, project, fake, open, send, settled, state } = setup(t, () => [
    init,
    answer('ok'),
  ]);
  const conversation = open();
  send('m1', { conversationId: conversation.id });
  await settled();
  const [session] = conversations.get(project.id, conversation.id).sessions;
  const key = {
    conversationId: conversation.id,
    provider: 'claude-cli',
    accountProfileId: 'default',
    sessionId: session.sessionId,
  };
  for (let turn = 1; turn < SESSION_MAX_TURNS; turn++) conversations.store.recordTurn(key, 100);
  send('m2', { conversationId: conversation.id });
  await settled();
  assert.equal(state('m2').state, 'succeeded');
  const runs = fake.runs();
  assert.ok(runs[1].args.includes('--session-id'));
  assert.equal(
    fake.packet(runs[1]).items.find((item) => item.id === 'handoff').data.reason,
    'length',
  );
  await conversations.close(project.id, conversation.id);
  assert.throws(() => conversations.fix(project.id, { conversationId: conversation.id }), {
    code: 'CONVERSATION_CLOSED',
  });
  send('m3', { conversationId: conversation.id });
  await settled();
  assert.equal(state('m3').state, 'failed');
  assert.equal(state('m3').result.code, 'CONVERSATION_CLOSED');
});

test('transcripts go on discard at once and 30 days after closing; other sessions are untouched', async (t) => {
  const { store, conversations, project, removed, open, send, settled } = setup(t, () => [
    init,
    answer('ok'),
  ]);
  const kept = open({ title: '남는 대화' });
  const discarded = open({ title: '버린 초안', kind: 'jig-make' });
  const old = open({ title: '오래된 대화' });
  for (const [id, conversation] of [
    ['k1', kept],
    ['d1', discarded],
    ['o1', old],
  ]) {
    send(id, { conversationId: conversation.id });
    await settled();
  }
  await conversations.close(project.id, discarded.id, { discard: true });
  assert.deepEqual(
    removed.map((entry) => entry.provider),
    ['claude-cli'],
  );
  assert.equal(
    removed[0].sessionId,
    conversations.get(project.id, discarded.id).sessions[0].sessionId,
  );
  assert.equal(conversations.get(project.id, discarded.id).sessions[0].state, 'closed');
  await conversations.close(project.id, old.id);
  await conversations.close(project.id, kept.id);
  assert.equal(await conversations.sweep(new Date()), 0);
  // Only what closed more than 30 days ago is swept.
  const closedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
  removed.length = 0;
  store.db.prepare('UPDATE conversations SET closedAt=? WHERE id=?').run(closedAt, old.id);
  assert.equal(await conversations.sweep(new Date()), 1);
  assert.deepEqual(
    removed.map((entry) => entry.sessionId),
    [conversations.get(project.id, old.id).sessions[0].sessionId],
  );
  assert.equal(conversations.get(project.id, kept.id).sessions[0].state, 'active');
  // A reopened conversation whose transcript is gone starts a new session from the ledger.
  conversations.reopen(project.id, old.id);
  assert.equal(conversations.get(project.id, old.id).session, null);
});

test('after a restart the session of a cut-off turn is not resumed', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const project = store.createProject('restart');
  let conversations = new ConversationService(store);
  const conversation = conversations.create(project.id, {
    kind: 'ask',
    title: 'x',
    provider: 'claude-cli',
    accountProfileId: 'default',
  });
  const key = {
    conversationId: conversation.id,
    provider: 'claude-cli',
    accountProfileId: 'default',
    sessionId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
  };
  conversations.store.addSession({ ...key, promptMode: 'neutral', cliVersion: '2.1.284' });
  conversations.store.recordTurn(key, 100);
  const input = (id) => ({
    id,
    body: id,
    provider: 'claude-cli',
    permission: 'review',
    pins: [],
    sketches: [],
    files: [],
    conversationId: conversation.id,
  });
  workspace.submit(project.id, input('r1'));
  workspace.update(project.id, 'r1', 'running', { phase: 'model' });
  // The engine restarts: running requests are interrupted, and the session must not be resumed.
  new Workspace(store);
  conversations = new ConversationService(store);
  assert.equal(conversations.get(project.id, conversation.id).session, null);
  assert.equal(conversations.store.sessions(conversation.id)[0].state, 'lost');
});

test('the ledger item stays under 8 KB by summarizing, then leaving out, the oldest entries', () => {
  const items = Array.from({ length: 40 }, (_, index) => ({
    id: `i${index}`,
    conversationId: 'c',
    kind: 'decision',
    body: { text: 'x'.repeat(400), index },
    requestId: null,
    createdAt: `t${index}`,
    supersededBy: null,
  }));
  const item = ledgerItem(items, 'all');
  assert.ok(Buffer.byteLength(JSON.stringify(item.data.items)) <= 8 * 1024);
  assert.ok(item.data.summarized > 0 && item.data.omitted > 0);
  assert.equal(item.data.items.at(-1).id, 'i39');
  assert.equal(typeof item.data.items[0].body, 'string');
  // Slightly over the limit: only the oldest few are summarized, the newest stay whole.
  const middle = ledgerItem(
    items
      .slice(0, 20)
      .map((entry) => ({ ...entry, body: { text: 'y'.repeat(360), index: entry.body.index } })),
    'all',
  );
  assert.ok(middle.data.summarized > 0 && middle.data.summarized < 20);
  assert.equal(middle.data.omitted, 0);
  assert.equal(middle.data.items.at(-1).body.index, 19);
  const small = ledgerItem(items.slice(0, 3), 'since-last-turn');
  assert.equal(small.data.summarized, 0);
  assert.equal(small.data.omitted, 0);
  assert.equal(kindOf('lookup'), 'ask');
  assert.equal(kindOf('complex', 'zwcad'), 'cad-edit');
  assert.equal(kindOf('simple_edit', undefined), 'model-edit');
  assert.equal(kindOf(undefined, undefined), 'general');
});

test('HTTP: conversations open with a fixed service and model, and requests join them', async () => {
  const runs = [];
  const app = await startServer({
    filename: ':memory:',
    host: { status: async () => ({ available: true }) },
    providerFactory: (options) => ({
      run: async (context) => {
        runs.push({ options, context });
        return {
          text: JSON.stringify({ message: '답변', operations: [] }),
          usage: { inputTokens: 10, outputTokens: 2 },
        };
      },
    }),
  });
  try {
    const login = await fetch(app.origin + '/api/v1/session', {
      method: 'POST',
      headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
    });
    const headers = {
      Origin: app.origin,
      'Content-Type': 'application/json',
      Cookie: login.headers.get('set-cookie').split(';')[0],
    };
    const api = async (path, method = 'GET', data) =>
      fetch(app.origin + '/api/v1' + path, {
        method,
        headers,
        body: data ? JSON.stringify(data) : undefined,
      });
    const project = await (await api('/projects', 'POST', { name: 'c' })).json();
    const base = `/projects/${project.id}/conversations`;
    const initial = await (await api(base)).json();
    assert.equal(initial.length, 1);
    assert.equal(initial[0].id, null);
    assert.equal(initial[0].title, '기본 대화');
    // Without a named service Jev (here: no key → fallback) chooses; the account is fixed.
    const created = await api(base, 'POST', { body: '법규상 이 대지의 건폐율은?', host: 'rhino' });
    assert.equal(created.status, 201);
    const conversation = await created.json();
    assert.equal(conversation.provider, 'claude-cli');
    assert.equal(conversation.accountProfileId, 'default');
    assert.equal(conversation.title, '법규상 이 대지의 건폐율은?');
    assert.equal(conversation.mode, 'session');
    // A named service and model are kept as given.
    const named = await (
      await api(base, 'POST', {
        title: 'CAD 편집',
        provider: 'codex-cli',
        model: 'gpt-5',
        effort: 'low',
        kind: 'cad-edit',
      })
    ).json();
    assert.deepEqual(
      [named.provider, named.model, named.effort, named.mode],
      ['codex-cli', 'gpt-5', 'low', 'ledger'],
    );
    assert.equal((await api(base, 'POST', { kind: 'chat' })).status, 400);
    // A turn of the conversation runs on its service and model whatever the request says.
    const requests = `/projects/${project.id}/requests`;
    const input = {
      id: 'turn-1',
      provider: 'claude-cli',
      model: 'auto',
      permission: 'review',
      body: '검토',
      pins: [],
      sketches: [],
      files: [],
    };
    assert.equal((await api(requests, 'POST', { ...input, conversationId: named.id })).status, 202);
    assert.equal((await api(requests, 'POST', { ...input, id: 'turn-2' })).status, 202);
    for (let i = 0; i < 50 && runs.length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const turn = await (await api(requests + '/turn-1')).json();
    assert.equal(turn.input.conversationId, named.id);
    assert.equal(turn.input.provider, 'codex-cli');
    assert.equal(turn.input.model, 'gpt-5');
    assert.equal(turn.input.effort, 'low');
    assert.equal(turn.state, 'succeeded');
    assert.equal(runs.find((entry) => entry.options.model === 'gpt-5').options.session, undefined);
    const listed = await (await api(requests)).json();
    assert.deepEqual(listed.map((row) => [row.id, row.input.conversationId ?? null]).sort(), [
      ['turn-1', named.id],
      ['turn-2', null],
    ]);
    const detail = await (await api(`${base}/${named.id}`)).json();
    assert.equal(detail.requests, 1);
    assert.deepEqual(
      detail.ledger.map((item) => item.kind),
      ['result-ref'],
    );
    assert.equal(
      (
        await api(`${base}/${named.id}/ledger`, 'POST', {
          kind: 'param-change',
          body: { key: 'spanMax', value: 11 },
        })
      ).status,
      201,
    );
    assert.equal(
      (await api(`${base}/default/ledger`, 'POST', { kind: 'decision', body: {} })).status,
      400,
    );
    assert.equal((await api(`${base}/missing`)).status, 404);
    const summary = await (await api(base)).json();
    assert.deepEqual(
      summary.map((row) => row.requests),
      [1, 0, 1],
    );
    // Hand-over to another service is a confirmed action; the next turn opens a new session.
    const handed = await (
      await api(`${base}/${named.id}/handoff`, 'POST', { provider: 'claude-cli' })
    ).json();
    assert.deepEqual([handed.provider, handed.model, handed.mode], ['claude-cli', null, 'session']);
    const closed = await (await api(`${base}/${named.id}/close`, 'POST', {})).json();
    assert.equal(closed.state, 'closed');
    assert.equal(
      (await api(requests, 'POST', { ...input, id: 'turn-3', conversationId: named.id })).status,
      409,
    );
    assert.equal(
      (await api(requests, 'POST', { ...input, id: 'turn-4', conversationId: 'missing' })).status,
      404,
    );
  } finally {
    await app.close();
  }
});

test('the route helper leaves other paths alone', async () => {
  assert.equal(
    await conversationRoutes(
      new URL('http://127.0.0.1/api/v1/projects/p/requests'),
      { method: 'GET' },
      {},
    ),
    false,
  );
});

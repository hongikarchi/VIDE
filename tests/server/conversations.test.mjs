import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  SESSION_PROVIDERS,
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

/** One POST to a conversation action through the route helper (local, not remote). */
function route(service, projectId, path, value = {}, extra = {}) {
  let sent;
  return conversationRoutes(
    new URL(`http://127.0.0.1/api/v1/projects/${projectId}/conversations/${path}`),
    { method: 'POST' },
    {
      service,
      body: async () => value,
      send: (status, data) => {
        sent = { status, data };
      },
      ...extra,
    },
  ).then(() => sent);
}

function setup(t, script, { codex = false } = {}) {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('conversations');
  const removed = [];
  const conversations = new ConversationService(store, {
    removeTranscript: async (provider, sessionId) => {
      removed.push({ provider, sessionId });
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

test('turns run on the default login: an older request account is ignored, a former profile session is not resumed', async (t) => {
  const { store, conversations, project, fake, open, send, settled, state } = setup(t, (turn) => [
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
  // An input that still names an account (a stored request of an older VIDE) changes nothing:
  // the session goes on (ADR-025, AccountSwitch changes the login under the same folder).
  send('a2', {
    conversationId: conversation.id,
    accountProfileId: '11111111-2222-4333-8444-555555555555',
  });
  await settled();
  assert.equal(state('a2').state, 'succeeded');
  let runs = fake.runs();
  assert.ok(runs[1].args.includes('--resume'));
  // A session an older VIDE opened on one of its own account profiles lived in that profile's
  // folder: it is not resumed; the next turn opens a new one on the default login with the ledger.
  store.db
    .prepare(
      "UPDATE provider_sessions SET accountProfileId='11111111-2222-4333-8444-555555555555' WHERE conversationId=?",
    )
    .run(conversation.id);
  send('a3', { conversationId: conversation.id });
  await settled();
  assert.equal(state('a3').state, 'succeeded');
  runs = fake.runs();
  const first = runs[0].args[runs[0].args.indexOf('--session-id') + 1];
  const opened = runs[2].args[runs[2].args.indexOf('--session-id') + 1];
  assert.ok(opened && opened !== first);
  assert.ok(!runs[2].args.includes('--resume'));
  const packet = fake.packet(runs[2]);
  const handoff = packet.items.find((item) => item.id === 'handoff');
  assert.equal(handoff.data.reason, 'account');
  const ledger = packet.items.find((item) => item.id === 'ledger');
  assert.ok(ledger.data.items.some((item) => item.kind === 'decision'));
  const saved = conversations.get(project.id, conversation.id);
  assert.deepEqual(
    saved.sessions.map((session) => [session.accountProfileId, session.state, session.turns]),
    [
      ['11111111-2222-4333-8444-555555555555', 'handed-off', 2],
      ['default', 'active', 1],
    ],
  );
  assert.equal(saved.accountProfileId, null, 'the conversation keeps no account');
});

test('an account limit stops the turn and is not sent again; after AccountSwitch the session goes on', async (t) => {
  const { conversations, project, fake, open, send, settled, state } = setup(t, (turn) =>
    turn === 1
      ? [
          init,
          {
            type: 'result',
            subtype: 'success',
            is_error: true,
            result: "You've hit your usage limit · resets 3pm",
          },
        ]
      : [init, answer(`답 ${turn + 1}`)],
  );
  const conversation = open();
  send('m1', { conversationId: conversation.id });
  await settled();
  send('m2', { conversationId: conversation.id });
  await settled();
  assert.equal(state('m2').state, 'failed');
  assert.equal(state('m2').result.code, 'PROVIDER_LIMIT');
  // The stopped turn is never sent again by itself, and there is no account hand-over card or route.
  assert.equal(fake.runs().length, 2);
  const saved = conversations.get(project.id, conversation.id);
  assert.equal(saved.handover, null);
  assert.equal(
    await conversationRoutes(
      new URL(
        `http://127.0.0.1/api/v1/projects/${project.id}/conversations/${conversation.id}/account`,
      ),
      { method: 'POST' },
      { service: conversations, body: async () => ({}), send: () => {} },
    ),
    false,
  );
  // The user changes the account in AccountSwitch and sends again: same session, resumed.
  send('m3', { conversationId: conversation.id });
  await settled();
  assert.equal(state('m3').state, 'succeeded');
  const runs = fake.runs();
  assert.equal(runs.length, 3);
  assert.ok(runs[2].args.includes('--resume'));
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

test('a Codex conversation resumes its thread: exec resume, isolation every turn, growth-only tokens', async (t) => {
  const thread = '01a0f026-1a25-7580-89e5-cbde1801d6d0';
  const other = '01a0f026-1a25-7580-89e5-cbde1801ffff';
  const fresh = '01a0f026-1a25-7580-89e5-cbde18020000';
  // Codex reports a resumed turn's usage as the session's running total (SPIKE ④).
  const totals = [100, 250, 420];
  const { conversations, project, fake, open, send, settled, state } = setup(
    t,
    (turn, call) => {
      const resumed = call.args[1] === 'resume';
      const id = !resumed ? (turn === 0 ? thread : fresh) : turn === 3 ? other : call.args[2];
      return [
        { type: 'thread.started', thread_id: id },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: `답 ${turn + 1}` } },
        {
          type: 'turn.completed',
          usage: { input_tokens: totals[turn] ?? 50, cached_input_tokens: 40, output_tokens: 2 },
        },
      ];
    },
    { codex: true },
  );
  const conversation = open();
  assert.equal(conversation.mode, 'session');
  for (const id of ['c1', 'c2', 'c3']) {
    send(id, { conversationId: conversation.id });
    await settled();
    assert.equal(state(id).state, 'succeeded', id);
  }
  const runs = fake.runs();
  assert.equal(runs.length, 3);
  assert.equal(runs[0].args[1], '--json');
  assert.equal(runs[0].args[runs[0].args.indexOf('--sandbox') + 1], 'read-only');
  for (const call of runs.slice(1)) {
    assert.deepEqual(call.args.slice(0, 3), ['exec', 'resume', thread]);
    assert.ok(!call.args.includes('--sandbox'));
    assert.ok(call.args.includes('sandbox_mode="read-only"'));
  }
  for (const call of runs) {
    assert.ok(!call.args.includes('--ephemeral'));
    assert.ok(call.args.includes('mcp_servers={}'));
    const packet = fake.packet(call);
    assert.match(packet.items.find((item) => item.id === 'turn-rules').data, /No tools/);
    assert.equal(
      packet.items.find((item) => item.id === 'conversation'),
      undefined,
    );
  }
  let saved = conversations.get(project.id, conversation.id);
  assert.equal(saved.session.sessionId, thread);
  assert.equal(saved.session.turns, 3);
  assert.equal(saved.session.inputTokens, 420);
  assert.equal(state('c2').result.sessionId, thread);
  // A resumed turn that reports another thread is a lost session: once more in a new one.
  send('c4', { conversationId: conversation.id });
  await settled();
  assert.equal(state('c4').state, 'succeeded');
  const all = fake.runs();
  assert.deepEqual(all[3].args.slice(0, 3), ['exec', 'resume', thread]);
  assert.equal(all[4].args[1], '--json');
  assert.equal(fake.packet(all[4]).items.find((item) => item.id === 'handoff').data.reason, 'lost');
  saved = conversations.get(project.id, conversation.id);
  assert.deepEqual(
    saved.sessions.map((session) => [session.sessionId, session.state]),
    [
      [thread, 'lost'],
      [fresh, 'active'],
    ],
  );
});

test('with Codex sessions switched off a Codex conversation runs the ledger method', async (t) => {
  SESSION_PROVIDERS['codex-cli'] = false;
  t.after(() => {
    SESSION_PROVIDERS['codex-cli'] = true;
  });
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

test('a session past the length setting goes on with a suggestion; [새 세션으로 이어가기] opens a new one', async (t) => {
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
  assert.equal(conversations.get(project.id, conversation.id).handover, null);
  for (let turn = 1; turn < SESSION_MAX_TURNS; turn++) conversations.store.recordTurn(key, 100);
  // At the turn limit (100 by default, ADR-028) a new session is suggested (T1), not forced: the
  // next turn still resumes.
  let saved = conversations.get(project.id, conversation.id);
  assert.deepEqual(saved.handover, {
    kind: 'length',
    grade: 'T1',
    turns: SESSION_MAX_TURNS,
    inputTokens: 10 + 100 * (SESSION_MAX_TURNS - 1),
    limits: { maxTurns: 100, maxInputTokens: 800000 },
    sends: { ledgerItems: 1, recentTurns: 1, files: 0 },
  });
  send('m2', { conversationId: conversation.id });
  await settled();
  assert.equal(state('m2').state, 'succeeded');
  let runs = fake.runs();
  assert.ok(runs[1].args.includes('--resume'));
  assert.equal(conversations.get(project.id, conversation.id).handover.kind, 'length');
  // The button: the session is left, the next turn opens a new one with the hand-over.
  const renewed = await route(conversations, project.id, `${conversation.id}/renew`);
  assert.equal(renewed.status, 200);
  assert.equal(renewed.data.handover, null);
  assert.equal(renewed.data.session, null);
  await assert.rejects(route(conversations, project.id, `${conversation.id}/renew`), {
    code: 'NO_ACTIVE_SESSION',
  });
  send('m3', { conversationId: conversation.id });
  await settled();
  runs = fake.runs();
  assert.ok(runs[2].args.includes('--session-id'));
  assert.equal(
    fake.packet(runs[2]).items.find((item) => item.id === 'handoff').data.reason,
    'length',
  );
  saved = conversations.get(project.id, conversation.id);
  assert.deepEqual(
    saved.sessions.map((row) => [row.state, row.turns]),
    [
      ['handed-off', SESSION_MAX_TURNS + 1],
      ['active', 1],
    ],
  );
  assert.deepEqual(
    saved.ledger.filter((item) => item.kind === 'handoff').map((item) => item.body.reason),
    ['length', 'length'],
  );
  await conversations.close(project.id, conversation.id);
  assert.throws(() => conversations.fix(project.id, { conversationId: conversation.id }), {
    code: 'CONVERSATION_CLOSED',
  });
  send('m4', { conversationId: conversation.id });
  await settled();
  assert.equal(state('m4').state, 'failed');
  assert.equal(state('m4').result.code, 'CONVERSATION_CLOSED');
});

test('the length setting is read from its file, saved locally only, and applies to the suggestion', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-conv-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const settingsFile = join(directory, 'conversation-settings.json');
  const service = new ConversationService(store, { settingsFile });
  assert.deepEqual(service.limits(), { maxTurns: 100, maxInputTokens: 800000 });
  const call = (method, value, remote = false) => {
    let sent;
    return conversationRoutes(
      new URL('http://127.0.0.1/api/v1/settings/conversations'),
      { method },
      {
        service,
        body: async () => value,
        send: (status, data) => (sent = { status, data }),
        remote,
      },
    ).then((handled) => (handled ? sent : undefined));
  };
  assert.deepEqual((await call('GET')).data, { maxTurns: 100, maxInputTokens: 800000 });
  await assert.rejects(call('PUT', { maxTurns: 4, maxInputTokens: 50000 }, true), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(call('PUT', { maxTurns: 1, maxInputTokens: 50000 }), {
    code: 'INVALID_INPUT',
  });
  assert.deepEqual((await call('PUT', { maxTurns: 4, maxInputTokens: 50000 })).data, {
    maxTurns: 4,
    maxInputTokens: 50000,
  });
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), {
    maxTurns: 4,
    maxInputTokens: 50000,
  });
  // A new service (a restart) reads the saved setting.
  const again = new ConversationService(store, { settingsFile });
  assert.deepEqual(again.limits(), { maxTurns: 4, maxInputTokens: 50000 });
  const project = store.createProject('limits');
  const conversation = again.create(project.id, {
    kind: 'ask',
    title: '길이',
    provider: 'claude-cli',
    accountProfileId: 'default',
  });
  const key = {
    conversationId: conversation.id,
    provider: 'claude-cli',
    accountProfileId: 'default',
    sessionId: '11111111-2222-4333-8444-555555555555',
  };
  again.store.addSession({ ...key, promptMode: 'neutral', cliVersion: '2.1.284' });
  again.store.recordTurn(key, 60000);
  assert.equal(again.get(project.id, conversation.id).handover.kind, 'length');
  assert.equal(service.limits().maxTurns, 4);
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

/** Jev as `place` sees it; `routes` counts Jev's calls. */
function placeDeps(choice = { provider: 'claude-cli', model: 'opus', effort: 'high' }) {
  const deps = {
    routes: 0,
    route: async () => {
      deps.routes++;
      return { ...choice, by: 'jev', task: 'complex' };
    },
  };
  return deps;
}
/** A composer turn: placed like `POST …/requests` (the first turn fixes the AI), then started. */
async function composerTurn({ conversations, workspace, execution, project }, deps, id, fields) {
  const input = {
    id,
    body: id,
    provider: 'claude-cli',
    model: 'auto',
    effort: 'default',
    permission: 'review',
    pins: [],
    sketches: [],
    files: [],
    ...fields,
  };
  const placed = await conversations.place(project.id, input, deps);
  const request = workspace.submit(project.id, input).request;
  execution.start(request);
  return { placed, request };
}
const flag = (call, name) =>
  call.args.includes(name) ? call.args[call.args.indexOf(name) + 1] : null;

test('the default conversation fixes its AI at the first turn; later turns keep it, effort may change', async (t) => {
  const context = setup(t, (turn) => [init, answer(`답 ${turn + 1}`)]);
  const { conversations, project, fake, send, settled, state } = context;
  // A request from before the default conversation was one.
  send('plain-1');
  await settled();
  assert.equal(conversations.list(project.id)[0].pending, true);
  const deps = placeDeps();
  const first = await composerTurn(context, deps, 'd1', { conversationId: 'default' });
  await settled();
  // Jev chose once; the turn runs in the default conversation's row on Jev's choice.
  assert.equal(deps.routes, 1);
  assert.equal(first.placed.conversation.id, `default-${project.id}`);
  assert.equal(first.placed.routing.by, 'jev');
  assert.deepEqual(
    [state('d1').input.conversationId, state('d1').input.model, state('d1').input.effort],
    [`default-${project.id}`, 'opus', 'high'],
  );
  assert.equal(state('d1').state, 'succeeded');
  // Later turns: "자동 (Jev)" in the composer is not asked again; effort changes, session stays.
  await composerTurn(context, deps, 'd2', { conversationId: 'default' });
  await settled();
  await composerTurn(context, deps, 'd3', {
    conversationId: 'default',
    model: 'opus',
    effort: 'low',
  });
  await settled();
  assert.equal(deps.routes, 1);
  assert.deepEqual(
    ['d2', 'd3'].map((id) => [
      state(id).input.model,
      state(id).input.effort,
      state(id).input.routing,
    ]),
    [
      ['opus', 'high', undefined],
      ['opus', 'low', undefined],
    ],
  );
  const runs = fake.runs().slice(1);
  const session = flag(runs[0], '--session-id');
  assert.match(session, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    runs.map((call) => [flag(call, '--model'), flag(call, '--effort'), flag(call, '--resume')]),
    [
      ['opus', 'high', null],
      ['opus', 'high', session],
      ['opus', 'low', session],
    ],
  );
  // Its first session got the earlier requests as a hand-over.
  const handoff = fake.packet(runs[0]).items.find((item) => item.id === 'handoff');
  assert.equal(handoff.data.reason, 'first');
  assert.deepEqual(handoff.data.recentTurns, [{ request: 'plain-1', response: '답 1' }]);
  // Listed as the default conversation (id null), now with its fixed AI and every request.
  const listed = conversations.list(project.id);
  assert.equal(listed.length, 1);
  assert.deepEqual(
    [listed[0].id, listed[0].provider, listed[0].model, listed[0].pending, listed[0].requests],
    [null, 'claude-cli', 'opus', false, 4],
  );
  assert.equal(conversations.get(project.id, null).session.turns, 3);
  // The default conversation is not closed.
  await assert.rejects(conversations.close(project.id, `default-${project.id}`), {
    code: 'INVALID_INPUT',
  });
});

test("the composer's own model at the first turn is kept without asking Jev", async (t) => {
  const context = setup(t, () => [init, answer('답')]);
  const deps = placeDeps();
  const { placed } = await composerTurn(context, deps, 'e1', {
    conversationId: 'default',
    model: 'sonnet',
    effort: 'medium',
  });
  await context.settled();
  assert.equal(deps.routes, 0);
  assert.equal(placed.routing, undefined);
  assert.deepEqual(
    [placed.conversation.provider, placed.conversation.model, placed.conversation.effort],
    ['claude-cli', 'sonnet', 'medium'],
  );
  // A conversation opened with "자동 (Jev)" before any request is fixed at its first turn.
  const pending = context.conversations.create(context.project.id, {
    kind: 'general',
    title: '대화',
    provider: 'claude-cli',
    model: 'sonnet',
    pending: true,
  });
  assert.equal(pending.pending, true);
  const fixed = await composerTurn(context, deps, 'e2', { conversationId: pending.id });
  await context.settled();
  assert.equal(deps.routes, 1);
  assert.equal(fixed.placed.conversation.id, pending.id);
  assert.equal(fixed.placed.movedFrom, undefined);
  const after = context.conversations.get(context.project.id, pending.id);
  assert.deepEqual([after.model, after.effort, after.pending], ['opus', 'high', false]);
  // The mark is not part of what the AI is sent.
  assert.deepEqual(
    after.ledger.map((item) => item.kind),
    ['result-ref'],
  );
});

test('[+] opens a conversation without asking Jev; its first request names it, a given name stays', async (t) => {
  const context = setup(t, () => [init, answer('답')]);
  const { conversations, project, settled } = context;
  const chosen = [];
  /** POST …/conversations as the [+] button and the programmatic callers send it. */
  const create = async (value) => {
    let sent;
    await conversationRoutes(
      new URL(`http://127.0.0.1/api/v1/projects/${project.id}/conversations`),
      { method: 'POST' },
      {
        service: conversations,
        body: async () => value,
        send: (status, data) => (sent = { status, data }),
        chooseModel: async (routing, requested) => {
          chosen.push(routing.body);
          return {
            provider: requested ?? 'claude-cli',
            model: 'sonnet',
            effort: 'default',
            task: 'lookup',
          };
        },
      },
    );
    return sent;
  };
  // [+] (T-097): no request yet, so no model call; an empty general tab whose first turn chooses.
  const plus = await create({ kind: 'general' });
  assert.equal(plus.status, 201);
  assert.deepEqual(
    [plus.data.kind, plus.data.title, plus.data.pending, plus.data.requests],
    ['general', '대화', true, 0],
  );
  assert.equal((await create({})).data.kind, 'general');
  const named = await create({ title: '구조 검토' });
  assert.deepEqual([named.data.title, named.data.pending], ['구조 검토', true]);
  assert.deepEqual(chosen, []);
  // The first request names the tab (its first 60 characters) and fixes its AI; kind and targets
  // are left as they are.
  const deps = placeDeps();
  const long =
    '보 간격을 2.5 m로 줄였을 때 처짐이 기준 안에 드는지 3층 평면의 모든 큰보에 대해 확인하고 결과를 표로 정리해줘';
  await composerTurn(context, deps, 'n1', { conversationId: plus.data.id, body: `  ${long}  ` });
  await settled();
  const after = conversations.get(project.id, plus.data.id);
  assert.equal(after.title, long.slice(0, 60) + ' …(생략)');
  assert.deepEqual(
    [after.kind, after.targets, after.pending, after.model],
    ['general', null, false, 'opus'],
  );
  // A later request does not rename it again.
  await composerTurn(context, deps, 'n2', { conversationId: plus.data.id, body: '다음 질문' });
  await settled();
  assert.equal(conversations.get(project.id, plus.data.id).title, after.title);
  // A name given when it opened is kept.
  await composerTurn(context, deps, 'n3', {
    conversationId: named.data.id,
    body: '기둥 위치 확인',
  });
  await settled();
  assert.equal(conversations.get(project.id, named.data.id).title, '구조 검토');
  // A jig conversation opened with its request still has Jev choose once, as before.
  const jig = await create({ kind: 'jig-run', title: '구조 검토 jig', body: '구조 검토 열어줘' });
  assert.deepEqual(
    [jig.data.kind, jig.data.title, jig.data.pending, jig.data.model],
    ['jig-run', '구조 검토 jig', false, 'sonnet'],
  );
  assert.deepEqual(chosen, ['구조 검토 열어줘']);
  // A request opening a conversation with a named model is not asked about either.
  const fixed = await create({ body: '법규 질문', provider: 'codex-cli', model: 'gpt-5' });
  assert.deepEqual(
    [fixed.data.provider, fixed.data.model, fixed.data.title],
    ['codex-cli', 'gpt-5', '법규 질문'],
  );
  assert.equal(chosen.length, 1);
});

test('another model from the composer opens a new conversation with the hand-over, and the request runs there', async (t) => {
  const context = setup(t, (turn) => [init, answer(`답 ${turn + 1}`)]);
  const { conversations, project, fake, open, send, settled, state } = context;
  const conversation = open({ model: 'sonnet' });
  send('m1', { conversationId: conversation.id });
  await settled();
  conversations.addLedger(project.id, conversation.id, {
    kind: 'decision',
    body: { text: '층고 4.2 m로 본다' },
  });
  const deps = placeDeps();
  const moved = await composerTurn(context, deps, 'm2', {
    conversationId: conversation.id,
    model: 'opus',
    effort: 'high',
    body: '같은 조건으로 계단을 다시 그려줘',
  });
  await settled();
  assert.equal(deps.routes, 0);
  assert.equal(moved.placed.movedFrom.id, conversation.id);
  const made = moved.placed.conversation;
  assert.notEqual(made.id, conversation.id);
  assert.deepEqual(
    [made.kind, made.provider, made.model, made.title],
    ['ask', 'claude-cli', 'opus', '법규 질문'],
  );
  assert.equal(state('m2').input.conversationId, made.id);
  assert.equal(state('m2').state, 'succeeded');
  // The old conversation is untouched and says where the request went; the new one, where from.
  const old = conversations.get(project.id, conversation.id);
  assert.equal(old.model, 'sonnet');
  assert.equal(old.session.turns, 1);
  assert.equal(old.ledger.at(-1).kind, 'handoff');
  assert.deepEqual(old.ledger.at(-1).body, {
    reason: 'moved',
    to: { conversationId: made.id, title: '법규 질문', provider: 'claude-cli', model: 'opus' },
  });
  const fresh = conversations.get(project.id, made.id);
  assert.equal(fresh.ledger[0].body.reason, 'model');
  assert.equal(fresh.ledger[0].body.from.conversationId, conversation.id);
  // The new conversation's first session carries the old one's ledger and latest turns.
  const runs = fake.runs();
  assert.equal(runs.length, 2);
  assert.equal(flag(runs[1], '--model'), 'opus');
  assert.ok(flag(runs[1], '--session-id'));
  assert.notEqual(flag(runs[1], '--session-id'), flag(runs[0], '--session-id'));
  const handoff = fake.packet(runs[1]).items.find((item) => item.id === 'handoff');
  assert.equal(handoff.data.reason, 'model');
  assert.deepEqual(handoff.data.recentTurns, [{ request: 'm1', response: '답 1' }]);
  assert.equal(handoff.data.from.model, 'sonnet');
  assert.deepEqual(
    handoff.data.from.ledger.items.map((item) => item.kind),
    ['result-ref', 'decision'],
  );
  // Back in the old conversation, its own model keeps it there (no further moves).
  const back = await composerTurn(context, deps, 'm3', {
    conversationId: conversation.id,
    model: 'sonnet',
  });
  await settled();
  assert.equal(back.placed.conversation.id, conversation.id);
  assert.equal(flag(fake.runs()[2], '--resume'), flag(runs[0], '--session-id'));
  // [다른 AI로 이어 가기] also opens a new conversation now.
  const handed = conversations.handoffTo(
    project.id,
    conversation.id,
    { provider: 'codex-cli', model: 'gpt-5' },
    'default',
  );
  assert.notEqual(handed.id, conversation.id);
  assert.deepEqual([handed.provider, handed.model], ['codex-cli', 'gpt-5']);
  assert.equal(conversations.get(project.id, conversation.id).provider, 'claude-cli');
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
    assert.equal(conversation.accountProfileId, null, 'no account is fixed (ADR-025)');
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
      ['codex-cli', 'gpt-5', 'low', 'session'],
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
    // A Codex conversation opens a session too (SPIKE ④ re-test); this fake names no thread.
    assert.equal(
      runs.find((entry) => entry.options.model === 'gpt-5').options.session.resume,
      false,
    );
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
    assert.notEqual(handed.id, named.id);
    // The default conversation's first turn fixes it; Jev is not asked on later turns.
    assert.equal(
      (await api(requests, 'POST', { ...input, id: 'turn-d1', conversationId: 'default' })).status,
      202,
    );
    const fixed = (await (await api(base)).json())[0];
    assert.deepEqual([fixed.id, fixed.provider, fixed.pending], [null, 'claude-cli', false]);
    const firstTurn = await (await api(requests + '/turn-d1')).json();
    assert.equal(firstTurn.input.conversationId, `default-${project.id}`);
    assert.ok(firstTurn.input.routing);
    // Another service from the composer: the request goes to a new conversation.
    const switched = await (
      await api(requests, 'POST', {
        ...input,
        id: 'turn-d2',
        conversationId: 'default',
        provider: 'codex-cli',
        model: 'gpt-5',
      })
    ).json();
    assert.notEqual(switched.input.conversationId, `default-${project.id}`);
    assert.deepEqual([switched.input.provider, switched.input.model], ['codex-cli', 'gpt-5']);
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

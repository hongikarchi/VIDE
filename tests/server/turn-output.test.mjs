import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { ClaudeCli } from '../../src/ai/claude-cli.ts';
import { CodexCli } from '../../src/ai/codex-cli.ts';
import { ConversationService, conversationRoutes } from '../../src/server/conversations.ts';
import {
  TURN_OUTPUT_JSON_SCHEMA,
  formatAnswers,
  parseTurnOutput,
  turnOutputResult,
} from '../../src/server/turn-output.ts';

// Structured turn output and question cards (PLAN-24 T-062 part 1, SPEC-02.19 6): the CLI is a
// fake transport, so the structured-output flag, the parsed cards, the ledger and the answer
// turn are asserted end to end.

const question = (id, extra = {}) => ({
  id,
  title: `${id} 경간 방향은?`,
  options: [
    { id: 'x', label: 'X 방향', hint: null, recommended: false },
    { id: 'y', label: 'Y 방향', hint: '긴 변 방향', recommended: true },
  ],
  blocks: '작은보 배치',
  allowFree: false,
  ...extra,
});
const output = (fields = {}) => ({
  status: 'question',
  text: '두 가지를 정하면 이어서 배치합니다.',
  questions: [question('span-dir'), question('slab', { allowFree: true })],
  ...fields,
});

test('valid output parses; the recommended option comes first and nulls drop out', () => {
  const parsed = parseTurnOutput({ structured: output() });
  assert.ok('output' in parsed);
  const [first] = parsed.output.questions;
  assert.deepEqual(
    first.options.map((o) => [o.id, o.recommended]),
    [
      ['y', true],
      ['x', false],
    ],
  );
  assert.equal(first.options[1].hint, undefined);
  // Codex: the final message text is the JSON.
  const fromText = parseTurnOutput({
    text: JSON.stringify(output({ status: 'done', questions: [] })),
  });
  assert.equal(fromText.output.status, 'done');
});

test('unknown fields, more than three questions, long text and bad ids are rejected', () => {
  const bad = [
    { ...output(), extra: 1 },
    output({ questions: [{ ...question('a'), note: 'x' }] }),
    output({ questions: ['a', 'b', 'c', 'd'].map((id) => question(id)) }),
    output({ text: 'x'.repeat(4001) }),
    output({ questions: [question('../a')] }),
    output({ questions: [question('a', { title: 't'.repeat(201) })] }),
    output({ questions: [question('a'), question('a')] }),
    output({
      questions: [
        question('a', {
          options: [
            { id: 'x', label: 'X', hint: null, recommended: true },
            { id: 'y', label: 'Y', hint: null, recommended: true },
          ],
        }),
      ],
    }),
    output({ status: 'maybe' }),
  ];
  for (const value of bad)
    assert.deepEqual(parseTurnOutput({ structured: value }), { code: 'TURN_OUTPUT_INVALID' });
  assert.deepEqual(parseTurnOutput({ text: '그냥 글' }), { code: 'TURN_OUTPUT_INVALID' });
  // A turn that did not ask keeps its text; an invalid structured one keeps the text with a code.
  assert.deepEqual(turnOutputResult(undefined, { text: 'x' }), {});
  assert.deepEqual(turnOutputResult({ structured: true }, { text: '그냥 글' }), {
    structured: undefined,
    turnOutputError: 'TURN_OUTPUT_INVALID',
  });
});

test('questions already in the ledger are not asked again', () => {
  const parsed = parseTurnOutput({ structured: output() }, new Set(['span-dir', 'slab']));
  assert.equal(parsed.output.questions.length, 0);
  assert.equal(parsed.output.status, 'progress');
  const one = parseTurnOutput({ structured: output() }, new Set(['slab']));
  assert.deepEqual(
    one.output.questions.map((q) => q.id),
    ['span-dir'],
  );
});

test('the schema is strict for both services: every property required, nothing extra', () => {
  const walk = (node) => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(walk);
    }
    if (node.type === 'array') walk(node.items);
  };
  walk(TURN_OUTPUT_JSON_SCHEMA);
  assert.match(
    formatAnswers([
      {
        question: question('a'),
        option: question('a').options[1],
        text: '코어 쪽',
        recommended: false,
      },
    ]),
    /a 경간 방향은\? → Y 방향 · "코어 쪽" \[a=y\]/,
  );
});

const init = { type: 'system', subtype: 'init', tools: [], mcp_servers: [] };
const claudeResult = (structured) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '',
  structured_output: structured,
  usage: { input_tokens: 10, output_tokens: 3 },
});
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
    child.stdin.on('data', (data) => (call.input += data));
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
        const file = args[args.indexOf('--output-schema') + 1];
        // Codex reads the schema file while it runs; the run folder is removed afterwards.
        call.schemaFile =
          args.includes('--output-schema') && existsSync(file) ? readFileSync(file, 'utf8') : null;
        for (const event of script(runs++, call)) child.stdout.write(JSON.stringify(event) + '\n');
        setTimeout(() => close(0), 5);
      });
    return child;
  };
  return {
    spawnProcess,
    runs: () => calls.filter((call) => ['-p', 'exec'].includes(call.args[0])),
  };
}
function setup(t, script, { codex = false } = {}) {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('turn output');
  const conversations = new ConversationService(store, { removeTranscript: async () => 0 });
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
  const provider = codex ? 'codex-cli' : 'claude-cli';
  const conversation = conversations.create(project.id, {
    kind: 'jig-run',
    title: '구조 검토',
    provider,
  });
  const submit = async (projectId, input) => {
    conversations.fix(projectId, input);
    const created = workspace.submit(projectId, input);
    execution.start(created.request);
    return created.request;
  };
  const send = (id, fields = {}) =>
    submit(project.id, {
      id,
      body: id,
      provider,
      permission: 'review',
      hostUse: 'none',
      conversationId: conversation.id,
      pins: [],
      sketches: [],
      files: [],
      ...fields,
    });
  const settled = async () => {
    while (execution.active.size)
      await Promise.all([...execution.active.values()].map((entry) => entry.completion));
  };
  const route = async (action, payload) => {
    let status, data;
    const url = new URL(
      `http://x/api/v1/projects/${project.id}/conversations/${conversation.id}/${action}`,
    );
    await conversationRoutes(
      url,
      { method: 'POST' },
      {
        service: conversations,
        body: async () => payload,
        send: (s, d) => ((status = s), (data = d)),
        chooseModel: async () => ({ provider }),
        submit,
      },
    );
    return { status, data };
  };
  return { store, workspace, project, conversations, conversation, fake, send, settled, route };
}

test('Claude: a turn without the host gets --json-schema; cards go in the result and the ledger', async (t) => {
  const ctx = setup(t, (run) =>
    run === 0
      ? [init, claudeResult(output())]
      : [init, claudeResult(output({ status: 'done', text: '배치했습니다.', questions: [] }))],
  );
  await ctx.send('ask-1');
  await ctx.settled();
  const done = ctx.workspace.get(ctx.project.id, 'ask-1');
  assert.equal(done.state, 'succeeded');
  assert.equal(done.result.text, '두 가지를 정하면 이어서 배치합니다.');
  assert.equal(done.result.turnOutput.status, 'question');
  assert.equal(done.result.turnOutput.questions[0].options[0].id, 'y');
  const [run] = ctx.fake.runs();
  // The flag joins the isolation and session arguments; nothing else changes.
  assert.deepEqual(
    JSON.parse(run.args[run.args.indexOf('--json-schema') + 1]),
    TURN_OUTPUT_JSON_SCHEMA,
  );
  for (const flag of ['--safe-mode', '--strict-mcp-config', '--session-id', '--tools'])
    assert.ok(run.args.includes(flag), flag);
  const ledger = () => ctx.conversations.store.ledger(ctx.conversation.id, { current: true });
  assert.deepEqual(
    ledger()
      .filter((item) => item.kind === 'question')
      .map((item) => [item.body.id, item.requestId]),
    [
      ['span-dir', 'ask-1'],
      ['slab', 'ask-1'],
    ],
  );

  // Refused answers: an option the card does not have, free text where it is not allowed.
  await assert.rejects(
    ctx.route('answer', {
      requestId: 'ask-1',
      answers: [{ questionId: 'span-dir', optionId: 'z' }],
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    ctx.route('answer', {
      requestId: 'ask-1',
      answers: [{ questionId: 'span-dir', text: '대각' }],
    }),
    { code: 'INVALID_INPUT' },
  );
  assert.equal(ledger().filter((item) => item.kind === 'answer').length, 0);

  // 권장값으로 진행 with one free answer: the next turn of the same conversation carries both.
  const answered = await ctx.route('answer', {
    requestId: 'ask-1',
    answers: [{ questionId: 'slab', text: '코어 쪽 우선' }],
    recommended: true,
  });
  assert.equal(answered.status, 201);
  const next = answered.data.request;
  assert.equal(next.input.conversationId, ctx.conversation.id);
  assert.match(next.input.body, /slab 경간 방향은\? → "코어 쪽 우선"/);
  assert.match(next.input.body, /span-dir 경간 방향은\? → Y 방향 \[span-dir=y\]/);
  await ctx.settled();
  const runs = ctx.fake.runs();
  assert.equal(runs.length, 2);
  assert.ok(runs[1].args.includes('--resume'));
  const packet = JSON.parse(runs[1].input);
  assert.ok(packet.items.some((item) => item.type === 'turn-output'));
  const answers = ledger().filter((item) => item.kind === 'answer');
  assert.deepEqual(
    answers.map((item) => [item.body.questionId, item.body.by, item.requestId]),
    [
      ['slab', 'user', next.id],
      ['span-dir', 'recommended', next.id],
    ],
  );
  assert.equal(ctx.workspace.get(ctx.project.id, next.id).result.turnOutput.status, 'done');
  // Answered questions are closed.
  await assert.rejects(ctx.route('answer', { requestId: 'ask-1', recommended: true }), {
    code: 'NOT_FOUND',
  });
});

test('a failed submit takes the recorded answers back', async (t) => {
  const ctx = setup(t, () => [init, claudeResult(output())]);
  await ctx.send('ask-1');
  await ctx.settled();
  ctx.conversations.store.setState(ctx.project.id, ctx.conversation.id, 'open');
  const url = new URL(
    `http://x/api/v1/projects/${ctx.project.id}/conversations/${ctx.conversation.id}/answer`,
  );
  await assert.rejects(
    conversationRoutes(
      url,
      { method: 'POST' },
      {
        service: ctx.conversations,
        body: async () => ({ requestId: 'ask-1', recommended: true }),
        send: () => {},
        chooseModel: async () => ({}),
        submit: async () => {
          throw Object.assign(new Error('busy'), { code: 'PROFILE_LOGIN_IN_PROGRESS' });
        },
      },
    ),
    { code: 'PROFILE_LOGIN_IN_PROGRESS' },
  );
  const current = ctx.conversations.store.ledger(ctx.conversation.id, { current: true });
  assert.equal(current.filter((item) => item.kind === 'answer').length, 0);
});

test('Codex: the schema goes as --output-schema <file>; the JSON text is parsed', async (t) => {
  const ctx = setup(
    t,
    () => [
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify(output({ questions: [question('q1')] })),
        },
      },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
    ],
    { codex: true },
  );
  await ctx.send('ask-1');
  await ctx.settled();
  const [run] = ctx.fake.runs();
  const at = run.args.indexOf('--output-schema');
  assert.ok(at > 0);
  assert.equal(run.args.at(-1), '-');
  assert.deepEqual(JSON.parse(run.schemaFile), TURN_OUTPUT_JSON_SCHEMA);
  // A Codex conversation now opens a session (T-061), so the transcript is kept: no --ephemeral.
  for (const flag of ['--ignore-user-config', '--sandbox'])
    assert.ok(run.args.includes(flag), flag);
  const done = ctx.workspace.get(ctx.project.id, 'ask-1').result;
  assert.equal(done.turnOutput.questions[0].id, 'q1');
});

test('turns with the host or a jig review format ask for no structured output', async (t) => {
  const ctx = setup(t, () => [init, { ...claudeResult(undefined), result: '자유 서술 답' }]);
  await ctx.send('read-1', { hostUse: undefined });
  await ctx.settled();
  const [run] = ctx.fake.runs();
  assert.ok(!run.args.includes('--json-schema'));
  assert.ok(!JSON.parse(run.input).items.some((item) => item.type === 'turn-output'));
  const result = ctx.workspace.get(ctx.project.id, 'read-1').result;
  assert.equal(result?.turnOutput, undefined);
});

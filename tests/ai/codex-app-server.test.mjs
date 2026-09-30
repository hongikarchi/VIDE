import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  CodexAppServer,
  appServerArguments,
  appServerIsolated,
  appServerThreadConfig,
  closeCodexAppServers,
  codexAppServerEnabled,
  liveCodexThreads,
  mcpStatusIsolated,
  nativeAnswers,
  questionCards,
  questionRule,
  threadParamsIsolated,
  threadResponseIsolated,
} from '../../src/ai/codex-app-server.ts';
import { codexInstructions } from '../../src/ai/codex-cli.ts';
import { turnOutputItem, parseTurnOutput } from '../../src/server/turn-output.ts';

// SPIKE-2026-09-30-codex-app-server: the message shapes below are the ones Codex 0.157.1 sent
// over `codex app-server` (stdio JSON-RPC) in the spike; the process itself is mocked.

const THREAD = '01a0f0a1-ed17-7cf0-99d7-d515efb01a67';
const OTHER = '01a0f0a9-360f-7151-9642-f659fcabf813';
const connection = (token = 'a'.repeat(64), tools = ['status']) => ({
  url: 'http://127.0.0.1:47000/mcp',
  token,
  tools,
});
const context = {
  goal: '합성 요청',
  revision: 2,
  items: [
    { id: 'yes', data: 'included' },
    { id: 'no', data: 'excluded' },
  ],
  includedIds: ['yes'],
};
const reply = (text, extra = []) => [
  ...extra,
  {
    method: 'item/completed',
    params: { item: { type: 'agentMessage', id: 'm1', text, phase: 'final_answer' } },
  },
  {
    method: 'thread/tokenUsage/updated',
    params: {
      tokenUsage: {
        total: { inputTokens: 900, outputTokens: 30 },
        last: {
          inputTokens: 100,
          outputTokens: 5,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 0,
        },
      },
    },
  },
  { method: 'turn/completed', params: { turn: { status: 'completed', error: null } } },
];
/**
 * A fake `codex` executable. `turns` is a list of scripts, one per turn/start: each an array of
 * notifications/server requests (threadId/turnId filled in), or a function of the fake.
 */
function fake({
  turns = [reply('VIDE_OK')],
  userServers = { rhino: {}, blender: {} },
  statuses,
  threadResponse = {},
  resumeError,
  auth = 'Logged in using ChatGPT',
} = {}) {
  const spawns = [];
  const requests = [];
  const responses = [];
  let turnNo = 0;
  function spawnProcess(executable, args, options) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = undefined;
    child.unref = () => {};
    spawns.push({ args, options });
    const close = () => {
      child.exitCode = 0;
      child.emit('exit', 0);
      child.emit('close', 0);
    };
    if (args[0] === '--version') {
      queueMicrotask(() => {
        child.stdout.write('codex-cli 0.157.1\n');
        close();
      });
      return child;
    }
    if (args[0] === 'login') {
      queueMicrotask(() => {
        child.stderr.write(auth + '\n');
        close();
      });
      return child;
    }
    const send = (message) => child.stdout.write(JSON.stringify(message) + '\n');
    let thread = THREAD,
      config = {},
      activeTurn;
    const server = {
      send,
      notify: (method, params) => send({ method, params: { threadId: thread, ...params } }),
      get turnId() {
        return activeTurn;
      },
    };
    let buffer = '';
    child.stdin.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.method === undefined) {
          responses.push(message);
          server.onResponse?.(message);
          continue;
        }
        requests.push(message);
        const { id, method, params } = message;
        const answer = (result) => send({ id, result });
        if (method === 'initialize') answer({ userAgent: 'fake', codexHome: 'C:/fake' });
        else if (method === 'config/read') answer({ config: { mcp_servers: userServers } });
        else if (method === 'thread/start' || method === 'thread/resume') {
          if (method === 'thread/resume' && resumeError)
            send({ id, error: { code: -32600, message: resumeError } });
          else {
            if (method === 'thread/resume') thread = params.threadId;
            config = params.config;
            answer({
              thread: { id: thread },
              sandbox: { type: 'readOnly', networkAccess: false },
              approvalPolicy: 'never',
              instructionSources: [],
              ...threadResponse,
            });
          }
        } else if (method === 'thread/unsubscribe') answer({ status: 'unsubscribed' });
        else if (method === 'mcpServerStatus/list') {
          const names = Object.keys(userServers);
          const data = statuses ?? [
            ...names.map((name) => ({ name, runtimeStatus: 'disabled', httpOrigin: null })),
            ...(config['mcp_servers.vide']
              ? [
                  {
                    name: 'vide',
                    runtimeStatus: 'connected',
                    httpOrigin: new URL(config['mcp_servers.vide'].url).origin,
                    tools: Object.fromEntries(
                      config['mcp_servers.vide'].enabled_tools.map((tool) => [tool, {}]),
                    ),
                  },
                ]
              : []),
          ];
          answer({ data, nextCursor: null });
        } else if (method === 'turn/start') {
          activeTurn = `turn-${++turnNo}`;
          answer({ turn: { id: activeTurn, status: 'inProgress' } });
          const script = turns[turnNo - 1] ?? reply('VIDE_OK');
          setTimeout(() => {
            server.notify('turn/started', { turn: { id: activeTurn, status: 'inProgress' } });
            if (typeof script === 'function') return script(server);
            for (const entry of script)
              send({
                ...entry,
                params: {
                  threadId: thread,
                  turnId: activeTurn,
                  ...entry.params,
                  ...(entry.method === 'turn/completed'
                    ? { turn: { id: activeTurn, ...entry.params.turn } }
                    : {}),
                },
              });
          }, 1);
        } else if (method === 'turn/interrupt') {
          answer({});
          server.notify('turn/completed', {
            turn: { id: params.turnId, status: 'interrupted', error: null },
          });
        } else send({ id, error: { code: -32601, message: 'unknown' } });
      }
    });
    child.stdin.on('finish', close);
    return child;
  }
  return {
    spawns,
    requests,
    responses,
    spawnProcess,
    servers: () => spawns.filter((entry) => entry.args[0] === 'app-server'),
    method: (name) => requests.filter((entry) => entry.method === name),
  };
}
const provider = (transport, options = {}) =>
  new CodexAppServer({
    executable: process.execPath,
    spawnProcess: transport.spawnProcess,
    stopGraceMs: 200,
    ...options,
  });

afterEach(async () => {
  await closeCodexAppServers();
});

test('플래그가 켜진 때만 app-server 경로를 쓴다', () => {
  assert.equal(codexAppServerEnabled({}), false);
  assert.equal(codexAppServerEnabled({ VIDE_CODEX_APP_SERVER: '0' }), false);
  assert.equal(codexAppServerEnabled({ VIDE_CODEX_APP_SERVER: '1' }), true);
});

test('프로세스 인자는 exec와 같은 격리를 싣고, 빠지거나 덧붙으면 거절한다', () => {
  for (const codeMode of [false, true]) {
    const args = appServerArguments({ codeMode });
    assert.ok(appServerIsolated(args, codeMode));
    assert.ok(args.includes('default_mode_request_user_input'));
    assert.ok(!appServerIsolated(args, !codeMode));
    const shell = args.indexOf('shell_tool');
    assert.ok(
      !appServerIsolated([...args.slice(0, shell - 1), ...args.slice(shell + 1)], codeMode),
    );
    assert.ok(!appServerIsolated([...args, '-c', 'mcp_servers.rhino.enabled=true'], codeMode));
    assert.ok(!appServerIsolated([...args, '-c', 'developer_instructions="x"'], codeMode));
    assert.ok(
      !appServerIsolated(
        args.map((value) =>
          value === 'sandbox_mode="read-only"' ? 'sandbox_mode="danger-full-access"' : value,
        ),
        codeMode,
      ),
    );
  }
});

test('스레드 설정은 사용자 MCP 서버를 모두 끄고 VIDE 서버만 이 턴의 도구로 둔다', () => {
  const vide = connection();
  const config = appServerThreadConfig(['rhino', 'blender'], vide, 'high');
  assert.equal(config['mcp_servers.rhino.enabled'], false);
  assert.equal(config['mcp_servers.blender.enabled'], false);
  assert.deepEqual(config['mcp_servers.vide'].enabled_tools, ['status']);
  assert.equal(config['mcp_servers.vide'].http_headers.Authorization, `Bearer ${vide.token}`);
  assert.equal(config.web_search, 'disabled');
  assert.equal(config.model_reasoning_effort, 'high');
  assert.throws(() => appServerThreadConfig(['bad.name']), { code: 'UNEXPECTED_TOOL_ACCESS' });
  // A user server named vide is switched off when the turn has no connection.
  assert.equal(appServerThreadConfig(['vide'])['mcp_servers.vide.enabled'], false);

  const params = {
    cwd: 'C:/tmp',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    developerInstructions: 'rules',
    config,
  };
  const expected = { instructions: 'rules', userServers: ['rhino', 'blender'], connection: vide };
  assert.ok(threadParamsIsolated(params, expected));
  for (const bad of [
    { ...params, sandbox: 'workspace-write' },
    { ...params, approvalPolicy: 'on-request' },
    { ...params, developerInstructions: 'other' },
    { ...params, baseInstructions: 'x' },
    { ...params, config: { ...config, 'mcp_servers.rhino.enabled': true } },
    { ...params, config: { ...config, 'mcp_servers.extra.enabled': false } },
    { ...params, config: { ...config, web_search: 'live' } },
    {
      ...params,
      config: {
        ...config,
        'mcp_servers.vide': { ...config['mcp_servers.vide'], enabled_tools: ['status', 'execute'] },
      },
    },
  ])
    assert.ok(!threadParamsIsolated(bad, expected));
});

test('서버가 보고한 스레드와 MCP 상태로 격리를 다시 확인한다', () => {
  const ok = {
    thread: { id: THREAD },
    sandbox: { type: 'readOnly', networkAccess: false },
    approvalPolicy: 'never',
    instructionSources: [],
  };
  assert.ok(threadResponseIsolated(ok));
  assert.ok(!threadResponseIsolated({ ...ok, sandbox: { type: 'workspaceWrite' } }));
  assert.ok(!threadResponseIsolated({ ...ok, sandbox: { type: 'readOnly', networkAccess: true } }));
  assert.ok(!threadResponseIsolated({ ...ok, approvalPolicy: 'on-request' }));
  assert.ok(!threadResponseIsolated({ ...ok, instructionSources: ['C:/x/AGENTS.md'] }));

  const vide = connection();
  const off = { name: 'rhino', runtimeStatus: 'disabled', httpOrigin: null };
  const on = {
    name: 'vide',
    runtimeStatus: 'connected',
    httpOrigin: 'http://127.0.0.1:47000',
    tools: { status: {} },
  };
  assert.ok(mcpStatusIsolated([off], undefined));
  assert.ok(mcpStatusIsolated([off, on], vide));
  assert.ok(!mcpStatusIsolated([{ ...off, runtimeStatus: 'connected' }], undefined));
  assert.ok(!mcpStatusIsolated([off, on], undefined));
  assert.ok(!mcpStatusIsolated([off], vide));
  assert.ok(!mcpStatusIsolated([off, { ...on, httpOrigin: 'http://127.0.0.1:9' }], vide));
  assert.ok(!mcpStatusIsolated([off, { ...on, tools: { status: {}, execute: {} } }], vide));
});

test('requestUserInput 질문을 질문 카드로 바꾸고 답을 원래 선택지 이름으로 돌려준다', () => {
  const questions = [
    {
      id: 'box color',
      header: '색상',
      question: '테스트 상자는 어떤 색으로 할까요?',
      isOther: true,
      isSecret: false,
      options: [
        { label: '빨강', description: '빨강으로 표시' },
        { label: '파랑 (Recommended)', description: '파랑으로 표시' },
      ],
    },
    {
      id: 'pw',
      header: '암호',
      question: '암호는?',
      isOther: false,
      isSecret: true,
      options: null,
    },
    {
      id: 'note',
      header: '',
      question: '남길 말이 있나요?',
      isOther: false,
      isSecret: false,
      options: null,
    },
  ];
  const { cards, sources } = questionCards(questions);
  assert.equal(cards.length, 2, 'the secret question is never shown');
  const [color, note] = cards;
  assert.equal(color.id, 'box-color');
  assert.equal(color.title, '테스트 상자는 어떤 색으로 할까요?');
  assert.deepEqual(
    color.options.map((option) => [option.label, option.recommended]),
    [
      ['파랑', true],
      ['빨강', false],
    ],
  );
  assert.equal(color.allowFree, true);
  assert.equal(color.blocks, '색상');
  assert.equal(note.allowFree, true);
  assert.equal(note.options.length, 2);
  // The cards pass the turn-output check as they are.
  const parsed = parseTurnOutput({
    text: JSON.stringify({ status: 'question', text: '', questions: cards }),
  });
  assert.ok('output' in parsed, JSON.stringify(parsed));

  const answers = nativeAnswers(questions, cards, sources, [
    { id: 'box-color', option: color.options[0].id },
    { id: 'note', text: '없음' },
  ]);
  assert.deepEqual(answers, {
    answers: {
      'box color': { answers: ['파랑 (Recommended)'] },
      pw: { answers: [] },
      note: { answers: ['없음'] },
    },
  });
});

test('한 턴: 선택 자료만 보내고 격리를 확인한 뒤 답·사용량을 공통 계약으로 반환한다', async () => {
  const transport = fake();
  const result = await provider(transport).run(context);
  assert.equal(result.text, 'VIDE_OK');
  assert.equal(result.revision, 2);
  assert.deepEqual(result.usage, {
    inputTokens: 100,
    outputTokens: 5,
    cacheReadTokens: 40,
    cacheCreationTokens: 0,
    subscriptionRemaining: null,
  });
  assert.equal(result.sessionId, undefined);
  const [server] = transport.servers();
  assert.ok(appServerIsolated(server.args, false));
  assert.equal(server.options.shell, false);
  const [start] = transport.method('thread/start');
  assert.equal(start.params.ephemeral, true);
  assert.equal(
    start.params.developerInstructions,
    `${codexInstructions(undefined, provider(transport).instructions)}\n\n${questionRule}`,
  );
  assert.equal(start.params.config['mcp_servers.rhino.enabled'], false);
  const [turn] = transport.method('turn/start');
  assert.ok(turn.params.input[0].text.includes('included'));
  assert.ok(!turn.params.input[0].text.includes('excluded'));
  // A run without a session keeps no process.
  assert.deepEqual(liveCodexThreads(), []);
});

test('대화: 한 프로세스를 턴 사이에 유지하고, 도구가 바뀌면 같은 스레드를 새 설정으로 다시 연다', async () => {
  const transport = fake({ turns: [reply('첫 답'), reply('둘째 답'), reply('셋째 답')] });
  const opening = await provider(transport, {
    session: { id: '11111111-2222-4333-8444-555555555555', resume: false },
  }).run(context);
  assert.equal(opening.sessionId, THREAD);
  assert.deepEqual(liveCodexThreads(), [THREAD]);
  const [start] = transport.method('thread/start');
  assert.equal(start.params.ephemeral, false);
  // The turn's rules travel in the packet (the session instructions are the neutral ones), with
  // the question tool allowed in them.
  const packet = JSON.parse(transport.method('turn/start')[0].params.input[0].text);
  const rules = JSON.stringify(packet).match(/Rules for this turn only[^"]*/)?.[0] ?? '';
  assert.ok(rules.includes('request_user_input'), rules);

  const second = await provider(transport, { session: { id: THREAD, resume: true } }).run(context);
  assert.equal(second.text, '둘째 답');
  assert.equal(second.sessionId, THREAD);
  assert.equal(transport.servers().length, 1, 'the kept process answers the next turn');
  assert.equal(transport.method('thread/resume').length, 0);

  // A turn with VIDE's tools needs code mode: another process, the thread resumed from disk.
  const third = await provider(transport, {
    session: { id: THREAD, resume: true },
    agent: connection(),
  }).run(context);
  assert.equal(third.text, '셋째 답');
  assert.equal(transport.servers().length, 2);
  assert.ok(appServerIsolated(transport.servers()[1].args, true));
  const [resume] = transport.method('thread/resume');
  assert.equal(resume.params.threadId, THREAD);
  assert.deepEqual(resume.params.config['mcp_servers.vide'].enabled_tools, ['status']);
});

test('같은 프로세스에서 이 턴의 토큰·도구가 바뀌면 unsubscribe 후 resume으로 다시 설정한다', async () => {
  const transport = fake({ turns: [reply('하나'), reply('둘')] });
  await provider(transport, {
    session: { id: '11111111-2222-4333-8444-555555555555', resume: false },
    agent: connection('a'.repeat(64)),
  }).run(context);
  await provider(transport, {
    session: { id: THREAD, resume: true },
    agent: connection('b'.repeat(64), ['status', 'query']),
  }).run(context);
  assert.equal(transport.servers().length, 1);
  assert.equal(transport.method('thread/unsubscribe').length, 1);
  const [resume] = transport.method('thread/resume');
  assert.equal(
    resume.params.config['mcp_servers.vide'].http_headers.Authorization,
    `Bearer ${'b'.repeat(64)}`,
  );
});

test('질문 처리기가 없으면 모델의 질문에서 턴을 멈추고 질문 카드를 턴 출력으로 돌려준다', async () => {
  const ask = (server) =>
    server.send({
      id: 0,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: THREAD,
        turnId: server.turnId,
        itemId: 'call_1',
        questions: [
          {
            id: 'box_color',
            header: '상자 색상',
            question: '테스트 상자는 어떤 색으로 할까요?',
            isOther: true,
            isSecret: false,
            options: [
              { label: '빨강', description: '빨강' },
              { label: '파랑', description: '파랑' },
            ],
          },
        ],
        isBlocking: false,
        autoResolutionMs: null,
      },
    });
  const transport = fake({ turns: [ask] });
  const structured = {
    ...context,
    items: [...context.items, turnOutputItem()],
    includedIds: [...context.includedIds, 'turn-output'],
  };
  const result = await provider(transport, {
    session: { id: '11111111-2222-4333-8444-555555555555', resume: false },
  }).run(structured);
  assert.equal(transport.method('turn/interrupt').length, 1);
  assert.equal(result.questionSource, 'codex-native');
  assert.equal(result.sessionId, THREAD);
  const parsed = parseTurnOutput(result);
  assert.ok('output' in parsed);
  assert.equal(parsed.output.status, 'question');
  assert.equal(parsed.output.questions[0].id, 'box_color');
  assert.ok(transport.method('turn/start')[0].params.outputSchema);
  // The thread stays for the answer's turn.
  assert.deepEqual(liveCodexThreads(), [THREAD]);
});

test('질문 처리기가 있으면 턴 중에 카드를 보이고 고른 답으로 같은 턴을 잇는다', async () => {
  const ask = (server) => {
    server.onResponse = (message) => {
      if (message.id !== 7) return;
      server.notify('item/completed', {
        turnId: server.turnId,
        item: { type: 'agentMessage', text: '파랑으로 하겠습니다.', phase: 'final_answer' },
      });
      server.notify('turn/completed', { turn: { id: server.turnId, status: 'completed' } });
    };
    server.send({
      id: 7,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: THREAD,
        turnId: server.turnId,
        questions: [
          {
            id: 'box_color',
            header: '색상',
            question: '어떤 색?',
            isOther: false,
            options: [{ label: '빨강' }, { label: '파랑' }],
          },
        ],
        isBlocking: true,
      },
    });
  };
  const transport = fake({ turns: [ask] });
  const shown = [];
  const result = await provider(transport).run(context, {
    onQuestion: async (cards) => {
      shown.push(cards);
      return [{ id: cards[0].id, option: cards[0].options.find((o) => o.label === '파랑').id }];
    },
  });
  assert.equal(result.text, '파랑으로 하겠습니다.');
  assert.equal(shown.length, 1);
  assert.deepEqual(transport.responses.find((entry) => entry.id === 7).result, {
    answers: { box_color: { answers: ['파랑'] } },
  });
  assert.equal(transport.method('turn/interrupt').length, 0);
});

test('provider의 nativeQuestions 처리기도 받는다; 닫으면(null) 빈 답으로 계속한다', async () => {
  const ask = (server) => {
    server.onResponse = (message) => {
      if (message.id !== 3) return;
      server.notify('item/completed', {
        turnId: server.turnId,
        item: { type: 'agentMessage', text: '기본값으로 진행', phase: 'final_answer' },
      });
      server.notify('turn/completed', { turn: { id: server.turnId, status: 'completed' } });
    };
    server.send({
      id: 3,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: THREAD,
        turnId: server.turnId,
        questions: [{ id: 'q', question: '어떤 색?', options: [{ label: 'A' }, { label: 'B' }] }],
      },
    });
  };
  const transport = fake({ turns: [ask] });
  const result = await provider(transport, { nativeQuestions: async () => null }).run(context);
  assert.equal(result.text, '기본값으로 진행');
  assert.deepEqual(transport.responses.find((entry) => entry.id === 3).result, {
    answers: { q: { answers: [] } },
  });
});

test('사용자 MCP 서버가 켜져 있거나 샌드박스가 다르면 턴을 시작하지 않는다', async () => {
  for (const options of [
    { statuses: [{ name: 'rhino', runtimeStatus: 'connected', httpOrigin: null }] },
    { threadResponse: { sandbox: { type: 'dangerFullAccess' } } },
    { threadResponse: { instructionSources: ['C:/Users/x/.codex/AGENTS.md'] } },
  ]) {
    const transport = fake(options);
    await assert.rejects(provider(transport).run(context), { code: 'UNEXPECTED_TOOL_ACCESS' });
    assert.equal(transport.method('turn/start').length, 0);
  }
});

test('셸·파일·웹 항목이나 허용되지 않은 도구 호출은 턴을 멈춘다', async () => {
  for (const item of [
    { type: 'commandExecution', command: 'dir' },
    { type: 'fileChange' },
    { type: 'webSearch' },
    { type: 'mcpToolCall', server: 'rhino', tool: 'run_command' },
    { type: 'mcpToolCall', server: 'vide', tool: 'execute' },
  ]) {
    const transport = fake({
      turns: [(server) => server.notify('item/started', { turnId: server.turnId, item })],
    });
    await assert.rejects(provider(transport, { agent: connection() }).run(context), {
      code: 'UNEXPECTED_TOOL_CALL',
    });
    assert.equal(transport.method('turn/interrupt').length, 1);
  }
  // VIDE's own tool of this turn passes.
  const transport = fake({
    turns: [
      reply('도구 결과 7', [
        {
          method: 'item/started',
          params: { item: { type: 'mcpToolCall', server: 'vide', tool: 'status' } },
        },
      ]),
    ],
  });
  const progress = [];
  const result = await provider(transport, { agent: connection() }).run(context, {
    onProgress: (event) => progress.push(event),
  });
  assert.equal(result.text, '도구 결과 7');
  assert.ok(progress.some((event) => event.phase === 'tool' && event.tool === 'status'));
});

test('승인 요청은 거절하고 턴을 멈춘다', async () => {
  const transport = fake({
    turns: [
      (server) =>
        server.send({
          id: 11,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: THREAD, turnId: server.turnId, command: 'dir' },
        }),
    ],
  });
  await assert.rejects(provider(transport).run(context), { code: 'UNEXPECTED_TOOL_CALL' });
  assert.ok(transport.responses.find((entry) => entry.id === 11).error);
});

test('없는 스레드를 이으면 SESSION_LOST, 구독 한도는 PROVIDER_LIMIT로 알린다', async () => {
  const lost = fake({ resumeError: `no rollout found for thread id ${OTHER}` });
  await assert.rejects(provider(lost, { session: { id: OTHER, resume: true } }).run(context), {
    code: 'SESSION_LOST',
  });
  const limited = fake({
    turns: [
      [
        {
          method: 'turn/completed',
          params: {
            turn: { status: 'failed', error: { message: "You've hit your usage limit." } },
          },
        },
      ],
    ],
  });
  await assert.rejects(provider(limited).run(context), { code: 'PROVIDER_LIMIT' });
});

test('취소하면 turn/interrupt로 멈추고 CANCELLED를 알린다', async () => {
  const transport = fake({ turns: [() => {}] });
  const controller = new AbortController();
  const running = provider(transport).run(context, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running, { code: 'CANCELLED' });
  assert.equal(transport.method('turn/interrupt').length, 1);
});

test('API 인증이나 미로그인은 프로세스를 띄우기 전에 거절한다', async () => {
  const transport = fake({ auth: 'Not logged in' });
  await assert.rejects(provider(transport).run(context), { code: 'SUBSCRIPTION_LOGIN_REQUIRED' });
  assert.equal(transport.servers().length, 0);
});

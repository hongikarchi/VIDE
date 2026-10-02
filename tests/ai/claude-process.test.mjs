import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  BACKGROUND_SETTLE_MS,
  KeptClaudeCli,
  closeClaudeProcesses,
  liveClaudeSessions,
  processArguments,
} from '../../src/ai/claude-process.ts';
import { clearAuthStatus } from '../../src/ai/claude-cli.ts';
import { resolveAgentToken } from '../../src/ai/agent-relay.ts';

// ADR-028 / T-104: one Claude process per conversation session; each turn is a stream-json user
// message on its stdin and ends with the turn's result. The fake below speaks the shapes the real
// CLI sent in SPIKE-2026-10-02-claude-persistent-process (init on every turn, background subagents
// reported by task events and a turn of the CLI's own).

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const TOKEN = 'a'.repeat(64);
const context = (goal = '합성 대화 턴') => ({
  goal,
  revision: 1,
  items: [{ id: 'text', type: 'text', data: 'synthetic' }],
  includedIds: ['text'],
});
const init = (tools = [], servers = []) => ({
  type: 'system',
  subtype: 'init',
  session_id: SESSION,
  tools,
  mcp_servers: servers,
});
const result = (text, usage = { input_tokens: 10, output_tokens: 2 }) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  usage,
});

/**
 * A fake CLI: `--version`/`auth status` answer at once; a turn process keeps running and calls
 * `onMessage(message, child)` for every stdin line (a user message or a control line).
 */
function fakeCli(onMessage) {
  const runs = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.unref = () => {};
    const close = (code = 0) => {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      child.emit('exit', code);
      child.emit('close', code);
    };
    child.close = close;
    child.send = (event) => child.stdout.write(JSON.stringify(event) + '\n');
    if (args[0] === '--version') {
      queueMicrotask(() => {
        child.stdout.write('2.1.287 (Claude Code)\n');
        close();
      });
      return child;
    }
    if (args[0] === 'auth') {
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
        close();
      });
      return child;
    }
    const run = { args, options, lines: [], child };
    runs.push(run);
    let buffer = '';
    child.stdin.on('data', (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        run.lines.push(line);
        setTimeout(() => onMessage(line, child, run), 1);
      }
    });
    return child;
  };
  return { spawnProcess, runs };
}
const provider = (fake, options = {}) =>
  new KeptClaudeCli({
    executable: process.execPath,
    spawnProcess: fake.spawnProcess,
    session: { id: SESSION, resume: false },
    loginKey: () => 'tester',
    stopGraceMs: 50,
    settleMs: 30,
    // The fakes have no pid: ending one closes it (a real process is ended with taskkill /T).
    killProcess: async (child) => {
      child.close(143);
      return true;
    },
    ...options,
  });
const answerEachTurn = (message, child) => {
  if (message.type !== 'user') return;
  child.send(init());
  child.send({ type: 'assistant', message: { content: [{ type: 'text', text: '생각' }] } });
  child.send(result(`답 ${message.message.content[0].text.length}`));
};

test.afterEach(async () => {
  await closeClaudeProcesses();
  clearAuthStatus();
});

test('two turns of a conversation run in one process; the second resumes nothing and starts at once', async () => {
  const fake = fakeCli(answerEachTurn);
  const first = provider(fake);
  const one = await first.run(context());
  assert.match(one.text, /^답 /);
  assert.equal(first.timing.processReused, false);
  assert.equal(fake.runs.length, 1);
  const args = fake.runs[0].args;
  assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--session-id') + 1], SESSION);
  assert.deepEqual(liveClaudeSessions(), [SESSION]);
  // The next turn of the same conversation: resume is set, the process key is the same.
  const second = provider(fake, { session: { id: SESSION, resume: true } });
  const two = await second.run(context('두 번째'));
  assert.match(two.text, /^답 /);
  assert.equal(second.timing.processReused, true);
  assert.equal(fake.runs.length, 1, 'no second process');
  assert.equal(fake.runs[0].lines.filter((line) => line.type === 'user').length, 2);
  // Each turn carries its own rules item in its user message.
  const packet = JSON.parse(fake.runs[0].lines[1].message.content[0].text);
  assert.equal(packet.items[0].id, 'turn-rules');
  assert.ok(second.timing.firstOutputAt >= second.timing.spawnAt);
});

test('a turn with another model, effort or tool set ends the kept process and resumes the session in a new one', async () => {
  const fake = fakeCli(answerEachTurn);
  await provider(fake).run(context());
  await provider(fake, { session: { id: SESSION, resume: true }, effort: 'high' }).run(context());
  assert.equal(fake.runs.length, 2);
  const args = fake.runs[1].args;
  assert.equal(args[args.indexOf('--resume') + 1], SESSION);
  assert.ok(!args.includes('--session-id'));
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.deepEqual(processArguments(['-p', '--resume', SESSION, '--model', 'x']), [
    '-p',
    '--model',
    'x',
  ]);
});

test('a kept process ends after its idle time and on engine shutdown', async () => {
  const fake = fakeCli(answerEachTurn);
  await provider(fake, { idleMs: 20 }).run(context());
  assert.deepEqual(liveClaudeSessions(), [SESSION]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(liveClaudeSessions(), []);
  await provider(fake, { session: { id: SESSION, resume: true } }).run(context());
  assert.equal(fake.runs.length, 2, 'the idle-ended process is started again with --resume');
  assert.deepEqual(liveClaudeSessions(), [SESSION]);
  await closeClaudeProcesses();
  assert.deepEqual(liveClaudeSessions(), []);
});

test('a stopped turn is interrupted in its process, which stays for the next turn', async () => {
  const fake = fakeCli((message, child) => {
    if (message.type === 'user') {
      child.send(init());
      return; // works until interrupted
    }
    if (message.type === 'control_request' && message.request.subtype === 'interrupt') {
      child.send({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id },
      });
      child.send({ type: 'result', subtype: 'error_during_execution', is_error: true });
    }
  });
  const controller = new AbortController();
  const states = [];
  const running = provider(fake).run(context(), {
    signal: controller.signal,
    onProgress: (event) => states.push(event.state),
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running, { code: 'CANCELLED' });
  assert.ok(states.includes('stopped'));
  assert.deepEqual(liveClaudeSessions(), [SESSION], 'the process is kept');
});

test('a process that ignores the interrupt is ended; an unconfirmed end is not reported as stopped', async () => {
  const fake = fakeCli((message, child) => {
    if (message.type === 'user') child.send(init());
  });
  const controller = new AbortController();
  const running = provider(fake).run(context(), { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running, { code: 'CANCELLED' });
  assert.deepEqual(liveClaudeSessions(), [], 'the ended process is not kept');

  const stuck = fakeCli((message, child) => {
    if (message.type === 'user') child.send(init());
  });
  const again = new AbortController();
  const states = [];
  const hanging = provider(stuck, { killProcess: async () => false }).run(context(), {
    signal: again.signal,
    onProgress: (event) => states.push(event.state),
  });
  setTimeout(() => again.abort(), 20);
  await assert.rejects(hanging, { code: 'STOP_UNCONFIRMED' });
  assert.ok(!states.includes('stopped'));
});

test('a process that dies mid-turn fails the turn as before and the next turn starts a new one', async () => {
  let turns = 0;
  const fake = fakeCli((message, child) => {
    if (message.type !== 'user') return;
    turns++;
    if (turns === 1) {
      child.send(init());
      child.stderr.write('boom');
      child.close(1);
      return;
    }
    answerEachTurn(message, child);
  });
  await assert.rejects(provider(fake).run(context()), { code: 'PROVIDER_FAILED' });
  assert.deepEqual(liveClaudeSessions(), []);
  const next = await provider(fake, { session: { id: SESSION, resume: true } }).run(context());
  assert.match(next.text, /^답 /);
  assert.equal(fake.runs.length, 2);
  assert.ok(fake.runs[1].args.includes('--resume'));
});

test('a resumed session without its transcript is SESSION_LOST', async () => {
  const fake = fakeCli((message, child) => {
    child.stderr.write('No conversation found with session ID');
    child.close(1);
  });
  await assert.rejects(provider(fake, { session: { id: SESSION, resume: true } }).run(context()), {
    code: 'SESSION_LOST',
  });
});

test('the turn waits for the subagents it started and answers with the last result', async () => {
  const warnings = [];
  const fake = fakeCli((message, child) => {
    if (message.type !== 'user') return;
    child.send(init());
    child.send({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Agent', input: { prompt: 'x' } }] },
    });
    child.send({ type: 'system', subtype: 'task_started', task_id: 't1' });
    child.send(result('기다리는 중'));
    setTimeout(() => {
      child.send({
        type: 'assistant',
        parent_tool_use_id: 'toolu_1',
        message: { content: [{ type: 'text', text: '하위 결과' }] },
      });
      child.send({ type: 'system', subtype: 'task_notification', task_id: 't1' });
      child.send(init());
      child.send(result('최종 답', { input_tokens: 5, output_tokens: 1 }));
    }, 20);
  });
  const value = await provider(fake, {
    agent: {
      url: 'http://127.0.0.1:1234/mcp',
      token: TOKEN,
      tools: ['query'],
    },
    builtinTools: { work: true },
  })
    .run(context(), { onProgress: (event) => warnings.push(event) })
    .catch((cause) => cause);
  // The connection needs VIDE's server in the init event; this fake reports none: a warning, and
  // the turn goes on (ADR-031 8).
  assert.equal(value.text, '최종 답');
  assert.ok(
    warnings.some(
      (event) => event.state === 'provider-warning' && event.reason === 'UNEXPECTED_TOOL_ACCESS',
    ),
  );
  // The turn succeeded, so its process is kept: end it so the next fake starts its own.
  await closeClaudeProcesses();

  const fake2 = fakeCli((message, child) => {
    if (message.type !== 'user') return;
    child.send(init(['Task', 'mcp__vide__query'], [{ name: 'vide', status: 'connected' }]));
    child.send({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Agent', input: { prompt: 'x' } }] },
    });
    child.send({ type: 'system', subtype: 'task_started', task_id: 't1' });
    child.send(result('기다리는 중'));
    setTimeout(() => {
      child.send({ type: 'system', subtype: 'task_notification', task_id: 't1' });
      child.send(init(['Task', 'mcp__vide__query'], [{ name: 'vide', status: 'connected' }]));
      child.send(result('최종 답', { input_tokens: 5, output_tokens: 1 }));
    }, 20);
  });
  const answer = await provider(fake2, {
    agent: { url: 'http://127.0.0.1:1234/mcp', token: TOKEN, tools: ['query'] },
    builtinTools: { work: true },
  }).run(context());
  assert.equal(answer.text, '최종 답');
  assert.equal(answer.usage.inputTokens, 15, 'usage of both results');
  const args = fake2.runs[0].args;
  assert.ok(args[args.indexOf('--tools') + 1].split(',').includes('Task'));
  assert.ok(args[args.indexOf('--allowedTools') + 1].split(',').includes('TaskCreate'));
  assert.ok(!args[args.indexOf('--tools') + 1].split(',').includes('WebSearch'));
  assert.ok(BACKGROUND_SETTLE_MS > 0);
});

test('without a turn of its own after the last report, the last result stands', async () => {
  const fake = fakeCli((message, child) => {
    if (message.type !== 'user') return;
    child.send(init());
    child.send({ type: 'system', subtype: 'task_started', task_id: 't9' });
    child.send(result('먼저 낸 답'));
    setTimeout(
      () =>
        child.send({ type: 'system', subtype: 'task_updated', task_id: 't9', status: 'failed' }),
      10,
    );
  });
  const started = Date.now();
  const value = await provider(fake, { settleMs: 60 }).run(context());
  assert.equal(value.text, '먼저 낸 답');
  assert.ok(Date.now() - started >= 60);
});

test('questions and images keep working on the kept stdin; the process token stands for the turn token only during the turn', async () => {
  let seenToken;
  const fake = fakeCli((message, child, run) => {
    if (message.type === 'user') {
      seenToken = resolveAgentToken(run.options.env.VIDE_AGENT_TOKEN);
      child.send(init(['mcp__vide__query'], [{ name: 'vide', status: 'connected' }]));
      child.send({
        type: 'control_request',
        request_id: 'q-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: '어느 쪽?',
                options: [{ label: '왼쪽' }, { label: '오른쪽' }],
              },
            ],
          },
        },
      });
      return;
    }
    if (message.type === 'control_response') child.send(result('질문 뒤 답'));
  });
  const images = {
    ...context(),
    items: [
      ...context().items,
      {
        id: 'img',
        type: 'image',
        data: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      },
    ],
    includedIds: ['text', 'img'],
  };
  const value = await provider(fake, {
    agent: { url: 'http://127.0.0.1:1234/mcp', token: TOKEN, tools: ['query'] },
    nativeQuestions: async (cards) => [{ id: cards[0].id, option: 'o2' }],
  }).run(images);
  assert.equal(value.text, '질문 뒤 답');
  const run = fake.runs[0];
  const processToken = run.options.env.VIDE_AGENT_TOKEN;
  assert.match(processToken, /^[a-f0-9]{64}$/);
  assert.notEqual(processToken, TOKEN, 'the process carries its own token');
  assert.equal(seenToken, TOKEN, 'during the turn it stands for the turn token');
  assert.equal(
    resolveAgentToken(processToken),
    processToken,
    'after the turn it stands for nothing',
  );
  const user = run.lines.find((line) => line.type === 'user');
  assert.equal(user.message.content[1].type, 'image');
  const answer = run.lines.find((line) => line.type === 'control_response');
  assert.equal(answer.response.response.updatedInput.answers['어느 쪽?'], '오른쪽');
  assert.ok(run.args.includes('--permission-prompt-tool'));
});

test('a turn has no total output cap; one line past 16 MB stops it', async () => {
  const big = 'x'.repeat(600 * 1024);
  const fake = fakeCli((message, child) => {
    if (message.type !== 'user') return;
    child.send(init());
    for (let i = 0; i < 4; i++)
      child.send({ type: 'assistant', message: { content: [{ type: 'text', text: big }] } });
    child.send(result('2 MB 넘게 받은 뒤의 답'));
  });
  const value = await provider(fake).run(context());
  assert.equal(value.text, '2 MB 넘게 받은 뒤의 답');
  await closeClaudeProcesses();

  const huge = fakeCli((message, child) => {
    if (message.type !== 'user') return;
    child.send(init());
    child.stdout.write('{"type":"assistant","x":"' + 'y'.repeat(16 * 1024 * 1024 + 10));
  });
  await assert.rejects(provider(huge, { session: { id: SESSION, resume: true } }).run(context()), {
    code: 'OUTPUT_TOO_LARGE',
  });
});

test('a subagent that reported before the result: the turn waits for the CLI turn that reads the report', async () => {
  let turns = 0;
  const fake = fakeCli((message, child) => {
    if (message.type !== 'user') return;
    turns++;
    if (turns === 1) {
      child.send(init());
      child.send({ type: 'system', subtype: 'task_started', task_id: 't1' });
      child.send({ type: 'system', subtype: 'task_notification', task_id: 't1' });
      child.send(result('중간 답'));
      setTimeout(() => {
        child.send(init());
        child.send(result('보고를 읽은 답'));
      }, 40);
      return;
    }
    setTimeout(() => {
      child.send(init());
      child.send(result('둘째 턴의 답'));
    }, 30);
  });
  const first = await provider(fake, { settleMs: 150 }).run(context());
  assert.equal(first.text, '보고를 읽은 답');
  const second = await provider(fake, { session: { id: SESSION, resume: true } }).run(context());
  assert.equal(second.text, '둘째 턴의 답');
  assert.equal(fake.runs.length, 1);
});

test('output while no turn listens ends the kept process; the next turn resumes in a new one', async () => {
  let turns = 0;
  const fake = fakeCli((message, child) => {
    if (message.type !== 'user') return;
    turns++;
    child.send(init());
    if (turns === 1) {
      child.send({ type: 'system', subtype: 'task_started', task_id: 't1' });
      child.send({ type: 'system', subtype: 'task_notification', task_id: 't1' });
      child.send(result('먼저 낸 답'));
      // The CLI's own turn starts after VIDE stopped waiting (settle 30 ms).
      setTimeout(() => {
        child.send(init());
        child.send(result('늦은 답'));
      }, 80);
      return;
    }
    child.send(result('둘째 턴의 답'));
  });
  const first = await provider(fake).run(context());
  assert.equal(first.text, '먼저 낸 답');
  assert.deepEqual(liveClaudeSessions(), [SESSION]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(liveClaudeSessions(), [], 'the process that spoke between turns is ended');
  const second = await provider(fake, { session: { id: SESSION, resume: true } }).run(context());
  assert.equal(second.text, '둘째 턴의 답');
  assert.equal(fake.runs.length, 2);
  assert.ok(fake.runs[1].args.includes('--resume'));
});

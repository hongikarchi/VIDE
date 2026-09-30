import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  ClaudeCli,
  answerToolRequest,
  nativeQuestionArguments,
  nativeQuestionCards,
  nativeQuestionInputWithAnswers,
} from '../../src/ai/claude-cli.ts';

// SPIKE-2026-09-30-native-questions-claude: Claude Code's AskUserQuestion reaches VIDE as a
// `can_use_tool` control request (--permission-prompt-tool stdio); VIDE shows its question cards
// and answers with `updatedInput.answers`. Events below are the shapes the real CLI sent.
const askInput = {
  questions: [
    {
      question: '기둥 간격은 어느 쪽으로 할까요?',
      header: '간격',
      multiSelect: false,
      options: [
        { label: '6 m', description: '지금 도면과 같게' },
        { label: '8 m', description: '넓은 쪽' },
      ],
    },
  ],
};
const context = {
  goal: '합성 질문 시험',
  revision: 1,
  items: [{ id: 'text', type: 'text', data: 'synthetic' }],
  includedIds: ['text'],
};

test('AskUserQuestion input becomes question cards and the answers go back by question text', () => {
  const cards = nativeQuestionCards(askInput);
  assert.deepEqual(cards, [
    {
      id: 'q1',
      title: '기둥 간격은 어느 쪽으로 할까요?',
      options: [
        { id: 'o1', label: '6 m', hint: '지금 도면과 같게' },
        { id: 'o2', label: '8 m', hint: '넓은 쪽' },
      ],
      allowFree: true,
    },
  ]);
  assert.deepEqual(nativeQuestionInputWithAnswers(askInput, [{ id: 'q1', option: 'o2' }]).answers, {
    '기둥 간격은 어느 쪽으로 할까요?': '8 m',
  });
  assert.deepEqual(
    nativeQuestionInputWithAnswers(askInput, [{ id: 'q1', option: 'o1', text: '외곽만' }]).answers,
    { '기둥 간격은 어느 쪽으로 할까요?': '6 m — 외곽만' },
  );
  // More than the cards hold, or a malformed input, is not shown.
  const four = { questions: Array.from({ length: 4 }, () => askInput.questions[0]) };
  assert.equal(nativeQuestionCards(four), undefined);
  assert.equal(nativeQuestionCards({ questions: [{ question: 'x', options: [] }] }), undefined);
});

test('only AskUserQuestion is answered; other tools and closed cards are denied', async () => {
  const signal = new AbortController().signal;
  const other = await answerToolRequest({ tool_name: 'Bash', input: {} }, async () => [], signal);
  assert.equal(other.behavior, 'deny');
  const closed = await answerToolRequest(
    { tool_name: 'AskUserQuestion', input: askInput },
    async () => null,
    signal,
  );
  assert.equal(closed.behavior, 'deny');
  const answered = await answerToolRequest(
    { tool_name: 'AskUserQuestion', input: askInput },
    async (cards) => [{ id: cards[0].id, option: 'o1' }],
    signal,
  );
  assert.equal(answered.behavior, 'allow');
  assert.equal(answered.updatedInput.answers['기둥 간격은 어느 쪽으로 할까요?'], '6 m');
  assert.deepEqual(answered.updatedInput.questions, askInput.questions);
});

test('the flag offers the tool, routes prompts over stdio and leaves dontAsk otherwise', () => {
  const base = ['-p', '--tools', '', '--permission-mode', 'dontAsk', '--output-format', 'x'];
  assert.deepEqual(nativeQuestionArguments([...base], false), base);
  const args = nativeQuestionArguments([...base]);
  assert.equal(args[args.indexOf('--tools') + 1], 'AskUserQuestion');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
  const draft = nativeQuestionArguments(['--tools', 'Read,Write', '--input-format', 'stream-json']);
  assert.equal(draft[1], 'Read,Write,AskUserQuestion');
  assert.equal(draft.filter((value) => value === '--input-format').length, 1);
});

/** A fake CLI that asks once over the control channel and finishes after the answer. */
function questioningCli(requests) {
  const calls = [];
  const spawnProcess = (_executable, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.unref = () => {};
    const close = () => {
      child.exitCode = 0;
      child.emit('exit', 0);
      child.emit('close', 0);
    };
    const emit = (event) => child.stdout.write(JSON.stringify(event) + '\n');
    const call = { args, lines: [], ended: false };
    calls.push(call);
    if (args[0] === '--version') {
      queueMicrotask(() => {
        child.stdout.write('2.1.285 (Claude Code)\n');
        close();
      });
      return child;
    }
    if (args[0] === 'auth') {
      queueMicrotask(() => {
        emit({ loggedIn: true, authMethod: 'claude.ai' });
        close();
      });
      return child;
    }
    let buffer = '';
    const pending = [...requests];
    child.stdin.on('data', (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        call.lines.push(message);
        if (message.type === 'user') {
          emit({ type: 'system', subtype: 'init', tools: ['AskUserQuestion'], mcp_servers: [] });
          emit({
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', name: 'AskUserQuestion', input: askInput }],
            },
          });
        }
        const next = pending.shift();
        if (next) emit(next);
        else if (message.type === 'control_response') {
          const answer = message.response.response?.updatedInput?.answers ?? {};
          emit({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: Object.values(answer).join(',') || 'no answer',
            usage: {},
          });
        }
      }
    });
    child.stdin.on('finish', () => {
      call.ended = true;
      // Plain text input (no flag): the CLI would start after stdin ends.
      if (!call.lines.length) {
        emit({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
        for (const request of pending) emit(request);
      }
      setTimeout(close, 5);
    });
    return child;
  };
  return { spawnProcess, calls };
}
const canUse = (id, tool_name = 'AskUserQuestion', input = askInput) => ({
  type: 'control_request',
  request_id: id,
  request: { subtype: 'can_use_tool', tool_name, input, tool_use_id: 'toolu_1' },
});

test('a run with the flag shows the cards, feeds the answer back and keeps run time apart', async () => {
  const fake = questioningCli([canUse('req-1')]);
  const shown = [];
  const phases = [];
  const cli = new ClaudeCli({
    executable: process.execPath,
    spawnProcess: fake.spawnProcess,
    timeoutMs: 50,
    nativeQuestions: async (cards) => {
      shown.push(cards);
      // The user takes longer than the run's own limit: the timer is paused while asking.
      await new Promise((resolve) => setTimeout(resolve, 120));
      return [{ id: 'q1', option: 'o2' }];
    },
  });
  const value = await cli.run(context, { onProgress: (event) => phases.push(event.phase) });
  assert.equal(value.text, '8 m');
  assert.equal(shown.length, 1);
  assert.equal(shown[0][0].title, '기둥 간격은 어느 쪽으로 할까요?');
  assert.ok(phases.includes('question'));
  const run = fake.calls.find((entry) => entry.args[0] === '-p');
  assert.equal(run.args[run.args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(run.lines[0].type, 'user');
  assert.equal(JSON.parse(run.lines[0].message.content[0].text).goal, '합성 질문 시험');
  const response = run.lines.find((line) => line.type === 'control_response').response;
  assert.equal(response.request_id, 'req-1');
  assert.equal(response.response.behavior, 'allow');
  assert.ok(run.ended);
});

test('unknown control requests get an error reply; other tools are denied without a card', async () => {
  const fake = questioningCli([
    { type: 'control_request', request_id: 'req-0', request: { subtype: 'hook_callback' } },
    canUse('req-1', 'Bash', { command: 'dir' }),
  ]);
  let asked = 0;
  const cli = new ClaudeCli({
    executable: process.execPath,
    spawnProcess: fake.spawnProcess,
    nativeQuestions: async () => {
      asked++;
      return null;
    },
  });
  const value = await cli.run(context);
  assert.equal(value.text, 'no answer');
  assert.equal(asked, 0);
  const run = fake.calls.find((entry) => entry.args[0] === '-p');
  const replies = run.lines.filter((line) => line.type === 'control_response');
  assert.deepEqual(replies[0].response, {
    subtype: 'error',
    request_id: 'req-0',
    error: 'unsupported',
  });
  assert.equal(replies[1].response.response.behavior, 'deny');
});

test('without the flag a control request or AskUserQuestion is not accepted', async () => {
  const fake = questioningCli([canUse('req-1')]);
  const cli = new ClaudeCli({ executable: process.execPath, spawnProcess: fake.spawnProcess });
  await assert.rejects(cli.run(context), { code: 'INVALID_PROVIDER_OUTPUT' });
  const run = fake.calls.find((entry) => entry.args[0] === '-p');
  assert.equal(run.args[run.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!run.args.includes('--permission-prompt-tool'));
});

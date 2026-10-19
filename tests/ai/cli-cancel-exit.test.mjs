// T-366: a cancelled turn's CLI process ends within seconds (it once lived 606 s: a kept process
// that answered the interrupt was left for its 10 min idle time). Real child processes stand for
// the CLI here, so the real end (`killOwnedProcess`, taskkill /T on Windows) is what is measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { ClaudeCli, clearAuthStatus } from '../../src/ai/claude-cli.ts';
import {
  KeptClaudeCli,
  closeClaudeProcesses,
  liveClaudeSessions,
} from '../../src/ai/claude-process.ts';

const SESSION = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const context = () => ({
  goal: '합성 취소 턴',
  revision: 1,
  items: [{ id: 'text', type: 'text', data: 'synthetic' }],
  includedIds: ['text'],
});

/** The CLI's turn: init on the first input, then work forever; `answer` makes it end a turn on interrupt (and stay alive). */
const script = (answer) => `
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
let buffer = '', started = false;
process.stdin.on('data', (d) => {
  buffer += d;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const line = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (line.type === 'user' && !started) {
      started = true;
      out({ type: 'system', subtype: 'init', session_id: ${JSON.stringify(SESSION)}, tools: [], mcp_servers: [] });
    }
    if (${answer} && line.type === 'control_request' && line.request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: line.request_id } });
      out({ type: 'result', subtype: 'error_during_execution', is_error: true });
    }
  }
});
process.stdin.on('end', () => {});
setInterval(() => {}, 1000);
`;

/** `--version`/`auth status` answer at once; a turn is a real node process running `script`. */
function cli({ answer }) {
  const turns = [];
  const spawnProcess = (executable, args, options) => {
    if (args[0] === '--version' || args[0] === 'auth') {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      queueMicrotask(() => {
        child.stdout.write(
          args[0] === '--version'
            ? '2.1.287 (Claude Code)\n'
            : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
        );
        child.exitCode = 0;
        child.emit('exit', 0);
        child.emit('close', 0);
      });
      return child;
    }
    const child = spawn(process.execPath, ['-e', script(answer)], {
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const turn = { child, closedAt: undefined };
    child.once('close', () => (turn.closedAt = Date.now()));
    turns.push(turn);
    return child;
  };
  return { spawnProcess, turns };
}

/** Cancels once the turn is running and returns how long the process lived after the cancel. */
async function cancelRunning(provider, fake) {
  const controller = new AbortController();
  let cancelledAt;
  const running = provider.run(context(), {
    signal: controller.signal,
    onProgress: (event) => {
      if (event.state === 'running' && !cancelledAt) {
        cancelledAt = Date.now();
        controller.abort();
      }
    },
  });
  await assert.rejects(running, { code: 'CANCELLED' });
  const turn = fake.turns.at(-1);
  if (turn.closedAt === undefined)
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      turn.child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  assert.ok(turn.closedAt !== undefined, 'the process ended');
  return turn.closedAt - cancelledAt;
}

test.afterEach(async () => {
  await closeClaudeProcesses();
  clearAuthStatus();
});

test('단발 실행: 취소하면 소유한 프로세스를 바로 끝내고 종료까지의 시간을 남긴다', async () => {
  const fake = cli({ answer: false });
  const provider = new ClaudeCli({
    executable: process.execPath,
    spawnProcess: fake.spawnProcess,
    nativeQuestions: async () => ({}),
  });
  const ms = await cancelRunning(provider, fake);
  assert.ok(ms <= 6000, `ended ${ms} ms after the cancel`);
  assert.equal(typeof provider.timing.stopExitMs, 'number');
  assert.ok(provider.timing.stopExitMs <= 6000);
});

for (const answer of [true, false])
  test(`유지 프로세스: 취소하면 interrupt 뒤 프로세스를 끝낸다 (CLI가 ${answer ? '턴을 끝내도' : '응답하지 않아도'})`, async () => {
    const fake = cli({ answer });
    const provider = new KeptClaudeCli({
      executable: process.execPath,
      spawnProcess: fake.spawnProcess,
      session: { id: SESSION, resume: false },
      loginKey: () => 'tester',
    });
    // 응답하지 않으면 interrupt 대기(2 s) 뒤 강제 종료하므로 완료 기준(취소 5 s 안 종료)을 상한으로 둔다.
    const limit = answer ? 6000 : 8000;
    const ms = await cancelRunning(provider, fake);
    assert.ok(ms <= limit, `ended ${ms} ms after the cancel`);
    assert.deepEqual(liveClaudeSessions(), [], 'the cancelled turn leaves no kept process');
    assert.equal(typeof provider.timing.stopExitMs, 'number');
    assert.ok(provider.timing.stopExitMs <= limit);
  });

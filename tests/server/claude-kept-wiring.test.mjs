import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { ClaudeCli, clearAuthStatus } from '../../src/ai/claude-cli.ts';
import {
  CLAUDE_PERSISTENT_FLAG,
  KeptClaudeCli,
  closeClaudeProcesses,
  liveClaudeSessions,
} from '../../src/ai/claude-process.ts';

// ADR-028 / T-104·T-105 through Execution's default factory: a conversation turn of Claude runs in
// the conversation's kept process, a single run and VIDE_CLAUDE_PERSISTENT=0 do not, closing the
// engine ends kept processes, and the provider's own tools go only to conversation turns.

const SESSION = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const AGENT = { url: 'http://127.0.0.1:1234/mcp', token: 'b'.repeat(64), tools: ['query'] };
const context = {
  goal: '합성 대화 턴',
  revision: 1,
  items: [{ id: 'text', type: 'text', data: 'synthetic' }],
  includedIds: ['text'],
};

function fakeCli() {
  const runs = [];
  const spawnProcess = (executable, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.unref = () => {};
    child.kill = () => close(143);
    const close = (code = 0) => {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      child.emit('exit', code);
      child.emit('close', code);
    };
    const send = (event) => child.stdout.write(JSON.stringify(event) + '\n');
    if (args[0] === '--version' || args[0] === 'auth') {
      queueMicrotask(() => {
        child.stdout.write(
          args[0] === 'auth'
            ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
            : '2.1.287 (Claude Code)\n',
        );
        close();
      });
      return child;
    }
    const run = { args, child };
    runs.push(run);
    let buffer = '';
    child.stdin.on('data', (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (line.type !== 'user') continue;
        setTimeout(() => {
          send({
            type: 'system',
            subtype: 'init',
            session_id: SESSION,
            tools: [],
            mcp_servers: [],
          });
          send({ type: 'result', subtype: 'success', is_error: false, result: '답', usage: {} });
        }, 1);
      }
    });
    return run.child;
  };
  return { spawnProcess, runs };
}

const executionOf = () => new Execution(new Workspace(new Store(':memory:')));
const withFake = (provider, fake) => {
  provider.spawnProcess = fake.spawnProcess;
  // The kept process is ended through the fake (it has no pid for taskkill).
  if (provider instanceof KeptClaudeCli)
    provider.killProcess = async (child) => {
      child.kill();
      return true;
    };
  return provider;
};

test.afterEach(async () => {
  await closeClaudeProcesses();
  clearAuthStatus();
});

test('a Claude conversation turn runs in the kept process, reused on the next turn and ended by close()', async () => {
  const execution = executionOf();
  const fake = fakeCli();
  const input = { provider: 'claude-cli', conversationId: 'c1' };
  const first = execution.provider(input, undefined, { id: SESSION, resume: false });
  assert.ok(first instanceof KeptClaudeCli);
  withFake(first, fake);
  assert.equal((await first.run(context)).text, '답');
  const second = withFake(
    execution.provider(input, undefined, { id: SESSION, resume: true }),
    fake,
  );
  await second.run(context);
  assert.equal(second.timing.processReused, true);
  assert.equal(fake.runs.length, 1, 'one process for both turns');
  assert.deepEqual(liveClaudeSessions(), [SESSION]);
  await execution.close();
  assert.deepEqual(liveClaudeSessions(), [], 'engine shutdown ends the kept process');
});

test('a single run and VIDE_CLAUDE_PERSISTENT=0 use one process per run', async () => {
  const execution = executionOf();
  const single = execution.provider({ provider: 'claude-cli' });
  assert.ok(single instanceof ClaudeCli && !(single instanceof KeptClaudeCli));
  const saved = process.env[CLAUDE_PERSISTENT_FLAG];
  process.env[CLAUDE_PERSISTENT_FLAG] = '0';
  try {
    const turn = execution.provider({ provider: 'claude-cli', conversationId: 'c1' }, undefined, {
      id: SESSION,
      resume: false,
    });
    assert.ok(!(turn instanceof KeptClaudeCli));
  } finally {
    if (saved === undefined) delete process.env[CLAUDE_PERSISTENT_FLAG];
    else process.env[CLAUDE_PERSISTENT_FLAG] = saved;
  }
});

test('host turns get the work tools only inside a conversation', () => {
  const execution = executionOf();
  const instructions = { mode: 'modeling', projectId: 'p1' };
  const outside = execution.provider({ provider: 'claude-cli' }, AGENT, undefined, instructions);
  assert.equal(outside.builtin, undefined, 'a host request outside a conversation gets none');
  const inside = execution.provider(
    { provider: 'claude-cli', conversationId: 'c1' },
    AGENT,
    { id: SESSION, resume: false },
    instructions,
  );
  assert.deepEqual({ ...inside.builtin }, { work: true, web: true });
  const review = execution.provider(
    { provider: 'claude-cli', conversationId: 'c1' },
    AGENT,
    undefined,
    { mode: 'review', projectId: 'p1' },
  );
  assert.equal(review.builtin, undefined, "a jig's AI review gets none");
});

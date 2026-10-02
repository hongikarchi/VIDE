import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaudeCli, IdleClock, clearAuthStatus } from '../../src/ai/claude-cli.ts';
import {
  CLAUDE_FILE_TOOLS,
  turnRules,
  workFolderArguments,
  workFolderRule,
} from '../../src/ai/agent-connection.ts';
import { CodexCli } from '../../src/ai/codex-cli.ts';
import { CodexAppServer } from '../../src/ai/codex-app-server.ts';

// ADR-031 8 (T-122): the CLIs' own read, search, write and shell tools in the project work folder,
// outside it each use asked through VIDE's permission handler; a call outside the allowlist never
// ends the turn; only time without output counts. Synthetic CLI processes only.

const files = {
  cwd: 'C:\\work\\project',
  dirs: ['C:\\work\\refs'],
  attachments: ['C:\\data\\attachments\\p1\\a.png'],
};
const context = () => ({ goal: '도면 폴더를 정리', revision: 1, items: [], includedIds: [] });
const init = { type: 'system', subtype: 'init', tools: [...CLAUDE_FILE_TOOLS], mcp_servers: [] };
const result = (text = '완료') => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  usage: { input_tokens: 1, output_tokens: 1 },
});

/** A Claude CLI that answers each stdin line with `script(line, child)` (stream-json in and out). */
function fakeClaude(script) {
  const runs = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    // No pid: a stop never reaches a real process (killOwnedProcess needs one).
    child.unref = () => {};
    child.kill = () => true;
    const close = (code = 0) => {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      child.emit('exit', code);
      child.emit('close', code);
    };
    child.send = (event) => child.stdout.write(JSON.stringify(event) + '\n');
    child.close = close;
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
    runs.push({ args, options, lines: [] });
    const run = runs.at(-1);
    let buffer = '';
    child.stdin.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        run.lines.push(line);
        script(line, child);
      }
    });
    child.stdin.on('finish', () => setTimeout(() => close(), 5));
    return child;
  };
  return { spawnProcess, runs };
}

test('work folder arguments: plain mode, the file and shell tools listed but not pre-allowed, prompts over stdio', () => {
  const args = workFolderArguments(
    [
      '-p',
      '--restricted',
      '--tools',
      'Task',
      '--permission-mode',
      'dontAsk',
      '--append-system-prompt',
      'rules',
      '--allowedTools',
      'mcp__vide__query,Task',
    ],
    files,
    { connected: true },
  );
  assert.ok(!args.includes('--restricted') && !args.includes('--safe-mode'));
  assert.deepEqual(args[args.indexOf('--tools') + 1].split(','), ['Task', ...CLAUDE_FILE_TOOLS]);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
  assert.deepEqual(
    args.flatMap((value, i) => (args[i - 1] === '--add-dir' ? [value] : [])),
    files.dirs,
  );
  // Never pre-allowed: each use the CLI does not allow itself reaches VIDE's handler.
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__vide__query,Task');
  // A connected run keeps its own rules; a single run without VIDE's tools gets the folder rule.
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'rules');
  const single = workFolderArguments(['--append-system-prompt', 'no tools'], files);
  assert.match(single[1], /project work folder "C:\\\\work\\\\project"/);
  // No work folder: the arguments are untouched.
  assert.deepEqual(workFolderArguments(['--restricted'], undefined), ['--restricted']);
  assert.match(workFolderRule({ ...files, readOnly: true }), /Plan turn: read and search files/);
  assert.match(turnRules(undefined, 'claude', { files }), /No VIDE tools are available/);
});

test('Codex exec (no approval channel) keeps the shell off and gets no work folder; the app-server gets it', () => {
  const exec = new CodexCli({ executable: process.execPath, builtinTools: { files } });
  assert.equal(exec.builtin, undefined);
  const args = exec.arguments();
  assert.ok(args.some((value, i) => value === 'shell_tool' && args[i - 1] === '--disable'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  const server = new CodexAppServer({ executable: process.execPath, builtinTools: { files } });
  assert.deepEqual(server.builtin.files.dirs, files.dirs);
  assert.match(server.developerInstructions(), /project work folder/);
});

test('Claude: a file use outside the work folder goes to VIDE and the answer goes back; the CLI runs in the folder', async () => {
  clearAuthStatus();
  const asked = [];
  const fake = fakeClaude((line, child) => {
    if (line.type === 'user') {
      child.send(init);
      child.send({
        type: 'control_request',
        request_id: 'perm-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Read',
          input: { file_path: 'D:\\other\\spec.pdf' },
          blocked_path: 'D:\\other\\spec.pdf',
        },
      });
    }
    if (line.type === 'control_response' && line.response.request_id === 'perm-1')
      child.send(result('읽었습니다'));
  });
  const cli = new ClaudeCli({
    executable: process.execPath,
    spawnProcess: fake.spawnProcess,
    builtinTools: { files },
    toolPermission: async (request) => {
      asked.push(request);
      return { allow: true };
    },
  });
  const value = await cli.run(context());
  assert.equal(value.text, '읽었습니다');
  const [run] = fake.runs;
  assert.equal(run.options.cwd, files.cwd);
  assert.ok(!run.args.includes('--restricted') && !run.args.includes('--safe-mode'));
  assert.deepEqual(asked, [
    {
      tool: 'Read',
      input: { file_path: 'D:\\other\\spec.pdf' },
      blockedPath: 'D:\\other\\spec.pdf',
    },
  ]);
  const reply = run.lines.find((line) => line.type === 'control_response');
  assert.deepEqual(reply.response.response, {
    behavior: 'allow',
    updatedInput: { file_path: 'D:\\other\\spec.pdf' },
  });
  // The rules of this single run name the folder.
  assert.match(run.args[run.args.indexOf('--append-system-prompt') + 1], /C:\\\\work\\\\project/);
});

test('Claude: a refused use answers deny with the reason and the turn goes on', async () => {
  clearAuthStatus();
  const fake = fakeClaude((line, child) => {
    if (line.type === 'user') {
      child.send(init);
      child.send({
        type: 'control_request',
        request_id: 'perm-2',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf D:\\x' } },
      });
    }
    if (line.type === 'control_response') child.send(result('거절됨을 알림'));
  });
  const value = await new ClaudeCli({
    executable: process.execPath,
    spawnProcess: fake.spawnProcess,
    builtinTools: { files },
    toolPermission: async () => ({ allow: false, message: 'FILE_ACCESS_DENIED: no' }),
  }).run(context());
  assert.equal(value.text, '거절됨을 알림');
  const reply = fake.runs[0].lines.find((line) => line.type === 'control_response');
  assert.deepEqual(reply.response.response, {
    behavior: 'deny',
    message: 'FILE_ACCESS_DENIED: no',
  });
});

test('only time without output counts: a busy turn outlives the limit, silence ends it', async () => {
  clearAuthStatus();
  // Output every 20 ms for ~200 ms against a 60 ms limit: the turn finishes.
  const busy = fakeClaude((line, child) => {
    if (line.type !== 'user') return;
    child.send(init);
    let n = 0;
    const tick = setInterval(() => {
      n++;
      if (n < 10)
        child.send({ type: 'assistant', message: { content: [{ type: 'text', text: `${n}` }] } });
      else {
        clearInterval(tick);
        child.send(result('오래 일함'));
      }
    }, 20);
  });
  const make = (fake) =>
    new ClaudeCli({
      executable: process.execPath,
      spawnProcess: fake.spawnProcess,
      builtinTools: { files },
      toolPermission: async () => ({ allow: true }),
      timeoutMs: 60,
      stopGraceMs: 50,
    });
  assert.equal((await make(busy).run(context())).text, '오래 일함');
  // A tool call that has not answered holds the clock (a long host execute is work).
  const tool = fakeClaude((line, child) => {
    if (line.type !== 'user') return;
    child.send(init);
    child.send({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }] },
    });
    setTimeout(() => {
      child.send({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] },
      });
      child.send(result('도구 끝'));
    }, 200);
  });
  assert.equal((await make(tool).run(context())).text, '도구 끝');
  // Silence after the start: the turn stops with TIMEOUT.
  const silent = fakeClaude((line, child) => {
    if (line.type === 'user') child.send(init);
    // The stop asks nothing of a single run: the process is ended.
  });
  const quiet = make(silent);
  const started = Date.now();
  await assert.rejects(quiet.run(context()), (error) =>
    ['TIMEOUT', 'STOP_UNCONFIRMED'].includes(error.code),
  );
  assert.ok(Date.now() - started < 2000);
});

test('IdleClock: re-armed by events, held by questions and open tool calls, stopped for good', async () => {
  let fired = 0;
  const clock = new IdleClock(30, () => fired++);
  clock.hold();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fired, 0);
  clock.release();
  clock.toolStarted('x');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fired, 0);
  clock.toolEnded('x');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fired, 1);
  clock.arm();
  clock.stop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fired, 1);
});

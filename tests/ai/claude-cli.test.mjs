import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  ClaudeCli,
  clearAuthStatus,
  buildPacket,
  cliArguments,
  subscriptionEnvironment,
  compareVersions,
  removeClaudeTranscript,
  sessionArguments,
  supportedCliVersion,
} from '../../src/ai/claude-cli.ts';
import { neutralInstruction } from '../../src/ai/agent-connection.ts';

const context = () => ({
  goal: '선택 자료를 설명',
  revision: 1,
  items: [
    { id: 'a', label: '허용', type: 'text', data: 'public', internalPath: 'private-path' },
    { id: 'b', label: '제외', type: 'text', data: 'secret' },
  ],
  includedIds: ['a'],
});
const init = { type: 'system', subtype: 'init', tools: [], mcp_servers: [] };
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '분석 응답',
  usage: { input_tokens: 5, output_tokens: 3 },
};

test('malformed nested provider output is rejected instead of throwing from a stream callback', async () => {
  for (const event of [
    { type: 'assistant', message: { content: { type: 'tool_use' } } },
    { ...result, usage: { input_tokens: '5' } },
    { type: 'assistant', message: { content: [null] } },
  ]) {
    const fake = transport([init, event, result]);
    await assert.rejects(
      new ClaudeCli({ executable: process.execPath, spawnProcess: fake.spawnProcess }).run(
        context(),
      ),
      { code: 'INVALID_PROVIDER_OUTPUT' },
    );
  }
});
function transport(events, { neverClose = false, version = '2.1.284 (Claude Code)' } = {}) {
  const calls = [];
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
    const close = () => {
      child.exitCode = 0;
      child.emit('exit', 0);
      child.emit('close', 0);
    };
    if (args[0] === '--version')
      queueMicrotask(() => {
        child.stdout.write(version + '\n');
        close();
      });
    else if (args[0] === 'auth')
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'not-for-output' }),
        );
        close();
      });
    else
      child.stdin.on('finish', () => {
        for (const event of events) child.stdout.write(JSON.stringify(event) + '\n');
        if (!neverClose) setTimeout(close, 5);
      });
    return child;
  };
  return { spawnProcess, calls };
}

test('전송 자료 제외는 실제 stdin에서도 유지되고 파일 경로를 인자로 넘기지 않는다', async () => {
  const fake = transport([init, result]);
  const cli = new ClaudeCli({ executable: process.execPath, spawnProcess: fake.spawnProcess });
  const value = await cli.run(context());
  const call = fake.calls.find((entry) => entry.args[0] === '-p');
  assert.equal(value.text, '분석 응답');
  assert.equal(value.usage.subscriptionRemaining, null);
  assert.ok(call.input.includes('public'));
  assert.ok(!call.input.includes('secret'));
  assert.ok(!call.input.includes('private-path'));
  assert.equal(call.options.shell, false);
  assert.ok(!call.args.includes('--bare'));
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.ok(call.args.includes('--safe-mode'));
  assert.ok(!JSON.stringify(value).includes('not-for-output'));
});

test('명시되지 않은 항목 ID·중복 ID·과도한 자료를 거절한다', () => {
  assert.throws(() => buildPacket({ ...context(), includedIds: ['missing'] }), {
    code: 'INVALID_CONTEXT',
  });
  assert.throws(() => buildPacket({ ...context(), includedIds: ['a', 'a'] }), {
    code: 'INVALID_CONTEXT',
  });
  assert.throws(
    () => buildPacket({ ...context(), items: [{ id: 'a', data: 'x'.repeat(300000) }] }),
    { code: 'CONTEXT_TOO_LARGE' },
  );
});

test('API fallback과 커스텀 환경 설정을 구독 자식 프로세스에서 제거한다', () => {
  const env = subscriptionEnvironment({
    PATH: 'ok',
    ANTHROPIC_API_KEY: 'hidden',
    ANTHROPIC_BASE_URL: 'custom',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'hidden',
    CLAUDE_CONFIG_DIR: 'other',
  });
  assert.deepEqual(env, { PATH: 'ok' });
});

test('도구 권한이나 호출이 발견되면 성공 결과가 와도 거절한다', async () => {
  for (const events of [
    [{ ...init, tools: ['Bash'] }, result],
    [
      init,
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } },
      result,
    ],
  ]) {
    const fake = transport(events),
      cli = new ClaudeCli({ executable: process.execPath, spawnProcess: fake.spawnProcess });
    await assert.rejects(cli.run(context()), (error) =>
      ['UNEXPECTED_TOOL_ACCESS', 'UNEXPECTED_TOOL_CALL'].includes(error.code),
    );
  }
});

test('취소 요청 뒤 실제 프로세스 종료를 관측해야 stopped를 알린다', async () => {
  const fake = transport([init, result]),
    controller = new AbortController(),
    states = [];
  const cli = new ClaudeCli({ executable: process.execPath, spawnProcess: fake.spawnProcess });
  await assert.rejects(
    cli.run(context(), {
      signal: controller.signal,
      onProgress: (event) => {
        states.push(event.state);
        if (event.state === 'running') controller.abort();
      },
    }),
    { code: 'CANCELLED' },
  );
  assert.deepEqual(states, ['starting', 'running', 'stopping', 'stopped']);
});

test('종료를 관측하지 못하면 stopped로 속이지 않고 불명확으로 반환한다', async () => {
  const fake = transport([init], { neverClose: true }),
    states = [];
  const cli = new ClaudeCli({
    executable: process.execPath,
    spawnProcess: fake.spawnProcess,
    timeoutMs: 20,
    stopGraceMs: 20,
  });
  await assert.rejects(cli.run(context(), { onProgress: (event) => states.push(event.state) }), {
    code: 'STOP_UNCONFIRMED',
  });
  assert.ok(states.includes('stopping'));
  assert.ok(!states.includes('stopped'));
});

test('최종 응답 누락과 공급자 오류를 성공으로 반환하지 않는다', async () => {
  for (const events of [[init], [init, { ...result, is_error: true }]]) {
    const fake = transport(events),
      cli = new ClaudeCli({ executable: process.execPath, spawnProcess: fake.spawnProcess });
    await assert.rejects(cli.run(context()), (error) =>
      ['INCOMPLETE_RESULT', 'PROVIDER_FAILED'].includes(error.code),
    );
  }
});

test('검증한 판 범위(cli-compat.json)와 판 비교', () => {
  assert.ok(supportedCliVersion('claude-cli', '2.1.284 (Claude Code)'));
  assert.ok(supportedCliVersion('claude-cli', '2.1.300'));
  assert.ok(!supportedCliVersion('claude-cli', '2.1.283'));
  assert.ok(!supportedCliVersion('claude-cli', '2.2.0'));
  assert.ok(!supportedCliVersion('claude-cli', '2.2.0-beta.1'));
  assert.ok(supportedCliVersion('codex-cli', 'codex-cli 0.157.1'));
  assert.ok(!supportedCliVersion('codex-cli', '0.157.0-alpha.3'));
  assert.ok(!supportedCliVersion('codex-cli', '0.158.0-alpha.1'));
  assert.ok(!supportedCliVersion('codex-cli', 'unknown'));
  assert.equal(compareVersions('0.154.0-alpha.6.2', '0.154.0'), -1);
  assert.equal(compareVersions('0.154.0-alpha.10', '0.154.0-alpha.6.2'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('범위 밖·읽을 수 없는 판이면 로그인 확인과 실행 전에 거절한다', async () => {
  for (const [name, version] of [
    ['newer', '2.2.0 (Claude Code)'],
    ['older', '2.1.200 (Claude Code)'],
    ['garbled', 'Claude Code'],
  ]) {
    const fake = transport([init, result], { version });
    const cli = new ClaudeCli({
      executable: resolve(`fake-claude-${name}.exe`),
      spawnProcess: fake.spawnProcess,
    });
    await assert.rejects(cli.run(context()), (error) => {
      assert.equal(error.code, 'CLI_VERSION_UNSUPPORTED');
      if (name !== 'garbled') assert.equal(error.supported, '>=2.1.284 <2.2.0');
      return true;
    });
    assert.deepEqual(
      fake.calls.map((call) => call.args[0]),
      ['--version'],
    );
  }
});

test('판 확인은 실행 파일별로 60초 동안 다시 하지 않는다', async () => {
  const fake = transport([init, result]);
  const cli = new ClaudeCli({
    executable: resolve('fake-claude-cached.exe'),
    spawnProcess: fake.spawnProcess,
  });
  await cli.run(context());
  await cli.run(context());
  assert.equal(fake.calls.filter((call) => call.args[0] === '--version').length, 1);
  assert.equal(fake.calls.filter((call) => call.args[0] === '-p').length, 2);
});

test('로그인 방식이 바뀐 신호(--bare 기본화)는 CLI_MODE_CHANGED로 멈춘다', async () => {
  // Shape collected from `claude -p --bare` on 2.1.284 (SPIKE-2026-09-30-cli-session-resume §0).
  const bare = {
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'Not logged in · Please run /login',
    terminal_reason: 'api_error',
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const fake = transport([init, bare]);
  const cli = new ClaudeCli({ executable: process.execPath, spawnProcess: fake.spawnProcess });
  await assert.rejects(cli.run(context()), { code: 'CLI_MODE_CHANGED' });
  // An ordinary API error is still a provider failure, not a mode change.
  const other = transport([
    init,
    { ...bare, result: 'API Error: 500 Internal server error', terminal_reason: 'api_error' },
  ]);
  await assert.rejects(
    new ClaudeCli({ executable: process.execPath, spawnProcess: other.spawnProcess }).run(
      context(),
    ),
    { code: 'PROVIDER_FAILED' },
  );
});

test('캐시 읽기·생성 토큰을 사용량에 기록한다', async () => {
  const fake = transport([
    init,
    {
      ...result,
      usage: {
        input_tokens: 10,
        output_tokens: 174,
        cache_read_input_tokens: 6638,
        cache_creation_input_tokens: 251,
      },
    },
  ]);
  const value = await new ClaudeCli({
    executable: process.execPath,
    spawnProcess: fake.spawnProcess,
  }).run(context());
  assert.deepEqual(value.usage, {
    inputTokens: 10,
    outputTokens: 174,
    cacheReadTokens: 6638,
    cacheCreationTokens: 251,
    subscriptionRemaining: null,
  });
  const plain = transport([init, result]);
  const unknown = await new ClaudeCli({
    executable: process.execPath,
    spawnProcess: plain.spawnProcess,
  }).run(context());
  assert.equal(unknown.usage.cacheReadTokens, null);
  assert.equal(unknown.usage.cacheCreationTokens, null);
});

// Conversation sessions (PLAN-24 T-061, ARCH-01 §2): one run per turn on one transcript.
test('세션 인자: 첫 턴 --session-id, 이후 --resume, 기록 끄기만 빼고 격리 인자는 그대로', () => {
  const id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
  const opened = sessionArguments(cliArguments(), { id, resume: false });
  const resumed = sessionArguments(cliArguments(), { id, resume: true });
  for (const args of [opened, resumed]) {
    assert.ok(!args.includes('--no-session-persistence'));
    assert.equal(args[args.indexOf('--system-prompt-snapshot') + 1], 'off');
    // The default system prompt stays; without a bundle only the neutral rules are appended.
    assert.ok(!args.includes('--system-prompt'));
    assert.equal(args[args.indexOf('--append-system-prompt') + 1], neutralInstruction);
    for (const flag of [
      '--safe-mode',
      '--strict-mcp-config',
      '--setting-sources',
      '--permission-mode',
    ])
      assert.ok(args.includes(flag));
  }
  assert.equal(opened[opened.indexOf('--session-id') + 1], id);
  assert.ok(!opened.includes('--resume'));
  assert.equal(resumed[resumed.indexOf('--resume') + 1], id);
  assert.ok(!resumed.includes('--session-id'));
  assert.throws(() => sessionArguments(cliArguments(), { id: '../x', resume: true }));
  assert.throws(
    () => new ClaudeCli({ executable: process.execPath, session: { id: 'x', resume: false } }),
    { code: 'INVALID_SESSION' },
  );
});

test('세션 턴은 중립 프롬프트를 쓰고 이번 턴 규칙을 자료로 보낸다(도구 없는 턴·도구 있는 턴)', async () => {
  const id = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
  const plain = transport([init, result]);
  await new ClaudeCli({
    executable: process.execPath,
    spawnProcess: plain.spawnProcess,
    session: { id, resume: false },
  }).run(context());
  const run = plain.calls.find((entry) => entry.args[0] === '-p');
  const packet = JSON.parse(run.input);
  assert.deepEqual(
    packet.items.map((item) => item.id),
    ['turn-rules', 'a'],
  );
  assert.match(packet.items[0].data, /No tools are available in this turn/);
  assert.ok(!run.args.includes('--system-prompt'));
  const appended = run.args[run.args.indexOf('--append-system-prompt') + 1];
  assert.ok(appended.startsWith('# VIDE 작업 지침 (공통)'));
  assert.ok(appended.endsWith(neutralInstruction));
  const connection = {
    url: 'http://127.0.0.1:4000/mcp',
    token: 'a'.repeat(64),
    tools: ['query', 'execute'],
  };
  const tools = transport([
    {
      ...init,
      tools: ['mcp__vide__query', 'mcp__vide__execute'],
      mcp_servers: [{ name: 'vide', status: 'connected' }],
    },
    result,
  ]);
  await new ClaudeCli({
    executable: process.execPath,
    spawnProcess: tools.spawnProcess,
    agent: connection,
    session: { id, resume: true },
  }).run(context());
  const toolRun = tools.calls.find((entry) => entry.args[0] === '-p');
  assert.ok(toolRun.args.includes('--restricted'));
  assert.equal(toolRun.args[toolRun.args.indexOf('--resume') + 1], id);
  assert.ok(!toolRun.args.includes('--system-prompt'));
  const toolPrompt = toolRun.args[toolRun.args.indexOf('--append-system-prompt') + 1];
  // A session keeps the neutral rules: the tool rules travel in the packet, not the prompt.
  assert.ok(toolPrompt.endsWith(neutralInstruction));
  assert.match(toolPrompt, /# 모델링 지침/);
  assert.equal(
    toolRun.args[toolRun.args.indexOf('--allowedTools') + 1],
    'mcp__vide__query,mcp__vide__execute',
  );
  assert.match(
    JSON.parse(toolRun.input).items[0].data,
    /Available tools: the vide MCP tools query, execute/,
  );
  // Without a session the single-run prompts stay as they were.
  const single = transport([init, result]);
  await new ClaudeCli({ executable: process.execPath, spawnProcess: single.spawnProcess }).run(
    context(),
  );
  const singleRun = single.calls.find((entry) => entry.args[0] === '-p');
  assert.match(
    singleRun.args[singleRun.args.indexOf('--append-system-prompt') + 1],
    /# VIDE 작업 지침[\s\S]*Do not use tools/,
  );
  assert.equal(
    JSON.parse(singleRun.input).items.find((item) => item.id === 'turn-rules'),
    undefined,
  );
});

test('이어 실행에서 기록이 없으면(No conversation found) SESSION_LOST, 첫 턴이나 단발은 PROVIDER_FAILED', async () => {
  const lost = (session) => {
    const spawnProcess = (executable, args) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.unref = () => {};
      const close = (code) => {
        child.exitCode = code;
        child.emit('exit', code);
        child.emit('close', code);
      };
      if (args[0] === '--version')
        queueMicrotask(() => {
          child.stdout.write('2.1.284 (Claude Code)\n');
          close(0);
        });
      else if (args[0] === 'auth')
        queueMicrotask(() => {
          child.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
          close(0);
        });
      else
        child.stdin.on('finish', () => {
          child.stderr.write(
            'No conversation found with session ID: 1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a\n',
          );
          setTimeout(() => close(1), 5);
        });
      return child;
    };
    return new ClaudeCli({ executable: process.execPath, spawnProcess, session }).run(context());
  };
  const id = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
  await assert.rejects(lost({ id, resume: true }), { code: 'SESSION_LOST' });
  await assert.rejects(lost({ id, resume: false }), { code: 'PROVIDER_FAILED' });
  await assert.rejects(lost(undefined), { code: 'PROVIDER_FAILED' });
});

test('기록 삭제는 그 세션의 파일과 비게 된 프로젝트 폴더만 지운다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vide-claude-profile-'));
  try {
    const id = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
    const other = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
    await mkdir(join(root, 'projects', 'C--tmp-one'), { recursive: true });
    await mkdir(join(root, 'projects', 'C--tmp-two'), { recursive: true });
    await writeFile(join(root, 'projects', 'C--tmp-one', id + '.jsonl'), '{}\n');
    // Subagent transcripts live in the session's own folder (ADR-028).
    await mkdir(join(root, 'projects', 'C--tmp-one', id, 'subagents'), { recursive: true });
    await writeFile(join(root, 'projects', 'C--tmp-one', id, 'subagents', 'agent-a.jsonl'), '{}\n');
    await writeFile(join(root, 'projects', 'C--tmp-two', id + '.jsonl'), '{}\n');
    await writeFile(join(root, 'projects', 'C--tmp-two', other + '.jsonl'), '{}\n');
    await writeFile(join(root, 'settings.json'), '{}');
    assert.equal(await removeClaudeTranscript(root, id), 2);
    assert.ok(!existsSync(join(root, 'projects', 'C--tmp-one')));
    assert.ok(existsSync(join(root, 'projects', 'C--tmp-two', other + '.jsonl')));
    assert.ok(existsSync(join(root, 'settings.json')));
    assert.equal(await removeClaudeTranscript(root, id), 0);
    assert.equal(await removeClaudeTranscript(join(root, 'missing'), id), 0);
    await assert.rejects(removeClaudeTranscript(root, '../settings'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('구조화 출력 스키마는 포함된 turn-output 항목에서만 읽고 크기를 제한한다(T-062)', async () => {
  const { outputSchemaOf } = await import('../../src/ai/claude-cli.ts');
  const schema = { type: 'object', additionalProperties: false, properties: {}, required: [] };
  const base = { goal: 'g', revision: 1 };
  const item = { id: 'turn-output', type: 'turn-output', data: { schema } };
  assert.equal(outputSchemaOf({ ...base, items: [item], includedIds: [] }), undefined);
  assert.equal(outputSchemaOf({ ...base, items: [], includedIds: [] }), undefined);
  assert.deepEqual(
    JSON.parse(outputSchemaOf({ ...base, items: [item], includedIds: ['turn-output'] })),
    schema,
  );
  const huge = { ...item, data: { schema: { description: 'x'.repeat(17000) } } };
  assert.throws(() => outputSchemaOf({ ...base, items: [huge], includedIds: ['turn-output'] }), {
    code: 'INVALID_CONTEXT',
  });
  // Without the item the arguments are the single-run ones, unchanged.
  const cli = new ClaudeCli({ executable: process.execPath });
  const args = await cli.withOutputSchema(cli.arguments(), undefined, '');
  assert.deepEqual(args, cliArguments(cli.instructions));
});

test('a confirmed login is reused for ten minutes; a limit or a cleared login asks again', async () => {
  const fake = transport([init, result]);
  const authCalls = () => fake.calls.filter((call) => call.args[0] === 'auth').length;
  const make = () =>
    new ClaudeCli({
      executable: process.execPath,
      spawnProcess: fake.spawnProcess,
    });
  const first = make();
  await first.run(context());
  assert.equal(authCalls(), 1);
  assert.equal(first.timing.authCached, false);
  assert.ok(first.timing.spawnAt > 0 && first.timing.firstOutputAt >= first.timing.spawnAt);
  const second = make();
  await second.run(context());
  assert.equal(authCalls(), 1, 'the second run reuses the login');
  assert.equal(second.timing.authCached, true);
  // A cleared login (a refused run) is asked again.
  clearAuthStatus();
  await make().run(context());
  assert.equal(authCalls(), 2);
  // A run refused on its subscription limit asks the login again next time.
  const limited = transport([
    init,
    { ...result, subtype: 'error', is_error: true, result: "You've hit your usage limit" },
  ]);
  const limitedCli = () =>
    new ClaudeCli({ executable: process.execPath, spawnProcess: limited.spawnProcess });
  await assert.rejects(limitedCli().run(context()), { code: 'PROVIDER_LIMIT' });
  await assert.rejects(limitedCli().run(context()), { code: 'PROVIDER_LIMIT' });
  assert.equal(limited.calls.filter((call) => call.args[0] === 'auth').length, 2);
});

test('a login that is not available is never remembered', async () => {
  let loggedIn = false;
  const fake = transport([init, result]);
  const spawnProcess = (executable, args, options) => {
    if (args[0] !== 'auth') return fake.spawnProcess(executable, args, options);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ loggedIn, authMethod: 'claude.ai' }));
      setTimeout(() => child.emit('close', 0), 1);
    });
    return child;
  };
  const cli = () => new ClaudeCli({ executable: process.execPath, spawnProcess });
  await assert.rejects(cli().run(context()), { code: 'SUBSCRIPTION_LOGIN_REQUIRED' });
  loggedIn = true;
  assert.equal((await cli().run(context())).text, '분석 응답');
});

test('a run has no total output cap (ADR-028): more than 1 MB of events still answers', async () => {
  const text = 'x'.repeat(400 * 1024);
  const big = { type: 'assistant', message: { content: [{ type: 'text', text }] } };
  const fake = transport([init, big, big, big, result]);
  const value = await new ClaudeCli({
    executable: process.execPath,
    spawnProcess: fake.spawnProcess,
  }).run(context());
  assert.equal(value.text, '분석 응답');
});

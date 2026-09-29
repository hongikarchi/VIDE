import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import {
  ClaudeCli,
  buildPacket,
  subscriptionEnvironment,
  compareVersions,
  supportedCliVersion,
} from '../../src/ai/claude-cli.ts';

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

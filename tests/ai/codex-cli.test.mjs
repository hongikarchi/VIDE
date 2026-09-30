import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import {
  CodexCli,
  codexArguments,
  codexEnvironment,
  removeCodexTranscript,
} from '../../src/ai/codex-cli.ts';
import { createProvider, providerCatalog } from '../../src/ai/providers.ts';
const context = {
  goal: '합성 요청',
  revision: 3,
  items: [
    { id: 'yes', data: 'included' },
    { id: 'no', data: 'excluded' },
  ],
  includedIds: ['yes'],
};
const success = [
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'VIDE_OK' } },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
];
function fake(events = success, auth = 'Logged in using ChatGPT', version = 'codex-cli 0.157.1') {
  const calls = [];
  function spawnProcess(executable, args, options) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.unref = () => {};
    const call = { args, options, input: '' };
    calls.push(call);
    child.stdin.on('data', (value) => {
      call.input += value;
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
    else if (args[0] === 'login')
      queueMicrotask(() => {
        child.stderr.write(auth + '\n');
        close();
      });
    else
      child.stdin.once('finish', () => {
        for (const event of events) child.stdout.write(JSON.stringify(event) + '\n');
        setTimeout(close, 5);
      });
    return child;
  }
  return { calls, spawnProcess };
}
test('ChatGPT 구독 인증·선택 자료·Codex JSON 응답을 공통 계약으로 반환한다', async () => {
  const transport = fake(),
    provider = createProvider({
      provider: 'codex-cli',
      executable: process.execPath,
      spawnProcess: transport.spawnProcess,
    });
  const result = await provider.run(context);
  const call = transport.calls.find((entry) => entry.args[0] === 'exec');
  assert.equal(result.text, 'VIDE_OK');
  assert.equal(result.revision, 3);
  assert.equal(result.usage.subscriptionRemaining, null);
  assert.ok(call.input.includes('included'));
  assert.ok(!call.input.includes('excluded'));
  assert.equal(call.options.shell, false);
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
});
test('API 인증과 미로그인은 실행 전에 거절한다', async () => {
  for (const auth of ['Logged in using an API key', 'Not logged in', '']) {
    const transport = fake(success, auth),
      provider = new CodexCli({
        executable: process.execPath,
        spawnProcess: transport.spawnProcess,
      });
    await assert.rejects(provider.run(context), { code: 'SUBSCRIPTION_LOGIN_REQUIRED' });
    assert.ok(!transport.calls.some((call) => call.args[0] === 'exec'));
  }
});
test('구독 경로는 API 키·대체 endpoint·주입 인증 및 사용자 설정을 사용하지 않는다', () => {
  assert.deepEqual(
    codexEnvironment({
      PATH: 'keep',
      OPENAI_API_KEY: 'secret',
      OPENAI_BASE_URL: 'other',
      CODEX_API_KEY: 'secret',
      CODEX_ACCESS_TOKEN: 'secret',
      CODEX_HOME: 'other',
    }),
    { PATH: 'keep' },
  );
  const args = codexArguments('chosen-model');
  for (const item of [
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    'forced_login_method="chatgpt"',
    'web_search="disabled"',
    'shell_tool',
    'apps',
    'plugins',
  ])
    assert.ok(args.includes(item));
  assert.ok(args.includes('chosen-model'));
  assert.ok(!args.some((x) => x.includes('dangerously')));
});
test('도구 실행 이벤트·턴 실패·불완전 출력·잘못된 이벤트를 성공으로 취급하지 않는다', async () => {
  const cases = [
    [
      [
        success[0],
        { type: 'item.started', item: { type: 'command_execution' } },
        ...success.slice(1),
      ],
      'UNEXPECTED_TOOL_CALL',
    ],
    [[success[0], { type: 'turn.failed' }], 'PROVIDER_FAILED'],
    // A subscription limit is its own code so the next request can use another account.
    [
      [
        success[0],
        { type: 'error', message: "You've hit your usage limit. Try again later." },
        { type: 'turn.failed', error: { message: 'usage_limit_reached' } },
      ],
      'PROVIDER_LIMIT',
    ],
    [[success[0]], 'INCOMPLETE_RESULT'],
    [[null], 'INVALID_PROVIDER_OUTPUT'],
  ];
  for (const [events, code] of cases) {
    const transport = fake(events),
      provider = new CodexCli({
        executable: process.execPath,
        spawnProcess: transport.spawnProcess,
      });
    await assert.rejects(provider.run(context), { code });
  }
});
test('비치명적 오류 항목은 경고로 표시하되 원문을 노출하지 않는다', async () => {
  const transport = fake([
      { type: 'item.completed', item: { type: 'error', message: 'private diagnostic' } },
      ...success,
    ]),
    progress = [];
  const result = await new CodexCli({
    executable: process.execPath,
    spawnProcess: transport.spawnProcess,
  }).run(context, { onProgress: (x) => progress.push(x) });
  assert.ok(progress.some((x) => x.state === 'provider-warning'));
  assert.equal(result.text, 'VIDE_OK');
  assert.ok(!JSON.stringify(progress).includes('private diagnostic'));
});
test('취소는 실제 종료 확인과 구분하고 공급자 선택에 자동 fallback이 없다', async () => {
  const transport = fake(),
    controller = new AbortController(),
    states = [];
  await assert.rejects(
    new CodexCli({ executable: process.execPath, spawnProcess: transport.spawnProcess }).run(
      context,
      {
        signal: controller.signal,
        onProgress: (event) => {
          states.push(event.state);
          if (event.state === 'running') controller.abort();
        },
      },
    ),
    { code: 'CANCELLED' },
  );
  assert.deepEqual(states, ['starting', 'running', 'stopping', 'stopped']);
  assert.deepEqual(
    providerCatalog.map((x) => x.id),
    ['claude-cli', 'codex-cli'],
  );
  assert.throws(() => createProvider({ provider: 'automatic', executable: process.execPath }), {
    code: 'UNKNOWN_PROVIDER',
  });
});
test('범위 밖 Codex 판은 실행하지 않는다', async () => {
  const transport = fake(success, 'Logged in using ChatGPT', 'codex-cli 0.158.0');
  await assert.rejects(
    new CodexCli({
      executable: resolve('fake-codex-newer.exe'),
      spawnProcess: transport.spawnProcess,
    }).run(context),
    { code: 'CLI_VERSION_UNSUPPORTED', supported: '>=0.157.0 <0.158.0' },
  );
  assert.deepEqual(
    transport.calls.map((call) => call.args[0]),
    ['--version'],
  );
});
test('인증 없이 나간 요청(401 Missing bearer)은 CLI_MODE_CHANGED로 멈춘다', async () => {
  // Shape collected from `codex exec` without credentials on 0.157.1 (SPIKE-2026-09-30 §0).
  const missing =
    'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses';
  const transport = fake([
    success[0],
    { type: 'error', message: `Reconnecting... 1/5 (${missing})` },
    { type: 'turn.failed', error: { message: missing } },
  ]);
  await assert.rejects(
    new CodexCli({ executable: process.execPath, spawnProcess: transport.spawnProcess }).run(
      context,
    ),
    { code: 'CLI_MODE_CHANGED' },
  );
});
test('Codex 캐시 토큰(cached_input_tokens·cache_write_input_tokens)을 기록한다', async () => {
  const transport = fake([
    success[0],
    success[1],
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 9281,
        cached_input_tokens: 7552,
        cache_write_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 0,
      },
    },
  ]);
  const result = await new CodexCli({
    executable: process.execPath,
    spawnProcess: transport.spawnProcess,
  }).run(context);
  assert.deepEqual(result.usage, {
    inputTokens: 9281,
    outputTokens: 5,
    cacheReadTokens: 7552,
    cacheCreationTokens: 0,
    subscriptionRemaining: null,
  });
});

// Session arguments (PLAN-24 T-061): the contract for when SPIKE ④ passes; conversations on
// Codex run the ledger method until then, so a CodexCli without a session is unchanged.
test('세션 인자: 기록을 남기고, resume은 exec resume <id>와 sandbox_mode 설정으로 간다', () => {
  const id = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';
  const opened = codexArguments('m', { id, resume: false });
  assert.deepEqual(opened.slice(0, 2), ['exec', '--json']);
  assert.ok(!opened.includes('--ephemeral'));
  assert.equal(opened[opened.indexOf('--sandbox') + 1], 'read-only');
  const resumed = codexArguments('m', { id, resume: true });
  assert.deepEqual(resumed.slice(0, 4), ['exec', 'resume', id, '--json']);
  assert.ok(!resumed.includes('--sandbox'));
  assert.ok(resumed.includes('sandbox_mode="read-only"'));
  assert.ok(!resumed.includes('--ephemeral'));
  for (const args of [opened, resumed]) {
    const instructions = args.find((value) => value.startsWith('developer_instructions='));
    assert.ok(!/Do not invoke tools/.test(instructions));
    assert.match(instructions, /turn-rules/);
    for (const item of ['--ignore-user-config', '--ignore-rules', 'mcp_servers={}', 'shell_tool'])
      assert.ok(args.includes(item));
    assert.equal(args.at(-1), '-');
  }
  const cli = new CodexCli({
    executable: process.execPath,
    session: { id, resume: true },
    effort: 'low',
  });
  const args = cli.arguments();
  assert.equal(args[1], 'resume');
  assert.ok(args.includes('model_reasoning_effort="low"'));
});

test('Codex 기록 삭제는 sessions/연/월/일 아래 그 세션의 rollout 파일만 지운다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vide-codex-home-'));
  try {
    const id = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
    const day = join(home, 'sessions', '2026', '09', '30');
    await mkdir(day, { recursive: true });
    await writeFile(join(day, `rollout-2026-09-30T10-00-00-${id}.jsonl`), '{}\n');
    await writeFile(
      join(day, 'rollout-2026-09-30T11-00-00-6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f.jsonl'),
      '{}\n',
    );
    await writeFile(join(home, 'config.toml'), '');
    assert.equal(await removeCodexTranscript(home, id), 1);
    assert.equal((await readdir(day)).length, 1);
    assert.equal(await removeCodexTranscript(home, id), 0);
    assert.equal(await removeCodexTranscript(join(home, 'missing'), id), 0);
    await assert.rejects(removeCodexTranscript(home, '../config'), { code: 'INVALID_SESSION' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

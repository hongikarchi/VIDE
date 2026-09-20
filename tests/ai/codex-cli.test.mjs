import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexCli, codexArguments, codexEnvironment } from '../../src/ai/codex-cli.mjs';
import { createProvider, providerCatalog } from '../../src/ai/providers.mjs';
const context = { goal: '합성 요청', revision: 3, items: [{ id: 'yes', data: 'included' }, { id: 'no', data: 'excluded' }], includedIds: ['yes'] };
const success = [{ type: 'turn.started' }, { type: 'item.completed', item: { type: 'agent_message', text: 'VIDE_OK' } },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }];
function fake(events = success, auth = 'Logged in using ChatGPT') {
  const calls = [];
  function spawnProcess(executable, args, options) {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null; child.unref = () => {};
    const call = { args, options, input: '' }; calls.push(call);
    child.stdin.on('data', value => { call.input += value; });
    const close = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
    if (args[0] === 'login') queueMicrotask(() => { child.stderr.write(auth + '\n'); close(); });
    else child.stdin.once('finish', () => { for (const event of events) child.stdout.write(JSON.stringify(event) + '\n'); setTimeout(close, 5); });
    return child;
  }
  return { calls, spawnProcess };
}
test('ChatGPT 구독 인증·선택 자료·Codex JSON 응답을 공통 계약으로 반환한다', async () => {
  const transport = fake(), provider = createProvider({ provider: 'codex-cli', executable: process.execPath, spawnProcess: transport.spawnProcess });
  const result = await provider.run(context);
  assert.equal(result.text, 'VIDE_OK'); assert.equal(result.revision, 3); assert.equal(result.usage.subscriptionRemaining, null);
  assert.ok(transport.calls[1].input.includes('included')); assert.ok(!transport.calls[1].input.includes('excluded'));
  assert.equal(transport.calls[1].options.shell, false);
  assert.equal(transport.calls[1].args[transport.calls[1].args.indexOf('--sandbox') + 1], 'read-only');
});
test('API 인증과 미로그인은 실행 전에 거절한다', async () => {
  for (const auth of ['Logged in using an API key', 'Not logged in', '']) {
    const transport = fake(success, auth), provider = new CodexCli({ executable: process.execPath, spawnProcess: transport.spawnProcess });
    await assert.rejects(provider.run(context), { code: 'SUBSCRIPTION_LOGIN_REQUIRED' }); assert.equal(transport.calls.length, 1);
  }
});
test('구독 경로는 API 키·대체 endpoint·주입 인증 및 사용자 설정을 사용하지 않는다', () => {
  assert.deepEqual(codexEnvironment({ PATH: 'keep', OPENAI_API_KEY: 'secret', OPENAI_BASE_URL: 'other', CODEX_API_KEY: 'secret', CODEX_ACCESS_TOKEN: 'secret', CODEX_HOME: 'other' }), { PATH: 'keep' });
  const args = codexArguments('chosen-model');
  for (const item of ['--ignore-user-config', '--ignore-rules', '--ephemeral', 'forced_login_method="chatgpt"', 'web_search="disabled"', 'shell_tool', 'apps', 'plugins']) assert.ok(args.includes(item));
  assert.ok(args.includes('chosen-model')); assert.ok(!args.some(x => x.includes('dangerously')));
});
test('도구 실행 이벤트·턴 실패·불완전 출력·잘못된 이벤트를 성공으로 취급하지 않는다', async () => {
  const cases = [
    [[success[0], { type: 'item.started', item: { type: 'command_execution' } }, ...success.slice(1)], 'UNEXPECTED_TOOL_CALL'],
    [[success[0], { type: 'turn.failed' }], 'PROVIDER_FAILED'],
    [[success[0]], 'INCOMPLETE_RESULT'],
    [[null], 'INVALID_PROVIDER_OUTPUT'],
  ];
  for (const [events, code] of cases) {
    const transport = fake(events), provider = new CodexCli({ executable: process.execPath, spawnProcess: transport.spawnProcess });
    await assert.rejects(provider.run(context), { code });
  }
});
test('비치명적 오류 항목은 경고로 표시하되 원문을 노출하지 않는다', async () => {
  const transport = fake([{ type: 'item.completed', item: { type: 'error', message: 'private diagnostic' } }, ...success]), progress = [];
  const result = await new CodexCli({ executable: process.execPath, spawnProcess: transport.spawnProcess }).run(context, { onProgress: x => progress.push(x) });
  assert.ok(progress.some(x => x.state === 'provider-warning')); assert.equal(result.text, 'VIDE_OK');
  assert.ok(!JSON.stringify(progress).includes('private diagnostic'));
});
test('취소는 실제 종료 확인과 구분하고 공급자 선택에 자동 fallback이 없다', async () => {
  const transport = fake(), controller = new AbortController(), states = [];
  await assert.rejects(new CodexCli({ executable: process.execPath, spawnProcess: transport.spawnProcess }).run(context, {
    signal: controller.signal, onProgress: event => { states.push(event.state); if (event.state === 'running') controller.abort(); },
  }), { code: 'CANCELLED' });
  assert.deepEqual(states, ['starting', 'running', 'stopping', 'stopped']);
  assert.deepEqual(providerCatalog.map(x => x.id), ['claude-cli', 'codex-cli']);
  assert.throws(() => createProvider({ provider: 'automatic', executable: process.execPath }), { code: 'UNKNOWN_PROVIDER' });
});

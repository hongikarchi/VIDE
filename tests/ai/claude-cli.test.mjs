import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaudeCli, buildPacket, subscriptionEnvironment } from '../../src/ai/claude-cli.ts';

const context = () => ({ goal: '선택 자료를 설명', revision: 1,
  items: [{ id: 'a', label: '허용', type: 'text', data: 'public', internalPath: 'private-path' },
    { id: 'b', label: '제외', type: 'text', data: 'secret' }], includedIds: ['a'] });
const init = { type: 'system', subtype: 'init', tools: [], mcp_servers: [] };
const result = { type: 'result', subtype: 'success', is_error: false, result: '분석 응답', usage: { input_tokens: 5, output_tokens: 3 } };

test('malformed nested provider output is rejected instead of throwing from a stream callback',async()=>{
 for(const event of [{type:'assistant',message:{content:{type:'tool_use'}}},{...result,usage:{input_tokens:'5'}},{type:'assistant',message:{content:[null]}}]){
  const fake=transport([init,event,result]);
  await assert.rejects(new ClaudeCli({executable:process.execPath,spawnProcess:fake.spawnProcess}).run(context()),{code:'INVALID_PROVIDER_OUTPUT'});
 }
});
function transport(events, { neverClose = false } = {}) {
  const calls = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null; child.unref = () => {};
    const call = { executable, args, options, input: '' }; calls.push(call);
    child.stdin.on('data', data => { call.input += data; });
    const close = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
    if (args[0] === 'auth') queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'not-for-output' })); close();
    });
    else child.stdin.on('finish', () => {
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
  const call = fake.calls[1];
  assert.equal(value.text, '분석 응답'); assert.equal(value.usage.subscriptionRemaining, null);
  assert.ok(call.input.includes('public')); assert.ok(!call.input.includes('secret')); assert.ok(!call.input.includes('private-path'));
  assert.equal(call.options.shell, false); assert.ok(!call.args.includes('--bare'));
  assert.equal(call.args[call.args.indexOf('--tools') + 1], ''); assert.ok(call.args.includes('--safe-mode'));
  assert.ok(!JSON.stringify(value).includes('not-for-output'));
});

test('명시되지 않은 항목 ID·중복 ID·과도한 자료를 거절한다', () => {
  assert.throws(() => buildPacket({ ...context(), includedIds: ['missing'] }), { code: 'INVALID_CONTEXT' });
  assert.throws(() => buildPacket({ ...context(), includedIds: ['a', 'a'] }), { code: 'INVALID_CONTEXT' });
  assert.throws(() => buildPacket({ ...context(), items: [{ id: 'a', data: 'x'.repeat(300000) }] }), { code: 'CONTEXT_TOO_LARGE' });
});

test('API fallback과 커스텀 환경 설정을 구독 자식 프로세스에서 제거한다', () => {
  const env = subscriptionEnvironment({ PATH: 'ok', ANTHROPIC_API_KEY: 'hidden', ANTHROPIC_BASE_URL: 'custom',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'hidden', CLAUDE_CONFIG_DIR: 'other' });
  assert.deepEqual(env, { PATH: 'ok' });
});

test('도구 권한이나 호출이 발견되면 성공 결과가 와도 거절한다', async () => {
  for (const events of [[{ ...init, tools: ['Bash'] }, result],
    [init, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } }, result]]) {
    const fake = transport(events), cli = new ClaudeCli({ executable: process.execPath, spawnProcess: fake.spawnProcess });
    await assert.rejects(cli.run(context()), error => ['UNEXPECTED_TOOL_ACCESS', 'UNEXPECTED_TOOL_CALL'].includes(error.code));
  }
});

test('취소 요청 뒤 실제 프로세스 종료를 관측해야 stopped를 알린다', async () => {
  const fake = transport([init, result]), controller = new AbortController(), states = [];
  const cli = new ClaudeCli({ executable: process.execPath, spawnProcess: fake.spawnProcess });
  await assert.rejects(cli.run(context(), { signal: controller.signal, onProgress: event => {
    states.push(event.state); if (event.state === 'running') controller.abort();
  } }), { code: 'CANCELLED' });
  assert.deepEqual(states, ['starting', 'running', 'stopping', 'stopped']);
});

test('종료를 관측하지 못하면 stopped로 속이지 않고 불명확으로 반환한다', async () => {
  const fake = transport([init], { neverClose: true }), states = [];
  const cli = new ClaudeCli({ executable: process.execPath, spawnProcess: fake.spawnProcess, timeoutMs: 20, stopGraceMs: 20 });
  await assert.rejects(cli.run(context(), { onProgress: event => states.push(event.state) }), { code: 'STOP_UNCONFIRMED' });
  assert.ok(states.includes('stopping')); assert.ok(!states.includes('stopped'));
});

test('최종 응답 누락과 공급자 오류를 성공으로 반환하지 않는다', async () => {
  for (const events of [[init], [init, { ...result, is_error: true }]]) {
    const fake = transport(events), cli = new ClaudeCli({ executable: process.execPath, spawnProcess: fake.spawnProcess });
    await assert.rejects(cli.run(context()), error => ['INCOMPLETE_RESULT', 'PROVIDER_FAILED'].includes(error.code));
  }
});

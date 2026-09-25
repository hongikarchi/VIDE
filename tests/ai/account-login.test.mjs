import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AccountLogin } from '../../src/ai/account-login.ts';
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(options = {}) {
  const children = [],
    calls = [];
  let kills = 0;
  const login = new AccountLogin({
    spawnProcess: (file, args, settings) => {
      calls.push({ file, args, settings });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      children.push(child);
      return child;
    },
    kill: async () => {
      kills++;
      return true;
    },
    ...options,
  });
  const input = {
    provider: 'codex-cli',
    profileId: 'second',
    directory: 'C:/synthetic/profile',
    executable: 'codex.exe',
    verify: async () => ({ available: true }),
  };
  return { login, input, calls, children, kills: () => kills };
}
test('official login keeps its lease until exit and auth verification, discarding raw output', async () => {
  const { login, input, calls, children } = fixture();
  let verify;
  login.start({
    ...input,
    verify: () =>
      new Promise((resolve) => {
        verify = resolve;
      }),
  });
  assert.equal(calls[0].settings.env.CODEX_HOME, input.directory);
  assert.equal(calls[0].settings.shell, false);
  assert.ok(calls[0].args.includes('cli_auth_credentials_store="file"'));
  children[0].stdout.write('SENSITIVE_TEST_OUTPUT');
  assert.equal(JSON.stringify(login.list()).includes('SENSITIVE_TEST_OUTPUT'), false);
  assert.throws(() => login.start(input), { code: 'PROFILE_LOGIN_IN_PROGRESS' });
  children[0].emit('close', 0);
  assert.equal(login.busy('codex-cli'), true);
  verify({ available: true });
  await tick();
  assert.equal(login.list()[0].state, 'succeeded');
  assert.equal(login.busy('codex-cli'), false);
  await login.close();
});
for (const mode of ['cancel', 'timeout', 'failure', 'auth-failure'])
  test('login ' + mode + ' never selects an account or releases before process exit', async () => {
    const { login, input, children, kills } = fixture({
      timeoutMs: mode === 'timeout' ? 5 : 300000,
    });
    login.start({ ...input, verify: async () => ({ available: mode !== 'auth-failure' }) });
    if (mode === 'cancel') login.cancel('codex-cli');
    if (mode === 'timeout') await new Promise((resolve) => setTimeout(resolve, 20));
    if (['cancel', 'timeout'].includes(mode)) {
      assert.equal(login.list()[0].state, 'stopping');
      assert.equal(login.busy('codex-cli'), true);
      assert.equal(kills(), 1);
    }
    children[0].emit('close', mode === 'failure' ? 1 : 0);
    await tick();
    assert.equal(login.list()[0].state, mode === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(login.busy('codex-cli'), false);
    await login.close();
  });
test('server close waits for its login process, while providers have separate leases', async () => {
  const { login, input, children, kills } = fixture();
  login.start(input);
  login.start({ ...input, provider: 'claude-cli' });
  let done = false;
  const closing = login.close().then(() => {
    done = true;
  });
  await tick();
  assert.equal(done, false);
  assert.equal(kills(), 2);
  for (const child of children) child.emit('close', null);
  await closing;
  assert.equal(done, true);
});

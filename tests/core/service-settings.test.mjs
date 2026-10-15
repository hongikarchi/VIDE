// External service settings and the sealed token (SPEC-13.11, PLAN-46 T-217): the token is never in
// an answer, the settings file, a log or the secret file in plain text; remote sessions cannot write;
// [연결] needs the VIDE account; the status comes from a real `meta` call against the fake cLAWde
// server ('연결됨', '로그인 필요', '닿지 않음'); an account token is renewed before it expires. The
// user's own GitHub·Cloudflare accounts (SPEC-05.11, T-344) are checked against fake APIs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { serviceSettingsRoutes } from '../../src/server/service-routes.ts';
import { SecretStore, dpapiProtector } from '../../src/services/secrets.ts';
import { ServiceSettings } from '../../src/services/settings.ts';
import { ClawdeClient } from '../../src/services/clawde.ts';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';
import { accountConnection, accountTokenFor } from '../../src/services/account-services.ts';
import {
  FAKE_CLOUDFLARE_ACCOUNT,
  FAKE_CLOUDFLARE_NAME,
  FAKE_CLOUDFLARE_TOKEN,
  FAKE_GITHUB_LOGIN,
  FAKE_GITHUB_TOKEN,
  startFakeAccounts,
} from '../fixtures/fake-accounts/server.mjs';

let fake;
before(async () => {
  fake = await startFakeClawde();
});
after(() => fake.close());

/** Every file under `directory` (recursively) as text, to look for the token. */
async function allText(directory) {
  const out = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await stat(path)).size > 20_000_000) continue;
    out.push([path, (await readFile(path)).toString('latin1')]);
  }
  return out;
}

async function app(t, serviceOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-services-'));
  const server = await startServer({
    filename: join(directory, 'data', 'store.sqlite'),
    serviceOptions: { protector: testProtector, ...serviceOptions },
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const login = await fetch(server.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: server.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(server.launchUrl).hash.slice(1) }),
  });
  const headers = {
    Origin: server.origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(server.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text || 'null') };
  };
  return { directory, api };
}

test('a saved token never comes back; the status follows meta: connected, login required, unreachable', async (t) => {
  const { directory, api } = await app(t);
  const empty = await api('/settings/services');
  assert.equal(empty.json.clawde.status, 'not-configured');
  assert.equal(empty.json.clawde.token.set, false);

  const saved = await api('/settings/services', 'PUT', {
    clawde: { baseUrl: fake.url + '/', token: fake.token },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.clawde.baseUrl, fake.url, 'trailing slash dropped');
  assert.deepEqual(saved.json.clawde.token, { set: true, source: 'static', expiresAt: null });
  assert.equal(saved.json.clawde.enabled, true, 'saving a token turns the service on');
  assert.equal(saved.json.clawde.status, 'unchecked');
  assert.ok(!saved.text.includes(fake.token));

  const checked = await api('/settings/services/clawde/check', 'POST');
  assert.equal(checked.json.clawde.status, 'connected');
  assert.equal(checked.json.clawde.lawDbDate, '2026-09-01');
  const call = fake.received.at(-1);
  assert.equal(call.path, '/v1/meta');
  assert.equal(call.authorization, `Bearer ${fake.token}`);
  assert.match(call.videVersion, /\S/);

  fake.control({ failStatus: 401 });
  assert.equal(
    (await api('/settings/services/clawde/check', 'POST')).json.clawde.status,
    'login-required',
  );
  fake.control({ failStatus: 503 });
  assert.equal(
    (await api('/settings/services/clawde/check', 'POST')).json.clawde.status,
    'unreachable',
  );
  fake.reset();

  // An address nothing listens on: '닿지 않음'.
  await api('/settings/services', 'PUT', { clawde: { baseUrl: 'http://127.0.0.1:9' } });
  assert.equal(
    (await api('/settings/services/clawde/check', 'POST')).json.clawde.status,
    'unreachable',
  );

  // A failed call (the server logs it) and the settings files: no token anywhere in plain text.
  await api('/settings/services', 'PUT', { clawde: { baseUrl: 'not a url' } });
  for (const [path, text] of await allText(directory))
    assert.ok(!text.includes(fake.token), `token in ${path}`);
  const sealed = await readFile(join(directory, 'data', 'secrets', 'services.bin'));
  assert.equal(sealed.subarray(0, 6).toString(), 'SEALED', 'kept through the protector');
  const settingsFile = JSON.parse(
    await readFile(join(directory, 'data', 'service-settings.json'), 'utf8'),
  );
  assert.equal(settingsFile.services.clawde.tokenSource, 'static');

  // [끊기]: the token is gone and the service is off.
  const off = await api('/settings/services/clawde/disconnect', 'POST');
  assert.equal(off.json.clawde.token.set, false);
  assert.equal(off.json.clawde.enabled, false);
  assert.equal(off.json.clawde.status, 'not-configured');
});

test('projects that send nothing are kept per project id', async (t) => {
  const { api } = await app(t);
  const saved = await api('/settings/services', 'PUT', {
    clawde: { projectsOff: ['p-1', 'p-1', 'p-2'] },
  });
  assert.deepEqual(saved.json.clawde.projectsOff, ['p-1', 'p-2']);
  const bad = await api('/settings/services', 'PUT', { clawde: { token: '' } });
  assert.equal(bad.status, 400);
  const unknown = await api('/settings/services', 'PUT', { clawde: { secret: 'x' } });
  assert.equal(unknown.status, 400, 'unknown fields are refused');
});

test('[연결] is refused on a PC not signed in to the VIDE account', async (t) => {
  const { api } = await app(t);
  await api('/settings/services', 'PUT', { clawde: { baseUrl: fake.url } });
  const view = await api('/settings/services');
  assert.equal(view.json.clawde.accountLinked, false);
  const refused = await api('/settings/services/clawde/connect', 'POST');
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'ACCOUNT_NOT_LINKED');
});

test('remote sessions cannot change service settings', async () => {
  const settings = new ServiceSettings({
    directory: undefined,
    secrets: new SecretStore(undefined),
  });
  const client = new ClawdeClient({ settings, version: 'test' });
  const sent = [];
  const call = (path, method) =>
    serviceSettingsRoutes(new URL('http://x' + path), method, {
      settings,
      client,
      body: async () => ({ clawde: { token: 'x' } }),
      send: (status, value) => sent.push({ status, value }),
      remote: true,
    });
  for (const [path, method] of [
    ['/api/v1/settings/services', 'PUT'],
    ['/api/v1/settings/services/clawde/connect', 'POST'],
    ['/api/v1/settings/services/clawde/disconnect', 'POST'],
    ['/api/v1/settings/services/clawde/check', 'POST'],
  ])
    await assert.rejects(call(path, method), (error) => error.code === 'FORBIDDEN', path);
  assert.equal(await call('/api/v1/settings/services', 'GET'), true);
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].value.clawde.token.set, false);
});

test('an account token is used, and renewed shortly before it expires', async (t) => {
  let clock = Date.parse('2026-10-08T00:00:00Z');
  const issued = [];
  const account = {
    linked: async () => true,
    token: async () => {
      const expiresAt = new Date(clock + 10 * 60_000).toISOString();
      issued.push(expiresAt);
      return { accessToken: fake.token, expiresAt };
    },
  };
  const directory = await mkdtemp(join(tmpdir(), 'vide-services-account-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new ServiceSettings({
    directory,
    secrets: new SecretStore(directory, testProtector),
    account,
    now: () => new Date(clock),
  });
  const client = new ClawdeClient({ settings, version: 'test' });
  await settings.update({ clawde: { baseUrl: fake.url } });
  const view = await settings.connect();
  assert.equal(view.clawde.token.source, 'account');
  assert.equal(view.clawde.token.expiresAt, issued[0]);
  await client.meta();
  assert.equal(issued.length, 1, 'still valid: no renewal');
  clock += 9.5 * 60_000;
  await client.meta();
  assert.equal(issued.length, 2, 'renewed within the last minute');
  assert.equal((await settings.view()).clawde.status, 'connected');

  // A renewal the account site refuses: '로그인 필요', the call is not made.
  account.token = async () => {
    throw Object.assign(Error('SITE_UNREACHABLE'), { code: 'SITE_UNREACHABLE' });
  };
  clock += 10 * 60_000;
  const before = fake.received.length;
  await assert.rejects(client.meta(), (error) => error.code === 'SERVICE_AUTH');
  assert.equal(fake.received.length, before);
  assert.equal((await settings.view()).clawde.status, 'login-required');
});

test(
  'DPAPI seals and opens secrets for this Windows user',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'vide-dpapi-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new SecretStore(directory, dpapiProtector);
    await store.set('clawde.token', 'dpapi-시험-token');
    const sealed = await readFile(join(directory, 'secrets', 'services.bin'));
    assert.ok(!sealed.toString('latin1').includes('dpapi'));
    assert.equal(
      await new SecretStore(directory, dpapiProtector).get('clawde.token'),
      'dpapi-시험-token',
    );
    await store.set('clawde.token', undefined);
    assert.equal(await new SecretStore(directory, dpapiProtector).get('clawde.token'), undefined);
  },
);

// The user's own GitHub·Cloudflare accounts (SPEC-05.11, PLAN-54 T-344) against fake APIs.
async function accountsApp(t) {
  const accounts = await startFakeAccounts();
  t.after(() => accounts.close());
  const { directory, api } = await app(t, {
    githubApi: accounts.github,
    cloudflareApi: accounts.cloudflare,
  });
  return { accounts, directory, api };
}

test('GitHub: a token is checked with GET /user, its scopes decide 연결됨 or 권한 부족, never shown', async (t) => {
  const { accounts, directory, api } = await accountsApp(t);
  const empty = await api('/settings/services');
  assert.equal(empty.json.github.status, 'not-configured');
  assert.deepEqual(empty.json.github.token, { set: false, checkedAt: null });
  assert.equal(empty.json.cloudflare.status, 'not-configured');

  const missing = await api('/settings/services/github/check', 'POST');
  assert.equal(missing.status, 409);
  assert.equal(missing.json.code, 'ACCOUNT_NOT_CONNECTED');

  const saved = await api('/settings/services', 'PUT', { github: { token: FAKE_GITHUB_TOKEN } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.github.status, 'unchecked');
  assert.equal(saved.json.github.enabled, true);
  assert.equal(saved.json.clawde.status, 'not-configured', 'cLAWde untouched');
  assert.ok(!saved.text.includes(FAKE_GITHUB_TOKEN));

  const checked = await api('/settings/services/github/check', 'POST');
  assert.equal(checked.json.github.status, 'connected');
  assert.equal(checked.json.github.login, FAKE_GITHUB_LOGIN);
  assert.deepEqual(checked.json.github.scopes, ['repo', 'workflow']);
  assert.equal(checked.json.github.scopesChecked, true);
  assert.equal(checked.json.github.token.set, true);
  assert.equal(checked.json.github.token.checkedAt, checked.json.github.checkedAt);
  assert.ok(!checked.text.includes(FAKE_GITHUB_TOKEN));
  assert.deepEqual(accounts.calls.at(-1), { method: 'GET', path: '/github/user' });

  // A classic token without `repo`: 권한 부족, but the token stays saved.
  accounts.control({ githubScopes: 'read:user' });
  const short = await api('/settings/services/github/check', 'POST');
  assert.equal(short.json.github.status, 'scope-missing');
  assert.equal(short.json.github.token.set, true);
  assert.equal(short.json.github.rejected, false);

  // A fine-grained token lists no scopes: connected, scopes unchecked.
  accounts.control({ githubScopes: null });
  const fine = await api('/settings/services/github/check', 'POST');
  assert.equal(fine.json.github.status, 'connected');
  assert.equal(fine.json.github.scopesChecked, false);

  accounts.control({ fail: 503 });
  assert.equal(
    (await api('/settings/services/github/check', 'POST')).json.github.status,
    'unreachable',
  );
  accounts.control({ fail: 'drop' });
  assert.equal(
    (await api('/settings/services/github/check', 'POST')).json.github.status,
    'unreachable',
  );
  accounts.reset();

  // A token the service refuses (401).
  await api('/settings/services', 'PUT', { github: { token: 'ghp_test_wrong' } });
  const refused = await api('/settings/services/github/check', 'POST');
  assert.equal(refused.json.github.status, 'scope-missing');
  assert.equal(refused.json.github.rejected, true);
  assert.equal(refused.json.github.login, null);

  await api('/settings/services', 'PUT', { github: { token: FAKE_GITHUB_TOKEN } });
  await api('/settings/services/github/check', 'POST');
  for (const [path, text] of await allText(directory))
    assert.ok(!text.includes(FAKE_GITHUB_TOKEN), `token in ${path}`);
  const settingsFile = JSON.parse(
    await readFile(join(directory, 'data', 'service-settings.json'), 'utf8'),
  );
  assert.equal(settingsFile.services.github.login, FAKE_GITHUB_LOGIN);
  assert.equal(settingsFile.services.github.status, 'connected');

  const off = await api('/settings/services/github/disconnect', 'POST');
  assert.equal(off.json.github.status, 'not-configured');
  assert.equal(off.json.github.token.set, false);
  assert.equal(off.json.github.login, null);
  assert.equal(off.json.github.enabled, false);
});

test('Cloudflare: token verify then the account name; a wrong account ID is 권한 부족', async (t) => {
  const { accounts, directory, api } = await accountsApp(t);
  await api('/settings/services', 'PUT', { cloudflare: { token: FAKE_CLOUDFLARE_TOKEN } });
  const noAccount = await api('/settings/services');
  assert.equal(noAccount.json.cloudflare.status, 'not-configured', 'needs the account ID too');
  assert.equal(
    (await api('/settings/services/cloudflare/check', 'POST')).json.code,
    'ACCOUNT_NOT_CONNECTED',
  );
  const badId = await api('/settings/services', 'PUT', { cloudflare: { accountId: 'abc' } });
  assert.equal(badId.status, 400);

  await api('/settings/services', 'PUT', {
    cloudflare: { accountId: FAKE_CLOUDFLARE_ACCOUNT.toUpperCase() },
  });
  const checked = await api('/settings/services/cloudflare/check', 'POST');
  assert.equal(checked.json.cloudflare.status, 'connected');
  assert.equal(checked.json.cloudflare.accountId, FAKE_CLOUDFLARE_ACCOUNT);
  assert.equal(checked.json.cloudflare.accountName, FAKE_CLOUDFLARE_NAME);
  assert.ok(!checked.text.includes(FAKE_CLOUDFLARE_TOKEN));
  assert.deepEqual(
    accounts.calls.map((call) => call.path),
    ['/cloudflare/user/tokens/verify', `/cloudflare/accounts/${FAKE_CLOUDFLARE_ACCOUNT}`],
  );

  accounts.control({ cloudflareStatus: 'disabled' });
  const disabled = await api('/settings/services/cloudflare/check', 'POST');
  assert.equal(disabled.json.cloudflare.status, 'scope-missing');
  assert.equal(disabled.json.cloudflare.rejected, true);
  accounts.reset();

  await api('/settings/services', 'PUT', {
    cloudflare: { accountId: 'ffffffffffffffffffffffffffffffff' },
  });
  const otherAccount = await api('/settings/services');
  assert.equal(otherAccount.json.cloudflare.status, 'unchecked', 'a new ID forgets the check');
  assert.equal(otherAccount.json.cloudflare.accountName, null);
  assert.equal(
    (await api('/settings/services/cloudflare/check', 'POST')).json.cloudflare.status,
    'scope-missing',
  );
  accounts.control({ fail: 502 });
  await api('/settings/services', 'PUT', { cloudflare: { accountId: FAKE_CLOUDFLARE_ACCOUNT } });
  assert.equal(
    (await api('/settings/services/cloudflare/check', 'POST')).json.cloudflare.status,
    'unreachable',
  );
  accounts.reset();
  for (const [path, text] of await allText(directory))
    assert.ok(!text.includes(FAKE_CLOUDFLARE_TOKEN), `token in ${path}`);

  const off = await api('/settings/services/cloudflare/disconnect', 'POST');
  assert.equal(off.json.cloudflare.status, 'not-configured');
  assert.equal(off.json.cloudflare.accountId, null);
});

test('accountTokenFor gives the sealed token, refuses an unconnected or short account', async (t) => {
  const accounts = await startFakeAccounts();
  t.after(() => accounts.close());
  const directory = await mkdtemp(join(tmpdir(), 'vide-account-token-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new ServiceSettings({
    directory,
    secrets: new SecretStore(directory, testProtector),
    apis: { githubApi: accounts.github, cloudflareApi: accounts.cloudflare },
  });
  await assert.rejects(
    accountTokenFor(settings, 'github'),
    (error) => error.code === 'ACCOUNT_NOT_CONNECTED',
  );
  await settings.update({ github: { token: FAKE_GITHUB_TOKEN } });
  assert.equal(await accountTokenFor(settings, 'github'), FAKE_GITHUB_TOKEN, 'unchecked is usable');
  const connection = await accountConnection(settings, 'github');
  assert.equal(connection.api, accounts.github);
  accounts.control({ githubScopes: 'gist' });
  await settings.checkAccount('github');
  await assert.rejects(
    accountTokenFor(settings, 'github'),
    (error) => error.code === 'ACCOUNT_SCOPE',
  );
  // A token the service refused is no connection at all (not a missing right).
  accounts.control({ fail: 401 });
  await settings.checkAccount('github');
  assert.equal((await settings.view()).github.rejected, true);
  await assert.rejects(
    accountTokenFor(settings, 'github'),
    (error) => error.code === 'ACCOUNT_NOT_CONNECTED',
  );
  accounts.reset();
  await settings.update({ github: { enabled: false } });
  assert.equal((await settings.view()).github.status, 'off');
  await assert.rejects(
    accountTokenFor(settings, 'github'),
    (error) => error.code === 'ACCOUNT_NOT_CONNECTED',
  );

  await settings.update({ cloudflare: { token: FAKE_CLOUDFLARE_TOKEN } });
  await assert.rejects(
    accountTokenFor(settings, 'cloudflare'),
    (error) => error.code === 'ACCOUNT_NOT_CONNECTED',
    'no account ID yet',
  );
  await settings.update({ cloudflare: { accountId: FAKE_CLOUDFLARE_ACCOUNT } });
  const cloudflare = await accountConnection(settings, 'cloudflare');
  assert.equal(cloudflare.token, FAKE_CLOUDFLARE_TOKEN);
  assert.equal(cloudflare.accountId, FAKE_CLOUDFLARE_ACCOUNT);

  // A settings file from before T-344 (cLAWde only) still loads.
  const old = await mkdtemp(join(tmpdir(), 'vide-account-old-'));
  t.after(() => rm(old, { recursive: true, force: true }));
  await writeFile(
    join(old, 'service-settings.json'),
    JSON.stringify({ services: { clawde: { baseUrl: 'http://127.0.0.1:9', enabled: true } } }),
  );
  const loaded = await new ServiceSettings({
    directory: old,
    secrets: new SecretStore(old, testProtector),
  }).view();
  assert.equal(loaded.clawde.baseUrl, 'http://127.0.0.1:9');
  assert.equal(loaded.github.status, 'not-configured');
});

test('remote sessions cannot connect or disconnect the user accounts', async () => {
  const settings = new ServiceSettings({
    directory: undefined,
    secrets: new SecretStore(undefined),
  });
  const client = new ClawdeClient({ settings, version: 'test' });
  const sent = [];
  for (const path of [
    '/api/v1/settings/services/github/check',
    '/api/v1/settings/services/github/disconnect',
    '/api/v1/settings/services/cloudflare/check',
    '/api/v1/settings/services/cloudflare/disconnect',
  ])
    await assert.rejects(
      serviceSettingsRoutes(new URL('http://x' + path), 'POST', {
        settings,
        client,
        body: async () => ({}),
        send: (status, value) => sent.push({ status, value }),
        remote: true,
      }),
      (error) => error.code === 'FORBIDDEN',
      path,
    );
  assert.equal(sent.length, 0);
});

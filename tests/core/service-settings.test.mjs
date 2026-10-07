// External service settings and the sealed token (SPEC-13.11, PLAN-46 T-217): the token is never in
// an answer, the settings file, a log or the secret file in plain text; remote sessions cannot write;
// [연결] needs the VIDE account; the status comes from a real `meta` call against the fake cLAWde
// server ('연결됨', '로그인 필요', '닿지 않음'); an account token is renewed before it expires.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { serviceSettingsRoutes } from '../../src/server/service-routes.ts';
import { SecretStore, dpapiProtector } from '../../src/services/secrets.ts';
import { ServiceSettings } from '../../src/services/settings.ts';
import { ClawdeClient } from '../../src/services/clawde.ts';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';

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

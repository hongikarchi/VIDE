// 공공 자료 키와 전송 고지 (PLAN-45 T-205, SPEC-12.4 키·전송 고지, FR-18): keys saved in this PC's
// file and read back only by the library, the screen sees present/absent, an environment variable
// wins, the diagnostic bundle never takes the file, remote sessions are refused, and nothing is
// sent before the project confirms the notice. Synthetic keys and service only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicDataKeyStore } from '../../src/server/public-data-keys.ts';
import { SiteDataSettings, siteDataRoutes } from '../../src/server/site-data-routes.ts';
import { writeDiagnosticBundle } from '../../src/server/diagnostic-bundle.ts';
import { startServer } from '../../src/server/server.ts';
import { KEYS, P1, fakeSiteData } from '../fixtures/site-data.mjs';

test('key store: save, present/absent only, environment wins, remove', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-public-keys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PublicDataKeyStore(directory, {});
  assert.deepEqual(
    store.view().keys.map((k) => k.present),
    [false, false, false, false],
  );
  const view = await store.set('VWORLD_KEY', '  synthetic-vworld-1234 ');
  assert.equal(view.keys.find((k) => k.name === 'VWORLD_KEY').present, true);
  assert.ok(!JSON.stringify(view).includes('synthetic-vworld'), 'the view never holds a value');
  await store.set('JUSO_KEY', 'synthetic-juso');
  assert.deepEqual(store.read(), {
    VWORLD_KEY: 'synthetic-vworld-1234',
    JUSO_KEY: 'synthetic-juso',
  });
  assert.match(
    await readFile(join(directory, 'public-data.env'), 'utf8'),
    /^VWORLD_KEY=synthetic-vworld-1234\nJUSO_KEY=synthetic-juso\n$/,
  );

  const withEnv = new PublicDataKeyStore(directory, { VWORLD_KEY: 'from-env' });
  assert.equal(withEnv.read().VWORLD_KEY, 'from-env');
  assert.equal(withEnv.view().keys.find((k) => k.name === 'VWORLD_KEY').from, 'env');

  await store.set('VWORLD_KEY', '');
  assert.deepEqual(store.read(), { JUSO_KEY: 'synthetic-juso' });
  await assert.rejects(store.set('JUSO_KEY', 'a\nb'), /INVALID_INPUT/);

  // The diagnostic bundle never takes the key file.
  const bundle = await writeDiagnosticBundle({ directory });
  assert.ok(!bundle.files.some((name) => /public-data/.test(name)), bundle.files.join(','));
});

test('routes: remote sessions are refused for keys and notice choices', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-public-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = (remote, input = {}) => ({
    remote,
    keys: new PublicDataKeyStore(directory, {}),
    settings: new SiteDataSettings(join(directory, 'site-data-settings.json')),
    requireProject: () => {},
    body: async () => input,
    send: () => {},
  });
  const url = (path) => new URL('http://127.0.0.1' + path);
  await assert.rejects(
    siteDataRoutes(url('/api/v1/settings/public-data'), 'GET', options(true)),
    /FORBIDDEN/,
  );
  await assert.rejects(
    siteDataRoutes(
      url('/api/v1/settings/public-data'),
      'PUT',
      options(true, { name: 'JUSO_KEY', value: 'x' }),
    ),
    /FORBIDDEN/,
  );
  await assert.rejects(
    siteDataRoutes(
      url('/api/v1/projects/p/site-data/notice'),
      'PUT',
      options(true, { confirm: true }),
    ),
    /FORBIDDEN/,
  );
  assert.equal(await siteDataRoutes(url('/api/v1/projects/p/other'), 'GET', options(true)), false);
});

test('HTTP: keys, notice before sending, confirm, lookup and collect, off', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-site-data-http-'));
  const fake = fakeSiteData();
  const app = await startServer({
    filename: join(directory, 'data', 'store.sqlite'),
    siteDataOptions: { fetch: fake.fetch, environment: {} },
  });
  let closed = false;
  t.after(async () => {
    if (!closed) await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const headers = {
    Origin: app.origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  for (const [name, value] of Object.entries(KEYS))
    assert.equal((await api('/settings/public-data', 'PUT', { name, value })).status, 200);
  const keys = await api('/settings/public-data');
  assert.ok(keys.json.keys.filter((k) => k.present).length === 3);
  assert.ok(!JSON.stringify(keys.json).includes('V-KEY'));

  const project = (await api('/projects', 'POST', { name: '합성 대지' })).json;
  const before = await api(`/projects/${project.id}/site-data/lookup`, 'POST', {
    query: '합성시 가나동 1',
  });
  assert.equal(before.status, 200);
  assert.ok(before.json.needsConfirm.sends.length >= 3);
  assert.ok(before.json.needsConfirm.recipients.some((r) => r.host === 'api.vworld.kr'));
  assert.equal(fake.calls.length, 0, 'nothing is sent before the notice is confirmed');

  const confirmed = await api(`/projects/${project.id}/site-data/notice`, 'PUT', { confirm: true });
  assert.equal(confirmed.json.confirmed, true);
  const lookup = await api(`/projects/${project.id}/site-data/lookup`, 'POST', {
    query: '합성시 가나동 1',
  });
  assert.equal(lookup.json.proposal, P1);
  const collect = await api(`/projects/${project.id}/site-data/collect`, 'POST', {
    pnus: [P1],
    radius: 50,
  });
  assert.equal(collect.json.target.items[0].pnu, P1);
  assert.ok(!JSON.stringify(collect.json).includes('D-KEY'));

  await api(`/projects/${project.id}/site-data/notice`, 'PUT', { off: true });
  const off = await api(`/projects/${project.id}/site-data/collect`, 'POST', { pnus: [P1] });
  assert.equal(off.status, 409);
  assert.equal(off.json.code, 'SITE_DATA_OFF');
  assert.equal((await api('/projects/none/site-data/notice')).status, 404);

  // Diagnostics name the run, never keys, addresses or PNUs (written out on close).
  await app.close();
  closed = true;
  const folder = join(directory, 'data', 'logs');
  const logs = (
    await Promise.all((await readdir(folder)).map((name) => readFile(join(folder, name), 'utf8')))
  ).join('');
  assert.match(logs, /"site-data"/);
  for (const secret of [...Object.values(KEYS), '가나동', P1])
    assert.ok(!logs.includes(secret), secret);
});

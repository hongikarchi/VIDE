import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';

const root = fileURLToPath(new URL('../../src/sharing/', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { Miniflare, Log, LogLevel } = require('miniflare'),
  { build } = require('esbuild');
const directory = resolve(root, '../../.vide/sharing-membership', randomUUID());
await mkdir(directory, { recursive: true });
const bundled = await build({
  entryPoints: [join(root, 'worker.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['node:*', 'cloudflare:*'],
  conditions: ['workerd', 'worker', 'browser'],
});
let mf;
const origin = 'http://127.0.0.1:8792',
  secret = randomBytes(32).toString('hex');
let logs = '';
class TestLog extends Log {
  log(message) {
    logs += message + '\n';
  }
}
const runtimeOptions = {
  resourcePersistencePath: join(directory, 'state'),
  telemetry: { enabled: false },
  log: new TestLog(LogLevel.NONE),
  workers: [
    {
      config: {
        name: 'vide-sharing-test',
        compatibilityDate: '2026-09-22',
        compatibilityFlags: ['nodejs_compat'],
        manifest: {
          mainModule: 'worker.js',
          modules: { 'worker.js': { type: 'esm', contents: bundled.outputFiles[0].text } },
        },
        env: {
          DB: { type: 'd1', id: 'test-db', dev: { remote: false } },
          ASSETS: { type: 'r2', name: 'test-assets', dev: { remote: false } },
          EMAIL: { type: 'send-email', dev: { remote: false } },
          AUTH_MODE: { type: 'text', value: 'manual-approval' },
          AUTH_ORIGIN: { type: 'text', value: origin },
          AUTH_SECRET: { type: 'text', value: secret },
          EMAIL_FROM: { type: 'text', value: 'VIDE <noreply@example.com>' },
        },
      },
    },
  ],
};
mf = new Miniflare(runtimeOptions);
const call = async (
  path,
  { method = 'GET', data, cookie, origin: requestOrigin = origin } = {},
) => {
  const response = await mf.dispatchFetch(origin + path, {
    method,
    headers: {
      Origin: requestOrigin,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.20',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const raw = await response.text();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  return {
    status: response.status,
    value,
    cookie: response.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; '),
  };
};
try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(join(root, 'migrations'))).sort()) {
    const sql = (await readFile(join(root, 'migrations', name), 'utf8')).replace(/^--.*$/gm, '');
    for (const statement of sql.split(';').filter((v) => v.trim()))
      await db.prepare(statement).run();
  }
  const account = async (name) => {
    const email = name + '@example.com',
      password = randomBytes(20).toString('hex');
    await call('/api/auth/sign-up/email', { method: 'POST', data: { name, email, password } });
    const response = await call('/api/auth/sign-in/email', {
      method: 'POST',
      data: { email, password },
    });
    assert.equal(response.status, 200, JSON.stringify(response));
    return { cookie: response.cookie };
  };
  const alice = await account('alice'),
    eve = await account('eve');
  // Pairing: a signed-in owner creates a one-time code; the desktop exchanges it for a host key.
  const code = await call('/api/hosts/pairings', {
    method: 'POST',
    cookie: alice.cookie,
    data: {},
  });
  assert.equal(code.status, 201);
  assert.match(code.value.code, /^[A-Z2-9]{8}$/);
  const device = (path, data, key) =>
    mf.dispatchFetch(origin + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(data),
    });
  let response = await device('/api/hosts/pair', { code: code.value.code, name: 'Studio PC' });
  assert.equal(response.status, 201);
  const pair = await response.json();
  assert.match(pair.secret, /^[a-f0-9]{64}$/);
  // A code works once.
  response = await device('/api/hosts/pair', { code: code.value.code, name: 'Again' });
  assert.equal(response.status, 404);
  const key = `${pair.hostId}.${pair.secret}`;
  // Only quick-tunnel addresses are accepted, so the list cannot point elsewhere.
  response = await device(
    '/api/hosts/heartbeat',
    { url: 'https://evil.example.com', status: {} },
    key,
  );
  assert.equal(response.status, 400);
  response = await device(
    '/api/hosts/heartbeat',
    { url: 'https://a-b-c.trycloudflare.com', status: {} },
    `${pair.hostId}.${'0'.repeat(64)}`,
  );
  assert.equal(response.status, 401);
  // Offline until the first heartbeat.
  let list = await call('/api/hosts', { cookie: alice.cookie });
  assert.equal(list.value.hosts[0].online, false);
  assert.equal(
    (
      await call(`/api/hosts/${pair.hostId}/open`, {
        method: 'POST',
        cookie: alice.cookie,
        data: {},
      })
    ).status,
    409,
  );
  response = await device(
    '/api/hosts/heartbeat',
    {
      url: 'https://a-b-c.trycloudflare.com',
      status: { documents: [{ host: 'rhino', name: 'Tower', live: true }] },
    },
    key,
  );
  assert.equal(response.status, 200);
  list = await call('/api/hosts', { cookie: alice.cookie });
  assert.equal(list.value.hosts[0].online, true);
  assert.equal(list.value.hosts[0].status.documents[0].name, 'Tower');
  // Other accounts neither see nor open the host.
  assert.deepEqual((await call('/api/hosts', { cookie: eve.cookie })).value.hosts, []);
  assert.equal(
    (await call(`/api/hosts/${pair.hostId}/open`, { method: 'POST', cookie: eve.cookie, data: {} }))
      .status,
    404,
  );
  const opened = await call(`/api/hosts/${pair.hostId}/open`, {
    method: 'POST',
    cookie: alice.cookie,
    data: {},
  });
  assert.equal(opened.status, 200);
  const link = new URL(opened.value.url);
  assert.equal(link.origin, 'https://a-b-c.trycloudflare.com');
  // The desktop verifies the Worker's token with the same key, once.
  const { RemoteAccess } = await import('../../src/server/remote-access.ts');
  const { writeFile: write } = await import('node:fs/promises');
  const hostDirectory = join(directory, 'host');
  await mkdir(hostDirectory, { recursive: true });
  await write(
    join(hostDirectory, 'remote-host.json'),
    JSON.stringify({
      workerOrigin: origin,
      hostId: pair.hostId,
      secret: pair.secret,
      name: 'Studio PC',
    }),
  );
  const { EventEmitter } = await import('node:events');
  const fakeTunnel = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit('exit', 0);
    setTimeout(
      () => child.stderr.emit('data', Buffer.from('| https://a-b-c.trycloudflare.com |')),
      10,
    );
    return child;
  };
  const remote = new RemoteAccess({
    directory: hostDirectory,
    port: () => 1234,
    status: async () => ({}),
    executable: 'cloudflared',
    spawnProcess: fakeTunnel,
    fetcher: (url, init) => mf.dispatchFetch(String(url), init),
  });
  await remote.start();
  assert.equal(remote.host, 'a-b-c.trycloudflare.com');
  const token = link.hash.slice('#r='.length);
  const session = await remote.login(token);
  assert.equal(remote.authorized(session), true);
  await assert.rejects(() => remote.login(token), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => remote.login(token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))), {
    code: 'UNAUTHORIZED',
  });
  await remote.stop();
  assert.equal(remote.authorized(session), false);
  // Stopping reports the host offline.
  list = await call('/api/hosts', { cookie: alice.cookie });
  assert.equal(list.value.hosts[0].online, false);
  assert.equal(
    (await call(`/api/hosts/${pair.hostId}`, { method: 'DELETE', cookie: alice.cookie })).status,
    200,
  );
  const result = {
    passed: true,
    pairingOnce: true,
    tunnelUrlRestricted: true,
    ownerOnly: true,
    signedTokenVerifiedOnce: true,
    offlineOnStop: true,
    directory,
  };
  await writeFile(join(directory, 'hosts-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await mf?.dispose();
}

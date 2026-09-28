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
          SIGNUP_CODE: { type: 'text', value: 'test-code' },
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
  const signUp = (username, password, code = 'test-code') =>
    call('/api/account/sign-up', { method: 'POST', data: { username, password, code } });
  const account = async (name) => {
    const password = randomBytes(20).toString('hex');
    assert.equal((await signUp(name, password)).status, 201);
    const response = await call('/api/account/sign-in', {
      method: 'POST',
      data: { username: name, password },
    });
    assert.equal(response.status, 200, JSON.stringify(response));
    return { cookie: response.cookie, password, id: response.value.user.id };
  };
  // Sign-up needs the owner's code; IDs are unique; the direct email route is closed.
  assert.equal((await signUp('mallory', 'long-enough-pw', 'wrong')).status, 403);
  assert.equal(
    (
      await call('/api/auth/sign-up/email', {
        method: 'POST',
        data: { name: 'x', email: 'x@example.com', password: 'long-enough-pw' },
      })
    ).status,
    403,
  );
  const alice = await account('alice'),
    eve = await account('eve');
  assert.equal((await signUp('alice', 'another-password')).status, 409);
  assert.equal(
    (
      await call('/api/account/sign-in', {
        method: 'POST',
        data: { username: 'alice', password: 'wrong-password' },
      })
    ).status,
    401,
  );
  assert.equal((await call('/api/me', { cookie: alice.cookie })).value.username, 'alice');

  // The work PC signs in with the same ID and password (no pairing code) and gets a host key.
  const { RemoteAccess } = await import('../../src/server/remote-access.ts');
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
  const hostDirectory = join(directory, 'host');
  await mkdir(hostDirectory, { recursive: true });
  const local = [{ id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Tower' }];
  const received = [];
  const pc = new RemoteAccess({
    directory: hostDirectory,
    port: () => 1234,
    status: async () => ({ documents: [{ host: 'rhino', name: 'Tower.3dm', live: true }] }),
    projects: () => local,
    activity: () => ({ [local[0].id]: Date.now() }),
    onProjects: (projects) => received.push(projects),
    executable: 'cloudflared',
    spawnProcess: fakeTunnel,
    fetcher: (url, init) => mf.dispatchFetch(String(url), init),
    heartbeatMs: 60_000,
  });
  await assert.rejects(() => pc.link('alice', 'wrong-password', 'Studio PC', origin), {
    code: 'INVALID_LOGIN',
  });
  let status = await pc.link('alice', alice.password, 'Studio PC', origin);
  assert.equal(status.linked, true);
  assert.equal(status.username, 'alice');
  while (!(await pc.status()).running) await new Promise((r) => setTimeout(r, 10));
  await pc.heartbeat();
  // The check did not leave a browser session behind for the PC.
  const sessions = await db
    .prepare('SELECT COUNT(*) AS n FROM session WHERE userId=?')
    .bind(alice.id)
    .first();
  assert.equal(sessions.n, 1);
  // The PC's existing project joined alice's list, and the PC is listed as on (local + remote).
  let projects = (await call('/api/projects', { cookie: alice.cookie })).value.projects;
  assert.deepEqual(
    projects.map((p) => p.name),
    ['Tower'],
  );
  let hosts = (await call('/api/hosts', { cookie: alice.cookie })).value.hosts;
  assert.equal(hosts.length, 1);
  const hostId = hosts[0].id;
  assert.equal(projects[0].host_id, hostId);
  assert.equal(hosts[0].online, true);
  assert.equal(hosts[0].remote, true);
  assert.equal(hosts[0].local, 'http://127.0.0.1:1234');
  assert.equal(hosts[0].status.documents[0].name, 'Tower.3dm');
  // Other accounts see neither.
  assert.deepEqual((await call('/api/hosts', { cookie: eve.cookie })).value.hosts, []);
  assert.deepEqual((await call('/api/projects', { cookie: eve.cookie })).value.projects, []);

  // A project made or renamed on the site reaches the PC with the next heartbeat.
  const made = await call('/api/projects', {
    method: 'POST',
    cookie: alice.cookie,
    data: { name: 'Web project' },
  });
  assert.equal(made.status, 201);
  assert.equal(made.value.host_id, hostId);
  assert.equal(
    (
      await call('/api/projects/' + local[0].id, {
        method: 'PATCH',
        cookie: alice.cookie,
        data: { name: 'Tower B' },
      })
    ).status,
    200,
  );
  await pc.heartbeat();
  assert.deepEqual(
    received
      .at(-1)
      .map((p) => p.name)
      .sort(),
    ['Tower B', 'Web project'],
  );

  // Opening a project returns one-minute links for this PC: local (same PC) and remote (tunnel).
  const open = (id, user) =>
    call(`/api/projects/${id}/open`, { method: 'POST', cookie: user.cookie, data: {} });
  const opened = await open(made.value.id, alice);
  assert.equal(opened.status, 200, JSON.stringify(opened));
  const remoteLink = new URL(opened.value.remote),
    localLink = new URL(opened.value.local);
  assert.equal(remoteLink.origin, 'https://a-b-c.trycloudflare.com');
  assert.equal(localLink.origin, 'http://127.0.0.1:1234');
  assert.equal(remoteLink.searchParams.get('project'), made.value.id);
  assert.equal((await open(made.value.id, eve)).status, 404);
  // The PC verifies the site's tokens with the same key, once each.
  const remoteToken = remoteLink.hash.slice('#r='.length),
    localToken = localLink.hash.slice('#r='.length);
  const session = await pc.login(remoteToken);
  assert.equal(pc.authorized(session), true);
  await assert.rejects(() => pc.login(remoteToken), { code: 'UNAUTHORIZED' });
  await pc.verify(localToken);
  await assert.rejects(() => pc.verify(localToken), { code: 'UNAUTHORIZED' });

  // Only quick-tunnel and loopback addresses are accepted, and only with the host key.
  const device = (path, data, key) =>
    mf.dispatchFetch(origin + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(data),
    });
  const key = JSON.parse(await readFile(join(hostDirectory, 'remote-host.json'), 'utf8'));
  const hostKey = `${key.hostId}.${key.secret}`;
  assert.equal(key.password, undefined);
  let response = await device(
    '/api/hosts/device/heartbeat',
    { url: 'https://evil.example.com' },
    hostKey,
  );
  assert.equal(response.status, 400);
  response = await device('/api/hosts/device/heartbeat', { local: 'http://10.0.0.5:80' }, hostKey);
  assert.equal(response.status, 400);
  response = await device('/api/hosts/device/heartbeat', {}, `${key.hostId}.${'0'.repeat(64)}`);
  assert.equal(response.status, 401);

  // Project card image from the PC.
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  assert.equal(await pc.pushThumbnail(made.value.id, jpeg), true);
  const image = await mf.dispatchFetch(`${origin}/api/projects/${made.value.id}/thumbnail`, {
    headers: { Cookie: alice.cookie },
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');

  // Remote access off: still on for local use, but no remote link.
  status = await pc.setRemote(false);
  assert.equal(status.running, false);
  hosts = (await call('/api/hosts', { cookie: alice.cookie })).value.hosts;
  assert.equal(hosts[0].online, true);
  assert.equal(hosts[0].remote, false);
  assert.equal(pc.authorized(session), false);
  // App closed: offline, and opening says so.
  await pc.close();
  hosts = (await call('/api/hosts', { cookie: alice.cookie })).value.hosts;
  assert.equal(hosts[0].online, false);
  assert.equal((await open(made.value.id, alice)).status, 409);
  // Deleting leaves the account list only.
  assert.equal(
    (await call('/api/projects/' + made.value.id, { method: 'DELETE', cookie: alice.cookie }))
      .status,
    200,
  );
  projects = (await call('/api/projects', { cookie: alice.cookie })).value.projects;
  assert.deepEqual(
    projects.map((p) => p.name),
    ['Tower B'],
  );
  // Signing the PC out removes it from the account.
  await pc.unlink();
  assert.deepEqual((await call('/api/hosts', { cookie: alice.cookie })).value.hosts, []);
  const result = {
    passed: true,
    signupCodeRequired: true,
    idLogin: true,
    pcLoginWithoutCode: true,
    projectsShared: true,
    localAndRemoteLinks: true,
    signedTokensOnce: true,
    addressesRestricted: true,
    offlineOnClose: true,
    directory,
  };
  await writeFile(join(directory, 'hosts-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await mf?.dispose();
}

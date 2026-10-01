import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { startServer } from '../../src/server/server.ts';

const TUNNEL = 'a-b-c.trycloudflare.com';
const fakeTunnel = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit('exit', 0);
  setTimeout(() => child.stderr.emit('data', Buffer.from(`| https://${TUNNEL} |`)), 5);
  return child;
};
// Raw HTTP so the test can present the tunnel's Host header like cloudflared does.
function call(port, path, { method = 'GET', host, origin, cookie, body, gzip } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          host,
          ...(origin ? { origin } : {}),
          ...(cookie ? { cookie } : {}),
          ...(gzip ? { 'accept-encoding': 'gzip' } : {}),
          ...(data ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const text = (
            res.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
          ).toString();
          resolve({ status: res.statusCode, headers: res.headers, text });
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}
const sign = (secret, payload) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return encoded + '.' + createHmac('sha256', secret).update(encoded).digest('hex');
};

test('site-signed tokens open local and tunnel sessions; tunnel cannot reach app control', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-remote-'));
  const heartbeats = [];
  const secret = randomBytes(32).toString('hex'),
    hostId = '356ff01d-b586-460c-8e2b-8c9f3c083e96';
  // A PC already signed in to the account (remote access off until turned on).
  await writeFile(
    join(directory, 'remote-host.json'),
    JSON.stringify({
      workerOrigin: 'https://sharing.example',
      hostId,
      secret,
      name: 'Studio PC',
      username: 'studio',
      remote: false,
    }),
  );
  const app = await startServer({
    filename: join(directory, 'workspace.sqlite'),
    remoteOptions: {
      executable: 'cloudflared',
      spawnProcess: fakeTunnel,
      fetcher: async (url, init) => {
        heartbeats.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
        return new Response('{"ok":true,"projects":[]}', { status: 200 });
      },
    },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const launch = new URL(app.launchUrl),
    port = Number(launch.port),
    local = launch.host;
  const localSession = await call(port, '/api/v1/session', {
    method: 'POST',
    host: local,
    origin: launch.origin,
    body: { token: launch.hash.slice(1) },
  });
  const localCookie = localSession.headers['set-cookie'][0].split(';')[0];
  // A linked PC reports presence with its local address even without the tunnel.
  while (!heartbeats.length) await new Promise((r) => setTimeout(r, 10));
  assert.equal(heartbeats[0].url, 'https://sharing.example/api/hosts/device/heartbeat');
  assert.equal(heartbeats[0].body.local, launch.origin);
  assert.equal(heartbeats[0].body.url, null);
  // The account site may ask (cross-origin) whether this is the browser's own PC; others may not.
  const hello = await call(port, '/api/v1/hello', {
    host: local,
    origin: 'https://sharing.example',
  });
  assert.equal(hello.status, 200);
  assert.equal(hello.headers['access-control-allow-origin'], 'https://sharing.example');
  assert.equal(JSON.parse(hello.text).hostId, hostId);
  assert.equal(
    (await call(port, '/api/v1/hello', { host: local, origin: 'https://evil.example' })).status,
    403,
  );
  // Opening this PC from the account site locally: a signed token gives a local session.
  const localToken = sign(secret, {
    h: hostId,
    n: randomBytes(16).toString('hex'),
    e: Date.now() + 60_000,
  });
  const siteLogin = await call(port, '/api/v1/session', {
    method: 'POST',
    host: local,
    origin: launch.origin,
    body: { remoteToken: localToken },
  });
  assert.equal(siteLogin.status, 200, siteLogin.text);
  assert.equal(siteLogin.headers['set-cookie'][0].split(';')[0], localCookie);
  assert.equal(
    (
      await call(port, '/api/v1/session', {
        method: 'POST',
        host: local,
        origin: launch.origin,
        body: { remoteToken: localToken },
      })
    ).status,
    401,
  );
  // Before the tunnel runs, its Host is just an unknown host.
  assert.equal((await call(port, '/api/v1/projects', { host: TUNNEL })).status, 403);
  const started = await call(port, '/api/v1/remote/remote', {
    method: 'POST',
    host: local,
    origin: launch.origin,
    cookie: localCookie,
    body: { enabled: true },
  });
  assert.equal(started.status, 200, started.text);
  let status;
  do {
    await new Promise((r) => setTimeout(r, 10));
    status = JSON.parse(
      (await call(port, '/api/v1/remote', { host: local, cookie: localCookie })).text,
    );
  } while (!status.running);
  assert.equal(status.url, `https://${TUNNEL}`);
  assert.equal(heartbeats.at(-1).body.url, `https://${TUNNEL}`);
  const remote = { host: TUNNEL, origin: `https://${TUNNEL}` };
  // The web page itself loads (compressed) before login; the API does not.
  const page = await call(port, '/', { ...remote, gzip: true });
  assert.equal(page.status, 200);
  assert.equal((await call(port, '/api/v1/projects', remote)).status, 401);
  // The local session cookie is not a remote session.
  assert.equal(
    (await call(port, '/api/v1/projects', { ...remote, cookie: localCookie })).status,
    401,
  );
  const expired = sign(secret, {
    h: hostId,
    n: randomBytes(16).toString('hex'),
    e: Date.now() - 1,
  });
  assert.equal(
    (
      await call(port, '/api/v1/session', {
        ...remote,
        method: 'POST',
        body: { remoteToken: expired },
      })
    ).status,
    401,
  );
  const token = sign(secret, {
    h: hostId,
    n: randomBytes(16).toString('hex'),
    e: Date.now() + 60_000,
  });
  const login = await call(port, '/api/v1/session', {
    ...remote,
    method: 'POST',
    body: { remoteToken: token },
  });
  assert.equal(login.status, 200, login.text);
  assert.match(
    login.headers['set-cookie'][0],
    /vide_remote=[a-f0-9]{64}; HttpOnly; Secure; SameSite=Strict/,
  );
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal(
    (
      await call(port, '/api/v1/session', {
        ...remote,
        method: 'POST',
        body: { remoteToken: token },
      })
    ).status,
    401,
  );
  const projects = await call(port, '/api/v1/projects', { ...remote, cookie, gzip: true });
  assert.equal(projects.status, 200);
  // Writes need the tunnel origin; app control, settings and the agent endpoint stay local.
  assert.equal(
    (
      await call(port, '/api/v1/projects', {
        host: TUNNEL,
        cookie,
        method: 'POST',
        origin: launch.origin,
        body: { name: 'x' },
      })
    ).status,
    403,
  );
  for (const [path, method] of [
    ['/api/v1/shutdown', 'POST'],
    ['/api/v1/remote/remote', 'POST'],
    ['/api/v1/remote/unlink', 'POST'],
    ['/api/v1/settings/ai', 'PUT'],
    // The usage lookup switch is this PC's setting; account management is in AccountSwitch.
    ['/api/v1/accounts/usage-settings', 'POST'],
    ['/mcp', 'POST'],
  ]) {
    const blocked = await call(port, path, {
      ...remote,
      cookie,
      method,
      body: method === 'GET' ? undefined : {},
    });
    assert.equal(blocked.status, 403, path + ' ' + blocked.text);
  }
  // Remote project work is allowed.
  const created = await call(port, '/api/v1/projects', {
    ...remote,
    cookie,
    method: 'POST',
    body: { name: 'From iPad' },
  });
  assert.equal(created.status, 201, created.text);
  // The project's AI instructions are readable remotely but changed on this PC only.
  const instructions = `/api/v1/projects/${JSON.parse(created.text).id}/ai-instructions`;
  assert.equal(
    (await call(port, instructions, { ...remote, cookie, method: 'PUT', body: { text: 'x' } }))
      .status,
    403,
  );
  assert.equal((await call(port, instructions, { ...remote, cookie })).status, 200);
  // A direct-mode guard (bulk erase, layer deletion, purge) is released at this PC only.
  const confirm = `/api/v1/projects/${JSON.parse(created.text).id}/requests/r-1/confirm`;
  assert.equal(
    (await call(port, confirm, { ...remote, cookie, method: 'POST', body: {} })).status,
    403,
  );
  // Remote status (no secrets) is readable from the remote page for its settings panel.
  assert.equal((await call(port, '/api/v1/remote', { ...remote, cookie })).status, 200);
  // Turning remote access off ends remote sessions; the PC stays listed for local use.
  await call(port, '/api/v1/remote/remote', {
    method: 'POST',
    host: local,
    origin: launch.origin,
    cookie: localCookie,
    body: { enabled: false },
  });
  assert.equal(heartbeats.at(-1).body.url, null);
  assert.equal((await call(port, '/api/v1/projects', { ...remote, cookie })).status, 403);
});

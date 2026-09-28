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

test('tunnel requests need a Worker-signed session and cannot reach app control', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-remote-'));
  const heartbeats = [];
  const app = await startServer({
    filename: join(directory, 'workspace.sqlite'),
    remoteOptions: {
      executable: 'cloudflared',
      spawnProcess: fakeTunnel,
      fetcher: async (url, init) => {
        heartbeats.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response('{"ok":true}', { status: 200 });
      },
    },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const secret = randomBytes(32).toString('hex'),
    hostId = '356ff01d-b586-460c-8e2b-8c9f3c083e96';
  await writeFile(
    join(directory, 'remote-host.json'),
    JSON.stringify({ workerOrigin: 'https://sharing.example', hostId, secret, name: 'Studio PC' }),
  );
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
  // Before the tunnel runs, its Host is just an unknown host.
  assert.equal((await call(port, '/api/v1/projects', { host: TUNNEL })).status, 403);
  const started = await call(port, '/api/v1/remote/start', {
    method: 'POST',
    host: local,
    origin: launch.origin,
    cookie: localCookie,
    body: {},
  });
  assert.equal(started.status, 200, started.text);
  assert.equal(JSON.parse(started.text).url, `https://${TUNNEL}`);
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
    ['/api/v1/remote/stop', 'POST'],
    ['/api/v1/remote', 'GET'],
    ['/api/v1/settings/ai', 'PUT'],
    ['/api/v1/accounts/select', 'POST'],
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
  // Stopping the tunnel ends remote sessions and reports offline.
  await call(port, '/api/v1/remote/stop', {
    method: 'POST',
    host: local,
    origin: launch.origin,
    cookie: localCookie,
    body: {},
  });
  assert.equal(heartbeats.at(-1).body.url, null);
  assert.equal((await call(port, '/api/v1/projects', { ...remote, cookie })).status, 403);
});

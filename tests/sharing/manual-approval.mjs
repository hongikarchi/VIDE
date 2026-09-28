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
  const account = async (name) => {
    const email = name + '@users.vide.invalid',
      password = randomBytes(20).toString('hex');
    let response = await call('/api/account/sign-up', {
      method: 'POST',
      data: { username: name, password, code: 'test-code' },
    });
    assert.equal(response.status, 201, JSON.stringify(response));
    response = await call('/api/account/sign-in', {
      method: 'POST',
      data: { username: name, password },
    });
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.ok(response.cookie);
    return { id: response.value.user.id, email, cookie: response.cookie, password };
  };
  const alice = await account('alice'),
    bob = await account('bob'),
    eve = await account('eve');
  const create = await call('/api/projects', {
    method: 'POST',
    cookie: alice.cookie,
    data: { name: 'Manual approval' },
  });
  assert.equal(create.status, 201);
  const project = create.value.id;
  const base = '/api/projects/' + project;
  const invite = async () => {
    const r = await call(base + '/invitations', {
      method: 'POST',
      cookie: alice.cookie,
      data: { email: bob.email, role: 'commenter' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.value.emailDelivery, 'disabled');
    return { ...r.value, token: new URL(r.value.link).hash.slice(1) };
  };
  const submit = (user, i) =>
    call('/api/invitations/accept', {
      method: 'POST',
      cookie: user.cookie,
      data: { token: i.token },
    });
  const i = await invite();
  assert.equal((await submit(eve, i)).status, 409);
  const [a, b] = await Promise.all([submit(bob, i), submit(bob, i)]);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.equal(a.value.requestId, b.value.requestId);
  assert.equal((await call(base, { cookie: bob.cookie })).status, 404);
  const route = base + '/join-requests/' + a.value.requestId;
  assert.equal(
    (await call(route, { method: 'POST', cookie: bob.cookie, data: { decision: 'approve' } }))
      .status,
    404,
  );
  assert.equal(
    (
      await call(route, {
        method: 'POST',
        cookie: alice.cookie,
        data: { decision: 'approve' },
        origin: 'https://foreign.example',
      })
    ).status,
    403,
  );
  assert.equal(
    (await call(route, { method: 'POST', cookie: alice.cookie, data: { decision: 'approve' } }))
      .status,
    200,
  );
  assert.equal((await call(base, { cookie: bob.cookie })).status, 200);
  assert.equal(
    (await call(base + '/members/' + bob.id, { method: 'DELETE', cookie: alice.cookie })).status,
    200,
  );
  assert.equal(
    (await call(route, { method: 'POST', cookie: alice.cookie, data: { decision: 'approve' } }))
      .status,
    409,
  );
  assert.equal((await submit(bob, i)).status, 409);
  assert.equal((await call(base, { cookie: bob.cookie })).status, 404);
  for (const scenario of ['revoke', 'expire', 'reject']) {
    const inv = await invite(),
      pending = await submit(bob, inv),
      path = base + '/join-requests/' + pending.value.requestId;
    if (scenario === 'revoke')
      await call(base + '/invitations/' + inv.id, { method: 'DELETE', cookie: alice.cookie });
    if (scenario === 'expire')
      await db.prepare('UPDATE invitations SET expires_at=0 WHERE id=?').bind(inv.id).run();
    if (scenario === 'reject')
      assert.equal(
        (await call(path, { method: 'POST', cookie: alice.cookie, data: { decision: 'reject' } }))
          .status,
        200,
      );
    assert.equal(
      (await call(path, { method: 'POST', cookie: alice.cookie, data: { decision: 'approve' } }))
        .status,
      409,
    );
    assert.equal((await call(base, { cookie: bob.cookie })).status, 404);
  }
  for (const path of [
    'request-password-reset',
    'reset-password',
    'send-verification-email',
    'change-email',
  ])
    assert.equal(
      (
        await call('/api/auth/' + path, {
          method: 'POST',
          cookie: bob.cookie,
          data: { email: bob.email },
        })
      ).status,
      403,
    );
  // ID accounts are admitted by the sign-up code (no mailbox); email verification never ran.
  assert.equal((await db.prepare('SELECT count(*) n FROM verification').first()).n, 0);
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        unverifiedLogin: true,
        approvalRequired: true,
        replayRevokedExpiredRejected: true,
        mailDisabled: true,
      },
      null,
      2,
    ),
  );
  console.log('Manual approval checks passed:', directory);
} finally {
  await mf.dispose();
}

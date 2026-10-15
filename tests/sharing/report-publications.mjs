// SPEC-04.14, PLAN-54 T-343: a work PC puts a 보고용 folder behind a password link `/r/<id>/` on the
// account site. Only the project's owner account publishes (with its PC's host key); the site keeps
// a hash of the password, never the value; the link shows a password form, the right password
// gives a cookie for that publication only; 다시 게시 keeps the link (and the password unless a new
// one is sent); [내리기] deletes the files and the link answers 404. The last part runs the engine's
// own uploader (src/server/publish-routes.ts) through RemoteAccess, with a file sent in parts.
// Run: node tests/sharing/report-publications.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { runDirectory } from '../integration/run-directory.mjs';

const root = fileURLToPath(new URL('../../src/sharing/', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { Miniflare, Log, LogLevel } = require('miniflare'),
  { build } = require('esbuild');
const directory = runDirectory('sharing-report-publications');
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
const origin = 'http://127.0.0.1:8795',
  secret = randomBytes(32).toString('hex');
const options = (settings = {}) => ({
  resourcePersistencePath: join(directory, 'state'),
  telemetry: { enabled: false },
  log: new Log(LogLevel.NONE),
  workers: [
    {
      config: {
        name: 'vide-sharing-report-publications-test',
        compatibilityDate: '2026-09-22',
        compatibilityFlags: ['nodejs_compat'],
        manifest: {
          mainModule: 'worker.js',
          modules: { 'worker.js': { type: 'esm', contents: bundled.outputFiles[0].text } },
        },
        env: {
          DB: { type: 'd1', id: 'test-db', dev: { remote: false } },
          ASSETS: { type: 'r2', name: 'test-assets', dev: { remote: false } },
          ...Object.fromEntries(
            Object.entries({
              AUTH_MODE: 'manual-approval',
              AUTH_ORIGIN: origin,
              AUTH_SECRET: secret,
              SIGNUP_CODE: 'test-code',
              EMAIL_FROM: '',
              ...settings,
            }).map(([key, value]) => [key, { type: 'text', value }]),
          ),
        },
      },
    },
  ],
});
let mf = new Miniflare(options());
const call = async (path, { method = 'GET', data, form, cookie, headers = {} } = {}) => {
  const response = await mf.dispatchFetch(origin + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(form !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    ...(form !== undefined ? { body: new URLSearchParams(form).toString() } : {}),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    value = buffer.toString('utf8');
  }
  return { status: response.status, value, headers: response.headers };
};

try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(join(root, 'migrations'))).sort()) {
    const sql = (await readFile(join(root, 'migrations', name), 'utf8')).replace(/^--.*$/gm, '');
    for (const statement of sql.split(';').filter((v) => v.trim()))
      await db.prepare(statement).run();
  }
  const passwords = {};
  let address = 10;
  const account = async (username) => {
    passwords[username] = randomBytes(20).toString('hex');
    const up = await call('/api/account/sign-up', {
      method: 'POST',
      headers: { Origin: origin },
      data: { username, password: passwords[username], code: 'test-code' },
    });
    assert.equal(up.status, 201, JSON.stringify(up.value));
  };
  const device = async (username, name) => {
    const login = await call('/api/hosts/device/login', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': `192.0.2.${++address}` },
      data: { name, username, password: passwords[username] },
    });
    assert.equal(login.status, 201, JSON.stringify(login.value));
    return `${login.value.hostId}.${login.value.secret}`;
  };
  await account('eve');
  await account('mallory');
  const evePc = await device('eve', '설계실 PC'),
    malloryPc = await device('mallory', 'M PC');
  const projectId = 'project-report-0001';
  const auth = (key) => ({ Authorization: `Bearer ${key}` });
  assert.equal(
    (
      await call('/api/hosts/device/projects', {
        method: 'POST',
        headers: auth(evePc),
        data: { id: projectId, name: '논현동 근생' },
      })
    ).status,
    201,
  );
  const dev = (key, path, init = {}) =>
    call('/api/hosts/device/report-publications' + path, { ...init, headers: auth(key) });
  const put = (key, id, path, text) =>
    dev(key, `/${id}/files`, {
      method: 'PUT',
      data: { path, data: Buffer.from(text).toString('base64') },
    });
  const reportPassword = 'coffee-mug-review'; // a made-up test value
  const page =
    '<!doctype html><html><body><h1>건축개요 보고서</h1><a href="표.csv">표</a></body></html>';

  // --- who may publish ---
  assert.equal(
    (await call('/api/hosts/device/report-publications', { method: 'POST', data: {} })).status,
    401,
    'the host key is needed',
  );
  const notOwner = await dev(malloryPc, '', {
    method: 'POST',
    data: { projectId, title: '보고서', password: reportPassword },
  });
  assert.equal(notOwner.status, 404, 'a non-member account cannot publish the project');
  assert.equal(
    (
      await dev(evePc, '', {
        method: 'POST',
        data: { projectId, title: '보고서', password: 'short' },
      })
    ).status,
    400,
    'a password under 8 characters',
  );

  // --- publish ---
  const started = await dev(evePc, '', {
    method: 'POST',
    data: { projectId, title: '건축개요 보고서', password: reportPassword },
  });
  assert.equal(started.status, 201, JSON.stringify(started.value));
  const id = started.value.id;
  assert.match(id, /^[0-9a-f]{32}$/, 'an unguessable id');
  assert.equal(started.value.url, `${origin}/r/${id}/`);
  // Not served before finish.
  assert.equal((await call(`/r/${id}/`)).status, 404, 'nothing opens before the upload finishes');
  assert.equal((await put(evePc, id, 'index.html', page)).status, 200);
  assert.equal((await put(evePc, id, '표.csv', '﻿층,면적\r\n1,120\r\n')).status, 200);
  assert.equal((await put(evePc, id, 'report.json', '{}')).status, 400, 'only page, CSV, images');
  assert.equal((await put(evePc, id, '../x.html', 'x')).status, 400, 'no path segments');
  assert.equal((await put(malloryPc, id, 'a.html', 'x')).status, 404, "another account's link");
  const finished = await dev(evePc, `/${id}/finish`, { method: 'POST', data: {} });
  assert.equal(finished.status, 200, JSON.stringify(finished.value));
  assert.equal(finished.value.fileCount, 2);
  const row = await db.prepare('SELECT * FROM report_publications WHERE id=?').bind(id).first();
  assert.notEqual(row.password_hash, reportPassword);
  assert.ok(
    !JSON.stringify(row).includes(reportPassword),
    'the site keeps a hash, never the password',
  );

  // --- the link ---
  const form = await call(`/r/${id}/`);
  assert.equal(form.status, 401);
  assert.match(form.value, /비밀번호를 입력하세요/);
  assert.match(form.value, /건축개요 보고서/, 'the form names the report');
  assert.doesNotMatch(form.value, /<h1>건축개요 보고서<\/h1>/, 'not the content');
  assert.equal(form.headers.get('Cache-Control'), 'private, no-store');
  assert.match(form.headers.get('X-Robots-Tag'), /noindex/);
  assert.match(form.headers.get('Content-Security-Policy'), /style-src 'unsafe-inline'/);
  assert.equal((await call(`/r/${id}`)).status, 303, 'the bare link adds the slash');
  assert.equal((await call(`/r/${id}/표.csv`)).status, 401, 'files need the password too');
  const wrong = await call(`/r/${id}/login`, {
    method: 'POST',
    form: { password: 'not-the-password' },
    headers: { Origin: origin },
  });
  assert.equal(wrong.status, 401);
  assert.match(wrong.value, /비밀번호가 맞지 않습니다/);
  assert.equal(
    (
      await call(`/r/${id}/login`, {
        method: 'POST',
        form: { password: reportPassword },
        headers: { Origin: 'https://elsewhere.example' },
      })
    ).status,
    403,
    'a form on another site cannot try passwords',
  );
  const login = await call(`/r/${id}/login`, {
    method: 'POST',
    form: { password: reportPassword },
    headers: { Origin: origin },
  });
  assert.equal(login.status, 303);
  const setCookie = login.headers.get('Set-Cookie');
  assert.match(
    setCookie,
    new RegExp(
      `^__Host-vr-${id}=\\d+\\.[0-9a-f]{64}; Max-Age=28800; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ),
  );
  const cookie = setCookie.split(';')[0];
  const opened = await call(`/r/${id}/`, { cookie });
  assert.equal(opened.status, 200);
  assert.match(opened.value, /<h1>건축개요 보고서<\/h1>/);
  assert.equal(opened.headers.get('Cache-Control'), 'private, no-store');
  assert.match(opened.headers.get('X-Robots-Tag'), /noindex/);
  const csv = await call(`/r/${id}/${encodeURIComponent('표.csv')}`, { cookie });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('Content-Type'), /text\/csv/);
  assert.equal((await call(`/r/${id}/nothing.html`, { cookie })).status, 404);
  const forged = cookie.replace(/[0-9a-f](?=$)/, (c) => (c === '0' ? '1' : '0'));
  assert.equal((await call(`/r/${id}/`, { cookie: forged })).status, 401, 'a forged cookie');

  // A second publication: its own cookie, the first one's does not open it.
  const other = await dev(evePc, '', {
    method: 'POST',
    data: { projectId, title: '대지 보고서', password: 'Other-pass-42' },
  });
  await put(evePc, other.value.id, 'index.html', '<h1>대지</h1>');
  await dev(evePc, `/${other.value.id}/finish`, { method: 'POST', data: {} });
  assert.equal(
    (await call(`/r/${other.value.id}/`, { cookie: cookie.replace(id, other.value.id) })).status,
    401,
    "one publication's cookie does not open another",
  );

  // --- 다시 게시: same link, same password, old files until finish, then replaced ---
  const again = await dev(evePc, '', {
    method: 'POST',
    data: { projectId, title: '건축개요 보고서', id },
  });
  assert.equal(again.status, 200, JSON.stringify(again.value));
  assert.equal(again.value.id, id);
  await put(evePc, id, 'index.html', '<h1>고친 보고서</h1>');
  assert.match(
    (await call(`/r/${id}/`, { cookie })).value,
    /<h1>건축개요 보고서<\/h1>/,
    'still the old one',
  );
  await dev(evePc, `/${id}/finish`, { method: 'POST', data: {} });
  assert.match(
    (await call(`/r/${id}/`, { cookie })).value,
    /고친 보고서/,
    'the cookie still works',
  );
  assert.equal(
    (await call(`/r/${id}/${encodeURIComponent('표.csv')}`, { cookie })).status,
    404,
    'the old version is gone with the switch',
  );
  const objects = (await (await mf.getR2Bucket('ASSETS')).list({ prefix: `reports/${id}/` }))
    .objects;
  assert.equal(objects.length, 1, 'only the new version is kept');

  // Uploads paused: no new publish, removal still works.
  await mf.setOptions(options({ UPLOADS_ENABLED: 'false' }));
  const paused = await dev(evePc, '', {
    method: 'POST',
    data: { projectId, title: '보고서', password: reportPassword },
  });
  assert.equal(paused.status, 503);
  assert.equal(paused.value.error, 'UPLOADS_DISABLED');
  await mf.setOptions(options());

  // --- [내리기] ---
  assert.equal((await dev(malloryPc, `/${id}`, { method: 'DELETE' })).status, 404);
  const removed = await dev(evePc, `/${id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.value.removed, true);
  assert.equal((await call(`/r/${id}/`, { cookie })).status, 404, 'the link is gone');
  assert.equal(
    (await (await mf.getR2Bucket('ASSETS')).list({ prefix: `reports/${id}/` })).objects.length,
    0,
    'the files are deleted',
  );
  assert.equal((await dev(evePc, `/${id}`, { method: 'DELETE' })).value.removed, false);
  assert.equal(
    (await dev(evePc, '', { method: 'POST', data: { projectId, title: 'x', id } })).status,
    404,
    'a removed publication is not brought back',
  );

  // --- the engine's uploader through the PC's account link, a big file in parts ---
  const { RemoteAccess } = await import('../../src/server/remote-access.ts');
  const { publishToSite } = await import('../../src/server/publish-routes.ts');
  const hostDirectory = join(directory, 'host');
  await mkdir(hostDirectory, { recursive: true });
  const pc = new RemoteAccess({
    directory: hostDirectory,
    port: () => 1234,
    status: async () => ({ version: '0.2.30' }),
    fetcher: (url, init) =>
      mf.dispatchFetch(String(url), {
        ...init,
        headers: { ...init?.headers, 'CF-Connecting-IP': '198.51.100.21' },
      }),
    heartbeatMs: 60_000,
  });
  try {
    assert.equal((await pc.link('eve', passwords.eve, '현장 PC', origin)).linked, true);
    const big = Buffer.alloc(11 * 1024 * 1024, 'a');
    big.write('<!doctype html><h1>큰 보고서</h1>');
    const done = await publishToSite(pc, {
      projectId,
      title: '큰 보고서',
      password: reportPassword,
      files: [
        ['index.html', big],
        ['표.csv', Buffer.from('a,b\r\n')],
      ],
    });
    assert.equal(done.url, `${origin}/r/${done.id}/`);
    const enter = await call(`/r/${done.id}/login`, {
      method: 'POST',
      form: { password: reportPassword },
      headers: { Origin: origin },
    });
    const bigCookie = enter.headers.get('Set-Cookie').split(';')[0];
    const served = await mf.dispatchFetch(`${origin}/r/${done.id}/`, {
      headers: { Cookie: bigCookie },
    });
    const bytes = Buffer.from(await served.arrayBuffer());
    assert.equal(bytes.length, big.length, 'the parts were joined into one file');
    assert.ok(bytes.equals(big));
    // 다시 게시 through the uploader: no password sent, the old one still opens it.
    const again2 = await publishToSite(pc, {
      projectId,
      title: '큰 보고서',
      id: done.id,
      files: [['index.html', Buffer.from('<h1>작게</h1>')]],
    });
    assert.equal(again2.id, done.id);
    assert.match(
      await (
        await mf.dispatchFetch(`${origin}/r/${done.id}/`, { headers: { Cookie: bigCookie } })
      ).text(),
      /작게/,
    );
  } finally {
    await pc.close();
  }

  console.log(
    JSON.stringify({
      ownerOnly: true,
      hashOnly: true,
      passwordForm: true,
      cookiePerPublication: true,
      republishKeepsLink: true,
      uploadsPause: true,
      unpublish404: true,
      engineUploaderInParts: true,
    }),
  );
} finally {
  await mf?.dispose();
}

// ADR-036, PLAN-34 T-157·T-158: the site takes opt-in reports from VIDE installs — small, anonymous,
// limited per install and per address, never one that still holds a path or an e-mail; bundles
// only while the site switch is on; the reports API and CSV answer site admins (or the admin token)
// only. Run: node tests/sharing/telemetry.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { runDirectory } from '../integration/run-directory.mjs';

const root = fileURLToPath(new URL('../../src/sharing/', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { Miniflare, Log, LogLevel } = require('miniflare'),
  { build } = require('esbuild');
const directory = runDirectory('sharing-telemetry');
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
const origin = 'http://127.0.0.1:8793',
  secret = randomBytes(32).toString('hex'),
  adminToken = randomBytes(24).toString('hex');
const options = (settings = {}) => ({
  resourcePersistencePath: join(directory, 'state'),
  telemetry: { enabled: false },
  log: new Log(LogLevel.NONE),
  workers: [
    {
      config: {
        name: 'vide-sharing-telemetry-test',
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
              ADMIN_USERS: 'boss, chief@example.com',
              TELEMETRY_ADMIN_TOKEN: adminToken,
              TELEMETRY_INSTALL_DAILY: '3',
              TELEMETRY_IP_DAILY: '6',
              ...settings,
            }).map(([key, value]) => [key, { type: 'text', value }]),
          ),
        },
      },
    },
  ],
});
let mf = new Miniflare(options());
const call = async (
  path,
  { method = 'GET', data, cookie, ip = '192.0.2.1', headers = {}, raw } = {},
) => {
  const response = await mf.dispatchFetch(origin + path, {
    method,
    headers: {
      ...(data !== undefined || raw === undefined ? { 'Content-Type': 'application/json' } : {}),
      'CF-Connecting-IP': ip,
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(data !== undefined
      ? { body: JSON.stringify(data) }
      : raw !== undefined
        ? { body: raw }
        : {}),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return {
    status: response.status,
    value,
    headers: response.headers,
    cookies: response.headers.getSetCookie(),
  };
};
const report = (installId = randomUUID(), payload = {}) => ({
  installId,
  version: '0.2.21',
  kind: 'summary',
  payload: {
    os: 'win32 10.0.26200',
    counts: { 'engine:api-error': 2 },
    errors: [
      {
        part: 'engine',
        event: 'api-error',
        count: 2,
        fields: { code: 'PROJECT_BUSY', path: '/api/v1/projects/:id' },
      },
    ],
    exits: [],
    timings: { 'request.totalMs': { n: 3, p50: 900, p90: 2000, max: 2500 } },
    ...payload,
  },
});

try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(join(root, 'migrations'))).sort()) {
    const sql = (await readFile(join(root, 'migrations', name), 'utf8')).replace(/^--.*$/gm, '');
    for (const statement of sql.split(';').filter((v) => v.trim()))
      await db.prepare(statement).run();
  }

  // --- the public endpoint ---
  const install = randomUUID();
  const first = await call('/api/telemetry/reports', { method: 'POST', data: report(install) });
  assert.equal(first.status, 201, JSON.stringify(first.value));
  assert.equal(first.cookies.length, 0, 'no cookie for a report');
  const row = await db
    .prepare('SELECT * FROM telemetry_reports WHERE id=?')
    .bind(first.value.id)
    .first();
  assert.equal(row.install_id, install);
  assert.equal(row.version, '0.2.21');
  assert.equal(row.kind, 'summary');
  assert.equal(JSON.parse(row.payload).errors[0].fields.code, 'PROJECT_BUSY');
  // Malformed: a made-up id, an unknown kind, a non-object payload, text instead of JSON.
  for (const bad of [
    { ...report(), installId: 'not-a-uuid' },
    { ...report(), kind: 'everything' },
    { ...report(), version: '../../etc' },
    { ...report(), payload: [1, 2] },
  ])
    assert.equal((await call('/api/telemetry/reports', { method: 'POST', data: bad })).status, 400);
  assert.equal(
    (
      await call('/api/telemetry/reports', {
        method: 'POST',
        raw: 'x',
        headers: { 'Content-Type': 'text/plain' },
      })
    ).status,
    415,
  );
  // Too large.
  const large = await call('/api/telemetry/reports', {
    method: 'POST',
    data: report(randomUUID(), { filler: 'x'.repeat(60 * 1024) }),
  });
  assert.equal(large.status, 413);
  // A report that still holds a path, a user folder or an e-mail is not kept.
  for (const leak of [
    { message: 'open C:\\Users\\kim\\x.3dm' },
    { message: 'open C:/work/x.3dm' },
    { message: 'at \\\\server\\share\\x' },
    { message: 'kim@studio.co.kr' },
    { message: '/home/kim/.vide' },
  ]) {
    const response = await call('/api/telemetry/reports', {
      method: 'POST',
      data: report(randomUUID(), {
        errors: [{ part: 'engine', event: 'server-error', count: 1, fields: leak }],
      }),
    });
    assert.equal(response.status, 422, JSON.stringify(leak));
  }
  assert.equal(
    (await db.prepare('SELECT COUNT(*) AS n FROM telemetry_reports').first()).n,
    1,
    'rejected reports are not stored',
  );
  // Rate limits: 3 a day per install (1 used), 6 a day per address.
  assert.equal(
    (await call('/api/telemetry/reports', { method: 'POST', data: report(install) })).status,
    201,
  );
  assert.equal(
    (await call('/api/telemetry/reports', { method: 'POST', data: report(install) })).status,
    201,
  );
  const limited = await call('/api/telemetry/reports', { method: 'POST', data: report(install) });
  assert.equal(limited.status, 429);
  assert.equal(limited.value.error, 'RATE_LIMITED');
  const ip = '198.51.100.7';
  for (let i = 0; i < 6; i++)
    assert.equal(
      (await call('/api/telemetry/reports', { method: 'POST', ip, data: report() })).status,
      201,
    );
  assert.equal(
    (await call('/api/telemetry/reports', { method: 'POST', ip, data: report() })).status,
    429,
  );
  // Bundles are off by default (R2 is not used until the owner turns them on).
  const zip = Buffer.from('PK\u0005\u0006' + '\0'.repeat(18), 'binary');
  const bundleHeaders = {
    'Content-Type': 'application/zip',
    'X-Vide-Install': install,
    'X-Vide-Version': '0.2.21',
    'X-Vide-Dumps': '0',
  };
  const off = await call('/api/telemetry/bundles', {
    method: 'POST',
    raw: zip,
    headers: bundleHeaders,
  });
  assert.equal(off.status, 503);
  assert.equal(off.value.error, 'BUNDLES_DISABLED');

  // --- admins only ---
  const account = async (username) => {
    const password = randomBytes(20).toString('hex');
    const up = await call('/api/account/sign-up', {
      method: 'POST',
      headers: { Origin: origin },
      data: { username, password, code: 'test-code' },
    });
    assert.equal(up.status, 201, JSON.stringify(up.value));
    const signIn = await call('/api/account/sign-in', {
      method: 'POST',
      headers: { Origin: origin },
      ip: '192.0.2.50',
      data: { username, password },
    });
    return signIn.cookies.map((v) => v.split(';')[0]).join('; ');
  };
  const boss = await account('boss'),
    eve = await account('eve');
  assert.equal((await call('/api/admin/telemetry/reports')).status, 401);
  const forbidden = await call('/api/admin/telemetry/reports', { cookie: eve });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.value.error, 'ADMIN_REQUIRED');
  assert.equal((await call('/api/admin/telemetry/reports.csv', { cookie: eve })).status, 403);
  assert.equal(
    (
      await call('/api/admin/telemetry/reports', {
        headers: { Authorization: 'Bearer ' + 'x'.repeat(40) },
      })
    ).status,
    401,
    'a wrong token is no admin',
  );
  assert.equal((await call('/api/me', { cookie: eve })).value.admin, false);
  assert.equal((await call('/api/me', { cookie: boss })).value.admin, true);
  const listed = await call('/api/admin/telemetry/reports?limit=500', { cookie: boss });
  assert.equal(listed.status, 200);
  assert.equal(listed.value.reports.length, 9);
  assert.equal(listed.value.reports[0].brief.topError, 'api-error PROJECT_BUSY');
  const byInstall = await call(`/api/admin/telemetry/reports?install=${install}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(byInstall.status, 200, 'the developers token reads reports');
  assert.equal(byInstall.value.reports.length, 3);
  const today = new Date().toISOString().slice(0, 10);
  const summary = await call(`/api/admin/telemetry/summary?day=${today}&version=0.2.21`, {
    cookie: boss,
  });
  assert.deepEqual(
    summary.value.rows.map((r) => [r.day, r.version, r.kind, r.reports, r.installs]),
    [[today, '0.2.21', 'summary', 9, 7]],
  );
  assert.equal((await call('/api/admin/telemetry/reports?day=bad', { cookie: boss })).status, 400);
  assert.equal(
    (await call('/api/admin/telemetry/reports', { method: 'POST', cookie: boss, data: {} })).status,
    405,
  );

  // CSV: a header, one line per report, formula-looking cells made inert.
  await call('/api/telemetry/reports', {
    method: 'POST',
    ip: '203.0.113.9',
    data: report(randomUUID(), {
      os: '=HYPERLINK("http://x")',
      errors: [
        {
          part: 'engine',
          event: 'server-error',
          count: 1,
          fields: { code: '+SUM', message: 'a "quoted", line' },
        },
      ],
    }),
  });
  const csv = await call('/api/admin/telemetry/reports.csv', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('Content-Type'), /^text\/csv/);
  assert.match(csv.headers.get('Content-Disposition'), /attachment; filename="vide-reports-/);
  const lines = csv.value
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n');
  assert.equal(
    lines[0],
    'id,received_at,day,install_id,version,kind,size,os,errors,top_error,exits,truncated,payload',
  );
  assert.equal(lines.length, 11);
  const injected = lines.find((line) => line.includes('HYPERLINK'));
  assert.match(injected, /,"'=HYPERLINK\(""http:\/\/x""\)",/);
  assert.ok(injected.includes(',server-error +SUM,'), injected);
  // The payload is one quoted cell: its quotes doubled.
  assert.ok(injected.includes('""message"":""a \\""quoted\\"", line""'), injected);

  // Bundles with the switch on: stored in R2 and indexed; admins download them.
  await mf.setOptions(
    options({ TELEMETRY_BUNDLES_ENABLED: 'true', TELEMETRY_BUNDLE_MAX_MB: '0.001' }),
  );
  const tooBig = await call('/api/telemetry/bundles', {
    method: 'POST',
    raw: Buffer.alloc(4096),
    headers: { ...bundleHeaders, 'Content-Length': '4096' },
  });
  assert.equal(tooBig.status, 413);
  assert.equal(
    (
      await call('/api/telemetry/bundles', {
        method: 'POST',
        raw: zip,
        headers: { ...bundleHeaders, 'Content-Type': 'text/plain' },
      })
    ).status,
    415,
  );
  const on = await call('/api/telemetry/bundles', {
    method: 'POST',
    raw: zip,
    headers: { ...bundleHeaders, 'Content-Length': String(zip.length) },
  });
  assert.equal(on.status, 201, JSON.stringify(on.value));
  const bundles = await call('/api/admin/telemetry/bundles', { cookie: boss });
  assert.equal(bundles.value.enabled, true);
  assert.equal(bundles.value.bundles[0].id, on.value.id);
  const download = await mf.dispatchFetch(`${origin}/api/admin/telemetry/bundles/${on.value.id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), zip);
  assert.equal(
    (await call(`/api/admin/telemetry/bundles/${on.value.id}`, { cookie: eve })).status,
    403,
  );

  console.log(
    JSON.stringify({
      reportsStored: true,
      malformedRefused: true,
      leaksRefused: true,
      rateLimited: true,
      bundlesOffByDefault: true,
      adminOnly: true,
      csv: true,
      bundlesWhenOn: true,
    }),
  );
} finally {
  await mf?.dispose();
}

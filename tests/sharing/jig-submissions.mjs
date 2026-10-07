// ADR-041, SPEC-04.13, PLAN-43 T-201: a work PC sends a jig pack to the admins' box. The site
// computes the SHA-256 of the bytes, refuses what is not a pack of the declared id and version
// and what is over the size cap, lists only the account's own submissions to a PC, and opens the
// box (list, download, status, delete) to admins only. Run: node tests/sharing/jig-submissions.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { runDirectory } from '../integration/run-directory.mjs';

const root = fileURLToPath(new URL('../../src/sharing/', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { Miniflare, Log, LogLevel } = require('miniflare'),
  { build } = require('esbuild');
const directory = runDirectory('sharing-jig-submissions');
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
const origin = 'http://127.0.0.1:8794',
  secret = randomBytes(32).toString('hex');
const options = (settings = {}) => ({
  resourcePersistencePath: join(directory, 'state'),
  telemetry: { enabled: false },
  log: new Log(LogLevel.NONE),
  workers: [
    {
      config: {
        name: 'vide-sharing-jig-submissions-test',
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
              ADMIN_USERS: 'boss',
              ...settings,
            }).map(([key, value]) => [key, { type: 'text', value }]),
          ),
        },
      },
    },
  ],
});
let mf = new Miniflare(options());
const call = async (path, { method = 'GET', data, cookie, headers = {}, raw } = {}) => {
  const response = await mf.dispatchFetch(origin + path, {
    method,
    headers: {
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(data !== undefined
      ? { body: JSON.stringify(data) }
      : raw !== undefined
        ? { body: raw }
        : {}),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    value = buffer;
  }
  return { status: response.status, value, headers: response.headers };
};
/** A `.vjig` as the engine's pack.ts makes it (gzip JSON; the HMAC is not the site's concern). */
const pack = (id = 'project/beam-check', version = '0.1.1', extra = {}) =>
  gzipSync(
    Buffer.from(
      JSON.stringify({
        format: 'vide.jig.pack/1',
        id,
        version,
        files: { 'jig.json': Buffer.from('{}').toString('base64') },
        digest: 'a'.repeat(64),
        sig: { alg: 'HMAC-SHA256', keyId: 'k'.repeat(16), mac: 'b'.repeat(64) },
        ...extra,
      }),
    ),
  );
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(join(root, 'migrations'))).sort()) {
    const sql = (await readFile(join(root, 'migrations', name), 'utf8')).replace(/^--.*$/gm, '');
    for (const statement of sql.split(';').filter((v) => v.trim()))
      await db.prepare(statement).run();
  }
  const passwords = {};
  // Better Auth limits sign-ins per address; each sign-in comes from its own.
  let address = 10;
  const account = async (username) => {
    passwords[username] = randomBytes(20).toString('hex');
    const up = await call('/api/account/sign-up', {
      method: 'POST',
      headers: { Origin: origin },
      data: { username, password: passwords[username], code: 'test-code' },
    });
    assert.equal(up.status, 201, JSON.stringify(up.value));
    const response = await mf.dispatchFetch(origin + '/api/account/sign-in', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'CF-Connecting-IP': `192.0.2.${++address}`,
      },
      body: JSON.stringify({ username, password: passwords[username] }),
    });
    return response.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
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
  const boss = await account('boss'),
    eve = await account('eve');
  await account('mallory');
  const evePc = await device('eve', '설계실 PC'),
    malloryPc = await device('mallory', 'M PC');
  const submit = (
    key,
    bytes,
    { jig = 'project/beam-check', version = '0.1.1', note, headers } = {},
  ) =>
    call(
      `/api/hosts/device/jig-submissions?${new URLSearchParams({ jig, version, name: '보 검토' })}`,
      {
        method: 'POST',
        raw: bytes,
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Length': String(bytes.length),
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...(note !== undefined ? { 'X-Vide-Note': encodeURIComponent(note) } : {}),
          ...headers,
        },
      },
    );

  // --- a PC sends one ---
  const bytes = pack();
  assert.equal((await submit(undefined, bytes)).status, 401, 'the host key is needed');
  const sent = await submit(evePc, bytes, { note: '경간 6 m 넘는 보도 보게 했습니다' });
  assert.equal(sent.status, 201, JSON.stringify(sent.value));
  const first = sent.value.submission;
  assert.equal(first.sha256, sha256(bytes), 'the site computes the digest of the bytes');
  assert.equal(first.size, bytes.length);
  assert.equal(first.status, 'received');
  assert.equal(first.note, '경간 6 m 넘는 보도 보게 했습니다');
  assert.equal(first.pc, '설계실 PC');
  assert.equal(first.name, '보 검토');
  const stored = await (await mf.getR2Bucket('ASSETS')).get(`jig-submissions/${first.id}.vjig`);
  assert.equal(sha256(Buffer.from(await stored.arrayBuffer())), first.sha256, 'R2 holds the bytes');

  // Not a pack, or a pack of another id or version: refused, nothing kept.
  for (const [bad, query] of [
    [Buffer.from('not gzip at all'), {}],
    [gzipSync(Buffer.from('{"format":"other"}')), {}],
    [pack('project/other-jig'), {}],
    [pack(), { version: '0.1.2' }],
  ]) {
    const refused = await submit(evePc, bad, query);
    assert.equal(refused.status, 422, JSON.stringify(refused.value));
    assert.equal(refused.value.error, 'JIG_PACK_INVALID');
  }
  for (const query of [{ jig: '../etc' }, { version: 'latest' }])
    assert.equal((await submit(evePc, bytes, query)).status, 400);
  assert.equal(
    (await submit(evePc, bytes, { note: 'x'.repeat(2001) })).status,
    400,
    'a note over 2,000 characters',
  );
  assert.equal(
    (await db.prepare('SELECT COUNT(*) AS n FROM jig_submissions').first()).n,
    1,
    'refused packs are not stored',
  );

  // --- own list only ---
  const eveList = await call('/api/hosts/device/jig-submissions', {
    headers: { Authorization: `Bearer ${evePc}` },
  });
  assert.equal(eveList.status, 200);
  assert.deepEqual(
    eveList.value.submissions.map((s) => s.id),
    [first.id],
  );
  assert.equal(eveList.value.submissions[0].packDigest, undefined, 'no admin fields for a PC');
  const malloryList = await call('/api/hosts/device/jig-submissions', {
    headers: { Authorization: `Bearer ${malloryPc}` },
  });
  assert.deepEqual(malloryList.value.submissions, [], "another account's PC sees none");

  // --- admins only ---
  assert.equal((await call('/api/admin/jigs')).status, 401);
  const forbidden = await call('/api/admin/jigs', { cookie: eve });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.value.error, 'ADMIN_REQUIRED');
  assert.equal((await call(`/api/admin/jigs/${first.id}/pack`, { cookie: eve })).status, 403);
  assert.equal(
    (
      await call(`/api/admin/jigs/${first.id}/status`, {
        method: 'POST',
        cookie: eve,
        headers: { Origin: origin },
        data: { status: 'applied' },
      })
    ).status,
    403,
  );
  const box = await call('/api/admin/jigs', { cookie: boss });
  assert.equal(box.status, 200);
  assert.equal(box.value.submissions.length, 1);
  assert.equal(box.value.submissions[0].submitter, 'eve');
  assert.equal(box.value.submissions[0].packDigest, 'a'.repeat(64));
  const download = await call(`/api/admin/jigs/${first.id}/pack`, { cookie: boss });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('Content-Type'), 'application/gzip');
  assert.match(
    download.headers.get('Content-Disposition'),
    new RegExp(`filename="beam-check@0.1.1-${first.sha256.slice(0, 8)}.vjig"`),
  );
  assert.equal(sha256(download.value), first.sha256, 'the download is the submitted bytes');

  // Status: a browser write needs the site's Origin; a rejection needs a reason.
  const status = (data, headers = { Origin: origin }) =>
    call(`/api/admin/jigs/${first.id}/status`, { method: 'POST', cookie: boss, headers, data });
  assert.equal((await status({ status: 'reviewing' }, {})).status, 403, 'no Origin, no write');
  assert.equal((await status({ status: 'done' })).status, 400);
  const noReason = await status({ status: 'rejected' });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.value.error, 'REASON_REQUIRED');
  assert.equal((await status({ status: 'reviewing' })).value.submission.status, 'reviewing');
  const rejected = await status({ status: 'rejected', reason: '시험 자료가 없습니다' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.value.submission.reason, '시험 자료가 없습니다');
  const seen = await call('/api/hosts/device/jig-submissions', {
    headers: { Authorization: `Bearer ${evePc}` },
  });
  assert.equal(seen.value.submissions[0].status, 'rejected', 'the submitter sees the status');
  assert.equal(seen.value.submissions[0].reason, '시험 자료가 없습니다');
  assert.equal(
    (await call('/api/admin/jigs?status=rejected', { cookie: boss })).value.submissions.length,
    1,
  );

  // --- size cap ---
  await mf.setOptions(options({ JIG_SUBMISSION_MAX_MB: '0.001' }));
  const big = pack('project/beam-check', '0.1.1', { filler: randomBytes(4096).toString('hex') });
  const tooBig = await submit(evePc, big);
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.value.error, 'JIG_SUBMISSION_TOO_LARGE');
  await mf.setOptions(options({ UPLOADS_ENABLED: 'false' }));
  assert.equal((await submit(evePc, bytes)).status, 503, 'uploads paused');
  await mf.setOptions(options());

  // --- delete ---
  const removed = await call(`/api/admin/jigs/${first.id}`, {
    method: 'DELETE',
    cookie: boss,
    headers: { Origin: origin },
  });
  assert.equal(removed.status, 200);
  assert.equal(
    await (await mf.getR2Bucket('ASSETS')).get(`jig-submissions/${first.id}.vjig`),
    null,
  );
  assert.equal((await call('/api/admin/jigs', { cookie: boss })).value.submissions.length, 0);

  // --- the whole way, locally: the engine packs a real jig and sends it with the PC's link, the
  // admin finds it in the box, downloads it and unpacks it with the recorded SHA-256 ---
  const { RemoteAccess } = await import('../../src/server/remote-access.ts');
  const { packJig } = await import('../../src/jigs/runtime/pack.ts');
  const { unpackSubmission } = await import('../../src/jigs/runtime/unpack.ts');
  const hostDirectory = join(directory, 'host');
  await mkdir(hostDirectory, { recursive: true });
  const pc = new RemoteAccess({
    directory: hostDirectory,
    port: () => 1234,
    status: async () => ({ version: '0.2.30' }),
    fetcher: (url, init) =>
      mf.dispatchFetch(String(url), {
        ...init,
        headers: { ...init?.headers, 'CF-Connecting-IP': '198.51.100.20' },
      }),
    heartbeatMs: 60_000,
  });
  try {
    assert.equal((await pc.link('eve', passwords.eve, '현장 PC', origin)).linked, true);
    const packed = await packJig(
      fileURLToPath(new URL('../../extensions/jigs/example-grid', import.meta.url)),
      {
        dataDir: join(directory, 'pc-data'),
        bundle: false,
        skipTests: true,
      },
    );
    const reply = await pc.uploadJigSubmission(
      {
        jigId: packed.jig.id,
        version: packed.jig.version,
        name: packed.jig.manifest.name,
        note: '격자 간격 기본값을 바꿨습니다',
      },
      packed.bytes,
    );
    assert.ok('submission' in reply, JSON.stringify(reply));
    assert.equal(reply.submission.sha256, sha256(packed.bytes));
    const inBox = (await call('/api/admin/jigs', { cookie: boss })).value.submissions[0];
    assert.equal(inBox.id, reply.submission.id);
    assert.equal(inBox.pc, '현장 PC');
    assert.equal(inBox.note, '격자 간격 기본값을 바꿨습니다');
    const fetched = await call(`/api/admin/jigs/${inBox.id}/pack`, { cookie: boss });
    const out = join(directory, 'repo-jigs');
    const unpacked = await unpackSubmission(fetched.value, { digest: inBox.sha256, outRoot: out });
    assert.equal(unpacked.dir, join(out, 'example-grid'));
    assert.equal(unpacked.validation.ok, true, JSON.stringify(unpacked.validation.issues));
    const listed = await pc.deviceFetch('/jig-submissions');
    assert.equal((await listed.json()).submissions[0].id, inBox.id);
  } finally {
    await pc.close();
  }

  console.log(
    JSON.stringify({
      submitted: true,
      digest: true,
      notPackRefused: true,
      ownListOnly: true,
      adminOnly: true,
      statusAndReason: true,
      sizeCap: true,
      deleted: true,
      engineToUnpack: true,
    }),
  );
} finally {
  await mf?.dispose();
}

// Cloudflare 게시 (PLAN-54 T-347, SPEC-05.11, ARCH-01 「게시 템플릿」): the REST-only deploy client
// against a fake Cloudflare API (two-step asset upload, script, secrets, workers.dev), and the
// password-site Worker itself run in Node with a fake ASSETS binding. No real account is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assetManifest,
  CloudflareDeployError,
  deployPasswordSite,
  templateCompatibilityDate,
  undeploy,
  workerNameOf,
  workerNamePattern,
} from '../../src/server/cloudflare-deploy.ts';
import { publishRecordSchema } from '../../src/contracts/publish.ts';
import { startFakeCloudflare } from '../fixtures/fake-cloudflare/server.mjs';
import worker from '../../src/sharing/deploy-templates/password-site/worker.js';

const PASSWORD = 'pw-test-1234';
const SESSION = 'session-test-secret';
const files = (html = '<h1>보고서</h1>') =>
  new Map([
    ['index.html', html],
    ['logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ['img/a.png', Buffer.from([1, 2, 3])],
  ]);
const target = (cf, name = 'demo-report') => ({
  api: cf.api,
  accountId: cf.accountId,
  token: cf.token,
  name,
});
const rejects = (promise, code, detail) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof CloudflareDeployError, String(error));
    assert.equal(error.code, code);
    if (detail) assert.match(error.detail ?? '', detail);
    return true;
  });

test('publishes the template worker with assets, secrets and the workers.dev address', async (t) => {
  const cf = await startFakeCloudflare();
  t.after(cf.close);
  const result = await deployPasswordSite({
    ...target(cf),
    files: files(),
    password: PASSWORD,
    sessionSecret: SESSION,
    publicPaths: ['/logo.png'],
  });
  assert.equal(result.url, 'https://demo-report.fake-account.workers.dev/');
  assert.equal(result.workerName, 'demo-report');
  assert.equal(typeof result.scriptVersion, 'string');
  assert.equal(result.passwordChanged, true);

  const script = cf.state.scripts.get('demo-report');
  // The uploaded main module is the template file, byte for byte.
  const template = readFileSync(
    new URL('../../src/sharing/deploy-templates/password-site/worker.js', import.meta.url),
    'utf8',
  );
  assert.equal(script.metadata.main_module, 'worker.js');
  assert.equal(script.modules['worker.js'], template);
  assert.equal(script.metadata.compatibility_date, templateCompatibilityDate());
  assert.match(script.metadata.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(script.metadata.assets.config.run_worker_first, true);
  assert.deepEqual(
    script.metadata.bindings.find((binding) => binding.name === 'PUBLIC_PATHS'),
    { type: 'plain_text', name: 'PUBLIC_PATHS', text: '/logo.png' },
  );
  assert.deepEqual([...script.assets.keys()].sort(), ['/img/a.png', '/index.html', '/logo.png']);
  assert.equal(script.workersDev, true);
  // Secrets arrive through the secrets endpoint only — never in the script upload.
  assert.equal(script.secrets.get('REPORT_PASSWORD'), PASSWORD);
  assert.equal(script.secrets.get('SESSION_SECRET'), SESSION);
  const scriptPut = cf.requests.find((r) => r.method === 'PUT' && r.formFields);
  assert.ok(!JSON.stringify(script.metadata).includes(PASSWORD));
  assert.ok(!JSON.stringify(script.metadata).includes(SESSION));
  assert.ok(!JSON.stringify(scriptPut).includes(PASSWORD));
  const secretPuts = cf.requests.filter((r) => r.path.endsWith('/secrets'));
  assert.deepEqual(
    secretPuts.map((r) => r.json.name),
    ['REPORT_PASSWORD', 'SESSION_SECRET'],
  );
  // Two-step upload: the session's buckets (2 hashes each here) went up with base64=true.
  const uploads = cf.requests.filter((r) => r.path.includes('/workers/assets/upload'));
  assert.equal(uploads.length, 2);
  assert.ok(uploads.every((r) => r.path.endsWith('?base64=true')));
  assert.equal(
    Buffer.from(cf.state.stored.get(script.assets.get('/img/a.png')), 'base64').toString('hex'),
    '010203',
  );

  const record = publishRecordSchema.parse({
    target: 'cloudflare',
    url: result.url,
    workerName: result.workerName,
    publishedAt: new Date().toISOString(),
    passwordSet: true,
    sourceRun: { instanceId: 'i-1', jigId: 'project/s06-frame' },
  });
  assert.ok(!JSON.stringify(record).includes(PASSWORD));
});

test('deploying twice overwrites the site and keeps the password when none is given', async (t) => {
  const cf = await startFakeCloudflare();
  t.after(cf.close);
  await deployPasswordSite({ ...target(cf), files: files('<h1>1판</h1>'), password: PASSWORD });
  const first = cf.state.scripts.get('demo-report');
  const before = cf.requests.length;
  const again = await deployPasswordSite({ ...target(cf), files: files('<h1>2판</h1>') });
  const second = cf.state.scripts.get('demo-report');
  assert.equal(again.url, 'https://demo-report.fake-account.workers.dev/');
  assert.equal(again.passwordChanged, false);
  assert.notEqual(second.etag, first.etag);
  assert.notEqual(second.assets.get('/index.html'), first.assets.get('/index.html'));
  assert.equal(
    Buffer.from(cf.state.stored.get(second.assets.get('/index.html')), 'base64').toString('utf8'),
    '<h1>2판</h1>',
  );
  // Unchanged files are not uploaded again; the password stays (keep_bindings, no secret PUT).
  const later = cf.requests.slice(before);
  const uploads = later.filter((r) => r.path.includes('/workers/assets/upload'));
  assert.equal(uploads.length, 1);
  assert.deepEqual(second.metadata.keep_bindings, ['secret_text']);
  assert.equal(later.filter((r) => r.path.endsWith('/secrets')).length, 0);
  assert.equal(second.secrets.get('REPORT_PASSWORD'), PASSWORD);

  // A new password replaces both secrets.
  await deployPasswordSite({
    ...target(cf),
    files: files('<h1>2판</h1>'),
    password: 'pw-test-new',
  });
  const third = cf.state.scripts.get('demo-report');
  assert.equal(third.secrets.get('REPORT_PASSWORD'), 'pw-test-new');
  assert.match(third.secrets.get('SESSION_SECRET'), /^[0-9a-f]{96}$/);
  // Nothing new to upload → the session token is the completion token.
  assert.equal(third.assets.size, 3);
});

test('site names are lowercase kebab up to 63 characters', async (t) => {
  for (const ok of ['a', 'demo-report', 'x'.repeat(63), 'r2-2026'])
    assert.ok(workerNamePattern.test(ok), ok);
  for (const bad of ['', 'Demo', 'demo_report', '-demo', 'demo-', 'x'.repeat(64), '보고서', 'a.b'])
    assert.ok(!workerNamePattern.test(bad), bad);
  assert.equal(workerNameOf('논현동 164', 'Frame Study'), '164-frame-study');
  assert.equal(workerNameOf('보고서'), 'vide-report');
  assert.ok(workerNameOf('x'.repeat(80)).length <= 63);

  const cf = await startFakeCloudflare();
  t.after(cf.close);
  await rejects(
    deployPasswordSite({ ...target(cf, 'Demo_Report'), files: files(), password: PASSWORD }),
    'INVALID_SITE_NAME',
  );
  await rejects(
    deployPasswordSite({ ...target(cf), accountId: '../x', files: files(), password: PASSWORD }),
    'INVALID_ACCOUNT_ID',
  );
  assert.equal(cf.requests.length, 0);
});

test('file lists are checked before anything is sent', () => {
  assert.throws(() => assetManifest(new Map()), { code: 'INVALID_PUBLISH_FILES' });
  assert.throws(() => assetManifest(new Map([['../x.html', 'x']])), {
    code: 'INVALID_PUBLISH_FILES',
  });
  assert.throws(() => assetManifest(new Map([['a\\b.html', 'x']])), {
    code: 'INVALID_PUBLISH_FILES',
  });
  assert.throws(() => assetManifest(new Map([['big.bin', Buffer.alloc(25 * 1024 * 1024 + 1)]])), {
    code: 'PUBLISH_TOO_LARGE',
  });
  const [asset] = assetManifest(new Map([['index.html', 'a']]));
  assert.equal(asset.path, '/index.html');
  assert.match(asset.hash, /^[0-9a-f]{32}$/);
});

test('API failures carry the first error message; auth and scope are told apart', async (t) => {
  const cf = await startFakeCloudflare();
  t.after(cf.close);
  cf.fail('script', { status: 400, message: 'Uncaught SyntaxError at worker.js:1', code: 10021 });
  await rejects(
    deployPasswordSite({ ...target(cf), files: files(), password: PASSWORD }),
    'PUBLISH_FAILED',
    /^Uncaught SyntaxError at worker\.js:1 \(10021\)$/,
  );
  cf.fail('script');
  cf.fail('session', { status: 403, message: 'Authentication error', code: 10000 });
  await rejects(
    deployPasswordSite({ ...target(cf), files: files(), password: PASSWORD }),
    'ACCOUNT_SCOPE',
  );
  cf.fail('session');
  await rejects(
    deployPasswordSite({
      ...target(cf),
      token: 'cf_test_wrong',
      files: files(),
      password: PASSWORD,
    }),
    'ACCOUNT_NOT_CONNECTED',
  );
  // The token never appears in what the error carries.
  try {
    await deployPasswordSite({ ...target(cf), token: 'cf_test_wrong', files: files() });
  } catch (error) {
    assert.ok(!JSON.stringify({ ...error, message: error.message }).includes('cf_test_wrong'));
  }
});

test('an unreachable API is SERVICE_UNREACHABLE', async (t) => {
  const cf = await startFakeCloudflare();
  const api = cf.api;
  await cf.close();
  await rejects(
    deployPasswordSite({ ...target(cf), api, files: files(), password: PASSWORD }),
    'SERVICE_UNREACHABLE',
  );
  await rejects(
    deployPasswordSite({
      ...target(cf),
      files: files(),
      password: PASSWORD,
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    }),
    'SERVICE_UNREACHABLE',
  );
});

test('undeploy removes the worker; a missing one is not an error', async (t) => {
  const cf = await startFakeCloudflare();
  t.after(cf.close);
  await deployPasswordSite({ ...target(cf), files: files(), password: PASSWORD });
  assert.deepEqual(await undeploy(target(cf)), { removed: true });
  assert.equal(cf.state.scripts.has('demo-report'), false);
  assert.ok(cf.requests.at(-1).path.endsWith('?force=true'));
  assert.deepEqual(await undeploy(target(cf)), { removed: false });
});

// ---- the Worker itself -------------------------------------------------------------------------

const ORIGIN = 'https://demo-report.fake-account.workers.dev';
const env = (extra = {}) => ({
  REPORT_PASSWORD: '보고서-비번',
  SESSION_SECRET: SESSION,
  PUBLIC_PATHS: '/logo.png',
  ASSETS: { fetch: async (request) => new Response('asset ' + new URL(request.url).pathname) },
  ...extra,
});
const get = (path, headers = {}) => new Request(ORIGIN + path, { headers });
const loginWith = (password, origin = ORIGIN) =>
  new Request(ORIGIN + '/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
  });

test('worker: 503 without secrets, login form, cookie session, public allowlist', async () => {
  const missing = await worker.fetch(get('/'), env({ SESSION_SECRET: undefined }));
  assert.equal(missing.status, 503);
  assert.equal(missing.headers.get('X-Robots-Tag'), 'noindex, nofollow');

  const page = await worker.fetch(get('/'), env());
  assert.equal(page.status, 401);
  const html = await page.text();
  assert.match(html, /<input type="password" name="password"/);
  assert.equal(page.headers.get('Cache-Control'), 'private, no-store');

  // The allowlisted asset needs no session; other assets do.
  assert.equal(await (await worker.fetch(get('/logo.png'), env())).text(), 'asset /logo.png');
  assert.equal((await worker.fetch(get('/img/a.png'), env())).status, 401);

  assert.equal((await worker.fetch(loginWith('틀림'), env())).status, 401);
  assert.equal(
    (await worker.fetch(loginWith('보고서-비번', 'https://evil.example'), env())).status,
    403,
  );
  // NFD input matches the NFC password.
  const ok = await worker.fetch(loginWith('보고서-비번'.normalize('NFD')), env());
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get('Set-Cookie');
  assert.match(
    cookie,
    /^__Host-review=\d+\.[0-9a-f]{64}; Max-Age=28800; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
  );
  const session = cookie.split(';')[0];

  const opened = await worker.fetch(get('/', { Cookie: session }), env());
  assert.equal(opened.status, 200);
  assert.equal(await opened.text(), 'asset /');
  assert.equal(opened.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(opened.headers.get('X-Robots-Tag'), 'noindex, nofollow');

  // A forged or expired cookie, or another secret, is refused.
  const [expires, signature] = session.split('=')[1].split('.');
  const forged = `__Host-review=${Number(expires) + 1}.${signature}`;
  assert.equal((await worker.fetch(get('/', { Cookie: forged }), env())).status, 401);
  assert.equal(
    (await worker.fetch(get('/', { Cookie: session }), env({ SESSION_SECRET: 'other-test' })))
      .status,
    401,
  );
  assert.equal(
    (await worker.fetch(get('/', { Cookie: '__Host-review=1.' + '0'.repeat(64) }), env())).status,
    401,
  );
  assert.match(await (await worker.fetch(get('/robots.txt'), env())).text(), /Disallow: \//);
});

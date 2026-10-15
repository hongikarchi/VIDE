// 보고용 게시 (PLAN-54 T-343, SPEC-04.14, SPEC-05.11, Design SCR-43): `POST …/outputs/:name/publish`
// sends only the 보고용 page and CSVs, to the VIDE site link (a fake site device endpoint here) or
// to the user's Cloudflare account (the fake Cloudflare API); `publish.json` records target, url,
// time, passwordSet and the source run but never the password; 다시 게시 keeps the password
// (nothing sent) unless a new one is made; [내리기] removes it there and stamps `revokedAt`;
// a remote session may not publish; the engine wires the routes and never logs the password.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  publishRoutes,
  defaultSiteName,
  withoutCopyMark,
} from '../../src/server/publish-routes.ts';
import { startFakeCloudflare } from '../fixtures/fake-cloudflare/server.mjs';
import { startServer } from '../../src/server/server.ts';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';

const PASSWORD = 'coffee-mug-review'; // a made-up test value
const NAME = '2026-10-15-건축개요 보고서';
const PROJECT = 'p-0001';

/** A kept 보고용 copy as WorkspaceOutputs.writePublicReport leaves it (no work folder). */
async function seedOutput(data, projectId = PROJECT, name = NAME) {
  const dir = join(data, 'projects', projectId, 'outputs', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), '<!doctype html><h1>건축개요 보고서</h1>');
  await writeFile(join(dir, '층별 면적.csv'), '﻿층,면적\r\n1,120\r\n');
  await writeFile(
    join(dir, 'report.json'),
    JSON.stringify({
      title: '건축개요 보고서',
      madeAt: '2026-10-15T05:20:00.000Z',
      sections: ['overview'],
      scenes: [],
      sourceRun: {
        instanceId: 'inst-1234',
        reportId: 'summary',
        at: '2026-10-15T05:10:00.000Z',
        jigId: 'vide/building-summary',
        version: 3,
      },
    }),
  );
  await writeFile(
    join(dir, 'vide.json'),
    JSON.stringify({ key: 'k', folder: null, reason: 'no-workspace' }),
  );
  return dir;
}

/** The account site's `report-publications` device routes, in memory. */
function fakeSite() {
  const state = { pubs: new Map(), calls: [], linked: true, down: false };
  let next = 1;
  return {
    state,
    async deviceFetch(path, method = 'GET', data) {
      state.calls.push({ path, method, data });
      if (state.down) throw new TypeError('fetch failed');
      if (!state.linked) return undefined;
      const reply = (value, status = 200) => Response.json(value, { status });
      const m = /^\/report-publications(?:\/([^/]+))?(?:\/(files|finish))?$/.exec(path);
      if (!m) return reply({ error: 'NOT_FOUND' }, 404);
      const [, id, sub] = m;
      if (!id && method === 'POST') {
        if (data.id) {
          const pub = state.pubs.get(data.id);
          if (!pub || pub.revoked) return reply({ error: 'PUBLICATION_NOT_FOUND' }, 404);
          if (data.password) pub.password = data.password;
          pub.pending = new Map();
          return reply({ id: data.id, url: `https://site.test/r/${data.id}/`, partBytes: 16 });
        }
        if (!data.password) return reply({ error: 'INVALID_PASSWORD' }, 400);
        const newId = String(next++).padStart(32, '0');
        state.pubs.set(newId, { password: data.password, files: new Map(), pending: new Map() });
        return reply({ id: newId, url: `https://site.test/r/${newId}/`, partBytes: 16 }, 201);
      }
      const pub = state.pubs.get(id);
      if (!pub) return reply({ error: 'PUBLICATION_NOT_FOUND' }, 404);
      if (sub === 'files') {
        const bytes = Buffer.from(data.data, 'base64');
        const prev = data.part > 1 ? pub.pending.get(data.path) : Buffer.alloc(0);
        pub.pending.set(data.path, Buffer.concat([prev, bytes]));
        return reply(
          data.part === 1 && data.parts > 1
            ? { uploadId: 'u', etag: 'e1' }
            : { etag: 'e', stored: true },
        );
      }
      if (sub === 'finish') {
        pub.files = pub.pending;
        return reply({ id, url: `https://site.test/r/${id}/`, fileCount: pub.files.size });
      }
      if (method === 'DELETE') {
        pub.revoked = true;
        return reply({ removed: true });
      }
      return reply({ error: 'NOT_FOUND' }, 404);
    },
  };
}

function memorySecrets() {
  const values = new Map();
  return {
    values,
    get: async (k) => values.get(k),
    set: async (k, v) => void (v === undefined ? values.delete(k) : values.set(k, v)),
  };
}

async function harness({ remote = false, cloudflare } = {}) {
  const data = await mkdtemp(join(tmpdir(), 'vide-publish-'));
  const dir = await seedOutput(data);
  const site = fakeSite();
  const secrets = memorySecrets();
  const call = async (path, method = 'GET', body) => {
    let status = 0,
      value;
    try {
      const handled = await publishRoutes(new URL('http://x' + path), method, {
        dataDirectory: data,
        body: async () => body,
        send: (s, v) => ((status = s), (value = v)),
        remote,
        site,
        siteLinked: async () => site.state.linked,
        cloudflare:
          cloudflare ??
          (async () => {
            const e = new Error('ACCOUNT_NOT_CONNECTED');
            e.code = 'ACCOUNT_NOT_CONNECTED';
            throw e;
          }),
        secrets,
        projectName: () => 'Nonhyeon 164',
        now: () => new Date('2026-10-15T05:31:00.000Z'),
      });
      assert.ok(handled);
    } catch (error) {
      return { status: 'thrown', code: error.code };
    }
    return { status, value };
  };
  return {
    data,
    dir,
    site,
    secrets,
    call,
    close: () => rm(data, { recursive: true, force: true }),
  };
}
const base = `/api/v1/projects/${PROJECT}/outputs/${encodeURIComponent(NAME)}`;

test('VIDE site: publish sends only the 보고용 files, records publish.json without the password', async () => {
  const h = await harness();
  try {
    const state0 = await h.call(base + '/publish');
    assert.equal(state0.status, 200);
    assert.equal(state0.value.published, null);
    assert.equal(state0.value.passwordKept, false);
    assert.match(
      state0.value.defaultSiteName,
      /^nonhyeon-164-[0-9a-f]{6}$/,
      'kebab of the ASCII part + a tag',
    );
    assert.equal(
      (await h.call(base + '/publish', 'POST', { target: 'vide-site' })).code,
      'PUBLISH_PASSWORD_REQUIRED',
      'a first publish needs a password',
    );
    assert.equal(
      (await h.call(base + '/publish', 'POST', { target: 'vide-site', password: 'short' })).code,
      'INVALID_PASSWORD',
    );
    const done = await h.call(base + '/publish', 'POST', {
      target: 'vide-site',
      password: PASSWORD,
    });
    assert.equal(done.status, 200, JSON.stringify(done));
    const record = done.value.published;
    assert.equal(record.target, 'vide-site');
    assert.match(record.url, /^https:\/\/site\.test\/r\/0+1\/$/);
    assert.equal(record.passwordSet, true);
    assert.equal(record.publishedAt, '2026-10-15T05:31:00.000Z');
    assert.deepEqual(record.sourceRun, {
      instanceId: 'inst-1234',
      jigId: 'vide/building-summary',
      version: 3,
      report: 'summary',
      at: '2026-10-15T05:10:00.000Z',
    });
    const pub = h.site.state.pubs.get(record.publicationId);
    assert.deepEqual(
      [...pub.files.keys()].sort(),
      ['index.html', '층별 면적.csv'],
      'no report.json / vide.json',
    );
    const json = await readFile(join(h.dir, 'publish.json'), 'utf8');
    assert.ok(!json.includes(PASSWORD), 'publish.json has no password');
    assert.deepEqual(JSON.parse(json), record);
    assert.equal(h.secrets.values.get(`publish.${PROJECT}.${NAME}`), PASSWORD, 'sealed on the PC');
    const state1 = await h.call(base + '/publish');
    assert.equal(state1.value.passwordKept, true);
    assert.ok(!JSON.stringify(state1.value).includes(PASSWORD), 'the state never shows it');

    // 다시 게시: same link, no password sent.
    await writeFile(join(h.dir, 'index.html'), '<h1>고침</h1>');
    const before = h.site.state.calls.length;
    const again = await h.call(base + '/publish', 'POST', { target: 'vide-site' });
    assert.equal(again.status, 200);
    assert.equal(again.value.published.publicationId, record.publicationId);
    const start = h.site.state.calls[before];
    assert.equal(start.data.id, record.publicationId);
    assert.equal(start.data.password, undefined, 'the live password is kept');
    assert.equal(pub.files.get('index.html').toString(), '<h1>고침</h1>');
    assert.equal(pub.password, PASSWORD);

    // Another target while live: take this one down first.
    assert.equal(
      (await h.call(base + '/publish', 'POST', { target: 'cloudflare' })).code,
      'PUBLISH_TARGET_LIVE',
    );

    // [내리기]
    const down = await h.call(base + '/unpublish', 'POST');
    assert.equal(down.status, 200);
    assert.equal(down.value.published.revokedAt, '2026-10-15T05:31:00.000Z');
    assert.equal(pub.revoked, true);
    assert.equal(
      JSON.parse(await readFile(join(h.dir, 'publish.json'), 'utf8')).revokedAt,
      '2026-10-15T05:31:00.000Z',
    );
    assert.equal((await h.call(base + '/unpublish', 'POST')).code, 'NOT_PUBLISHED');
    // Publishing again after [내리기]: a new link with the sealed password.
    const fresh = await h.call(base + '/publish', 'POST', { target: 'vide-site' });
    assert.equal(fresh.status, 200);
    assert.notEqual(fresh.value.published.publicationId, record.publicationId);
    assert.equal(h.site.state.pubs.get(fresh.value.published.publicationId).password, PASSWORD);
    assert.equal(fresh.value.published.revokedAt, undefined);
  } finally {
    await h.close();
  }
});

test('VIDE site failures: not linked, unreachable, site refusal with a plain line; remote refused', async () => {
  const h = await harness();
  try {
    h.site.state.linked = false;
    assert.equal(
      (await h.call(base + '/publish', 'POST', { target: 'vide-site', password: PASSWORD })).code,
      'ACCOUNT_NOT_LINKED',
    );
    h.site.state.linked = true;
    h.site.state.down = true;
    assert.equal(
      (await h.call(base + '/publish', 'POST', { target: 'vide-site', password: PASSWORD })).code,
      'SERVICE_UNREACHABLE',
    );
    h.site.state.down = false;
    const original = h.site.deviceFetch;
    h.site.deviceFetch = async () => Response.json({ error: 'UPLOADS_DISABLED' }, { status: 503 });
    const refused = await h.call(base + '/publish', 'POST', {
      target: 'vide-site',
      password: PASSWORD,
    });
    assert.equal(refused.status, 502);
    assert.equal(refused.value.code, 'PUBLISH_FAILED');
    assert.equal(refused.value.detail, '사이트가 지금 새 업로드를 받지 않습니다');
    h.site.deviceFetch = original;
    await assert.rejects(readFile(join(h.dir, 'publish.json')), 'no record after a failure');
    assert.equal(h.secrets.values.size, 0, 'a failed publish does not seal the password');
    assert.equal(
      (await h.call(`/api/v1/projects/${PROJECT}/outputs/none/publish`)).code,
      'NOT_FOUND',
    );
  } finally {
    await h.close();
  }
  const remote = await harness({ remote: true });
  try {
    assert.equal((await remote.call(base + '/publish')).status, 200, 'a remote session may look');
    assert.equal(
      (await remote.call(base + '/publish', 'POST', { target: 'vide-site', password: PASSWORD }))
        .code,
      'FORBIDDEN',
    );
    assert.equal((await remote.call(base + '/unpublish', 'POST')).code, 'FORBIDDEN');
  } finally {
    await remote.close();
  }
});

test('Cloudflare: deploy with the default name, re-publish keeps the secret, unpublish deletes', async () => {
  const cf = await startFakeCloudflare();
  const h = await harness({
    cloudflare: async () => ({
      api: cf.api,
      token: cf.token,
      accountId: cf.accountId,
      timeoutMs: 5000,
    }),
  });
  try {
    const done = await h.call(base + '/publish', 'POST', {
      target: 'cloudflare',
      password: PASSWORD,
    });
    assert.equal(done.status, 200, JSON.stringify(done));
    const record = done.value.published;
    assert.equal(record.target, 'cloudflare');
    assert.equal(
      record.workerName,
      defaultSiteName('Nonhyeon 164', '건축개요 보고서', PROJECT, NAME),
    );
    assert.equal(record.url, `https://${record.workerName}.${cf.state.subdomain}.workers.dev/`);
    const script = cf.state.scripts.get(record.workerName);
    assert.equal(script.secrets.get('REPORT_PASSWORD'), PASSWORD, 'the password went as a secret');
    assert.deepEqual([...script.assets.keys()].sort(), ['/index.html', '/층별 면적.csv']);
    const json = await readFile(join(h.dir, 'publish.json'), 'utf8');
    assert.ok(!json.includes(PASSWORD) && !json.includes(cf.token), 'no password or token');
    // 다시 게시: no secret call.
    const secretsBefore = cf.requests.filter((r) => /\/secrets/.test(r.path)).length;
    const again = await h.call(base + '/publish', 'POST', { target: 'cloudflare' });
    assert.equal(again.status, 200);
    assert.equal(cf.requests.filter((r) => /\/secrets/.test(r.path)).length, secretsBefore);
    // A refusal from the service comes back as one line.
    cf.fail('script', { status: 400, message: 'Script too large', code: 10027 });
    const failed = await h.call(base + '/publish', 'POST', { target: 'cloudflare' });
    assert.equal(failed.value.code, 'PUBLISH_FAILED');
    assert.match(failed.value.detail, /Script too large/);
    assert.equal(
      JSON.parse(await readFile(join(h.dir, 'publish.json'), 'utf8')).publishedAt,
      record.publishedAt,
    );
    // Bad site name.
    assert.equal(
      (await h.call(base + '/publish', 'POST', { target: 'cloudflare', siteName: 'Bad_Name' }))
        .code,
      'INVALID_SITE_NAME',
    );
    // Renaming a live site is refused: the old Worker would stay open with no record of it.
    const renamed = await h.call(base + '/publish', 'POST', {
      target: 'cloudflare',
      siteName: 'another-name',
    });
    assert.equal(renamed.code, 'PUBLISH_NAME_LIVE');
    assert.ok(!cf.state.scripts.has('another-name'), 'no second Worker');
    assert.equal(
      JSON.parse(await readFile(join(h.dir, 'publish.json'), 'utf8')).workerName,
      record.workerName,
    );
    const down = await h.call(base + '/unpublish', 'POST');
    assert.equal(down.status, 200);
    assert.ok(!cf.state.scripts.has(record.workerName), 'the Worker is deleted');
  } finally {
    await h.close();
    await cf.close();
  }
});

test('engine: routes wired, publish refused without the account link, password not logged', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'vide-publish-engine-'));
  const app = await startServer({
    filename: join(folder, 'vide.sqlite'),
    serviceOptions: { protector: testProtector },
  });
  try {
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
    const api = async (path, method = 'GET', body) => {
      const r = await fetch(app.origin + '/api/v1' + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json() };
    };
    const project = (await api('/projects', 'POST', { name: '게시 시험' })).body;
    await seedOutput(folder, project.id);
    const path = `/projects/${project.id}/outputs/${encodeURIComponent(NAME)}/publish`;
    const state = await api(path);
    assert.equal(state.status, 200, JSON.stringify(state.body));
    assert.equal(state.body.siteLinked, false);
    const refused = await api(path, 'POST', { target: 'vide-site', password: PASSWORD });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'ACCOUNT_NOT_LINKED');
    const noCf = await api(path, 'POST', { target: 'cloudflare', password: PASSWORD });
    assert.equal(noCf.body.code, 'ACCOUNT_NOT_CONNECTED');
    assert.equal(
      (await api(path.replace('/publish', '/unpublish'), 'POST')).body.code,
      'NOT_PUBLISHED',
    );
  } finally {
    await app.close();
  }
  // Nothing the engine wrote (logs, settings) carries the password.
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (!/\.sqlite/.test(entry.name))
        assert.ok(!(await readFile(p)).includes(PASSWORD), `password found in ${p}`);
    }
  };
  await walk(folder);
  await rm(folder, { recursive: true, force: true, maxRetries: 3 });
});

test('the work folder copy mark never goes online', () => {
  const marked = Buffer.from(
    '<!doctype html>\n<!-- VIDE 사본 · 정본은 VIDE 보고용 보고서 · 직접 고쳐도 반영되지 않고 VIDE가 다시 쓴다 · vide-copy:public-report:00000000-0000-4000-8000-000000000001 -->\n<html><body>보고</body></html>',
  );
  const clean = withoutCopyMark(marked).toString('utf8');
  assert.equal(clean, '<!doctype html>\n<html><body>보고</body></html>');
  const plain = Buffer.from('<!doctype html><h1>x</h1>');
  assert.equal(withoutCopyMark(plain), plain);
});

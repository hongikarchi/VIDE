import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'vide-http-test-'));
  const app = await startServer({ filename: join(directory, 'test.sqlite'), ...options });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const api = (path, { body, method = 'GET', headers = {} } = {}) =>
    fetch(app.origin + '/api/v1' + path, {
      method,
      headers: { Origin: app.origin, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const response = await api('/session', {
    method: 'POST',
    body: { token: new URL(app.launchUrl).hash.slice(1) },
  });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return {
    app,
    api: (path, options = {}) =>
      api(path, { ...options, headers: { Cookie: cookie, ...options.headers } }),
    cookie,
  };
}

test('종료 요청 이후 조회를 유지하고 새 쓰기를 거절한다', async (t) => {
  let stopping = false;
  const { api } = await fixture(t, {
    onShutdown: () => {
      stopping = true;
    },
  });
  assert.equal((await api('/shutdown', { method: 'POST', body: {} })).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopping, true);
  assert.equal((await api('/projects')).status, 200);
  const write = await api('/projects', { method: 'POST', body: { name: 'Too late' } });
  assert.equal((await write.json()).code, 'APP_STOPPING');
});

test('쿠키 없는 접근, 다른 Origin, DNS rebinding Host를 거절한다', async (t) => {
  const { app, api } = await fixture(t);
  assert.equal((await fetch(app.origin + '/api/v1/projects')).status, 401);
  assert.equal(
    (await api('/projects', { headers: { Origin: 'https://attacker.example' } })).status,
    403,
  );
  const rebound = await new Promise((resolve, reject) => {
    const request = httpRequest(
      app.origin + '/api/v1/projects',
      { headers: { Host: 'attacker.example' } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(rebound, 403);
  assert.equal(
    (await api('/projects', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status,
    403,
  );
  const response = await api('/session', { method: 'POST', body: { token: '한'.repeat(64) } });
  assert.equal(response.status, 401);
});

test('실제 HTTP 프로젝트·입력 저장과 다른 프로젝트 격리·버전 충돌', async (t) => {
  const { api } = await fixture(t);
  const project = await (
    await api('/projects', { method: 'POST', body: { name: '합성 프로젝트' } })
  ).json();
  const other = await (await api('/projects', { method: 'POST', body: { name: '별도' } })).json();
  const note = await (
    await api(`/projects/${project.id}/inputs`, {
      method: 'POST',
      body: { text: '원본 보존', pins: [] },
    })
  ).json();
  const inputPath = `/projects/${project.id}/inputs/${note.id}`;
  assert.equal(
    (
      await api(inputPath, {
        method: 'PUT',
        body: { revision: 1, body: { text: '수정', pins: [] } },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api(inputPath, {
        method: 'PUT',
        body: { revision: 1, body: { text: '오래된 수정', pins: [] } },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api(`/projects/${other.id}/inputs/${note.id}`, {
        method: 'PUT',
        body: { revision: 2, body: { text: '오염', pins: [] } },
      })
    ).status,
    404,
  );
  assert.deepEqual(await (await api(`/projects/${other.id}/inputs`)).json(), []);
  const saved = await (await api(`/projects/${project.id}/inputs`)).json();
  assert.equal(saved[0].body.text, '수정');
});

test('API는 Origin 없는 쓰기와 실행 엔드포인트·경로 탈출을 허용하지 않는다', async (t) => {
  const { app, cookie, api } = await fixture(t);
  const response = await fetch(app.origin + '/api/v1/projects', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{"name":"wrong"}',
  });
  assert.equal(response.status, 403);
  assert.equal((await api('/execute', { method: 'POST', body: {} })).status, 404);
  assert.equal((await fetch(app.origin + '/src/core/store.ts')).status, 404);
  assert.equal(
    (await fetch(app.origin + '/')).headers
      .get('content-security-policy')
      .includes("frame-ancestors 'none'"),
    true,
  );
});

test('UTF-8 바이트가 요청 청크 사이에 나뉘어도 한국어 입력이 보존된다', async (t) => {
  const { app, cookie } = await fixture(t),
    bytes = Buffer.from('{"name":"한글 프로젝트"}');
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(
      app.origin + '/api/v1/projects',
      {
        method: 'POST',
        headers: { Origin: app.origin, Cookie: cookie, 'Content-Type': 'application/json' },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(text) }));
      },
    );
    request.on('error', reject);
    request.write(bytes.subarray(0, 10));
    setTimeout(() => request.end(bytes.subarray(10)), 5);
  });
  assert.equal(response.status, 201);
  assert.equal(response.data.name, '한글 프로젝트');
});

test('built UI assets load without exposing source files or build metadata', async (t) => {
  const { app } = await fixture(t);
  const page = await fetch(app.origin + '/');
  const html = await page.text();
  // Relative addresses: the same page is also served under the account site's /pc/<id>/ relay.
  const scripts = [...html.matchAll(/(?:src|href)="\.(\/assets\/[^" ]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(scripts.length > 0);
  for (const path of scripts) {
    const response = await fetch(app.origin + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /javascript|css/);
  }
  // Bundled fonts are served from the same assets folder (the desktop app works offline).
  // Shared chunks may bring their own stylesheets first; the fonts are in one of them.
  let font;
  for (const stylesheet of scripts.filter((path) => path.endsWith('.css'))) {
    const css = await (await fetch(app.origin + stylesheet)).text();
    font ??= css.match(/url\(\.\/([A-Za-z0-9_-]+\.woff2)\)/)?.[1];
  }
  assert.ok(font, 'a bundled woff2 font');
  const fontResponse = await fetch(app.origin + '/assets/' + font);
  assert.equal(fontResponse.status, 200, font);
  assert.equal(fontResponse.headers.get('content-type'), 'font/woff2');
  for (const path of [
    '/main.tsx',
    '/app.mjs',
    '/web-assets.ts',
    '/.vite/manifest.json',
    '/assets/missing.js',
    '/assets/index.js.map',
  ]) {
    assert.equal((await fetch(app.origin + path)).status, 404, path);
  }
});

test('동일 호스트의 서로 다른 VIDE 포트가 세션 쿠키를 덮어쓰지 않는다', async (t) => {
  const first = await fixture(t),
    second = await fixture(t);
  assert.notEqual(first.cookie.split('=')[0], second.cookie.split('=')[0]);
  const together = first.cookie + '; ' + second.cookie;
  for (const instance of [first, second])
    assert.equal((await instance.api('/projects', { headers: { Cookie: together } })).status, 200);
  assert.equal((await first.api('/projects', { headers: { Cookie: second.cookie } })).status, 401);
});

test('AI accounts are read only (ADR-025): the default logins, no management routes, no account on requests', async (t) => {
  const { api } = await fixture(t, {
    providerFactory: () => ({
      status: async () => ({ available: true }),
      run: async () => ({ text: '{}' }),
    }),
  });
  const post = (path, body) => api(path, { method: 'POST', body });
  // Who each CLI's default login is; no network, never tokens.
  const accounts = (await (await api('/accounts')).json()).accounts;
  assert.deepEqual(
    accounts.map((row) => row.provider),
    ['claude-cli', 'codex-cli'],
  );
  for (const row of accounts) assert.equal(typeof row.signedIn, 'boolean');
  const usage = await (await api('/accounts/usage')).json();
  assert.deepEqual(usage.settings, { usageLookup: false });
  assert.equal(usage.accounts.length, 2);
  // Only the lookup switch is a setting; switching settings are gone.
  assert.deepEqual(
    (await (await post('/accounts/usage-settings', { usageLookup: true })).json()).settings,
    { usageLookup: true },
  );
  assert.equal((await post('/accounts/usage-settings', { autoSwitch: true })).status, 400);
  // Adding, signing in, selecting and removing accounts is done in AccountSwitch.
  assert.equal((await post('/accounts', { provider: 'codex-cli', label: 'Second' })).status, 404);
  for (const path of [
    '/accounts/login',
    '/accounts/login-command',
    '/accounts/login/cancel',
    '/accounts/login/code',
    '/accounts/logout',
    '/accounts/remove',
    '/accounts/rename',
    '/accounts/select',
  ])
    assert.equal((await post(path, { provider: 'codex-cli', id: 'x' })).status, 404, path);
  // A request runs on the default login: it carries no account, and a client may not set one.
  const project = await (await post('/projects', { name: 'Accounts' })).json();
  const input = {
    id: 'one',
    body: 'Read',
    provider: 'codex-cli',
    permission: 'review',
    pins: [],
    sketches: [],
    files: [],
  };
  const submitted = await (await post(`/projects/${project.id}/requests`, input)).json();
  assert.equal(submitted.input.accountProfileId, undefined);
  assert.equal(
    (
      await (
        await post(`/projects/${project.id}/requests`, {
          ...input,
          id: 'injected',
          accountProfileId: 'default',
        })
      ).json()
    ).code,
    'INVALID_INPUT',
  );
});

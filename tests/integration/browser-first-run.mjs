// SPEC-05.6 「첫 실행」, Design SCR-26, ADR-039 (PLAN-38 T-178·T-179): the installed program's first
// run opens on the VIDE account sign-in, not on the work screen, and makes no project by itself.
// A wrong password and an unreachable site are told; signing in leaves remote access off; the
// project is made by name and the page reopens on it; a signed-in PC opens straight to work. The
// account site is a fake answering the engine's device routes; everything else is the real engine.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { installBrowserSupport } from './browser-support.mjs';

const directory = await mkdtemp(join(tmpdir(), 'vide-first-run-'));
const HOST = '356ff01d-b586-460c-8e2b-8c9f3c083e96';
const logins = [],
  tunnels = [];
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    signInRequired: true,
    remoteOptions: {
      heartbeatMs: 3_600_000,
      spawnProcess: (...args) => {
        tunnels.push(args);
        throw new Error('no tunnel in this test');
      },
      fetcher: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/api/hosts/device/login') {
          const body = JSON.parse(init.body);
          logins.push(body);
          if (body.username === 'offline') throw new TypeError('fetch failed');
          if (body.password !== 'right')
            return new Response('{"error":"INVALID_LOGIN"}', { status: 401 });
          return Response.json({ hostId: HOST, secret: 'b'.repeat(64) });
        }
        if (path.endsWith('/shared-projects')) return Response.json({ projects: [] });
        return Response.json({ ok: true, projects: [] });
      },
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }),
    errors = [];
  page.setDefaultTimeout(15000);
  await installBrowserSupport(page);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route(/\/api\/v1\/accounts\/usage(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        settings: { usageLookup: false },
        accounts: [
          { provider: 'claude-cli', signedIn: true, email: 'a@example.com', limitReached: false },
          { provider: 'codex-cli', signedIn: false, limitReached: false },
        ],
        accountSwitch: {
          installed: false,
          download: 'https://github.com/hongikarchi/AccountSwitch/releases/latest',
        },
      },
    }),
  );
  const projects = () =>
    page.evaluate(async () => (await (await fetch('api/v1/projects')).json()).length);

  // 1. First run: the sign-in screen, no work screen, no project made.
  await page.goto(app.launchUrl);
  const card = page.locator('#first-run');
  await card.getByRole('heading', { name: 'VIDE 계정으로 로그인' }).waitFor();
  assert.equal(await projects(), 0, 'no project is made before signing in');
  assert.equal(await page.locator('body.first-run-open').count(), 1);
  const text = await card.textContent();
  assert.match(text, /계정이 없으면 웹사이트에서 가입 코드로 만드세요/);
  await card.getByText(/AI 연결 · Claude Code: a@example.com · Codex: 로그인 필요/).waitFor();
  assert.equal(
    await card.getByRole('link', { name: 'AccountSwitch 설치' }).getAttribute('href'),
    'https://github.com/hongikarchi/AccountSwitch/releases/latest',
  );

  // 2. A wrong password, then an unreachable site: told, the ID stays, no tunnel.
  await card.getByLabel('아이디').fill('studio');
  await card.getByLabel('비밀번호', { exact: true }).fill('wrong');
  await card.getByRole('button', { name: '로그인' }).click();
  await card.getByRole('alert').getByText('아이디 또는 비밀번호를 확인하세요.').waitFor();
  assert.equal(await card.getByLabel('아이디').inputValue(), 'studio');
  assert.equal(await card.getByLabel('비밀번호', { exact: true }).inputValue(), '');
  await card.getByLabel('아이디').fill('offline');
  await card.getByLabel('비밀번호', { exact: true }).fill('right');
  await card.getByRole('button', { name: '로그인' }).click();
  await card
    .getByRole('alert')
    .getByText(/웹사이트에 연결하지 못했습니다.*다시 시도/)
    .waitFor();

  // 3. Signing in: the project step; remote access stays off and no tunnel starts.
  await card.getByLabel('아이디').fill('studio');
  await card.getByLabel('비밀번호', { exact: true }).fill('right');
  await card.getByLabel('PC 이름').fill('Studio PC');
  await card.getByRole('button', { name: '로그인' }).click();
  await card.getByRole('heading', { name: '프로젝트 열기' }).waitFor();
  await card.getByText('studio · Studio PC').waitFor();
  await card.getByText('아직 프로젝트가 없습니다. 이름을 넣어 만드세요.').waitFor();
  assert.deepEqual(
    logins.map((login) => login.username),
    ['studio', 'offline', 'studio'],
  );
  assert.equal(logins.at(-1).name, 'Studio PC');
  const remote = await page.evaluate(async () => (await fetch('api/v1/remote')).json());
  assert.equal(remote.linked, true);
  assert.equal(remote.remote, false, 'signing in leaves remote access off');
  assert.equal(tunnels.length, 0);
  assert.equal(await projects(), 0, 'still no project made by itself');

  // 4. A project made by name; the page reopens on it as the work screen.
  const create = card.getByRole('button', { name: '만들기' });
  assert.equal(await create.isDisabled(), true, 'an empty name makes nothing');
  await card.getByLabel('프로젝트 이름').fill('첫 프로젝트');
  await create.click();
  await page.waitForURL(/\?project=/);
  await page.waitForFunction(() => !document.querySelector('#body')?.disabled);
  assert.equal(await page.locator('#first-run').count(), 0);
  assert.match(await page.title(), /첫 프로젝트/);
  assert.equal(await projects(), 1);

  // 5. A signed-in PC opens straight to work.
  await page.goto(new URL(page.url()).origin + '/');
  await page.waitForFunction(() => !document.querySelector('#body')?.disabled);
  assert.equal(await page.locator('#first-run').count(), 0);
  assert.equal(await projects(), 1);
  assert.deepEqual(errors, []);
  console.log('first-run browser test passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

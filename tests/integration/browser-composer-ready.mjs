// The composer after project changes and after the work engine goes away and comes back.
// Installed 0.2.11: the engine restarted on the same port, the desktop window kept the page, and
// the composer stayed disabled until a manual reload. The page now retries and unlocks itself.
// VIDE_UI_DIR serves a UI build from another folder (default: the server's dist/ui).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'vide-composer-ready-'));
const uiDir = process.env.VIDE_UI_DIR;
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  const origin = new URL(app.launchUrl).origin;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) =>
    route.fulfill({ json: { available: false, zwcadAvailable: false } }),
  );
  if (uiDir)
    await page.route(
      (url) =>
        url.origin === origin && (url.pathname === '/' || url.pathname.startsWith('/assets/')),
      async (route) => {
        const path = new URL(route.request().url()).pathname;
        const file = path === '/' ? 'index.html' : path.slice(1);
        await route.fulfill({
          body: await readFile(join(uiDir, file)),
          contentType: file.endsWith('.html')
            ? 'text/html; charset=utf-8'
            : file.endsWith('.css')
              ? 'text/css'
              : 'text/javascript',
        });
      },
    );
  const composer = page.locator('#body');
  const enabled = async (label) => {
    await page.waitForFunction(() => !document.querySelector('#body').disabled, null, {
      timeout: 15_000,
    });
    await composer.fill(label);
    assert.equal(await composer.inputValue(), label);
  };

  // (1) First open, a new project, and a project id that no longer exists.
  await page.goto(app.launchUrl);
  await enabled('첫 프로젝트');
  const created = await page.evaluate(async () => {
    const response = await fetch('api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '나진상가' }),
    });
    return (await response.json()).id;
  });
  await page.goto(`${origin}/?project=${created}`);
  await enabled('새 프로젝트');
  await page.goto(`${origin}/?project=00000000-0000-4000-8000-000000000000`);
  await enabled('없어진 프로젝트');
  await page.goto(`${origin}/?project=${created}`);
  await enabled('구조 분석 부탁');

  // (2) The engine stops: the composer locks and the banner says why, with a retry.
  // (A real app.close() waits for the page's open connections, so the engine is cut off at the
  // network instead: every API call is refused like a stopped engine's port.)
  let down = true;
  await page.route('**/api/v1/**', (route) =>
    down ? route.abort('connectionrefused') : route.fallback(),
  );
  await page.waitForFunction(() => document.querySelector('#body').disabled, null, {
    timeout: 15_000,
  });
  const banner = page.locator('#connection-banner');
  await banner.waitFor({ state: 'visible' });
  assert.match(await banner.innerText(), /작업 엔진|연결/);
  assert.equal(await composer.inputValue(), '구조 분석 부탁', 'draft kept while locked');
  await banner.getByRole('button', { name: '다시 연결' }).click();
  await page.waitForTimeout(500);
  assert.equal(await composer.isDisabled(), true, 'still locked while the engine is off');

  // (3) The engine answers again (the desktop window keeps the page): unlocks by itself.
  down = false;
  await page.waitForFunction(() => !document.querySelector('#body').disabled, null, {
    timeout: 20_000,
  });
  await banner.waitFor({ state: 'hidden' });
  assert.equal(await composer.inputValue(), '구조 분석 부탁');
  await composer.fill('다시 연결 후 입력');

  // (4) A refused session (401) does not unlock by waiting; [다시 연결] retries on demand.
  let refuse = true;
  await page.route('**/api/v1/**', (route) =>
    refuse && !route.request().url().endsWith('/api/v1/host')
      ? route.fulfill({ status: 401, json: { code: 'UNAUTHORIZED' } })
      : route.fallback(),
  );
  await page.waitForFunction(() => document.querySelector('#body').disabled, null, {
    timeout: 15_000,
  });
  await page.waitForFunction(() =>
    document.querySelector('#connection-banner')?.textContent.includes('인증'),
  );
  refuse = false;
  await banner.getByRole('button', { name: '다시 연결' }).click();
  await enabled('인증 복구 후 입력');
  await banner.waitFor({ state: 'hidden' });

  // (5) Deleting the open project from the picker: Esc cancels, [삭제] removes it everywhere and
  // the page moves to a remaining project with a usable composer.
  await page.locator('#delete-project').click();
  await page.getByRole('alertdialog').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#delete-project').waitFor();
  await page.locator('#delete-project').click();
  await page.locator('#confirm-delete-project').click();
  await page.waitForFunction(
    (id) => {
      const picker = document.querySelector('#project-picker');
      return picker?.value && picker.value !== id && !picker.querySelector(`option[value="${id}"]`);
    },
    created,
    { timeout: 15_000 },
  );
  await enabled('삭제 후 입력');
  const remaining = await page.evaluate(async () =>
    (await (await fetch('api/v1/projects')).json()).map((project) => project.id),
  );
  assert.ok(!remaining.includes(created), 'deleted project is gone from the engine list');
  if (process.env.VIDE_SHOT) await page.screenshot({ path: process.env.VIDE_SHOT });
  assert.deepEqual(errors, []);
  console.log('Composer ready checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

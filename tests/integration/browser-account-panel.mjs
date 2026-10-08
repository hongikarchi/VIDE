// The VIDE account button and panel (SPEC-05.10, Design SCR-34): the rail's last button is the
// signed-in account's circle ('K' for kim) with the remote access dot; it opens the account panel
// with the ID, PC name, site connection, remote access switch and the AI accounts (read only);
// [이 PC 로그아웃] asks once more and then turns the button neutral on an engine without the sign-in
// check. Settings has no account tab; its [계정 열기] opens the panel. On a narrow screen the bar's
// account row opens the panel as a bottom sheet.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { runDirectory } from './run-directory.mjs';

const root = await mkdtemp(join(tmpdir(), 'vide-account-panel-'));
let app, browser;
try {
  app = await startServer({ filename: join(root, 'data', 'store.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let status = {
    linked: true,
    username: 'kim',
    name: 'Studio PC',
    site: 'https://site.example/',
    remote: true,
    running: true,
    url: 'https://tunnel.example',
    lastHeartbeat: new Date().toISOString(),
  };
  const remoteWrites = [];
  await page.route('**/api/v1/remote', (route) => route.fulfill({ json: status }));
  await page.route('**/api/v1/remote/remote', (route) => {
    const { enabled } = route.request().postDataJSON();
    remoteWrites.push(enabled);
    status = { ...status, remote: enabled, running: enabled };
    return route.fulfill({ json: status });
  });
  await page.route('**/api/v1/remote/unlink', (route) => {
    status = { linked: false, remote: false, running: false };
    return route.fulfill({ json: status });
  });
  await page.route('**/api/v1/accounts/usage', (route) =>
    route.fulfill({
      json: {
        settings: { usageLookup: false },
        accounts: [
          {
            provider: 'claude-cli',
            signedIn: true,
            email: 'a@example.com',
            limitReached: false,
            state: 'off',
          },
          { provider: 'codex-cli', signedIn: false, limitReached: false, state: 'signed-out' },
        ],
        accountSwitch: { installed: false },
      },
    }),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);

  // The button: the account's letter and colour, its tooltip, the remote dot.
  const button = page.locator('#account-button');
  await page.waitForFunction(
    () => document.querySelector('#account-button .avatar')?.textContent === 'K',
  );
  assert.equal(await button.getAttribute('title'), 'kim · Studio PC');
  assert.equal(await button.locator('.account-dot').getAttribute('data-state'), 'ok');
  const color = await button.locator('.avatar').getAttribute('data-avatar');
  assert.match(color, /^[1-8]$/);
  // It is the rail's last item, below the settings.
  assert.equal(
    await page.evaluate(() => document.querySelector('.rail').lastElementChild.id),
    'account-button',
  );

  // The panel: account, site, remote access, AI accounts (read only), sign-out.
  await button.click();
  const panel = page.getByRole('dialog', { name: 'VIDE 계정', exact: true });
  await panel.waitFor();
  await panel.getByText('Claude Code').waitFor();
  const text = await panel.textContent();
  assert.match(text, /kim/);
  assert.match(text, /Studio PC/);
  assert.match(text, /웹사이트 연결됨/);
  assert.match(text, /a@example\.com/);
  assert.match(text, /Codex로그인 필요/);
  assert.match(text, /AccountSwitch 설치/);
  assert.equal(await panel.locator('.account-head .avatar').textContent(), 'K');
  const box = await panel.boundingBox();
  const at = await button.boundingBox();
  assert.ok(box.x >= at.x + at.width, 'the panel opens to the right of the button');
  for (const name of ['계정 추가', '이 계정 사용'])
    assert.equal(await panel.getByRole('button', { name, exact: true }).count(), 0, name);
  const toggle = panel.getByLabel('다른 기기에서 열기 (원격 접속)');
  assert.equal(await toggle.isChecked(), true);
  await page.screenshot({ path: join(runDirectory('ui-audit'), 'account-panel-1440.png') });
  await toggle.uncheck();
  await page.waitForFunction(() => !document.querySelector('#account-button .account-dot'));
  assert.deepEqual(remoteWrites, [false]);

  // A press outside closes it.
  await page.mouse.click(700, 400);
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await button.getAttribute('aria-expanded'), 'false');

  // Settings: no account tab; [계정 열기] closes it and opens the panel.
  await page.locator('#workspace-settings').click();
  const settings = page.getByRole('dialog', { name: '상태 및 설정', exact: true });
  await settings.waitFor();
  assert.equal(await settings.locator('[data-tab="account"]').count(), 0);
  assert.match(
    await settings.textContent(),
    /VIDE 계정과 원격 접속은 왼쪽 아래 계정 단추에서 합니다/,
  );
  await settings.getByRole('button', { name: '계정 열기', exact: true }).click();
  await panel.waitFor();
  assert.equal(await settings.isVisible(), false);

  // Sign-out asks once more; this engine has no sign-in check, so the work screen stays and the
  // button turns neutral.
  await panel.getByRole('button', { name: '이 PC 로그아웃', exact: true }).click();
  await panel.getByText('이 PC의 프로젝트 자료는 남습니다.').waitFor();
  await panel.getByRole('button', { name: '로그아웃 확인', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('#account-button .avatar')?.dataset.avatar === 'none',
  );
  assert.equal(await button.getAttribute('title'), '로그인 안 됨');
  await panel.getByLabel('아이디', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });

  // Narrow screen: the bar's account row opens the panel as a bottom sheet.
  await page.setViewportSize({ width: 600, height: 800 });
  assert.equal(await button.isVisible(), false);
  const mobile = page.locator('#mobile-account-button');
  assert.equal(await mobile.isVisible(), true);
  await mobile.click();
  await panel.waitFor();
  const sheet = await panel.boundingBox();
  assert.equal(Math.round(sheet.x), 16);
  assert.equal(Math.round(sheet.y + sheet.height), 800 - 16);
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log('account button and panel checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

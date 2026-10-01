import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

// Settings → AI shows the current account of each CLI's default login read only (ADR-025,
// PLAN-25): email, plan, usage and the opt-in lookup, with "계정 관리는 AccountSwitch에서". No
// adding, signing in or switching accounts in VIDE. The status bar follows the login when
// AccountSwitch changes it, and the model list is read again. The usage answers are synthetic,
// so the test never reads this PC's real logins.
const root = await mkdtemp(join(tmpdir(), 'vide-account-ui-'));
let app, browser;
try {
  app = await startServer({
    filename: join(root, 'test.sqlite'),
    providerFactory: () => ({
      status: async () => ({ available: true }),
      run: async () => ({ text: '{}' }),
    }),
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let claudeEmail = 'a@example.com';
  const posted = [];
  let catalogReads = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/models')) catalogReads++;
  });
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/accounts/usage-settings', (route) => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: { settings: route.request().postDataJSON() } });
  });
  await page.route(/\/api\/v1\/accounts\/usage(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        settings: { usageLookup: true },
        accounts: [
          {
            provider: 'claude-cli',
            signedIn: true,
            email: claudeEmail,
            plan: 'max',
            session: { percent: 12, resetsAt: '2026-10-01T05:00:00Z' },
            weekly: { percent: 40, resetsAt: '2026-10-05T00:00:00Z' },
            limitReached: false,
            state: 'ok',
          },
          { provider: 'codex-cli', signedIn: false, limitReached: false, state: 'signed-out' },
        ],
      },
    }),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.locator('#workspace-settings').click();
  await page.locator('[data-tab="ai"]').click();
  const card = page.locator('.workspace-status-dialog .account-usage');
  await card.getByText('Claude · a@example.com').waitFor();
  const text = await card.textContent();
  assert.match(text, /계정 추가·로그인·전환은 AccountSwitch에서 합니다/);
  assert.match(text, /max/);
  assert.match(text, /ChatGPT · 로그인 안 됨/);
  assert.match(text, /터미널이나 AccountSwitch에서 이 서비스에 로그인하세요/);
  // Read only: nothing adds, signs in, selects or switches an account.
  for (const name of ['계정 추가', '사용', '이 계정 사용', '로그인', '로그아웃', '제거'])
    assert.equal(await card.getByRole('button', { name, exact: true }).count(), 0, name);
  assert.doesNotMatch(text, /자동 전환/);
  // The opt-in usage lookup stays a setting of this PC.
  await card.getByLabel('사용량 조회').uncheck();
  for (let i = 0; i < 50 && !posted.length; i++) await page.waitForTimeout(100);
  assert.deepEqual(posted.at(-1), { usageLookup: false });
  // The AI connection dialog has no account management either.
  await page.locator('#ai-settings').click();
  const dialog = page.locator('dialog.ai-settings');
  await dialog.getByRole('heading', { name: 'AI 연결', exact: true }).waitFor();
  assert.match(await dialog.textContent(), /AccountSwitch/);
  assert.equal(await dialog.getByRole('button', { name: '계정 추가' }).count(), 0);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  // The status bar shows the current login of the selected model's service and its usage.
  const indicator = page.locator('.statusbar [aria-label="현재 AI 계정"]');
  await page
    .locator('#model')
    .selectOption(
      await page.locator('#model optgroup[label="Claude"] option').first().getAttribute('value'),
    );
  await page.waitForFunction(() =>
    document
      .querySelector('.statusbar [aria-label="현재 AI 계정"]')
      ?.textContent.startsWith('a@example.com'),
  );
  assert.match(await indicator.textContent(), /5시간 12% · 7일 40%/);
  // AccountSwitch puts another account in place: the indicator follows and the models are re-read.
  const before = catalogReads;
  claudeEmail = 'b@example.com';
  await page.evaluate(() => window.dispatchEvent(new Event('vide-accounts-changed')));
  await page.waitForFunction(() =>
    document
      .querySelector('.statusbar [aria-label="현재 AI 계정"]')
      ?.textContent.startsWith('b@example.com'),
  );
  for (let i = 0; i < 50 && catalogReads === before; i++) await page.waitForTimeout(100);
  assert.ok(catalogReads > before, 'the model list is read again for the new login');
  // The removed account routes answer 404.
  assert.equal(
    await page.evaluate(
      async () => (await fetch('/api/v1/accounts/select', { method: 'POST' })).status,
    ),
    404,
  );
  assert.deepEqual(errors, []);
  console.log('Read-only account card, AccountSwitch guidance and status bar account verified.');
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

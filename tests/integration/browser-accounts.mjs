import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
const root = await mkdtemp(join(tmpdir(), 'vide-account-ui-'));
let app, browser, loginProcess;
let authenticated = true;
try {
  app = await startServer({
    filename: join(root, 'test.sqlite'),
    loginOptions: {
      spawnProcess: () => {
        loginProcess = new EventEmitter();
        loginProcess.stdout = new PassThrough();
        loginProcess.stderr = new PassThrough();
        return loginProcess;
      },
      kill: async () => true,
    },
    providerFactory: () => ({
      status: async () =>
        authenticated
          ? { available: true }
          : { available: false, reason: 'SUBSCRIPTION_LOGIN_REQUIRED' },
      run: async () => ({ text: '{}' }),
    }),
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  let catalogReads = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/models')) catalogReads++;
  });
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.goto(app.launchUrl);
  await page.locator('#workspace-settings').click();
  await page.locator('[data-tab="ai"]').click();
  await page.locator('#ai-settings').click();
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Codex · ChatGPT', exact: true }) });
  await section.getByLabel('codex-cli 계정 이름').fill('Second ChatGPT');
  await section.getByRole('button', { name: '계정 추가', exact: true }).click();
  const row = section.locator('.account-block').filter({ hasText: 'Second ChatGPT' });
  const inUse = (name) =>
    page.waitForFunction(
      (text) =>
        [...document.querySelectorAll('.ai-settings .account-row[data-active="true"]')].some(
          (node) => node.textContent.startsWith(text) && node.textContent.includes('사용 중'),
        ),
      name,
    );
  const more = async (block, name, item) => {
    await block.getByLabel(`${name} 더보기`).click();
    await block.getByRole('button', { name: item, exact: true }).click();
  };
  await row.getByRole('button', { name: '사용', exact: true }).click();
  await inUse('Second ChatGPT');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  // Any ChatGPT model (the list comes from the installed Codex CLI).
  await page
    .locator('#model')
    .selectOption(
      await page.locator('#model optgroup[label="ChatGPT"] option').first().getAttribute('value'),
    );
  await page.waitForFunction(
    () => document.querySelector('[aria-label="현재 AI 계정"]')?.textContent === 'Second ChatGPT',
  );
  await page.locator('#workspace-settings').click();
  await page.locator('[data-tab="ai"]').click();
  await page.locator('#ai-settings').click();
  // The official command stays available under ⋯.
  await more(row, 'Second ChatGPT', '명령으로 로그인');
  await section.getByLabel('공식 CLI 로그인 명령').waitFor();
  const command = await section.getByLabel('공식 CLI 로그인 명령').inputValue();
  assert.ok(command.includes('CODEX_HOME'));
  assert.ok(command.includes('cli_auth_credentials_store'));
  await section.getByRole('button', { name: '명령 닫기', exact: true }).click();
  assert.ok((await section.textContent()).includes('사용량 조회 꺼짐'));
  // Login shows the device link and one-time code to use in any browser; no browser opens.
  await row.getByRole('button', { name: '로그인', exact: true }).click();
  const panel = row.getByLabel('ChatGPT 로그인');
  await panel.getByText('코드를 받는 중…', { exact: true }).waitFor();
  loginProcess.stdout.write(
    '1. Open this link\n   https://auth.openai.com/codex/device\n2. Enter this one-time code\n   WXYZ-12345\n',
  );
  await panel.locator('.login-code').filter({ hasText: 'WXYZ-12345' }).waitFor();
  assert.equal(
    await panel.getByRole('link', { name: '기본 브라우저로 열기' }).getAttribute('href'),
    'https://auth.openai.com/codex/device',
  );
  const standardRow = section.locator('.account-block').first();
  assert.equal(
    await standardRow.getByRole('button', { name: '사용', exact: true }).isDisabled(),
    true,
  );
  // Cancelling leaves nothing behind in the list.
  await panel.getByRole('button', { name: '취소', exact: true }).click();
  await panel.getByText('멈추는 중…', { exact: true }).waitFor();
  loginProcess.emit('close', null);
  await panel.waitFor({ state: 'detached' });
  assert.equal((await section.textContent()).includes('취소'), false);
  await more(row, 'Second ChatGPT', '로그아웃');
  await row.getByText('로그아웃하는 중…', { exact: true }).waitFor();
  const beforeLogout = catalogReads;
  authenticated = false;
  loginProcess.emit('close', 0);
  await section.getByText('로그아웃했습니다.', { exact: true }).waitFor();
  await page.waitForTimeout(100);
  assert.ok(catalogReads > beforeLogout, 'Terminal authentication state refreshes the catalog');
  await inUse('Second ChatGPT');
  page.once('dialog', (dialog) => dialog.dismiss());
  await more(row, 'Second ChatGPT', '제거');
  assert.equal(await row.count(), 1);
  page.once('dialog', (dialog) => dialog.accept());
  await more(row, 'Second ChatGPT', '제거');
  await row.waitFor({ state: 'detached' });
  await inUse('기존 CLI 로그인');
  // The existing CLI login can be renamed too; an empty name restores the standard name.
  await more(standardRow, '기존 CLI 로그인', '이름 변경');
  await standardRow.getByLabel('기존 CLI 로그인 새 이름').fill('개인 ChatGPT');
  await standardRow.getByRole('button', { name: '저장', exact: true }).click();
  await inUse('개인 ChatGPT');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="현재 AI 계정"]')?.textContent === '개인 ChatGPT',
  );
  await page.locator('#workspace-settings').click();
  await page.locator('[data-tab="ai"]').click();
  await page.locator('#ai-settings').click();
  await more(standardRow, '개인 ChatGPT', '이름 변경');
  await standardRow.getByLabel('개인 ChatGPT 새 이름').fill('');
  await standardRow.getByRole('button', { name: '저장', exact: true }).click();
  await inUse('기존 CLI 로그인');
  console.log(
    'Account add/select/login instructions verified in Chromium; provider authentication mocked.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

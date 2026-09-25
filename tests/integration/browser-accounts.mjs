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
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.goto(app.launchUrl);
  await page.locator('#draft-menu summary').click();
  await page.locator('#ai-settings').click();
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Codex · ChatGPT', exact: true }) });
  await section.getByLabel('codex-cli 계정 이름').fill('Second ChatGPT');
  await section.getByRole('button', { name: '계정 추가', exact: true }).click();
  const row = section.locator('.account-settings > div').filter({ hasText: 'Second ChatGPT' });
  await row.getByRole('button', { name: '선택', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.ai-settings')?.textContent.includes('Second ChatGPT · 선택됨'),
  );
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('#model').selectOption('codex-cli');
  await page.waitForFunction(
    () => document.querySelector('[aria-label="현재 AI 계정"]')?.textContent === 'Second ChatGPT',
  );
  await page.locator('#draft-menu summary').click();
  await page.locator('#ai-settings').click();
  await row.getByRole('button', { name: '로그인 방법', exact: true }).click();
  await section.getByLabel('공식 CLI 로그인 명령').waitFor();
  const command = await section.getByLabel('공식 CLI 로그인 명령').inputValue();
  assert.ok(command.includes('CODEX_HOME'));
  assert.ok(command.includes('cli_auth_credentials_store'));
  assert.ok((await section.textContent()).includes('사용량 미확인'));
  await row.getByRole('button', { name: '로그인', exact: true }).click();
  await row.getByText('브라우저에서 인증하세요', { exact: true }).waitFor();
  assert.equal(await row.getByRole('button', { name: '선택', exact: true }).isDisabled(), true);
  await row.getByRole('button', { name: '로그인 취소', exact: true }).click();
  await row.getByText('로그인 종료 확인 중', { exact: true }).waitFor();
  loginProcess.emit('close', null);
  await row.getByText('로그인 취소됨', { exact: true }).waitFor();
  await row.getByRole('button', { name: '로그아웃', exact: true }).click();
  await row.getByText('로그아웃 진행 중', { exact: true }).waitFor();
  assert.equal(await row.getByRole('button', { name: '선택', exact: true }).isDisabled(), true);
  authenticated = false;
  loginProcess.emit('close', 0);
  await row.getByText('로그아웃 완료', { exact: true }).waitFor();
  assert.ok((await row.textContent()).includes('선택됨'));
  page.once('dialog', (dialog) => dialog.dismiss());
  await row.getByRole('button', { name: '제거', exact: true }).click();
  assert.equal(await row.count(), 1);
  page.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: '제거', exact: true }).click();
  await row.waitFor({ state: 'detached' });
  assert.ok((await section.textContent()).includes('기존 CLI 로그인 · 선택됨'));
  console.log(
    'Account add/select/login instructions verified in Chromium; provider authentication mocked.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

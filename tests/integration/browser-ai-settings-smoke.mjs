// The AI settings dialog's project addendum editor (PLAN-24 지침 묶음): type, save, reload, read back.
// Synthetic engine and provider; no model requests or host writes.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
const root = await mkdtemp(join(tmpdir(), 'vide-ai-settings-smoke-'));
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
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  const open = async () => {
    await page.locator('#workspace-settings').click();
    await page.locator('[data-tab="ai"]').click();
    await page.locator('#ai-settings').click();
    const editor = page.getByRole('textbox', { name: '프로젝트 AI 지침', exact: true });
    await editor.waitFor();
    await page.waitForFunction(
      () => !document.querySelector('.ai-instructions textarea')?.disabled,
    );
    return editor;
  };
  await page.goto(app.launchUrl);
  const text = '구조 레이어는 STR:: 아래에 둔다.\n치수는 mm로 답한다.';
  let editor = await open();
  assert.equal(await editor.inputValue(), '');
  const section = page.locator('section.ai-instructions');
  const saveButton = section.getByRole('button', { name: '지침 저장', exact: true });
  assert.ok(await saveButton.isDisabled(), 'unchanged text cannot be saved');
  await editor.fill(text);
  await saveButton.click();
  await section
    .getByRole('status')
    .filter({ hasText: '저장했습니다. 다음 요청부터 적용됩니다.' })
    .waitFor();
  assert.ok(await saveButton.isDisabled(), 'saved text disables the button');
  await page.reload();
  editor = await open();
  assert.equal(await editor.inputValue(), text);
  // Over the 8 KB limit the button stays disabled.
  await editor.fill('가'.repeat(3000));
  assert.ok(await saveButton.isDisabled(), 'over-limit text cannot be saved');
  console.log(JSON.stringify({ addendumSaved: true, reloaded: true, overLimitBlocked: true }));
} finally {
  await browser?.close();
  await app?.close?.();
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

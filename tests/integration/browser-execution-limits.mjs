import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
const root = await mkdtemp(join(tmpdir(), 'vide-limits-'));
let app, browser, actualTimeout;
try {
  app = await startServer({
    filename: join(root, 'test.sqlite'),
    providerFactory: (options) => ({
      status: async () => ({ available: true }),
      run: async () => {
        actualTimeout = options.timeoutMs;
        return { text: JSON.stringify({ message: 'Verified', operations: [] }) };
      },
    }),
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.locator('#body').fill('Review with bounded execution');
  const open = async () => {
    await page.locator('#workspace-settings').click();
    await page.locator('[data-tab="ai"]').click();
    await page.locator('#execution-limits').click();
  };
  await open();
  await page.getByLabel('도구 호출 수', { exact: true }).fill('8');
  await page.getByLabel('대상별 호스트 실행 수', { exact: true }).fill('3');
  await page.getByLabel('AI 응답 시간 (초)', { exact: true }).fill('60');
  await page.getByRole('button', { name: '적용', exact: true }).click();
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector('#body')?.value === 'Review with bounded execution',
  );
  await open();
  assert.equal(await page.getByLabel('도구 호출 수', { exact: true }).inputValue(), '8');
  assert.equal(await page.getByLabel('대상별 호스트 실행 수', { exact: true }).inputValue(), '3');
  assert.equal(await page.getByLabel('AI 응답 시간 (초)', { exact: true }).inputValue(), '60');
  const bounds = await page.getByRole('dialog', { name: '작업 상한', exact: true }).boundingBox();
  assert.ok(bounds.width <= 440 && bounds.x >= 0 && bounds.y >= 0);
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await page.locator('#request').click();
  const deadline = Date.now() + 10000;
  let saved;
  while (Date.now() < deadline) {
    saved = app.store.db
      .prepare('SELECT * FROM workspace_requests ORDER BY rowid DESC LIMIT 1')
      .get();
    if (saved?.state === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(saved?.state, 'succeeded');
  assert.deepEqual(JSON.parse(saved.input).executionLimits, {
    maxToolCalls: 8,
    maxHostCommands: 3,
    timeoutSeconds: 60,
  });
  assert.equal(actualTimeout, 60000);
  assert.deepEqual(errors, []);
  console.log(
    'Chromium: execution limit editing, cancellation, draft reload, actual API submission and provider timeout passed. Provider response mocked.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

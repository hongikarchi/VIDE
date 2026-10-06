import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { soleDb } from '../fixtures/store.mjs';
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
  // Since T-122 only the idle wait acts: the call and execute counts are gone from the dialog.
  const dialog = page.getByRole('dialog', { name: 'AI 응답 대기', exact: true });
  assert.equal(await dialog.getByRole('spinbutton').count(), 1);
  assert.equal(await dialog.getByText('도구 호출', { exact: false }).count(), 0);
  await page.getByLabel('응답 없이 기다리는 시간 (초)', { exact: true }).fill('10');
  await page.getByRole('button', { name: '적용', exact: true }).click();
  // Out of range (30~600): the field's own check keeps the dialog open.
  assert.equal(await dialog.isVisible(), true);
  await page.getByLabel('응답 없이 기다리는 시간 (초)', { exact: true }).fill('60');
  await page.getByRole('button', { name: '적용', exact: true }).click();
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector('#body')?.value === 'Review with bounded execution',
  );
  await open();
  assert.equal(
    await page.getByLabel('응답 없이 기다리는 시간 (초)', { exact: true }).inputValue(),
    '60',
  );
  const bounds = await page
    .getByRole('dialog', { name: 'AI 응답 대기', exact: true })
    .boundingBox();
  assert.ok(bounds.width <= 440 && bounds.x >= 0 && bounds.y >= 0);
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await page.locator('#request').click();
  const deadline = Date.now() + 10000;
  let saved;
  while (Date.now() < deadline) {
    saved = soleDb(app.store)
      .prepare('SELECT * FROM workspace_requests ORDER BY rowid DESC LIMIT 1')
      .get();
    if (saved?.state === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(saved?.state, 'succeeded');
  // The contract still carries the two old counts (stored requests parse); they keep their values.
  const limits = JSON.parse(saved.input).executionLimits;
  assert.equal(limits.timeoutSeconds, 60);
  assert.ok(Number.isInteger(limits.maxToolCalls) && Number.isInteger(limits.maxHostCommands));
  assert.equal(actualTimeout, 60000);
  assert.deepEqual(errors, []);
  console.log(
    'Chromium: idle wait editing (no call/execute counts), range refusal, cancellation, draft reload, actual API submission and provider timeout passed. Provider response mocked.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

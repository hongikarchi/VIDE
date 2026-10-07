// 설정 → AI → 외부 자료 (PLAN-45 T-205): the four public-data keys show present/absent only; a
// typed key is saved, the field clears and the value never comes back to the page; [지우기]
// removes it. Synthetic key; a fresh data folder and no environment keys.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const root = await mkdtemp(join(tmpdir(), 'vide-public-data-'));
const secret = 'not-a-real-key';
let app, browser;
try {
  app = await startServer({
    filename: join(root, 'test.sqlite'),
    siteDataOptions: { environment: {} },
    providerFactory: () => ({
      status: async () => ({ available: true }),
      run: async () => ({ text: '{}' }),
    }),
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.goto(app.launchUrl);
  await page.locator('#workspace-settings').click();
  await page.locator('[data-tab="ai"]').click();
  const section = page.locator('section.settings-public-data');
  await section.waitFor();
  assert.match(await section.locator('h3').textContent(), /외부 자료/);
  const row = section.locator('li[data-key="JUSO_KEY"]');
  assert.equal(await section.locator('.pill[data-ok="false"]').count(), 4, 'all four absent');
  await row.getByLabel('주소 검색 키 입력').fill(secret);
  await row.getByRole('button', { name: '저장' }).click();
  await row.locator('.pill[data-ok="true"]').filter({ hasText: '있음' }).waitFor();
  assert.equal(await row.getByLabel('주소 검색 키 입력').inputValue(), '');
  assert.ok(!(await page.content()).includes(secret), 'the value never returns to the page');
  assert.match(
    await readFile(join(root, 'public-data.env'), 'utf8'),
    /^JUSO_KEY=not-a-real-key\n$/,
  );
  await row.getByRole('button', { name: '지우기' }).click();
  await row.locator('.pill[data-ok="false"]').waitFor();
  console.log(JSON.stringify({ absentShown: true, saved: true, valueHidden: true, removed: true }));
} finally {
  await browser?.close();
  await app?.close?.();
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

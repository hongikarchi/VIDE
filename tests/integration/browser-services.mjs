// 설정 › 외부 서비스 (SPEC-13.11, PLAN-46 T-217) in Chromium against the fake cLAWde server: save
// the address and the development token, the status turns '연결됨' with the law DB date, the token
// is never shown again, [연결] is off on a PC not signed in, this project's '보내지 않음' sticks,
// '로그인 필요' after a 401, and [끊기].
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';

const root = await mkdtemp(join(tmpdir(), 'vide-services-ui-'));
let app, browser, fake;
try {
  fake = await startFakeClawde();
  app = await startServer({
    filename: join(root, 'data', 'store.sqlite'),
    serviceOptions: { protector: testProtector },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.locator('#workspace-settings').click();
  await page.locator('[data-tab="services"]').click();
  const status = page.locator('#clawde-status');
  await page.waitForFunction(() => document.querySelector('#clawde-status')?.textContent !== '…');
  assert.equal(await status.textContent(), '설정 안 됨');
  assert.equal(await page.locator('#clawde-connect').isDisabled(), true, 'not signed in');

  await page.locator('#clawde-address').fill(fake.url);
  await page.locator('#clawde-token').fill(fake.token);
  await page.locator('#clawde-save').click();
  await page.waitForFunction(
    () => document.querySelector('#clawde-status')?.textContent === '연결됨',
  );
  assert.match(await page.locator('#clawde-law-date').textContent(), /2026-09-01/);
  if (process.env.VIDE_SHOT) await page.screenshot({ path: process.env.VIDE_SHOT });
  assert.equal(await page.locator('#clawde-token').inputValue(), '', 'the field is emptied');
  assert.match(await page.locator('#clawde-token').getAttribute('placeholder'), /저장됨/);
  const html = await page.content();
  assert.ok(!html.includes(fake.token), 'the token is not on the page');

  // This project sends nothing to the service; kept after reopening.
  // A controlled box: it turns on when the engine has saved the list.
  await page.locator('#clawde-project-off').click();
  await page.waitForFunction(() => document.querySelector('#clawde-project-off')?.checked);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.locator('#workspace-settings').click();
  await page.locator('[data-tab="services"]').click();
  await page.waitForFunction(() => document.querySelector('#clawde-project-off')?.checked);

  fake.control({ failStatus: 401 });
  await page.locator('#clawde-check').click();
  await page.waitForFunction(
    () => document.querySelector('#clawde-status')?.textContent === '로그인 필요',
  );
  fake.control({ failStatus: null });
  await page.locator('#clawde-disconnect').click();
  await page.waitForFunction(
    () => document.querySelector('#clawde-status')?.textContent === '설정 안 됨',
  );
  assert.equal(await page.locator('#clawde-check').isDisabled(), true);
  const bounds = await page.locator('.services-settings').boundingBox();
  assert.ok(bounds.width > 200 && bounds.x >= 0);
  assert.deepEqual(errors, []);
  console.log(
    'Chromium: external service settings — token saved and hidden, 연결됨 with the law DB date, project off kept, 로그인 필요, 끊기.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await fake?.close();
  await rm(root, { recursive: true, force: true });
}

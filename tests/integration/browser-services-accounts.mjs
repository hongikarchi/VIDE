// 설정 › 외부 서비스 — GitHub · Cloudflare 칸 (SPEC-05.11, Design SCR-41, PLAN-54 T-344) in Chromium
// against fake GitHub·Cloudflare APIs: put a token and [연결] → '연결됨 · 저장소 만들기 가능 · 방금
// 확인', the token never on the page after saving, a token short of rights '권한 부족', a service
// that does not answer '확인 실패', Cloudflare with the account ID and the account name, [끊기].
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';
import {
  FAKE_CLOUDFLARE_ACCOUNT,
  FAKE_CLOUDFLARE_NAME,
  FAKE_CLOUDFLARE_TOKEN,
  FAKE_GITHUB_LOGIN,
  FAKE_GITHUB_TOKEN,
  startFakeAccounts,
} from '../fixtures/fake-accounts/server.mjs';

const root = await mkdtemp(join(tmpdir(), 'vide-services-accounts-ui-'));
let app, browser, accounts;
try {
  accounts = await startFakeAccounts();
  app = await startServer({
    filename: join(root, 'data', 'store.sqlite'),
    serviceOptions: {
      protector: testProtector,
      githubApi: accounts.github,
      cloudflareApi: accounts.cloudflare,
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.locator('#workspace-settings').click();
  await page.locator('[data-tab="services"]').click();
  const text = (selector) => page.locator(selector).textContent();
  const waitText = (selector, value) =>
    page.waitForFunction(
      ([s, v, pattern]) => {
        const found = document.querySelector(s)?.textContent ?? '';
        return pattern ? new RegExp(v).test(found) : found === v;
      },
      [selector, value instanceof RegExp ? value.source : value, value instanceof RegExp],
    );

  // Three cards in one frame; cLAWde first, as before.
  await waitText('#github-status', '연결 안 됨');
  assert.equal(await page.locator('.service-card').count(), 3);
  assert.equal(await text('#clawde-status'), '설정 안 됨');
  assert.equal(await text('#cloudflare-status'), '연결 안 됨');
  assert.equal(await text('#github-line'), '연결 안 됨');
  assert.equal(await page.locator('#github-connect').isDisabled(), true, 'nothing to connect');
  assert.equal(await page.locator('#github-disconnect').isDisabled(), true);
  assert.match(await text('#github-card'), /Personal access tokens/);

  // GitHub: token + [연결] → 연결됨 · login · 저장소 만들기 가능 · 방금 확인.
  await page.locator('#github-token').fill(FAKE_GITHUB_TOKEN);
  await page.locator('#github-connect').click();
  await waitText('#github-status', '연결됨');
  assert.equal(
    await text('#github-line'),
    `연결됨 · ${FAKE_GITHUB_LOGIN} · 저장소 만들기 가능 · 방금 확인`,
  );
  assert.equal(await page.locator('#github-token').inputValue(), '', 'the field is emptied');
  assert.match(await page.locator('#github-token').getAttribute('placeholder'), /설정됨/);
  if (process.env.VIDE_SHOT) await page.screenshot({ path: process.env.VIDE_SHOT });

  // A token without the repository right: 권한 부족, saved anyway.
  accounts.control({ githubScopes: 'read:user' });
  await page.locator('#github-connect').click();
  await waitText('#github-status', '권한 부족');
  assert.match(await text('#github-line'), /^권한 부족 — 저장소 만들기 권한이 없는 토큰입니다/);
  assert.doesNotMatch(await text('#github-card'), /read:user|repo\b/, 'no internal scope names');

  // The service does not answer: 확인 실패.
  accounts.control({ fail: 503 });
  await page.locator('#github-connect').click();
  await waitText('#github-status', '확인 실패');
  assert.match(await text('#github-line'), /^확인 실패 — 서비스에 닿지 않습니다 · 방금 시도$/);
  accounts.reset();

  // Cloudflare: token and account ID, then the account name.
  await page.locator('#cloudflare-token').fill(FAKE_CLOUDFLARE_TOKEN);
  await page.locator('#cloudflare-account').fill('not-an-id');
  await page.locator('#cloudflare-connect').click();
  await waitText('#cloudflare-card [role="alert"]', /계정 ID 형식/);
  await page.locator('#cloudflare-token').fill(FAKE_CLOUDFLARE_TOKEN);
  await page.locator('#cloudflare-account').fill(FAKE_CLOUDFLARE_ACCOUNT);
  await page.locator('#cloudflare-connect').click();
  await waitText('#cloudflare-status', '연결됨');
  assert.equal(await text('#cloudflare-line'), `연결됨 · 계정 ${FAKE_CLOUDFLARE_NAME} · 방금 확인`);
  assert.equal(await page.locator('#cloudflare-card [role="alert"]').count(), 0);

  // No token anywhere on the page after saving (fields, placeholders, attributes).
  const html = await page.content();
  assert.ok(!html.includes(FAKE_GITHUB_TOKEN), 'GitHub token not on the page');
  assert.ok(!html.includes(FAKE_CLOUDFLARE_TOKEN), 'Cloudflare token not on the page');

  // Reopen: kept, still hidden.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.locator('#workspace-settings').click();
  await page.locator('[data-tab="services"]').click();
  await waitText('#cloudflare-status', '연결됨');
  await waitText('#github-status', '확인 실패');
  assert.ok(!(await page.content()).includes(FAKE_GITHUB_TOKEN));

  // [끊기]: the token is forgotten.
  await page.locator('#github-disconnect').click();
  await waitText('#github-status', '연결 안 됨');
  assert.equal(await page.locator('#github-disconnect').isDisabled(), true);
  await page.locator('#cloudflare-disconnect').click();
  await waitText('#cloudflare-status', '연결 안 됨');

  const bounds = await page.locator('#cloudflare-card').boundingBox();
  assert.ok(bounds.width > 200 && bounds.x >= 0);
  assert.deepEqual(errors, []);
  console.log(
    'Chromium: GitHub·Cloudflare accounts — 연결됨 with login/account name, 권한 부족, 확인 실패, tokens never on the page, 끊기.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await accounts?.close();
  await rm(root, { recursive: true, force: true });
}

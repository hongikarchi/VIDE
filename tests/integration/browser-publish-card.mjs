// 보고용 게시 [공유] on screen (PLAN-54 T-343, Design SCR-43, SPEC-04.14): a computed 건축개요's 보고용
// is made through the engine; in 산출물 → 보고서 → [보고용] the head has [공유]. The card offers the
// VIDE site (default) and the user's Cloudflare (dim with the settings hint when not connected);
// a 12-character password is made and shown before the first [게시] only, [다시 만들기] changes it;
// [게시] shows the two progress lines then the result line (address · [복사] · [열기] · '비밀번호
// 설정됨' · time) and the password is gone from the page; [다시 게시] sends no password; a service
// refusal is one red line; [내리기] asks first. The publish routes are stubbed (page.route): the
// real ones are tests/server/publish-routes.test.mjs and tests/sharing/report-publications.mjs.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { closeJigRuntime, jigRuntimeFor } from '../../src/server/jig-routes.ts';
import { seedMassInstance } from '../fixtures/summary-chain.mjs';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-publish-card-'));
let app, browser, seeded;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ json: [{ id: 'codex-cli', available: true }] }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();

  // A computed 건축개요 and its 보고용 (no work folder: kept in the data folder).
  seeded = new Workspace(app.store);
  const runtime = jigRuntimeFor(seeded, directory);
  await seedMassInstance(runtime, projectId, '매스 A');
  const summary = await runtime.createInstance(projectId, {
    jig: 'vide/building-summary',
    title: '개요 A',
    layerRoot: 'VIDE::개요',
  });
  await runtime.run(projectId, summary.id, { mode: 'confirmed' });
  const reports = await page.evaluate(
    async ({ p, i }) => (await fetch(`/api/v1/projects/${p}/jig-instances/${i}/reports`)).json(),
    { p: projectId, i: summary.id },
  );
  const reportId = (reports.reports ?? reports)[0].id;
  const made = await page.evaluate(
    async ({ p, i, r }) =>
      (
        await fetch(`/api/v1/projects/${p}/jig-instances/${i}/reports/${r}/public`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '건축개요 보고서' }),
        })
      ).json(),
    { p: projectId, i: summary.id, r: reportId },
  );
  assert.ok(made.name, JSON.stringify(made));

  // The publish routes and the services view, stubbed.
  const state = {
    published: null,
    passwordKept: false,
    defaultSiteName: 'project-report-ab12cd',
    siteLinked: true,
  };
  const posts = [];
  let failNext = false;
  await page.route('**/api/v1/settings/services', (route) =>
    route.fulfill({ json: { cloudflare: { status: 'not-configured' } } }),
  );
  await page.route(/\/api\/v1\/projects\/[^/]+\/outputs\/[^/]+\/(publish|unpublish)$/, (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: state });
    const body = request.postDataJSON() ?? {};
    posts.push({ url: request.url(), body });
    if (request.url().endsWith('/unpublish')) {
      state.published = { ...state.published, revokedAt: '2026-10-15T05:40:00.000Z' };
      return route.fulfill({ json: { published: state.published } });
    }
    if (failNext) {
      failNext = false;
      return route.fulfill({
        status: 502,
        json: {
          code: 'PUBLISH_FAILED',
          detail: 'quota exceeded',
          reason: '올리지 못했습니다 — 서비스 응답: quota exceeded',
        },
      });
    }
    state.published = {
      target: 'vide-site',
      url: 'https://share.example.test/r/0123456789abcdef0123456789abcdef/',
      publishedAt: '2026-10-15T05:31:00.000Z',
      passwordSet: true,
      sourceRun: null,
      publicationId: '0123456789abcdef0123456789abcdef',
    };
    state.passwordKept = true;
    return route.fulfill({ json: { published: state.published } });
  });

  // 산출물 → 보고서 → 개요 A → [보고용].
  await page.locator('.rail [data-workspace-target="output"]').click();
  const views = page.getByRole('tablist', { name: '산출물 종류' });
  await views.getByRole('tab', { name: '보고서', exact: true }).click();
  const screen = page.locator('.output-workspace .report-workspace');
  await screen.locator('.report-group', { hasText: '개요 A' }).getByRole('button').first().click();
  await screen.locator('.kit-report').waitFor();
  const tiers = screen.getByRole('group', { name: '보고서 등급' });
  await tiers.getByRole('button', { name: '보고용' }).click();
  const head = screen.locator('[data-public-head]');
  await head.waitFor();
  const card = head.locator('[data-publish-card]');
  await card.getByRole('button', { name: '공유' }).click();
  const panel = card.getByRole('group', { name: '공유' });
  await panel.waitFor();

  // The choice: VIDE site checked; Cloudflare dim with the hint.
  const siteChoice = panel.getByRole('radio', { name: /VIDE 공유 사이트/ });
  const cfChoice = panel.getByRole('radio', { name: /내 Cloudflare 계정/ });
  assert.equal(await siteChoice.isChecked(), true);
  assert.equal(await cfChoice.isDisabled(), true);
  assert.match(await panel.innerText(), /설정 → 외부 서비스에서 Cloudflare를 연결하세요/);

  // The password: 12 characters, [다시 만들기] makes another, '게시 뒤에는 다시 보이지 않습니다'.
  const field = panel.locator('#publish-password');
  const first = await field.inputValue();
  assert.match(first, /^[A-Za-z0-9]{12}$/);
  await panel.getByRole('button', { name: '다시 만들기' }).click();
  const password = await field.inputValue();
  assert.match(password, /^[A-Za-z0-9]{12}$/);
  assert.notEqual(password, first);
  assert.match(await panel.innerText(), /게시 뒤에는 다시 보이지 않습니다/);
  await panel.getByRole('button', { name: '복사', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), password);
  if (shot) await page.screenshot({ path: join(shot, 'publish-card.png') });

  // A refusal: one red line, the password still there to try again.
  failNext = true;
  await panel.getByRole('button', { name: '게시', exact: true }).click();
  const failure = card.locator('.publish-failure');
  await failure.waitFor();
  assert.equal(await failure.textContent(), '올리지 못했습니다 — 서비스 응답: quota exceeded');
  assert.equal(await field.inputValue(), password);

  // [게시]: the password goes once, then it is not on the page any more.
  await panel.getByRole('button', { name: '게시', exact: true }).click();
  const result = card.locator('[data-publish-result]');
  await result.waitFor();
  assert.equal(posts.at(-1).body.target, 'vide-site');
  assert.equal(posts.at(-1).body.password, password);
  const line = await result.innerText();
  assert.match(line, /https:\/\/share\.example\.test\/r\/0123456789abcdef0123456789abcdef\//);
  assert.match(line, /비밀번호 설정됨/);
  assert.match(line, /10-15 \d{2}:\d{2}/);
  assert.equal(await panel.count(), 0, 'the card closes');
  assert.equal(await failure.count(), 0);
  assert.ok(!(await page.content()).includes(password), 'never shown after publishing');
  if (shot) await page.screenshot({ path: join(shot, 'publish-result.png') });

  // [다시 게시]: no password field, the overwrite note, nothing sent for the password.
  await card.getByRole('button', { name: '공유' }).click();
  await panel.waitFor();
  assert.equal(await panel.locator('#publish-password').count(), 0);
  assert.match(await panel.innerText(), /이전 게시를 덮습니다\. 비밀번호는 그대로입니다/);
  assert.match(await panel.innerText(), /올림 · 10-15/);
  await panel.getByRole('button', { name: '다시 게시' }).click();
  await panel.waitFor({ state: 'detached' });
  assert.equal(posts.at(-1).body.password, undefined);
  assert.ok(!(await page.content()).includes(password));

  // [내리기] asks first.
  await result.getByRole('button', { name: '내리기' }).click();
  const confirm = card.getByRole('dialog', { name: '내리기' });
  assert.match(await confirm.innerText(), /주소가 더 이상 열리지 않습니다/);
  await confirm.getByRole('button', { name: '내리기' }).click();
  await result.waitFor({ state: 'detached' });
  assert.ok(posts.at(-1).url.endsWith('/unpublish'));

  // Narrow screen: no sideways scrolling.
  await card.getByRole('button', { name: '공유' }).click();
  await page.setViewportSize({ width: 390, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 391));

  // The one refusal above is a 502 the browser logs; nothing else.
  assert.deepEqual(
    errors.filter((e) => !/status of 502/.test(e)),
    [],
  );
  console.log('Publish card checks passed');
} finally {
  if (seeded) await closeJigRuntime(seeded);
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}

// 보고서 view of the 산출물 tab (PLAN-22 T-057, PLAN-23 T-058, PLAN-26 T-081, SCR-17): it opens
// from the 산출물 tab, lists the S-06
// instance's report, draws it with the numbered sections and the 부록 (each '아직 없음' before any
// step has run), shows the three report gates passing, switches the paper, saves a page without scripts and
// goes back to the instance's context tab. A last tab stored under the former 'report' id still
// opens it. No real host or CLI; no step outputs are needed.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-report-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(15000);
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

  // An S-06 instance with no results yet (no Sync, so the output layer is not checked).
  const created = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/projects/${id}/jig-instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jig: 'project/s06-frame',
        title: '합성 골조',
        layerRoot: 'VIDE 출력',
      }),
    });
    return { status: response.status, body: await response.json() };
  }, projectId);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const instanceId = created.body.id ?? created.body.instance?.id;
  assert.ok(instanceId, JSON.stringify(created.body));

  // The 산출물 tab is ready; its 보고서 view shows the list and the report.
  const tab = page.locator('#workspace-tabs [role="tab"][data-workspace="output"]');
  assert.equal(await tab.getAttribute('aria-disabled'), null);
  await tab.click();
  assert.equal(await page.evaluate(() => document.body.dataset.workspace), 'output');
  const views = page.getByRole('tablist', { name: '산출물 종류' });
  await views.getByRole('tab', { name: '보고서', exact: true }).click();
  assert.equal(
    await views.getByRole('tab', { name: '보고서', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  const screen = page.locator('.output-workspace .report-workspace');
  await screen.locator('.report-group', { hasText: '합성 골조' }).waitFor();
  assert.ok(!(await page.locator('.workspace > .viewport-area').isVisible()));
  const report = screen.locator('.kit-report');
  await report.waitFor();
  assert.deepEqual(await report.locator('.kit-report-no').allTextContents(), [
    '01',
    '02',
    '03',
    '04',
    '05',
    '부록',
  ]);
  const titles = await report.locator('.kit-report-section h2').allTextContents();
  for (const title of titles.slice(0, 4)) assert.match(title, /아직 없음/);
  // The appendix reads the instance's settings from the engine even before any step has run.
  assert.match(titles[5], /^설정값 원장: \d+개 중 가정으로 둔 기본값 \d+개가 남아 있습니다\.$/);
  assert.match(
    titles[4],
    /^남은 조건 \d+개: 가정으로 둔 설정값 \d+개, 답하지 않은 질문 0개입니다\.$/,
  );
  assert.match(await report.locator('h1').textContent(), /아직 계산한 결과가 없습니다\./);
  assert.match(await report.textContent(), /검토하지 않은 항목/);
  assert.deepEqual(
    await screen
      .locator('.report-checks li[data-ok]')
      .evaluateAll((rows) => rows.map((r) => r.dataset.ok)),
    ['true', 'true', 'true'],
  );
  assert.doesNotMatch(await screen.textContent(), /claim-consistent|undefined|null/);
  if (shot) await page.screenshot({ path: join(shot, 'output-report.png') });

  // Paper: A4 portrait narrows the sheet (its width limit: at 1440 px the centre column is
  // already narrower than either paper, so the rendered widths can be equal).
  const sheetWidth = () =>
    screen.locator('.report-sheet').evaluate((el) => parseFloat(getComputedStyle(el).maxWidth));
  const a3 = await sheetWidth();
  await screen.getByLabel('판형').selectOption('a4');
  assert.equal(await screen.locator('.report-paper').getAttribute('data-paper'), 'a4');
  assert.ok((await sheetWidth()) < a3);

  // Save: the engine's page, self-contained and without scripts or setting controls.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    screen.getByRole('button', { name: 'HTML 저장' }).click(),
  ]);
  const html = await readFile(await download.path(), 'utf8');
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /VIDE에서 열기: .* · 합성 골조 · S-06 골조 배치 \d+\.\d+\.\d+/);
  assert.doesNotMatch(html, /<button|<input|<select/);

  // Back to the settings: the instance opens in its context tab.
  await report.getByRole('button', { name: '이 설정값으로 돌아가기' }).click();
  await page.waitForFunction(
    (id) =>
      document.querySelector('#workspace-tabs [aria-selected="true"]')?.dataset.workspace ===
      `jig:${id}`,
    instanceId,
  );
  assert.equal(await page.evaluate(() => document.body.dataset.workspace), 'context');
  assert.ok(!(await screen.isVisible()));

  // A last tab stored under the former 보고서 tab id opens 산출물 → 보고서.
  await page.evaluate(
    (id) =>
      localStorage.setItem(
        `vide:workspace:${id}`,
        JSON.stringify({ active: 'report', context: [] }),
      ),
    projectId,
  );
  await page.evaluate((id) => localStorage.setItem(`vide:output-view:${id}`, 'sheet'), projectId);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.workspace === 'output');
  assert.equal(await tab.getAttribute('aria-selected'), 'true');
  assert.equal(
    await views.getByRole('tab', { name: '보고서', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await report.waitFor();

  // Narrow screen: the list stacks above the page without sideways scrolling.
  await page.locator('#workspace-tabs [role="tab"][data-workspace="model"]').click();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.locator('.workspace-menu select').selectOption('output');
  await report.waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 391));

  assert.deepEqual(errors, []);
  console.log('Report tab checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

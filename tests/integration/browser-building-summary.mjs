// 건축개요 jig on screen (PLAN-45 T-213, SPEC-12.13·12.14, Design §14 `jig-source`): one official
// card (J-11) opens an instance; the `jig-source` cards say which 건축 가능 영역·매스 instance the
// 고른 대안 comes from and that no 사이트 모델링 instance exists; the steps compute the overview and
// the 층별 면적표 with their 출처 and the hand-checked totals of the synthetic chain; the in-panel
// report has no refusal; when the mass instance changes, the card says '다시 계산 필요' and the
// first step stops with the reason. The mass instance is seeded through the runtime on the same
// data folder (tests/fixtures/summary-chain.mjs); no host.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { closeJigRuntime, jigRuntimeFor } from '../../src/server/jig-routes.ts';
import { seedMassInstance } from '../fixtures/summary-chain.mjs';

const directory = await mkdtemp(join(tmpdir(), 'vide-building-summary-'));
let app, browser, seeded;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();

  // The 고른 대안 of a computed 건축 가능 영역·매스 instance (same store, same data folder).
  seeded = new Workspace(app.store);
  const runtime = jigRuntimeFor(seeded, directory);
  const massId = await seedMassInstance(runtime, projectId, '매스 A');

  // JIG → the official 건축개요 card (J-11, once) → a new instance.
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  const cards = dialog.locator('.jig-card', { hasText: '건축개요' });
  await cards.first().waitFor();
  assert.equal(await cards.count(), 1, 'one card for J-11');
  const card = cards.first();
  await card.getByRole('button', { name: '새로 열기' }).click();
  await card.getByLabel('출력 레이어').fill('VIDE::개요');
  await card.getByRole('button', { name: '열기', exact: true }).click();
  const panel = dialog.locator('[data-jig-panel="vide/building-summary"]');
  await panel.waitFor();
  const rail = (id, state) =>
    panel.locator(`.kit-rail li[data-step="${id}"]${state ? `[data-state="${state}"]` : ''}`);
  assert.deepEqual(
    await panel.locator('.kit-rail li').evaluateAll((rows) => rows.map((r) => r.dataset.step)),
    ['sources', 'summary', 'check'],
  );
  await rail('check', 'done').waitFor();

  // Where the inputs come from.
  const massCard = panel.locator('.jig-source[aria-label="고른 대안(건축 가능 영역·매스)"]');
  await massCard.locator('.jig-source-current').waitFor();
  assert.match(await massCard.textContent(), /매스 A/);
  assert.equal(await massCard.getAttribute('data-ready'), 'true');
  const siteCard = panel.locator('.jig-source[aria-label="대지 요약(사이트 모델링)"]');
  await siteCard.getByText('앞 jig의 작업본이 없습니다').waitFor();
  assert.equal(await massCard.locator('select option').count(), 2, '(자동) and 매스 A');

  // KPIs and the tables: 연면적 3,050 = 지상 2,450 + 지하 600, nothing out of line.
  const top = page.locator('.kit-slot[data-slot="top"]');
  const kpi = (label) => top.locator(`.kit-kpi[data-kpi="${label}"] .kit-kpi-value`).textContent();
  assert.match(await kpi('연면적'), /^3,?050\.00/);
  assert.match(await kpi('다른 칸'), /^0/);
  assert.match(await top.locator('.kit-report h1').textContent(), /기준 용적률 연면적 3,050.00/);
  const drawer = page.locator('.kit-slot[data-slot="drawer"]');
  const overview = drawer.getByRole('table', { name: '건축개요' });
  await overview.waitFor();
  const text = await overview.textContent();
  for (const word of ['계산', '사람 입력', '사람 입력 필요', '미적용', '87.08 %', '3,050.00 ㎡'])
    assert.ok(text.includes(word), word);
  await drawer.getByRole('tab', { name: /^층별 면적표/ }).click();
  const floors = drawer.getByRole('table', { name: '층별 면적표' });
  assert.equal(await floors.locator('tbody tr').count(), 10, 'B1, 1F~6F and three total rows');
  assert.match(await floors.textContent(), /필로티/);
  assert.ok(await drawer.getByRole('button', { name: 'CSV' }).isVisible());
  // The in-panel report: no refusal, the study note on top.
  const report = top.locator('.kit-report');
  await report.waitFor();
  assert.match(await report.textContent(), /탐색용 규모검토/);
  assert.equal(await report.locator('[data-export-refused]').count(), 0);
  if (process.env.VIDE_SHOT_DIR)
    await page.screenshot({ path: join(process.env.VIDE_SHOT_DIR, 'building-summary.png') });

  // The mass changes: its handed-over result is stale → 다시 계산 필요, and the run says why.
  await runtime.setParams(projectId, massId, {
    values: [{ key: 'trimMethod', value: 'drop-floors' }],
    by: 'user',
  });
  await panel.getByRole('button', { name: '다시 계산' }).click();
  await rail('sources', 'failed').waitFor();
  await massCard.locator('[data-stale-note]').waitFor();
  assert.match(await massCard.textContent(), /다시 계산 필요/);

  assert.deepEqual(errors, []);
  console.log('browser building summary passed');
} finally {
  if (seeded) await closeJigRuntime(seeded);
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

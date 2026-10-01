// 대시보드 › 오늘 (SPEC-01.14, Design SCR-20, PLAN-26 T-098): Enter adds a 할 일 with the date and
// time read from the words ('내일 3시 …' goes under 예정 at 15:00), the box finishes one into the
// '완료 n' fold, a click edits in place, ↑ and drag reorder, and everything survives a reload;
// [완료 비우기] clears the fold. Synthetic project only; no real CLI or host.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-dashboard-agenda-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'data', 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
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
  const openDashboard = () => page.locator('.rail [data-workspace-target="dashboard"]').click();
  await openDashboard();
  const board = page.getByRole('region', { name: '대시보드', exact: true });
  const section = board.getByRole('region', { name: '오늘', exact: true });
  await section.getByText('할 일이 없습니다.').waitFor();
  // The 오늘 section is the first section of the dashboard.
  assert.equal(
    await board.locator('section.dash-section').first().getAttribute('aria-label'),
    '오늘',
  );

  const input = section.getByRole('textbox', { name: '할 일 추가' });
  // The words give the date and time: tomorrow 15:00, under 예정.
  await input.fill('내일 3시 구조 회의');
  await section.getByText('내일 15:00 · 구조 회의').waitFor();
  await input.press('Enter');
  const later = section.getByRole('list', { name: '예정' });
  await later.getByRole('button', { name: '구조 회의', exact: true }).waitFor();
  assert.match(await later.locator('li').first().innerText(), /15:00\s*내일/);
  assert.equal(await input.inputValue(), '');
  for (const text of ['도면 정리', '회의록 검토', '현장 사진 분류']) {
    await input.fill(text);
    await input.press('Enter');
    await section.getByRole('list', { name: '오늘 할 일' }).getByText(text).waitFor();
  }
  const today = section.getByRole('list', { name: '오늘 할 일' });
  const texts = () => today.locator('.dash-agenda-text').allInnerTexts();
  assert.deepEqual(await texts(), ['도면 정리', '회의록 검토', '현장 사진 분류']);

  // ↑ moves one up; a drag moves another to the top.
  await today.getByRole('button', { name: '회의록 검토 위로' }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="오늘 할 일"] .dash-agenda-text')?.textContent ===
      '회의록 검토',
  );
  await today
    .locator('li', { hasText: '현장 사진 분류' })
    .dragTo(today.locator('li', { hasText: '회의록 검토' }));
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="오늘 할 일"] .dash-agenda-text')?.textContent ===
      '현장 사진 분류',
  );
  assert.deepEqual(await texts(), ['현장 사진 분류', '회의록 검토', '도면 정리']);

  // A click edits in place; Enter saves.
  await today.getByRole('button', { name: '도면 정리', exact: true }).click();
  const edit = section.getByRole('textbox', { name: '할 일 고치기' });
  await edit.fill('도면 정리 — 평면도');
  await edit.press('Enter');
  await today.getByRole('button', { name: '도면 정리 — 평면도', exact: true }).waitFor();
  assert.equal(await edit.count(), 0);

  // The box finishes one: it leaves the list for the '완료 1' fold.
  await today.getByRole('checkbox', { name: '회의록 검토 완료' }).click();
  const fold = section.getByRole('button', { name: '완료 1' });
  await fold.waitFor();
  assert.deepEqual(await texts(), ['현장 사진 분류', '도면 정리 — 평면도']);
  if (shot) await page.screenshot({ path: join(shot, 'dashboard-agenda.png') });

  // Everything is kept: a reload shows the same order, the edit and the fold.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await openDashboard();
  await today.getByText('현장 사진 분류').waitFor();
  assert.deepEqual(await texts(), ['현장 사진 분류', '도면 정리 — 평면도']);
  await later.getByRole('button', { name: '구조 회의', exact: true }).waitFor();
  await fold.click();
  const doneList = section.getByRole('list', { name: '완료한 할 일' });
  await doneList.getByText('회의록 검토').waitFor();
  await section.getByRole('button', { name: '완료 비우기' }).click();
  await fold.waitFor({ state: 'detached' });
  // [빼기] removes one.
  await today.getByRole('button', { name: '현장 사진 분류 빼기' }).click();
  await today.getByText('현장 사진 분류').waitFor({ state: 'detached' });
  assert.deepEqual(await texts(), ['도면 정리 — 평면도']);

  assert.deepEqual(errors, []);
  console.log('dashboard agenda browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

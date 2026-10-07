// 마감 일람표 jig in the browser (SPEC-11, Design SCR-28, PLAN-43 T-198): opened from the JIG list;
// 라이브러리 adopts a code and adjusts a layer past its 상한 (warning shown); 실별 배정 pastes a
// synthetic table (a wrong-element code left out and listed) and assigns a code through the picker;
// 납품 출력 shows both tables with the adjusted thickness and the typed 표제, prints only the sheet
// and downloads CSV; 체계 · 기준 shows the code scheme. Synthetic rooms only; no host, no AI.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-finish-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'data', 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
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
  const projectId = await page.locator('#project-picker').inputValue();
  const saved = () =>
    page.evaluate(async (id) => (await fetch(`/api/v1/projects/${id}/finish`)).json(), projectId);
  const settle = async () => {
    await page.waitForFunction(
      () => !document.querySelector('.finish-save')?.textContent?.includes('저장 중'),
    );
    await page.waitForTimeout(800);
    await page.waitForFunction(
      () => !document.querySelector('.finish-save')?.textContent?.includes('저장 중'),
    );
  };

  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  await dialog
    .locator('.jig-card', { hasText: '마감 일람표' })
    .getByRole('button', { name: '열기' })
    .click();
  const jig = page.locator('.finish-jig');
  const tab = (name) => jig.getByRole('tab', { name, exact: true });
  await tab('라이브러리 · 마감 선정').waitFor();
  assert.equal(await tab('라이브러리 · 마감 선정').getAttribute('aria-selected'), 'true');

  // 1. Library: walls by default; adopt W3101 by its card.
  await jig.getByRole('searchbox', { name: '마감 코드 검색' }).fill('W3101');
  await jig.getByRole('button', { name: 'W3101 채택' }).click();
  await jig.locator('.finish-card[data-on="true"]', { hasText: 'W3101' }).waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'finish-library.png') });
  // Floors: open F0103 and set 에폭시 몰탈 above its 상한 (10 mm).
  await jig.getByRole('searchbox', { name: '마감 코드 검색' }).fill('');
  await jig.getByRole('group', { name: '부위' }).getByRole('button', { name: /^바닥/ }).click();
  await jig.getByRole('searchbox', { name: '마감 코드 검색' }).fill('에폭시 몰탈');
  await jig
    .locator('.finish-card', { hasText: 'F0103' })
    .getByRole('button', { name: '상세 · THK' })
    .click();
  const detail = page.getByRole('dialog', { name: 'F0103 상세' });
  await detail.getByRole('spinbutton', { name: '에폭시 몰탈 두께' }).fill('12');
  await detail.getByText(/실무 상한 10mm 초과/).waitFor();
  const drawn = await detail.locator('svg.finish-section').boundingBox();
  assert.ok(drawn.height > 200 && drawn.width > 300, 'the section is drawn at its size');
  if (shot) await page.screenshot({ path: join(shot, 'finish-detail.png') });
  await detail.getByRole('button', { name: '닫기' }).click();
  await jig.locator('.finish-card', { hasText: 'F0103' }).getByText('상한 초과 1').waitFor();
  await settle();
  let state = await saved();
  assert.deepEqual(state.sheet.adopted, ['W3101']);
  assert.deepEqual(state.sheet.thk, { F0103: { 1: 12 } });

  // 2. Rooms: paste two synthetic rooms; a wall code in the floor column is left out.
  await tab('실별 배정').click();
  await jig.getByRole('button', { name: '붙여넣기로 추가' }).click();
  await jig
    .getByRole('textbox', { name: '붙여넣을 표' })
    .fill(
      '층별\t실번호\t실명\t바닥\t벽\t천장\n1층\t101\t합성 로비\tF0103 W3101\tW3101\t\n1층\t102\t합성 창고\tF0001\t\tC0001\n',
    );
  const preview = jig.getByRole('region', { name: '붙여넣기로 추가' });
  await preview.getByText('실 2개를 추가합니다').waitFor();
  await preview.getByRole('list', { name: '넣지 않는 코드' }).getByText(/W3101/).waitFor();
  await preview.getByRole('button', { name: '추가', exact: true }).click();
  await jig.getByText('실 2개를 추가했습니다.').waitFor();
  // A new room, named, with a floor code from the whole library.
  await jig.getByRole('button', { name: '실 추가' }).click();
  await jig.getByRole('textbox', { name: '새 실 실명' }).fill('합성 회의실');
  await jig.getByRole('button', { name: '합성 회의실 바닥 코드 추가' }).click();
  const picker = page.getByRole('dialog', { name: '마감 코드 선택' });
  await picker.getByRole('button', { name: '전체 라이브러리' }).click();
  await picker.getByRole('searchbox', { name: '코드 검색' }).fill('F0002');
  await picker.getByRole('button', { name: 'F0002 배정' }).click();
  await picker.locator('.finish-card[data-on="true"]', { hasText: 'F0002' }).waitFor();
  await picker.getByRole('button', { name: '완료' }).click();
  await jig
    .getByRole('row', { name: /합성 회의실/ })
    .getByRole('button', { name: 'F0002', exact: true })
    .waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'finish-rooms.png') });
  await settle();
  state = await saved();
  assert.deepEqual(
    state.rooms.map((r) => [r.floor, r.no, r.name, r.F, r.W, r.C]),
    [
      ['1층', '101', '합성 로비', ['F0103'], ['W3101'], []],
      ['1층', '102', '합성 창고', ['F0001'], [], ['C0001']],
      ['1층', '', '합성 회의실', ['F0002'], [], []],
    ],
  );
  assert.deepEqual(state.sheet.adopted, ['C0001', 'F0001', 'F0002', 'F0103', 'W3101']);

  // 3. Delivery: 실 마감표, the 표제, 마감 일람표 with the adjusted thickness.
  await tab('납품 출력').click();
  const roomSheet = jig.getByRole('table', { name: '실 마감표' });
  await roomSheet.getByRole('cell', { name: '합성 회의실' }).waitFor();
  assert.ok(await roomSheet.getByRole('cell', { name: 'F0103' }).count());
  await jig.getByRole('textbox', { name: '공사명' }).fill('합성 공사');
  await jig.getByRole('textbox', { name: '도면번호' }).fill('A-901');
  await jig.getByRole('table', { name: '표제' }).getByRole('cell', { name: '합성 공사' }).waitFor();
  await jig.getByRole('button', { name: '마감 일람표', exact: true }).click();
  const codeSheet = jig.getByRole('table', { name: '마감 일람표' });
  const epoxy = codeSheet.getByRole('row', { name: /F0103/ });
  assert.match(await epoxy.textContent(), /에폭시 몰탈.*12.*합성 로비/);
  if (shot) await page.screenshot({ path: join(shot, 'finish-output.png') });
  // [인쇄] prints a copy of the sheet only.
  await page.evaluate(() => {
    window.printed = [];
    window.print = () =>
      window.printed.push([
        document.body.hasAttribute('data-finish-print'),
        document
          .querySelector('.finish-print-root .finish-sheet-table')
          ?.getAttribute('aria-label'),
      ]);
  });
  await jig.getByRole('button', { name: '인쇄' }).click();
  assert.deepEqual(await page.evaluate(() => window.printed), [[true, '마감 일람표']]);
  await page.waitForFunction(() => !document.querySelector('.finish-print-root'));
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    jig.getByRole('button', { name: 'CSV', exact: true }).click(),
  ]);
  assert.equal(download.suggestedFilename(), '마감일람표.csv');
  const csv = await readFile(await download.path(), 'utf8');
  assert.ok(csv.startsWith('﻿"코드","부위"'));
  assert.match(csv, /"F0103","바닥",.*"12",.*"합성 로비"/);
  await settle();
  state = await saved();
  assert.equal(state.sheet.title.project, '합성 공사');
  assert.equal(state.sheet.title.drawingNo, 'A-901');

  // 4. System and reference.
  await tab('체계 · 기준').click();
  await jig.getByRole('heading', { name: '코드 구조' }).waitFor();
  await jig.getByRole('heading', { name: /도막방수 표준 두께/ }).waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'finish-system.png') });

  assert.deepEqual(errors, []);
  console.log('finish jig browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

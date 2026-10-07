// 대시보드 › 프로젝트 폴더 › 도곽 미리보기 (SPEC-14.15, Design SCR-30, PLAN-47 T-235): a folder of
// synthetic drawings is read by 도면 관계, then [도곽 찾기] opens the window: sheets (model tab window,
// layout), candidates that are not sheets until [도곽으로 쓰기], the title block list and the
// project CTB. The preview is a white-paper viewport in plot mode with the CTB's pens (ACI 1 red
// 0.5 mm). The engine runs fake readers; no ZWCAD, no real drawing, no file written.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { fakeXrefReader } from '../fixtures/xref.mjs';
import { fakeSheetsReader, writeSheetsDrawings } from '../fixtures/drawing-sheets.mjs';
import { syntheticCtbText, writeCtb } from '../../src/core/ctb.ts';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-sheets-browser-'));
const folder = join(directory, '2601 합성 도면');
await mkdir(folder);
await writeSheetsDrawings(folder);
await writeFile(
  join(folder, 'project.ctb'),
  writeCtb(
    syntheticCtbText((aci) =>
      aci === 1
        ? { color: String(0xc2ff0000 >> 0), lineweight: 7 }
        : { color: String(0xc2000000 >> 0), lineweight: 255 },
    ),
  ),
);
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'data', 'test.sqlite'),
    xrefReader: fakeXrefReader(),
    sheetsReader: fakeSheetsReader(),
    ctbSupportFolders: async () => [],
    collectOptions: { dwgReader: null },
  });
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
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
  const projectId = await page.locator('#project-picker').inputValue();
  // The folder and the 도면 관계 read through the API (browser-xref.mjs covers that screen).
  await page.evaluate(
    async ({ id, path }) => {
      const post = (url, body) =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      await post(`/api/v1/projects/${id}/folders`, { path });
      await post(`/api/v1/projects/${id}/xref/read`, {});
      for (let i = 0; i < 100; i++) {
        const state = await (await fetch(`/api/v1/projects/${id}/xref`)).json();
        if (state.state !== 'reading') return;
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    { id: projectId, path: folder },
  );
  await page.locator('.rail [data-workspace-target="dashboard"]').click();
  const board = page.getByRole('region', { name: '대시보드', exact: true });
  const more = board.locator('details.dash-more:not([open]) > summary');
  if (await more.count()) await more.click();
  const section = board.getByRole('region', { name: '프로젝트 폴더' });
  const group = section.getByRole('group', { name: '도곽 미리보기' });
  await group.getByText('파일은 쓰지 않습니다').waitFor();
  await group
    .getByRole('combobox', { name: '도곽을 찾을 도면' })
    .selectOption({ label: 'sheets.dwg' });
  await group.getByRole('button', { name: '도곽 찾기' }).click();
  const dialog = page.getByRole('dialog', { name: '도곽 미리보기' });
  await dialog.waitFor();
  const list = dialog.getByRole('list', { name: '시트 목록' });
  await list.getByText('A-401').waitFor();
  const rows = () =>
    list
      .locator('.sheets-row')
      .evaluateAll((items) => items.map((b) => b.querySelector('.sheets-mono').textContent));
  assert.deepEqual(await rows(), ['A-401', 'A-501']);
  await dialog.getByText(/내장 흑백\(monochrome\)/).waitFor();
  // Candidates: not sheets until picked.
  await dialog.getByRole('button', { name: 'TB-A1 도곽으로 쓰기' }).waitFor();
  await dialog.getByRole('button', { name: 'FRAME-A3 도곽으로 쓰기' }).waitFor();
  assert.equal(await dialog.getByText('NOTE-BOX').count(), 0);
  await dialog.getByRole('button', { name: 'TB-A1 도곽으로 쓰기' }).click();
  await list.getByText('A-103').waitFor();
  assert.deepEqual(await rows(), ['A-101', 'A-102', 'A-103', 'A-401', 'A-501']);
  await list.getByText('누락 xref 1').waitFor();
  await dialog.getByLabel('도곽 블록 목록').getByText('TB-A1').waitFor();
  // The project CTB: pens on white paper.
  await dialog
    .getByRole('combobox', { name: '프로젝트 CTB' })
    .selectOption({ label: 'project.ctb · 프로젝트 폴더' });
  await dialog.getByText('CTB: project.ctb · 프로젝트 등록').waitFor();
  await list.getByRole('button', { name: /A-102/ }).click();
  await dialog.locator('.sheets-sheet-head').getByText('평면도 2').waitFor();
  await page.waitForFunction(() => {
    const view = window.videSheetPreview;
    return view && view.colorOf('cad-F1') === '#ff0000';
  });
  const ink = await page.evaluate(() => ({
    red: window.videSheetPreview.colorOf('cad-F1'),
    width: window.videSheetPreview.plotWidthOf('cad-F1'),
    plot: document.querySelector('[data-testid="sheet-preview"] canvas')?.dataset.plot,
    others: window.videSheetPreview.visibleIds(),
  }));
  assert.equal(ink.red, '#ff0000');
  assert.ok(Math.abs(ink.width - 0.5 * 3.78) < 0.01, String(ink.width));
  assert.equal(ink.plot, 'true');
  assert.deepEqual(ink.others, ['cad-F1'], 'only the rows inside the sheet');
  if (shot) await page.screenshot({ path: join(shot, 'drawing-sheets-preview.png') });
  // The xref frame, then a layout sheet.
  await dialog.getByRole('button', { name: 'FRAME-A3 도곽으로 쓰기' }).click();
  await list.getByText('A-201').waitFor();
  await list.getByRole('button', { name: /A-201/ }).click();
  await dialog.locator('.sheets-sheet-head').getByText('문자에서 읽음').waitFor();
  await page.waitForFunction(() => window.videSheetPreview?.visibleIds().includes('x1-cad-C1'));
  await list.getByRole('button', { name: /A-501/ }).click();
  await dialog.locator('.sheets-sheet-head').getByText('배치 시트').waitFor();
  await page.waitForFunction(() => window.videSheetPreview?.visibleIds().includes('cad-P1'));
  // The model screen's diagnostic viewport is not replaced by the preview.
  assert.notEqual(await page.evaluate(() => window.videViewport === window.videSheetPreview), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await group.getByText(/시트 6 · 후보 0/).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true }));
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

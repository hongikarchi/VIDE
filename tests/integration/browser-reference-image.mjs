// Reference-image tab, phase (a) of PLAN-26 T-090 (SPEC-09.2·09.3·09.5): an image attachment's
// [영역 표시] opens '참고 이미지 · <파일>' in the row of open items; brush and rectangle draw regions
// A and B, a note, undo/redo, wheel zoom; the regions are saved by the engine and come back after
// a reload; [이해 확인] saves the flattened input image and shows the board's frame without any AI
// call; closing the tab hides the row. Synthetic image drawn in the page; no real CLI or host.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { runDirectory } from './run-directory.mjs';

const directory = await mkdtemp(join(tmpdir(), 'vide-reference-image-'));
const evidence = runDirectory('reference-image');
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const turns = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/requests$|\/conversations/.test(request.url()))
      turns.push(request.url());
  });
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

  // A synthetic 'facade' (800 x 560) drawn in the page, attached with a text file.
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 560;
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgb(220 226 231)';
    context.fillRect(0, 0, 800, 560);
    context.fillStyle = 'rgb(90 104 112)';
    context.fillRect(140, 70, 520, 400);
    context.fillStyle = 'rgb(176 128 82)';
    for (let x = 146; x <= 650; x += 18) context.fillRect(x, 74, 6, 314);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('#files').setInputFiles([
    { name: 'facade.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') },
    { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('메모') },
  ]);
  const imageChip = page.locator('#context .chip').filter({ hasText: 'facade.png' });
  await imageChip.locator('img.chip-thumb').waitFor();
  const textChip = page.locator('#context .chip').filter({ hasText: 'note.txt' });
  await textChip.waitFor();
  assert.equal(await textChip.getByRole('button', { name: '영역 표시' }).count(), 0);
  const attachmentId = await page.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem('vide:draft:' + id)).files.find(
        (file) => file.name === 'facade.png',
      ).id,
    projectId,
  );
  assert.equal(await page.locator('.workspace-tabs').isVisible(), false, 'nothing open yet');

  // [영역 표시] opens the reference tab in the row of open items.
  await imageChip.getByRole('button', { name: '영역 표시' }).click();
  await page.waitForFunction(() => document.body.dataset.workspace === 'reference');
  const tab = page.locator('.workspace-tablist [role="tab"][aria-selected="true"]');
  assert.equal(await tab.textContent(), '참고 이미지 · facade.png');
  assert.equal(await page.locator('.workspace-tabs').isVisible(), true);
  const stage = page.locator('.reference-stage');
  await page.locator('.reference-stage img').waitFor();
  assert.equal(await page.locator('#viewport, .viewport-area').first().isVisible(), false);
  const picture = async () => page.locator('.reference-stage img').boundingBox();
  let box = await picture();
  // The image is fitted in the stage.
  const stageBox = await stage.boundingBox();
  assert.ok(box.width <= stageBox.width && box.height <= stageBox.height + 1);
  assert.ok(Math.abs(box.width / box.height - 800 / 560) < 0.01);
  assert.equal(await page.getByText('그리면 영역 A가 시작됩니다', { exact: false }).count(), 1);

  // Brush: a stroke across the louvers starts region A.
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  await page.mouse.move(...at(0.55, 0.3));
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(...at(0.55 + k * 0.02, 0.3 + k * 0.03));
  await page.mouse.up();
  const regions = page.locator('.reference-region');
  await regions.first().waitFor();
  assert.deepEqual(await regions.locator('.reference-letter').allTextContents(), ['A']);
  assert.equal(await regions.first().locator('small').textContent(), '붓 1');
  assert.equal(await page.locator('.reference-region-fill[data-region="A"]').count(), 1);

  // A new region and a rectangle: region B.
  await page.getByRole('button', { name: '+ 새 영역' }).click();
  await page.getByRole('button', { name: '사각형', exact: true }).click();
  await page.mouse.move(...at(0.4, 0.75));
  await page.mouse.down();
  await page.mouse.move(...at(0.5, 0.8));
  await page.mouse.move(...at(0.6, 0.85));
  await page.mouse.up();
  assert.deepEqual(await regions.locator('.reference-letter').allTextContents(), ['A', 'B']);
  assert.equal(await regions.nth(1).locator('small').textContent(), '사각형 1');

  // A note on A (one step), then undo/redo with the keyboard.
  const noteA = page.getByLabel('영역 A 메모');
  await noteA.fill('루버 간격과 깊이만');
  await noteA.press('Enter');
  await page.keyboard.press('Control+z');
  assert.equal(await noteA.inputValue(), '');
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await noteA.inputValue(), '루버 간격과 깊이만');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  assert.equal(await regions.nth(1).locator('small').textContent(), '아직 그리지 않음');
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+y');
  assert.equal(await regions.nth(1).locator('small').textContent(), '사각형 1');
  assert.equal(await noteA.inputValue(), '루버 간격과 깊이만');

  // Wheel zoom about the pointer, then fit again.
  const zoom = page.locator('.reference-zoom');
  const before = await zoom.textContent();
  await page.mouse.move(...at(0.5, 0.5));
  await page.mouse.wheel(0, -400);
  await page.waitForFunction(
    (value) => document.querySelector('.reference-zoom').textContent !== value,
    before,
  );
  await page.getByRole('button', { name: '맞춤' }).click();
  await page.waitForFunction(
    (value) => document.querySelector('.reference-zoom').textContent === value,
    before,
  );
  await page.screenshot({ path: join(evidence, 'reference-editor-1440.png') });

  // Saved by the engine as vector shapes.
  await page.waitForFunction(
    () => document.querySelector('.reference-status')?.textContent === '저장됨',
  );
  const saved = await page.evaluate(
    async ([project, id]) =>
      (await fetch(`api/v1/projects/${project}/reference-boards/${id}`)).json(),
    [projectId, attachmentId],
  );
  assert.deepEqual(
    saved.regions.map((region) => [region.letter, region.note, region.shapes.map((s) => s.kind)]),
    [
      ['A', '루버 간격과 깊이만', ['brush']],
      ['B', '', ['rect']],
    ],
  );
  assert.equal(saved.width, 800);
  assert.ok(saved.regions[0].shapes[0].points.every((value) => value >= 0 && value <= 1));

  // A reload comes back to the same tab with the regions.
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.workspace === 'reference');
  await page.locator('.reference-region').nth(1).waitFor();
  assert.equal(await page.getByLabel('영역 A 메모').inputValue(), '루버 간격과 깊이만');
  assert.equal(await page.locator('.reference-region-fill').count(), 2);

  // [이해 확인]: no AI in this phase; the board's frame and the flattened input image.
  const check = page.getByRole('button', { name: '이해 확인' });
  assert.match(await check.getAttribute('title'), /해석은 다음 단계에서 연결됩니다/);
  await check.click();
  await page.locator('.reference-board').waitFor();
  assert.equal(await tab.textContent(), '이해 확인 · facade.png');
  for (const text of ['해석 대기', '아직 없음', '아직 해석이 없습니다'])
    assert.ok((await page.locator('.reference-board').textContent()).includes(text), text);
  await page.waitForFunction(() =>
    document.querySelector('.reference-caption')?.textContent.includes('입력 이미지 저장됨'),
  );
  const masked = await page.evaluate(
    async ([project, id]) => {
      const response = await fetch(`api/v1/projects/${project}/reference-boards/${id}/masked`);
      const bitmap = await createImageBitmap(await response.blob());
      return [response.status, bitmap.width, bitmap.height];
    },
    [projectId, attachmentId],
  );
  assert.deepEqual(masked, [200, 800, 560]);
  // Kept with the run for a look at the flattened image (image + regions + letters).
  const flat = await page.evaluate(
    async ([project, id]) => {
      const response = await fetch(`api/v1/projects/${project}/reference-boards/${id}/masked`);
      return btoa(String.fromCharCode(...new Uint8Array(await response.arrayBuffer())));
    },
    [projectId, attachmentId],
  );
  await writeFile(join(evidence, 'reference-masked-input.png'), Buffer.from(flat, 'base64'));
  assert.equal(turns.length, 0, 'no turn was sent');
  await page.screenshot({ path: join(evidence, 'reference-board-1440.png') });
  // Dark theme: the same board with the dark tokens.
  await page.locator('#rail-theme').click();
  await page.screenshot({ path: join(evidence, 'reference-board-dark.png') });
  await page.locator('#rail-theme').click();

  // Closing the tab: the model shows and the row hides; the chip opens the board again.
  await page.locator('.workspace-tablist .workspace-tab-close').click();
  await page.waitForFunction(() => document.body.dataset.workspace === 'model');
  assert.equal(await page.locator('.workspace-tabs').isVisible(), false);
  await page
    .locator('#context .chip')
    .filter({ hasText: 'facade.png' })
    .getByRole('button', { name: '영역 표시' })
    .click();
  await page.locator('.reference-board').waitFor();
  assert.equal(await tab.textContent(), '이해 확인 · facade.png');
  await page.getByRole('button', { name: '영역 고치기' }).click();
  await page.locator('.reference-editor').waitFor();
  assert.equal(await tab.textContent(), '참고 이미지 · facade.png');
  // 900 px wide: the editor still fits beside the conversation.
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(200);
  box = await picture();
  const narrow = await stage.boundingBox();
  assert.ok(box.width > 100 && box.width <= narrow.width);
  await page.screenshot({ path: join(evidence, 'reference-editor-900.png') });
  await page
    .locator('.workspace-tablist .workspace-tab-close')
    .click()
    .catch(async () => {
      await page.locator('.workspace-menu .workspace-tab-close').click();
    });
  await page.waitForFunction(() => document.body.dataset.workspace === 'model');

  assert.deepEqual(errors, []);
  console.log('browser-reference-image: ok');
} finally {
  await browser?.close();
  await app?.close?.();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

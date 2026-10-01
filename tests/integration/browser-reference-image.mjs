// Reference-image tab, PLAN-26 T-090 (SPEC-09): an image attachment's
// [영역 표시] opens '참고 이미지 · <파일>' in the row of open items; brush and rectangle draw regions
// A and B, a note, undo/redo, wheel zoom; the regions are saved by the engine and come back after
// a reload; [이해 확인] saves the flattened input image and sends the turn: the board fills from a
// mocked provider's interpretation (two bubbles, apart), the image placeholder becomes the picture,
// clicking bubble B sends a correction of B only (판 2), and [맞음] asks B's unknown target first,
// then sends a 자동 turn even in 계획; closing the tab hides the row. Synthetic image drawn in the
// page; no real CLI or host.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { runDirectory } from './run-directory.mjs';

const directory = await mkdtemp(join(tmpdir(), 'vide-reference-image-'));
const evidence = runDirectory('reference-image');
let app, browser, png;
// The test puts a view capture in place (no model is open in the page); later turns go without.
let forceView = true;
const answers = [];
const contexts = [];
const sent = [];
try {
  // A mocked provider answers from `answers`; the image job is a fake that takes a moment.
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    providerFactory: () => ({
      status: async () => ({ available: true }),
      run: async (context) => {
        contexts.push(context);
        const next = answers.shift() ?? {
          status: 'done',
          text: '네',
          questions: [],
          reference: null,
        };
        return { text: JSON.stringify(next) };
      },
    }),
    referenceOptions: {
      runImage: async (job) => {
        await new Promise((done) => setTimeout(done, 1500));
        await writeFile(job.outFile, Buffer.from(png, 'base64'));
        return { ok: true, elapsedMs: 1500, size: 1 };
      },
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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

  // A synthetic 'facade' (800 x 560) drawn in the page, attached with a text file.
  png = await page.evaluate(() => {
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

  // [이해 확인] (T-090 (b)): the flattened input image is saved and the turn goes to the chosen
  // conversation's AI (a mocked provider). A view capture is put in place by the test (no model
  // is open in this page): the request is marked as having one.
  await page.evaluate(
    async ([project, id, bytes]) =>
      fetch(`api/v1/projects/${project}/reference-boards/${id}/view`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)),
      }),
    [projectId, attachmentId, png],
  );
  await page.route('**/api/v1/projects/*/requests', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    const input = request.postDataJSON();
    sent.push(input);
    if (forceView && ['interpret', 'region'].includes(input.reference?.action))
      input.reference.view = true;
    await route.continue({ postData: JSON.stringify(input) });
  });
  answers.push({
    status: 'done',
    text: 'A는 2~5층 전면의 수직 루버, B는 입구 위 얇은 차양으로 이해했습니다.',
    questions: [],
    reference: {
      summary: '남측 파사드 전면에 수직 루버를 약 600 간격으로',
      imagePrompt: 'Vertical timber louvers about 600 mm apart on the front facade.',
      regions: [
        {
          letter: 'A',
          element: '수직 루버',
          anchor: { x: 0.62, y: 0.4 },
          values: [
            { name: '간격', value: '약 600', unit: 'mm', source: 'estimated' },
            { name: '깊이', value: '300', unit: 'mm', source: 'user' },
          ],
          line: 'A: 수직 루버 · 간격 약 600 · 깊이 300',
          openQuestions: ['끝 처리', '재료'],
          target: '남측 파사드',
        },
        {
          letter: 'B',
          element: '입구 차양',
          anchor: null,
          values: [{ name: '길이', value: '약 4', unit: 'm', source: 'estimated' }],
          line: 'B: 입구 차양 · 길이 약 4 m',
          openQuestions: [],
          target: 'unknown',
        },
      ],
    },
  });
  // The composer's model is the conversation's AI; the test's catalog has one model.
  await page.locator('#model').selectOption('codex-cli');
  const check = page.getByRole('button', { name: '이해 확인' });
  assert.match(await check.getAttribute('title'), /지금 대화의 AI에 이미지와 영역을 보냅니다/);
  await check.click();
  await page.locator('.reference-board').waitFor();
  assert.equal(await tab.textContent(), '이해 확인 · facade.png');
  await page.locator('.reference-bubble').nth(1).waitFor();
  const interpret = sent.find((input) => input.reference?.action === 'interpret');
  assert.equal(interpret.mode, 'plan');
  assert.equal(interpret.images.length, 1);
  assert.match(interpret.images[0].dataUrl, /^data:image\/jpeg;base64,/);
  assert.deepEqual(interpret.files, [{ id: attachmentId, name: 'facade.png' }]);
  const firstContext = contexts[0];
  assert.deepEqual(
    firstContext.items
      .find((item) => item.type === 'reference-board')
      .data.regions.map((r) => [r.letter, r.note]),
    [
      ['A', '루버 간격과 깊이만'],
      ['B', ''],
    ],
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
  // Bubbles: two, apart, the image placeholder then the picture.
  const bubbles = page.locator('.reference-bubble');
  assert.deepEqual(await bubbles.evaluateAll((nodes) => nodes.map((n) => n.dataset.letter)), [
    'A',
    'B',
  ]);
  const [boxA, boxB] = [await bubbles.nth(0).boundingBox(), await bubbles.nth(1).boundingBox()];
  const apart =
    boxA.x + boxA.width <= boxB.x ||
    boxB.x + boxB.width <= boxA.x ||
    boxA.y + boxA.height <= boxB.y ||
    boxB.y + boxB.height <= boxA.y;
  assert.ok(apart, 'bubbles do not overlap');
  assert.equal(await page.locator('.reference-leaders line').count(), 2);
  await page.locator('[data-image="running"]').waitFor();
  assert.ok(
    (await page.locator('[data-image="running"]').textContent()).includes('생성 중'),
    'the placeholder while the image job runs',
  );
  await page.screenshot({ path: join(evidence, 'reference-board-generating.png') });
  await page.locator('[data-image="ready"] img').waitFor({ timeout: 15000 });
  assert.match(
    await page.locator('.reference-pane').nth(1).locator('.reference-caption').textContent(),
    /걸린 시간 \d+초/,
  );
  const rows = page.locator('.reference-values tbody tr');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).textContent(), /간격 약 600 mm추정.*깊이 300 mm사용자/);
  assert.match(await rows.nth(1).textContent(), /모름/);
  await page.locator('.reference-states [data-on]').filter({ hasText: '이미지 준비' }).waitFor();
  await page.screenshot({ path: join(evidence, 'reference-board-filled-1440.png') });

  // Clicking bubble B: a one-line correction re-reads B only, as the next 판.
  answers.push({
    status: 'done',
    text: 'B를 얇은 캐노피로 고쳤습니다.',
    questions: [],
    reference: {
      summary: '남측 파사드에 수직 루버, 입구에 얇은 캐노피',
      imagePrompt: 'Vertical louvers and a thin entrance canopy.',
      regions: [
        {
          letter: 'B',
          element: '얇은 캐노피',
          anchor: null,
          values: [{ name: '두께', value: '100', unit: 'mm', source: 'user' }],
          line: 'B: 얇은 캐노피 · 두께 100',
          openQuestions: [],
          target: 'unknown',
        },
      ],
    },
  });
  await bubbles.nth(1).locator('.reference-bubble-body').click();
  await page.getByLabel('영역 B 고칠 내용').fill('차양이 아니라 두께 100 캐노피');
  await page.getByRole('button', { name: '이 영역만 다시' }).click();
  await page.locator('.reference-chip').filter({ hasText: '판 2' }).waitFor();
  const region = sent.find((input) => input.reference?.action === 'region');
  assert.deepEqual(
    [region.reference.letter, region.reference.note],
    ['B', '차양이 아니라 두께 100 캐노피'],
  );
  assert.equal(contexts[1].items.find((item) => item.type === 'reference-board').data.letter, 'B');
  await page.locator('.reference-bubble[data-letter="B"][data-changed]').waitFor();
  assert.equal(await page.locator('.reference-bubble[data-letter="A"][data-changed]').count(), 0);
  assert.match(await bubbles.nth(1).textContent(), /얇은 캐노피/);
  assert.match(await bubbles.nth(0).textContent(), /수직 루버/);
  await page.locator('[data-image="ready"] img').waitFor({ timeout: 15000 });

  // [맞음]: B's target is unknown, so a question card first; then a 자동 turn even in 계획.
  await page.locator('#mode-toggle [data-mode="plan"]').click();
  await page.getByRole('button', { name: '맞음 → 모델링 반영' }).click();
  await page.locator('.reference-targets .qcard').waitFor();
  assert.match(await page.locator('.reference-targets').textContent(), /영역 B\(얇은 캐노피\)/);
  await page.getByRole('button', { name: '이 답으로 진행' }).click();
  await page.locator('.reference-confirm .reference-chip').filter({ hasText: '확정' }).waitFor();
  const confirm = sent.find((input) => input.reference?.action === 'confirm');
  assert.deepEqual(confirm.reference.targets, { B: '새 레이어에 따로 만들기' });
  assert.equal(confirm.reference.version, 2);
  // SPEC-09.8 3: the reference with its regions, the last generated image and the original.
  assert.deepEqual(
    confirm.images.map((image) => image.name),
    ['영역을 그린 참고 이미지', '생성 이미지 · 판 2'],
  );
  assert.deepEqual(confirm.files, [{ id: attachmentId, name: 'facade.png' }]);
  assert.ok(JSON.stringify(confirm).length < 190_000, 'the request stays under 200 KB');
  const stored = await page.evaluate(
    async ([project, id]) => (await fetch(`api/v1/projects/${project}/requests/${id}`)).json(),
    [projectId, confirm.id],
  );
  assert.equal(stored.input.mode, 'auto');
  assert.match(stored.input.body, /맞음 → 모델링 반영 · 판 2/);
  assert.equal(await page.getByRole('button', { name: '새 판으로 고치기' }).count(), 1);
  await page.screenshot({ path: join(evidence, 'reference-board-confirmed-1440.png') });
  // Dark theme: the same board with the dark tokens.
  await page.locator('#rail-theme').click();
  await page.screenshot({ path: join(evidence, 'reference-board-dark.png') });
  await page.locator('#rail-theme').click();
  await page.locator('#mode-toggle [data-mode="auto"]').click();

  // [새 판으로 고치기] → 판 3; a correction sent with no model on screen makes 판 4 without an
  // image job: '연결된 모델이 없어 만들지 않음' and the state line at 말풍선 준비.
  await page.getByRole('button', { name: '새 판으로 고치기' }).click();
  await page.locator('.reference-chip').filter({ hasText: '판 3' }).waitFor();
  forceView = false;
  answers.push({
    status: 'done',
    text: 'A의 깊이를 300으로 고쳤습니다.',
    questions: [],
    reference: {
      summary: '남측 파사드에 수직 루버, 입구에 얇은 캐노피',
      imagePrompt: 'Vertical louvers 300 deep.',
      regions: [
        {
          letter: 'A',
          element: '수직 루버',
          anchor: { x: 0.62, y: 0.4 },
          values: [{ name: '깊이', value: '300', unit: 'mm', source: 'user' }],
          line: 'A: 수직 루버 · 깊이 300',
          openQuestions: [],
          target: '남측 파사드',
        },
      ],
    },
  });
  await bubbles.nth(0).locator('.reference-bubble-body').click();
  await page.getByLabel('영역 A 고칠 내용').fill('깊이 300');
  await page.getByRole('button', { name: '이 영역만 다시' }).click();
  await page.locator('.reference-chip').filter({ hasText: '판 4' }).waitFor();
  await page.locator('[data-image="no-model"]').waitFor();
  assert.match(
    await page.locator('[data-image="no-model"]').textContent(),
    /연결된 모델이 없어 만들지 않음/,
  );
  await page.locator('.reference-states [data-on]').filter({ hasText: '말풍선 준비' }).waitFor();
  // A correction whose answer has no interpretation: that region can be sent again, alone.
  answers.push({ status: 'done', text: '말로만 답합니다', questions: [] });
  await bubbles.nth(0).locator('.reference-bubble-body').click();
  await page.getByLabel('영역 A 고칠 내용').fill('간격 450');
  await page.getByRole('button', { name: '이 영역만 다시' }).click();
  const problem = page.locator('.reference-problem');
  await problem.waitFor();
  assert.match(await problem.textContent(), /영역 A 고치기에 실패했습니다/);
  assert.equal(await problem.getByRole('button', { name: 'A만 다시' }).count(), 1);
  assert.equal(await problem.getByRole('button', { name: '다시 확인' }).count(), 0);
  await page.screenshot({ path: join(evidence, 'reference-board-region-problem.png') });

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

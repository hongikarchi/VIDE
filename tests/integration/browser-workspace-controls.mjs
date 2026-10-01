import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { runDirectory } from './run-directory.mjs';
const directory = await mkdtemp(join(tmpdir(), 'vide-controls-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [
        {
          id: 'test-model',
          name: 'Test model',
          provider: 'codex-cli',
          efforts: ['default', 'low', 'high'],
        },
        { id: 'claude-cli', name: 'Default', provider: 'claude-cli', efforts: ['default'] },
      ],
    }),
  );
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/host', (route) =>
    route.fulfill({ json: { available: false, zwcadAvailable: true } }),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  assert.equal(await page.locator('#add-request').isDisabled(), true);
  // The paperclip is a plain button now: no menu, no object or linked-target items (SPEC-01.12).
  assert.equal(await page.locator('#attach-menu').count(), 0);
  assert.equal(await page.locator('#pin, #inspect-selection, #draw, #linked-targets').count(), 0);
  assert.match(await page.locator('#host-status').textContent(), /ZWCAD 실행 준비/);
  await page.locator('#model').selectOption('test-model');
  await page.locator('#effort-menu summary').click();
  await page.locator('#effort').focus();
  await page.keyboard.press('End');
  assert.equal(await page.locator('#effort-label').textContent(), 'high');
  await page.locator('#effort-menu summary').click();
  await page.locator('#model').selectOption('claude-cli');
  assert.equal(await page.locator('#effort').isDisabled(), true);
  assert.equal(await page.locator('#effort-label').textContent(), '기본값');
  await page.locator('#workspace-settings').click();
  const settings = page.getByRole('dialog', { name: '상태 및 설정', exact: true });
  // Settings are tabs: account, AI, connected programs, (PC program), status.
  await settings.getByRole('button', { name: 'AI', exact: true }).click();
  assert.equal(await settings.getByRole('button', { name: 'AI 연결 설정' }).isVisible(), true);
  await settings.getByRole('button', { name: 'AI 연결 설정' }).click();
  const aiSettings = page.getByRole('dialog', { name: 'AI 연결 설정', exact: true });
  await aiSettings.waitFor();
  await aiSettings.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('#workspace-settings').click();
  await settings.getByRole('button', { name: '계정 · 원격 접속', exact: true }).click();
  // VIDE account login: typed values survive the panel's status polling; password can be shown.
  await settings.getByLabel('아이디', { exact: true }).fill('studio');
  await settings.getByLabel('비밀번호', { exact: true }).fill('secret-pass');
  await page.waitForTimeout(3500);
  assert.equal(await settings.getByLabel('아이디', { exact: true }).inputValue(), 'studio');
  assert.equal(await settings.getByLabel('비밀번호', { exact: true }).inputValue(), 'secret-pass');
  await settings.getByRole('button', { name: '비밀번호 보기' }).click();
  assert.equal(await settings.getByLabel('비밀번호', { exact: true }).getAttribute('type'), 'text');
  await settings.getByRole('button', { name: '닫기', exact: true }).click();
  assert.equal(
    await page.locator('#workspace-settings').evaluate((node) => node === document.activeElement),
    true,
  );
  const originalHeight = (await page.locator('#body').boundingBox()).height;
  const handle = await page.locator('#composer-resize').boundingBox();
  await page.mouse.move(handle.x + 30, handle.y + 4);
  await page.mouse.down();
  await page.mouse.move(handle.x + 30, handle.y - 76);
  await page.mouse.up();
  assert.equal((await page.locator('#body').boundingBox()).height, originalHeight + 80);
  await page.locator('#composer-resize').focus();
  await page.keyboard.press('Home');
  assert.equal((await page.locator('#body').boundingBox()).height, 96);
  await page.locator('[data-view="axon"]').click();
  const canvas = page.locator('#canvas canvas');
  const canvasBox = await canvas.boundingBox();
  const x = canvasBox.x + canvasBox.width / 2,
    y = canvasBox.y + canvasBox.height / 2;
  const initialCamera = await canvas.screenshot();
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x + 75, y + 30, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-view="axon"]').getAttribute('aria-pressed'), 'false');
  assert.notDeepEqual(await canvas.screenshot(), initialCamera);
  await page.locator('[data-view="axon"]').click();
  await page.waitForTimeout(500);
  const beforePan = await canvas.screenshot();
  await page.keyboard.down('Shift');
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x + 75, y + 30, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Shift');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-view="axon"]').getAttribute('aria-pressed'), 'true');
  assert.notDeepEqual(await canvas.screenshot(), beforePan);
  // Drafts save automatically per project (no manual save/load menu): a reload restores them.
  await page.locator('#body').fill('Saved draft');
  // The work mode toggle (계획 / 자동) replaced the permission select: 자동 is the default, the
  // choice is remembered per project, Shift+Tab switches it, and no candidate/apply menu is left.
  assert.equal(await page.locator('#permission').count(), 0);
  const modeButton = (value) => page.locator(`#mode-toggle [data-mode="${value}"]`);
  assert.equal(await modeButton('auto').getAttribute('aria-checked'), 'true');
  assert.match(await page.locator('#mode-status').textContent(), /자동/);
  await modeButton('plan').click();
  assert.equal(await modeButton('plan').getAttribute('aria-checked'), 'true');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#body')?.value === 'Saved draft');
  assert.equal(await modeButton('plan').getAttribute('aria-checked'), 'true');
  await page.locator('#body').focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await modeButton('auto').getAttribute('aria-checked'), 'true');
  assert.match(await page.locator('#mode-status').textContent(), /자동/);
  assert.equal(await page.locator('#draft-menu').count(), 0);
  assert.equal(await page.locator('#quit-app').count(), 0);
  await page.locator('[data-tool="sketch"]').click();
  await page.locator('#cancel-sketch').click();
  await page.locator('[data-view="plan"]').click();
  assert.equal(await page.locator('[data-view="plan"]').getAttribute('aria-pressed'), 'true');
  assert.equal(
    await page.locator('#projection-toggle').getAttribute('aria-label'),
    '원근 투영으로 전환',
  );
  await page.locator('#projection-toggle').click();
  assert.equal(await page.locator('[data-view="plan"]').getAttribute('aria-pressed'), 'false');
  assert.equal(
    await page.locator('#projection-toggle').getAttribute('aria-label'),
    '평행 투영으로 전환',
  );
  await page.locator('[data-view="front"]').click();
  assert.equal(
    await page.locator('#canvas canvas').getAttribute('data-projection'),
    'orthographic',
  );
  const orthoBefore = await canvas.screenshot();
  await page.keyboard.down('Shift');
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x + 60, y + 20, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Shift');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-view="front"]').getAttribute('aria-pressed'), 'true');
  assert.notDeepEqual(await canvas.screenshot(), orthoBefore);
  await page.locator('[data-section="task-list"]').click();
  assert.equal(await page.locator('#document-tree').isVisible(), false);
  assert.equal(await page.locator('#task-list').isVisible(), true);
  assert.equal(await page.locator('#review-list').isVisible(), true);
  // The attached files show with the history; the rail's 자료 opens the 자료 screen (project DB).
  assert.equal(await page.locator('#reference-list').isVisible(), true);
  await page.getByRole('button', { name: '자료', exact: true }).click();
  const railPressed = (id) =>
    page.locator(`.rail [data-workspace-target="${id}"]`).getAttribute('aria-pressed');
  assert.equal(await railPressed('data'), 'true');
  await page.locator('.facts-workspace').waitFor();
  // The rail's 대시보드 opens the dashboard.
  await page.getByRole('button', { name: '대시보드', exact: true }).click();
  assert.equal(await railPressed('dashboard'), 'true');
  await page.getByRole('region', { name: '대시보드' }).getByRole('heading', { level: 2 }).waitFor();
  // Feedback: a small dialog; the form address is not set yet, so its open button is disabled.
  await page.getByRole('button', { name: '피드백 보내기', exact: true }).click();
  const feedback = page.getByRole('dialog', { name: '피드백 보내기', exact: true });
  await feedback.waitFor();
  assert.match(await feedback.textContent(), /주소가 아직 설정되지 않았습니다/);
  assert.equal(await feedback.getByRole('button', { name: '구글폼 열기' }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await feedback.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '피드백 보내기', exact: true }).click();
  await feedback.waitFor();
  await page.mouse.click(10, 450);
  await feedback.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '피드백 보내기', exact: true }).click();
  await feedback.getByRole('button', { name: '닫기', exact: true }).click();
  await feedback.waitFor({ state: 'detached' });
  // The theme toggle: light by default, dark on a click (the 3D view's auto background too).
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  assert.equal(await theme(), 'light');
  await page.getByRole('button', { name: '다크 테마로 전환', exact: true }).click();
  assert.equal(await theme(), 'dark');
  assert.equal(await page.locator('#canvas canvas').getAttribute('data-background'), 'dark');
  assert.equal(
    await page.getByRole('button', { name: '라이트 테마로 전환', exact: true }).isVisible(),
    true,
  );
  assert.equal(await page.locator('#body').inputValue(), 'Saved draft');
  await page.locator('[data-section="document-tree"]').click();
  const before = (await page.locator('#left').boundingBox()).width;
  await page.getByRole('separator', { name: '문서 패널 너비' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal((await page.locator('#left').boundingBox()).width, before + 16);
  const right = await page.getByRole('separator', { name: '대화 패널 너비' }).boundingBox();
  await page.mouse.move(right.x + 3, right.y + 100);
  await page.mouse.down();
  await page.mouse.move(right.x - 30, right.y + 100);
  await page.mouse.up();
  assert.ok((await page.locator('#right').boundingBox()).width > 370);
  assert.ok((await page.locator('.workspace').boundingBox()).width >= 260);
  // The paperclip opens the file picker at once; any type goes, kept by the engine (SPEC-01.12).
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#attach-file').click(),
  ]);
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles([
    { name: 'valid.txt', mimeType: 'text/plain', buffer: Buffer.from('valid') },
    { name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%test') },
    {
      name: 'model.3dm',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('3D Geometry File Format       \u0000\u0001'),
    },
  ]);
  await page.waitForFunction(() =>
    ['valid.txt', 'plan.pdf', 'model.3dm'].every((name) =>
      document.querySelector('#context').textContent.includes(name),
    ),
  );
  // A batch over the limits is refused whole (here: more than 20 files in one request).
  await page.locator('#files').setInputFiles(
    Array.from({ length: 18 }, (_, i) => ({
      name: `note-${i}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('note ' + i),
    })),
  );
  await page.waitForFunction(() => document.querySelector('#message').textContent.includes('20개'));
  assert.equal(await page.locator('#context .chip').filter({ hasText: 'note-0.txt' }).count(), 0);
  // A pasted image becomes an attachment with a small preview served by the engine.
  await page.locator('#body').focus();
  await page.evaluate((png) => {
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    document
      .querySelector('#body')
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
  }, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
  const thumb = page.locator('#context .chip').filter({ hasText: 'pasted.png' }).locator('img');
  await thumb.waitFor();
  await page.waitForFunction(
    () => document.querySelector('#context .chip img.chip-thumb')?.naturalWidth === 1,
  );
  const attached = await page.evaluate(async () => {
    const id = document.querySelector('#project-picker').value;
    return JSON.parse(localStorage.getItem('vide:draft:' + id)).files;
  });
  assert.deepEqual(
    attached.map((file) => [file.name, file.kind, file.copied, 'text' in file]),
    [
      ['valid.txt', 'text', true, false],
      ['plan.pdf', 'pdf', true, false],
      ['model.3dm', 'rhino-3dm', true, false],
      ['pasted.png', 'image', true, false],
    ],
  );
  assert.ok(attached.every((file) => /^[0-9a-f]{24}$/.test(file.id) && file.path));
  const evidence = runDirectory('ui-audit');
  await page.screenshot({ path: join(evidence, 'controls-1440.png') });
  await page.locator('#model').selectOption('test-model');
  await page.locator('#effort-menu summary').click();
  await page.screenshot({ path: join(evidence, 'effort-1440.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#effort-menu').getAttribute('open'), null);
  await page.locator('#workspace-settings').click();
  await page.screenshot({ path: join(evidence, 'settings-1440.png') });
  await settings.getByRole('button', { name: '닫기', exact: true }).click();
  await page.setViewportSize({ width: 800, height: 900 });
  await page.locator('button[data-mobile="model"]').click();
  // Below 900 px the workspace row is one menu over the centre (Design §03); below 850 px it
  // offers the fixed screens, as the rail is gone.
  assert.equal(await page.getByRole('tablist', { name: '작업공간' }).isVisible(), false);
  assert.equal(await page.getByRole('combobox', { name: '작업공간' }).inputValue(), 'model');
  await page.locator('#toggle-left').click();
  await page.locator('.left-panel-tabs').getByRole('button', { name: '작업 이력' }).click();
  assert.equal(await page.locator('#review-list').isVisible(), true);
  await page.screenshot({ path: join(evidence, 'controls-800.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  const project = await page.locator('#project-picker').inputValue();
  for (const id of ['basis-one', 'basis-two', 'failed-sync']) {
    const input = {
      id,
      body: id,
      pins: [],
      sketches: [],
      files: [],
      host: 'rhino',
      provider: 'codex-cli',
      model: 'test-model',
      effort: 'high',
      permission: 'candidate',
    };
    const result = {
      hostExecuted: true,
      executionMode: 'sdk',
      host: 'rhino',
      objects:
        id === 'basis-one' ? [{ id: 'native-block', name: 'Preserved block', kind: 'native' }] : [],
      scene:
        id === 'basis-one'
          ? [{ id: 'native-block', nativeType: 'InstanceReference', nativeId: 'block-guid' }]
          : [],
      displayCoverage:
        id === 'basis-one'
          ? { total: 1, displayed: 0, omitted: 1, omittedTypes: { InstanceReference: 1 } }
          : { total: 0, displayed: 0, omitted: 0, omittedTypes: {} },
    };
    app.store.db
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        id,
        project,
        JSON.stringify(input),
        id === 'failed-sync' ? 'failed' : 'succeeded',
        JSON.stringify(
          id === 'failed-sync' ? { code: 'IMPORT_LIMIT', hostExecuted: false } : result,
        ),
        new Date().toISOString(),
      );
  }
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  // The chosen theme comes back after a reload; the toggle switches back to light.
  assert.equal(await theme(), 'dark');
  await page.getByRole('button', { name: '라이트 테마로 전환', exact: true }).click();
  assert.equal(await theme(), 'light');
  assert.equal(await page.evaluate(() => localStorage.getItem('vide:theme')), 'light');
  await page.getByRole('button', { name: '오류 기록', exact: true }).click();
  await settings
    .locator('.problem-list li')
    .filter({ hasText: 'IMPORT_LIMIT' })
    .getByRole('button', { name: '작업 보기', exact: true })
    .click();
  assert.equal(await settings.isVisible(), false);
  assert.equal(await page.locator('[data-request-id="failed-sync"]').isVisible(), true);
  // Linked targets open from the composer's target chip, not from the paperclip (SPEC-01.12 5).
  await page.locator('#context button.target-file').click();
  const linking = page.getByRole('dialog', { name: '연계 대상', exact: true });
  await linking.getByLabel('연계 대상 1', { exact: true }).selectOption('basis-one');
  await linking.getByLabel('연계 대상 2', { exact: true }).selectOption('basis-two');
  // The coordinate question defaults to "different or unknown (AI aligns)"; choose "same".
  await linking.getByRole('radio', { name: /원점과 축이 같음/ }).check();
  await linking.getByRole('button', { name: '요청에 첨부', exact: true }).click();
  const linkedChip = page.locator('#context .chip').filter({ hasText: '연계 묶음' });
  assert.match(await linkedChip.textContent(), /basis-one.*basis-two/);
  await linkedChip.getByRole('button').click();
  assert.equal(await page.locator('#context .chip').filter({ hasText: '연계 묶음' }).count(), 0);
  // The work history lists the requests; a row opens that work on the right.
  const openWork = async (id) => {
    await page.locator('button[data-section="task-list"]').click();
    await page.locator(`[data-task-id="${id}"] .task-open`).click();
  };
  await openWork('basis-one');
  const card = page.locator('.work-view[data-request-id="basis-one"]');
  assert.match(await card.textContent(), /1개는 목록·네이티브 파일에 보존 · 화면 표현 미지원/);
  await card.getByRole('button', { name: '이 후보 보기', exact: true }).click();
  await page.getByRole('button', { name: '모델 표시 상태', exact: true }).click();
  assert.match(await settings.textContent(), /전체 1개 · 화면 표시 0개 · 표현 미지원 1개/);
  assert.match(await settings.textContent(), /InstanceReference 1개/);
  await settings.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('button[data-section="document-tree"]').click();
  // The layer list starts collapsed; a layer row opens its objects.
  await page.locator('#objects .layer-row').first().click();
  await page
    .locator('#objects')
    .getByRole('button', { name: 'Preserved block', exact: true })
    .click();
  await page.locator('#inspector-toggle').click();
  await page.waitForFunction(() =>
    document
      .querySelector('#inspector-content')
      .textContent.includes('미지원 · 목록·네이티브 파일에 보존'),
  );
  await openWork('basis-two');
  await page
    .locator('.work-view[data-request-id="basis-two"]')
    .getByRole('button', { name: '이 후보 보기', exact: true })
    .click();
  // The request list omits display meshes; the shown result is fetched before it is drawn.
  await page
    .getByRole('button', { name: '모델 표시 상태', exact: true })
    .waitFor({ state: 'hidden' });
  await openWork('basis-one');
  assert.equal(await card.locator('pre').isVisible(), false);
  assert.match(await card.locator('.work-conditions').textContent(), /대상Rhino/);
  await card.getByText('요청 원문', { exact: true }).click();
  assert.equal(await card.locator('pre').isVisible(), true);
  await page.route('**/api/v1/ai-settings', (route) =>
    route.fulfill({ status: 401, json: { code: 'UNAUTHORIZED' } }),
  );
  // Exercise the common API boundary without sending any operation to a real host/provider.
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ status: 401, json: { code: 'UNAUTHORIZED' } }),
  );
  await page.locator('#workspace-settings').click();
  await page.locator('[data-tab="ai"]').click();
  await page.locator('#ai-settings').click();
  await page.waitForFunction(() => !document.querySelector('#auth-status').hidden);
  assert.match(
    await page.getByRole('button', { name: '오류 기록', exact: true }).textContent(),
    /[1-9]/,
  );
  assert.equal(await page.locator('#request').isDisabled(), true);
  assert.equal(await page.locator('#body').inputValue(), 'Saved draft');
  assert.deepEqual(errors, []);
  await page.unrouteAll();
  await page.keyboard.press('Escape');
  // New projects and renames use an inline field (browser prompts are blocked in embedded views).
  await page.locator('#new-project').click();
  await page.locator('#project-name').fill('Second project');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      document.querySelector('#project-picker')?.selectedOptions[0]?.textContent ===
      'Second project',
  );
  await page.locator('#rename-project').click();
  await page.locator('#project-name').fill('Renamed project');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      document.querySelector('#project-picker')?.selectedOptions[0]?.textContent ===
      'Renamed project',
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelector('#project-picker')?.selectedOptions[0]?.textContent ===
      'Renamed project',
  );
  assert.equal(await page.locator('#project-picker option').count(), 2);
  console.log(
    'Workspace controls passed: guards, restore cancel/accept, slider, camera, tabs, resize, files, auth loss.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

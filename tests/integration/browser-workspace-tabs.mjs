// Workspace tabs (PLAN-22 T-047, Design §03 작업공간 탭, SCR-13·18): the rail's fixed destinations
// and the row over the centre column that holds only what is open (user decision 2026-10-01: hidden
// with nothing open), the JIG list, jig context tabs beside the 3D view (two at once, each keeping
// its state), a new instance of a v3 jig, 작업 이력, the per-project memory of the last screen (and
// a blocked storage), the narrow-screen menu, the 산출물 screen's three views (PLAN-26 T-081) and
// the host panel without rail or tabs. No real CLI or host.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-workspace-tabs-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const newPage = async (context) => {
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
    return page;
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await newPage(context);
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  const projectName = (await page.locator('#project-picker option:checked').textContent()).trim();

  // A Rhino and a CAD Sync of the same beams (synthetic), as in browser-jigs.mjs.
  const beams = [
    [0, 0, 6, 0],
    [0, 3, 6, 3],
    [0, 6, 6, 6.0008],
    [0, 9, 6, 9],
    [-1, -1, -1, 11.5],
  ];
  const b64 = (s) => Buffer.from(s).toString('base64');
  const rhinoScene = beams.map(([x0, y0, x1, y1], i) => ({
    id: 'r' + i,
    nativeId: '0000000' + i,
    nativeType: 'Curve',
    line: [x0 + 125, y0 + 48, 3.2, x1 + 125, y1 + 48, 3.2],
    layer64: b64(i === 4 ? 'GRID' : '구조::girder'),
  }));
  const cadScene = [beams[0], beams[1], [0, 6, 6, 6], beams[4]].map(([x0, y0, x1, y1], i) => ({
    id: 'cad-' + (20 + i),
    nativeId: String(20 + i),
    nativeType: 'Line',
    segments: [x0, y0, 0, x1, y1, 0],
    layer64: b64(i === 3 ? 'X-GRID' : 'S-BEAM'),
  }));
  const insert = (id, host, result) =>
    app.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
      id,
      projectId,
      JSON.stringify({
        id,
        body: host + ' sync',
        pins: [],
        sketches: [],
        files: [],
        provider: 'codex-cli',
        model: 'codex-cli',
        effort: 'default',
        permission: 'review',
        host,
      }),
      'succeeded',
      JSON.stringify({ hostExecuted: true, executionMode: 'sdk', host, ...result }),
      new Date().toISOString(),
    );
  insert('rhino-sync', 'rhino', {
    scene: rhinoScene,
    objects: rhinoScene.map((row, i) => ({
      id: row.id,
      name: 'B' + (i + 1),
      kind: 'native',
      nativeId: row.nativeId,
    })),
    sourceDocument: { name: 'model.3dm', capturedAt: 'test', instance: '1', documentId: 1 },
  });
  insert('cad-sync', 'zwcad', {
    scene: cadScene,
    objects: cadScene.map((row) => ({
      id: row.id,
      name: row.nativeId,
      kind: 'native',
      nativeId: row.nativeId,
    })),
    sourceUnits: 'Millimeters',
    sourceDocument: { name: 'plan.dwg', capturedAt: 'test', instance: '2', documentId: 1 },
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#task-list .task-row').length === 2);

  // The rail: the fixed destinations in order, the model screen pressed. The row over the centre
  // holds only what is open, so with nothing open it is hidden and the 3D view takes its room.
  const rail = (id) => page.locator(`.rail [data-workspace-target="${id}"]`);
  const pressed = async () =>
    page
      .locator('.rail [data-workspace-target][aria-pressed="true"]')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.workspaceTarget));
  assert.deepEqual(
    await page
      .locator('.rail [data-workspace-target]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))),
    // 만들기 is part of JIG (PLAN-26 T-099): the list's last card; browser-make.mjs checks it.
    ['대시보드', '모델', '작업 이력', '자료', 'JIG', '산출물'],
  );
  assert.deepEqual(await pressed(), ['model']);
  const tabs = page.getByRole('tablist', { name: '작업공간' });
  const tab = (name) => tabs.getByRole('tab', { name, exact: true });
  assert.equal(await page.locator('.workspace-tabs').isVisible(), false);
  const centre = await page.locator('.workspace').boundingBox();
  const right = await page.locator('#right').boundingBox();
  assert.ok(
    (await page.locator('.viewport-area').boundingBox()).y <= centre.y + 1,
    'the 3D view starts at the top of the centre',
  );
  // A draft and the selection stay through every tab change below.
  const draft = '탭을 바꿔도 남는 초안';
  await page.locator('#body').fill(draft);

  // JIG: the list over the whole centre; the documents panel gives it its room.
  await rail('jig').click();
  assert.deepEqual(await pressed(), ['jig']);
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  const official = dialog.locator('.jig-card[data-source="official"]');
  await official.first().waitFor();
  assert.equal(await page.locator('#canvas canvas').isVisible(), false);
  assert.equal(await page.locator('#left').isVisible(), false);
  const sources = dialog.getByRole('navigation', { name: '출처' });
  await sources.getByRole('button', { name: /^공식/ }).click();
  assert.equal(await dialog.locator('.jig-card[data-source="project"]').count(), 0);
  assert.equal(await official.count(), 11);
  await sources.getByRole('button', { name: /^이 프로젝트의 jig/ }).click();
  assert.equal(await official.count(), 0);
  await sources.getByRole('button', { name: /^전체/ }).click();
  if (shot) await page.screenshot({ path: join(shot, 'workspace-tabs-jig-list.png') });

  // A jig opens in a context tab: the panel on the left of the centre, the 3D view beside it.
  await dialog
    .locator('.jig-card', { hasText: 'Sync · 도면↔모델' })
    .getByRole('button', { name: '열기', exact: true })
    .click();
  const syncTab = tab(`Sync · ${projectName}`);
  assert.equal(await syncTab.getAttribute('aria-selected'), 'true');
  // An open jig shows the row (32 px, over the centre only) and belongs to the rail's JIG.
  assert.deepEqual(await tabs.getByRole('tab').allTextContents(), [`Sync · ${projectName}`]);
  assert.deepEqual(await pressed(), ['jig']);
  const row = await page.locator('.workspace-tabs').boundingBox();
  const jigCentre = await page.locator('.workspace').boundingBox();
  assert.ok(Math.abs(row.height - 32) <= 1, 'a 32 px row');
  assert.ok(row.x >= jigCentre.x - 1 && row.x + row.width <= right.x + 1, 'over the centre only');
  // 0.5 mm so the 0.8 mm beam (B3) is a deviation row, as in browser-jigs.mjs.
  await dialog.getByLabel('일치 허용 (mm)').fill('0.5');
  await dialog.getByRole('button', { name: '정렬·비교 실행' }).click();
  await dialog.locator('.jig-relation').waitFor();
  const panel = await dialog.boundingBox();
  const canvas = await page.locator('#canvas canvas').boundingBox();
  assert.ok(panel.x + panel.width <= canvas.x + 1, 'the panel docks left of the 3D view');
  assert.ok(canvas.width > 400, 'the 3D view keeps a working width');
  await dialog
    .locator('.jig-table tbody tr', { hasText: 'B3' })
    .getByRole('button', { name: /B3/ })
    .click();
  await page.waitForFunction(() => document.querySelector('#selection')?.textContent === 'B3');
  await dialog.getByLabel('R1 선택').check();

  // A second jig from the list; the Sync tab stays in the row.
  await dialog.getByRole('button', { name: '목록', exact: true }).click();
  assert.equal(await page.evaluate(() => document.body.dataset.workspace), 'jig');
  assert.deepEqual(await pressed(), ['jig']);
  assert.equal(await syncTab.count(), 1);
  await dialog
    .locator('.jig-card', { hasText: '구조 분석' })
    .getByRole('button', { name: '열기', exact: true })
    .click();
  const structureTab = tab(`구조 · ${projectName}`);
  assert.equal(await structureTab.getAttribute('aria-selected'), 'true');
  await dialog.getByText('탐색용 예비값입니다').waitFor();
  // Switching between the two keeps each jig's inputs and results.
  await syncTab.click();
  await dialog.locator('.jig-relation').waitFor();
  assert.ok(await dialog.getByLabel('R1 선택').isChecked());
  await structureTab.click();
  await dialog.getByText('탐색용 예비값입니다').waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'workspace-tabs-context.png') });

  // The rail's 모델: the 3D view and the documents; the open jigs stay in the row.
  await rail('model').click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(await pressed(), ['model']);
  assert.equal(await page.locator('#left').isVisible(), true);
  assert.equal(await page.locator('#document-tree').isVisible(), true);
  assert.equal(await page.locator('#body').inputValue(), draft);
  assert.equal(await page.locator('#selection').textContent(), 'B3');
  assert.ok(await tabs.isVisible());
  // 작업 이력: the model screen's left panel on the task history (with the attached files).
  await rail('history').click();
  assert.deepEqual(await pressed(), ['history']);
  assert.equal(await page.evaluate(() => document.body.dataset.workspace), 'model');
  assert.equal(await page.locator('#task-list').isVisible(), true);
  assert.equal(await page.locator('#document-tree').isVisible(), false);
  await rail('model').click();
  assert.equal(await page.locator('#document-tree').isVisible(), true);
  // Keyboard: arrows move over the open tabs and wrap.
  await syncTab.click();
  await syncTab.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await structureTab.getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowRight');
  assert.equal(await syncTab.getAttribute('aria-selected'), 'true');
  assert.ok(await syncTab.evaluate((node) => node === document.activeElement));
  await dialog.locator('.jig-relation').waitFor();
  // The rail's JIG opens the list, also from an open jig (the jig stays in the row).
  await rail('jig').click();
  assert.equal(await page.evaluate(() => document.body.dataset.workspace), 'jig');
  assert.equal(await syncTab.getAttribute('aria-selected'), 'false');

  // A v3 jig: a new instance with its name and output layer opens in its own tab.
  const grid = dialog.locator('.jig-card[data-source="project"]', {
    hasText: '격자 골조 배치 예제',
  });
  await grid.waitFor();
  await grid.getByRole('button', { name: '새로 열기', exact: true }).click();
  await grid.getByLabel('출력 레이어').fill('구조');
  await grid.getByRole('button', { name: '열기', exact: true }).click();
  const gridTab = tab(`격자 골조 배치 예제 · ${projectName}`);
  await gridTab.waitFor();
  assert.equal(await gridTab.getAttribute('aria-selected'), 'true');
  await page.waitForFunction(
    () => document.querySelector('.jig-dialog h2')?.textContent === '격자 골조 배치 예제',
  );
  assert.ok(await page.locator('#canvas canvas').isVisible());
  const listed = await page.evaluate(
    async (id) =>
      (await (await fetch(`/api/v1/projects/${id}/jig-instances`)).json()).instances.length,
    projectId,
  );
  assert.equal(listed, 1);
  // Closing its tab keeps the instance: the list offers it again.
  await page.getByRole('button', { name: `격자 골조 배치 예제 · ${projectName} 탭 닫기` }).click();
  assert.equal(await gridTab.count(), 0);
  await rail('jig').click();
  await grid
    .getByRole('list', { name: '격자 골조 배치 예제 작업본' })
    .getByRole('button', { name: '열기', exact: true })
    .click();
  assert.equal(await gridTab.getAttribute('aria-selected'), 'true');

  // The structure tab closes with its ×; the neighbouring tab shows.
  await structureTab.click();
  await page.getByRole('button', { name: `구조 · ${projectName} 탭 닫기` }).click();
  assert.equal(await structureTab.count(), 0);
  assert.equal(
    await tab(`격자 골조 배치 예제 · ${projectName}`).getAttribute('aria-selected'),
    'true',
  );

  // 대시보드 (the rail's first destination): the project's name, its jigs and the latest
  // finished requests over the centre; a jig opens like the JIG list's [열기].
  await rail('dashboard').click();
  assert.deepEqual(await pressed(), ['dashboard']);
  const board = page.getByRole('region', { name: '대시보드', exact: true });
  await board.getByRole('heading', { name: projectName, exact: true }).waitFor();
  assert.equal(await page.locator('#canvas canvas').isVisible(), false);
  assert.equal(await page.locator('#left').isVisible(), false);
  assert.ok(await board.getByRole('region', { name: '연결 파일' }).isVisible());
  assert.deepEqual(
    (
      await board
        .getByRole('region', { name: '최근 작업' })
        .locator('.dash-row-title')
        .allTextContents()
    ).sort(),
    ['rhino sync', 'zwcad sync'],
  );
  const boardJig = board
    .getByRole('region', { name: '이 프로젝트의 jig' })
    .getByRole('button', { name: /격자 골조 배치 예제/ });
  await boardJig.waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'workspace-tabs-dashboard.png') });
  await boardJig.click();
  await page.waitForFunction(
    () => document.querySelector('.jig-dialog h2')?.textContent === '격자 골조 배치 예제',
  );
  assert.equal(
    await tab(`격자 골조 배치 예제 · ${projectName}`).getAttribute('aria-selected'),
    'true',
  );

  // The project's last tab and open tabs come back after a reload.
  await syncTab.click();
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#task-list .task-row').length === 2);
  assert.equal(await syncTab.getAttribute('aria-selected'), 'true');
  assert.equal(await gridTab.count(), 1);
  await dialog.getByRole('button', { name: '정렬·비교 실행' }).waitFor();
  assert.equal(await page.locator('#body').inputValue(), draft);

  // Narrow screens: one menu in the centre's head instead of the row (it lists the fixed screens
  // too, which below 850 px have no rail).
  await page.setViewportSize({ width: 880, height: 900 });
  assert.equal(await tabs.isVisible(), false);
  const menu = page.getByRole('combobox', { name: '작업공간' });
  assert.equal(await menu.inputValue(), 'jig:legacy:sync');
  assert.ok(await page.getByRole('button', { name: `Sync · ${projectName} 탭 닫기` }).isVisible());
  await menu.selectOption({ label: '모델' });
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await menu.inputValue(), 'model');
  if (shot) await page.screenshot({ path: join(shot, 'workspace-tabs-880.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  // 산출물 (PLAN-26 T-081): 도면 · 보고서 · 렌더링 at its top; 도면 and 렌더링 are pages only, their
  // actions disabled ('준비 중'). The last view is remembered per project.
  await rail('output').click();
  assert.deepEqual(await pressed(), ['output']);
  assert.equal(await page.evaluate(() => document.body.dataset.workspace), 'output');
  const output = page.getByRole('region', { name: '산출물', exact: true });
  const views = output.getByRole('tablist', { name: '산출물 종류' });
  await views.waitFor();
  assert.equal(await page.locator('#canvas canvas').isVisible(), false);
  assert.equal(await page.locator('#left').isVisible(), false);
  const view = (name) => views.getByRole('tab', { name, exact: true });
  assert.deepEqual(await views.getByRole('tab').allTextContents(), ['도면', '보고서', '렌더링']);
  assert.equal(await view('도면').getAttribute('aria-selected'), 'true');
  const sheets = output.getByRole('tabpanel', { name: '도면' });
  await sheets.getByText('아직 시트가 없습니다').waitFor();
  assert.ok(await sheets.getByRole('img', { name: '빈 A1 가로 시트' }).isVisible());
  const newSheet = sheets.getByRole('button', { name: '새 시트' });
  assert.ok(await newSheet.isDisabled());
  assert.equal(await newSheet.getAttribute('title'), '준비 중');
  if (shot) await page.screenshot({ path: join(shot, 'output-sheet.png') });
  await view('보고서').click();
  // The report screen (src/ui/report-tab.tsx) lists the project's instances here.
  await output
    .getByRole('navigation', { name: '보고서 목록' })
    .getByText('격자 골조 배치 예제')
    .waitFor();
  assert.equal(await sheets.isVisible(), false);
  await view('보고서').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await view('렌더링').getAttribute('aria-selected'), 'true');
  const render = output.getByRole('tabpanel', { name: '렌더링' });
  assert.deepEqual(await render.locator('.output-node strong').allTextContents(), [
    '뷰 캡처',
    '깊이·선화',
    '이미지 생성',
    '결과',
  ]);
  assert.ok(await render.getByRole('textbox', { name: '프롬프트' }).isDisabled());
  assert.ok(await render.getByRole('combobox', { name: '스타일' }).isDisabled());
  const generate = render.getByRole('button', { name: '생성' });
  assert.ok(await generate.isDisabled());
  assert.equal(await generate.getAttribute('title'), '준비 중');
  await render.getByText('아직 생성한 이미지가 없습니다').waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'output-render.png') });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.workspace === 'output');
  assert.equal(await view('렌더링').getAttribute('aria-selected'), 'true');
  assert.ok(await render.isVisible());
  await rail('model').click();

  // Closing every open jig hides the row again; the model screen stays.
  for (const name of [`Sync · ${projectName}`, `격자 골조 배치 예제 · ${projectName}`])
    await page.getByRole('button', { name: `${name} 탭 닫기` }).click();
  assert.equal(await page.locator('.workspace-tabs').isVisible(), false);
  assert.deepEqual(await pressed(), ['model']);
  // Below 850 px there is no rail: the menu stays and offers the fixed screens.
  await page.setViewportSize({ width: 800, height: 900 });
  assert.equal(await page.locator('.rail').isVisible(), false);
  await page.locator('.mobile-tabs [data-mobile="model"]').click();
  await menu.waitFor();
  assert.deepEqual(await menu.locator('option').allTextContents(), [
    '대시보드',
    '모델',
    '자료',
    'JIG',
    '산출물',
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });

  // A storage that refuses (private window, blocked site data): the model tab, and tabs still work.
  const blocked = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await blocked.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (String(key).startsWith('vide:workspace:')) throw new DOMException('blocked');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith('vide:workspace:')) throw new DOMException('blocked');
      return set.call(this, key, value);
    };
  });
  const guarded = await newPage(blocked);
  await guarded.goto(app.launchUrl);
  await guarded.waitForFunction(
    () => document.querySelectorAll('#task-list .task-row').length === 2,
  );
  const guardedRail = (id) => guarded.locator(`.rail [data-workspace-target="${id}"]`);
  assert.equal(await guardedRail('model').getAttribute('aria-pressed'), 'true');
  await guardedRail('jig').click();
  await guarded
    .getByRole('dialog', { name: 'JIG', exact: true })
    .locator('.jig-card')
    .first()
    .waitFor();
  await blocked.close();

  // The host panel (SCR-12) has no rail, no tab row and no jig panel.
  const { origin, hash } = new URL(app.launchUrl);
  const panelPage = await newPage(context);
  await panelPage.goto(`${origin}/?panel=rhino&name=${encodeURIComponent('합성.3dm')}${hash}`);
  await panelPage.getByText('이 파일을 VIDE 프로젝트에 연결하세요').waitFor();
  assert.equal(await panelPage.locator('#workspace-tabs > *').count(), 0);
  assert.equal(await panelPage.locator('.workspace').isVisible(), false);
  assert.equal(await panelPage.locator('.rail').isVisible(), false);
  assert.equal(await panelPage.locator('.jig-dialog').isVisible(), false);

  assert.deepEqual(errors, []);
  console.log('workspace tab browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

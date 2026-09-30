// JIG tab: gallery, Sync jig run on two stored Syncs, AI review and edit requests. No real CLI or host.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
const directory = await mkdtemp(join(tmpdir(), 'vide-jigs-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [],
    posted = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/projects\/[^/]+\/requests$/.test(request.url()))
      posted.push(JSON.parse(request.postData()));
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
  // The same beams: the model is offset by 125/48/3.2 m, one beam 0.8 mm off, one only in the model.
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
  await page.evaluate(() => {
    const model = document.querySelector('#model');
    model.value = 'codex-cli';
    model.dispatchEvent(new Event('change'));
  });
  const projectName = (await page.locator('#project-picker option:checked').textContent()).trim();
  // A jig installed from a .vjig and pinned to this project (registry list, stood in here); its
  // [삭제] takes it off the project's list.
  let pinned = true;
  const unpinned = [];
  await page.route('**/api/v1/jigs/packages', async (route) => {
    const { jigs } = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        jigs: [
          ...jigs,
          {
            id: 'project/check-sample',
            version: '0.1.0',
            kind: 'tool',
            name: '합성 점검 jig',
            summary: '가져온 설명서로 그리는 합성 jig',
            source: 'pack',
            stage: 'project',
            capabilities: [],
          },
        ],
      },
    });
  });
  await page.route('**/api/v1/projects/*/jigs', (route) =>
    route.fulfill({
      json: { pinned: pinned ? [{ jigId: 'project/check-sample', version: '0.1.0' }] : [] },
    }),
  );
  await page.route('**/api/v1/projects/*/jigs/*/pin', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    unpinned.push(new URL(route.request().url()).pathname);
    pinned = false;
    return route.fulfill({ json: { unpinned: true } });
  });
  // The rail's JIG button opens the JIG tab (the list) before any jig was used.
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  await dialog.waitFor();
  const tabs = page.getByRole('tablist', { name: '작업공간' });
  assert.equal(
    await tabs.getByRole('tab', { name: 'JIG', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  // The list shows the official catalogue: the working jigs and the planned ones.
  const official = dialog.locator('.jig-card[data-source="official"]');
  await official.first().waitFor();
  assert.equal(await official.count(), 11);
  assert.equal(
    await dialog.locator('.jig-card[data-source="official"][data-status="planned"]').count(),
    8,
  );
  assert.equal(await official.getByRole('button', { name: '삭제', exact: true }).count(), 0);
  const installed = dialog.locator('.jig-card[data-source="project"]', {
    hasText: '합성 점검 jig',
  });
  await installed.waitFor();
  assert.match(await installed.textContent(), /가져온 설명서로 그리는 합성 jig/);
  await installed.getByRole('button', { name: '삭제', exact: true }).click();
  await installed
    .getByRole('group', { name: '합성 점검 jig 삭제 확인' })
    .getByRole('button', { name: '삭제', exact: true })
    .click();
  await dialog.getByText('‘합성 점검 jig’을 이 프로젝트의 jig에서 삭제했습니다.').waitFor();
  await installed.waitFor({ state: 'detached' });
  assert.deepEqual(unpinned, [`/api/v1/projects/${projectId}/jigs/project%2Fcheck-sample/pin`]);
  await dialog
    .locator('.jig-card[data-status="available"]', { hasText: 'Sync · 도면↔모델' })
    .getByRole('button', { name: '열기', exact: true })
    .click();
  // The jig opens in its own context tab.
  const syncTab = tabs.getByRole('tab', { name: `Sync · ${projectName}`, exact: true });
  assert.equal(await syncTab.getAttribute('aria-selected'), 'true');
  assert.match(
    await dialog.getByLabel('Rhino Sync').locator('option:checked').textContent(),
    /model\.3dm/,
  );
  assert.match(
    await dialog.getByLabel('ZWCAD Sync').locator('option:checked').textContent(),
    /plan\.dwg/,
  );
  await dialog.getByLabel('일치 허용 (mm)').fill('0.5');
  await dialog.getByRole('button', { name: '정렬·비교 실행' }).click();
  await dialog.locator('.jig-relation').waitFor();
  const relation = await dialog.locator('.jig-relation').textContent();
  assert.match(relation, /이동 X -125000 mm · Y -48000 mm · 높이 차 -3200 mm/);
  assert.match(relation, /오차 1 · Rhino에만 1 · CAD에만 0/);
  assert.match(relation, /구조::girder ↔ S-BEAM · 3쌍/);
  const rows = dialog.locator('.jig-table tbody tr');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).textContent(), /R1오차B3 · 구조::girderS-BEAM · 220\.8 mm/);
  // AI review: host-less, the table attached, only the table's rows citable.
  await dialog.getByRole('button', { name: /AI 검토/ }).click();
  await dialog.locator('.jig-sync [role=status]', { hasText: 'AI 검토를' }).waitFor();
  const review = posted.at(-1);
  assert.equal(review.permission, 'review');
  assert.equal(review.host, undefined);
  assert.equal(review.jig.kind, 'sync-review');
  assert.deepEqual(review.jig.rows, ['R1', 'R2', 'R3', 'R4', 'R5']);
  const table = JSON.parse(review.files[0].text);
  assert.equal(review.files[0].name, 'sync-jig.json');
  assert.deepEqual(table.relation.translationMm, [-125000, -48000]);
  assert.equal(table.rows[0].deviationMm, 0.8);
  // The drawing follows the model: the 0.8 mm beam moves, the missing beam is added.
  await dialog.getByLabel('R1 선택').check();
  await dialog.getByLabel('R2 선택').check();
  await dialog.getByRole('button', { name: /CAD를 Rhino에 맞춤/ }).click();
  await dialog.locator('.jig-sync [role=status]', { hasText: '반영 요청' }).waitFor();
  const cad = posted.at(-1);
  assert.equal(cad.host, 'zwcad');
  assert.equal(cad.baseRequestId, 'cad-sync');
  assert.equal(cad.permission, 'candidate');
  const edits = JSON.parse(cad.files[0].text);
  assert.deepEqual(edits[0], {
    row: 'R1',
    action: 'move-ends',
    handle: '22',
    from: [
      [0, 6000, 0],
      [6000, 6000, 0],
    ],
    to: [
      [0, 6000, 0],
      [6000, 6000.8, 0],
    ],
  });
  assert.deepEqual(edits[1], {
    row: 'R2',
    action: 'add-line',
    layer: 'S-BEAM',
    points: [
      [0, 9000, 0],
      [6000, 9000, 0],
    ],
  });
  // The model follows the drawing: the beam's end returns to the drawing, in model coordinates.
  await dialog.getByLabel('R2 선택').uncheck();
  await dialog.getByRole('button', { name: /Rhino를 CAD에 맞춤/ }).click();
  await page.waitForResponse((response) => /\/requests$/.test(response.url()));
  const rhino = posted.at(-1);
  assert.equal(rhino.host, 'rhino');
  assert.equal(rhino.baseRequestId, 'rhino-sync');
  assert.equal(rhino.applyToSource, true);
  assert.deepEqual(JSON.parse(rhino.files[0].text)[0], {
    row: 'R1',
    action: 'move-ends',
    id: '00000002',
    to: [
      [125, 54, 3.2],
      [131, 54, 3.2],
    ],
  });
  await page.screenshot({ path: join(directory, 'jigs.png') });
  // A row opens its object in the viewport; the panel is non-modal and stays open beside the model.
  await rows.nth(0).getByRole('button', { name: /B3/ }).click();
  await page.waitForFunction(
    () => document.querySelector('#selection-count')?.textContent === '1개 선택',
  );
  assert.equal(await page.locator('#selection').textContent(), 'B3');
  assert.ok(await dialog.isVisible(), 'the jig stays open while the model is shown');
  assert.equal(await dialog.evaluate((node) => node.matches(':modal')), false);
  const canvas = await page.locator('#canvas canvas').boundingBox();
  const panel = await dialog.boundingBox();
  // The panel docks on the left of the centre (the documents panel gives it its room).
  assert.ok(panel.x + panel.width <= canvas.x + 1, 'the 3D view sits beside the panel');
  assert.equal(await page.locator('#left').isVisible(), false);
  assert.ok(await dialog.getByLabel('R1 선택').isChecked(), 'the jig keeps its state');
  // Closing the tab goes back to the model; the rail's JIG button brings the same jig back.
  await dialog.getByRole('button', { name: '닫기' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await syncTab.count(), 0);
  assert.equal(await page.locator('#left').isVisible(), true);
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  await dialog.locator('.jig-relation').waitFor();
  assert.ok(await dialog.getByLabel('R1 선택').isChecked());
  assert.equal(await syncTab.getAttribute('aria-selected'), 'true');
  assert.deepEqual(errors, []);
  console.log('JIG tab checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

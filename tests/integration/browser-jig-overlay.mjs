// Viewport overlay layers and the non-modal JIG panel (PLAN-22 T-041): overlays are drawn over the
// model, picked as overlay items (never as document objects), styled, framed and removed; the jig
// keeps its inputs and results through a round trip to the 3D view. No real CLI or host.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

import { soleDb } from '../fixtures/store.mjs';
const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-jig-overlay-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [],
    posted = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/projects\/[^/]+\/requests$/.test(request.url()))
      posted.push(request.postData());
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
    soleDb(app.store)
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
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

  // Jig state: a comparison with the 'all' filter and one row picked.
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  await dialog
    .locator('.jig-card[data-status="available"]', { hasText: 'Sync · 도면↔모델' })
    .getByRole('button', { name: '열기' })
    .click();
  await dialog.getByRole('button', { name: '정렬·비교 실행' }).click();
  await dialog.locator('.jig-relation').waitFor();
  const relation = await dialog.locator('.jig-relation').textContent();
  await dialog.getByRole('button', { name: '전체', exact: true }).click();
  await dialog.getByLabel('R1 선택').check();
  const jigState = async () => ({
    relation: await dialog.locator('.jig-relation').textContent(),
    filter: await dialog
      .getByRole('button', { name: '전체', exact: true })
      .getAttribute('aria-pressed'),
    rows: await dialog.locator('.jig-table tbody tr').count(),
    picked: await dialog.getByLabel('R1 선택').isChecked(),
  });
  const before = await jigState();
  assert.deepEqual(before, { relation, filter: 'true', rows: 5, picked: true });

  // Show the model from the jig: the panel stays, the viewport beside it holds the Sync.
  await dialog
    .locator('.jig-table tbody tr', { hasText: 'B3' })
    .getByRole('button')
    .first()
    .click();
  await page.waitForFunction(() => document.querySelector('#selection')?.textContent === 'B3');
  assert.equal(await dialog.evaluate((node) => node.matches(':modal')), false);
  await page.waitForTimeout(600); // the framing of the shown object
  const documentIds = await page.evaluate(() => window.videViewport.visibleIds().sort());
  assert.equal(documentIds.length, 5);

  // Overlay layer: an area in plan, a dashed axis line and a numbered issue mark.
  const memory = () => page.evaluate(() => window.videViewport.benchmark(1));
  const base = await memory();
  const plain = await page.evaluate(() => window.videViewport.capture());
  const items = [
    {
      id: 'a1',
      kind: 'polygon',
      points: [
        [126.5, 49],
        [128.5, 49],
        [128.5, 50.5],
        [126.5, 50.5],
      ],
      z: 3.2,
      fill: true,
      tone: 'ov-clash',
    },
    {
      id: 'g1',
      kind: 'polyline',
      points: [
        [122, 46, 3.2],
        [122, 59, 3.2],
      ],
      dashed: true,
      tone: 'ov-grid',
    },
    { id: 'p1', kind: 'point', at: [129.5, 52.5, 3.2], label: '1', tone: 'ng' },
  ];
  await page.evaluate((items) => window.videViewport.overlay('diag', items), items);
  assert.deepEqual(await page.evaluate(() => window.videViewport.overlayInfo()), [
    { key: 'diag', items: ['a1', 'g1', 'p1'], visible: true, opacity: 1 },
  ]);
  assert.equal((await memory()).objects, base.objects, 'overlays are not document objects');
  // Review snapshots and thumbnails capture the model only, never the jig's marks.
  assert.equal(
    await page.evaluate(() => window.videViewport.capture()),
    plain,
    'capture leaves overlays out',
  );
  if (shot) await page.screenshot({ path: join(shot, 'jig-overlay.png') });
  assert.deepEqual(await page.evaluate(() => window.videViewport.visibleIds().sort()), documentIds);

  // Picking: the mark and the area are overlay items; they never change the model selection.
  const screen = (point) => page.evaluate((p) => window.videViewport.screenOf(p), point);
  const pickAt = (point) => page.evaluate(({ x, y }) => window.videViewport.pickAt(x, y), point);
  const mark = await screen([129.5, 52.5, 3.2]);
  assert.deepEqual((await pickAt(mark)).source, { source: 'overlay', key: 'diag', itemId: 'p1' });
  const area = await screen([127.5, 49.75, 3.2]);
  assert.deepEqual((await pickAt(area)).source, { source: 'overlay', key: 'diag', itemId: 'a1' });
  // The panel receives overlay clicks (a jig follows them to its table row).
  await dialog.evaluate((node) => {
    window.overlayPicks = [];
    node.addEventListener('overlaypick', (event) => window.overlayPicks.push(event.detail));
  });
  await page.mouse.click(mark.x, mark.y);
  await page.waitForFunction(() => window.overlayPicks.length === 1);
  assert.deepEqual(await page.evaluate(() => window.overlayPicks), [{ key: 'diag', itemId: 'p1' }]);
  assert.equal(await page.locator('#selection').textContent(), 'B3');
  // Select all takes document objects only.
  await page.locator('#canvas canvas').focus();
  await page.keyboard.press('Control+A');
  await page.waitForFunction(
    () => document.querySelector('#selection-count')?.textContent === '5개 선택',
  );

  // Style: opacity, then hidden (no longer picked), then shown again.
  await page.evaluate(() => window.videViewport.overlayStyle('diag', { opacity: 0.4 }));
  assert.equal((await page.evaluate(() => window.videViewport.overlayInfo()))[0].opacity, 0.4);
  await page.evaluate(() => window.videViewport.overlayStyle('diag', { visible: false }));
  assert.equal((await pickAt(mark)).source.source, 'document');
  await page.evaluate(() => window.videViewport.overlayStyle('diag', { visible: true }));
  assert.equal((await pickAt(mark)).source.source, 'overlay');
  // Replacing the items keeps the layer's style.
  await page.evaluate((items) => window.videViewport.overlay('diag', items), items.slice(1));
  assert.deepEqual(await page.evaluate(() => window.videViewport.overlayInfo()), [
    { key: 'diag', items: ['g1', 'p1'], visible: true, opacity: 0.4 },
  ]);

  // Focus frames an overlay item: the mark comes to the middle of the 3D view.
  await page.evaluate(() => window.videViewport.focus({ overlay: 'diag', itemId: 'p1' }));
  const box = await page.locator('#canvas canvas').boundingBox();
  const centred = await screen([129.5, 52.5, 3.2]);
  assert.ok(Math.abs(centred.x - (box.x + box.width / 2)) < 2, 'focus centres the item');
  assert.ok(Math.abs(centred.y - (box.y + box.height / 2)) < 2, 'focus centres the item');

  // Removal clears the layer and its GPU resources (geometry and the tag texture).
  const kept = await memory();
  await page.evaluate(() => window.videViewport.overlay('diag', null));
  assert.deepEqual(await page.evaluate(() => window.videViewport.overlayInfo()), []);
  assert.equal((await pickAt(centred)).source.source, 'document');
  const cleared = await memory();
  assert.equal(cleared.textures, kept.textures - 1, 'the issue tag texture is released');
  assert.equal(cleared.geometries, kept.geometries - 2, 'line and mark geometry are released');

  // Round trip through the 3D view: orbit, empty click, fold and unfold, close and reopen.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 40, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  let empty;
  for (const [fx, fy] of [
    [0.1, 0.9],
    [0.9, 0.9],
    [0.1, 0.2],
    [0.9, 0.2],
    [0.5, 0.95],
  ]) {
    const point = { x: box.x + box.width * fx, y: box.y + box.height * fy };
    if (!(await pickAt(point)).ids.length) {
      empty = point;
      break;
    }
  }
  assert.ok(empty, 'an empty spot in the 3D view');
  await page.mouse.click(empty.x, empty.y);
  await page.waitForFunction(() => document.querySelector('#selection-bar')?.hidden);
  assert.deepEqual(await jigState(), before);
  await dialog.getByRole('button', { name: '접기' }).click();
  // Folding gives the 3D view the width back.
  await page.waitForFunction(
    (width) => document.querySelector('#canvas canvas').getBoundingClientRect().width > width + 200,
    box.width,
  );
  if (shot) await page.screenshot({ path: join(shot, 'jig-folded.png') });
  await dialog.getByRole('button', { name: 'Sync · 도면↔모델 펼치기' }).click();
  assert.deepEqual(await jigState(), before);
  await dialog.getByRole('button', { name: '닫기' }).click();
  await dialog.waitFor({ state: 'hidden' });
  // The rail's JIG opens the list; the same jig opens again with its state.
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  await dialog
    .locator('.jig-card[data-status="available"]', { hasText: 'Sync · 도면↔모델' })
    .getByRole('button', { name: '열기' })
    .click();
  await dialog.locator('.jig-relation').waitFor();
  assert.deepEqual(await jigState(), before);
  // Nothing of the overlay went into a request.
  assert.ok(posted.every((body) => !/"diag"|"p1"|"a1"/.test(body)));
  assert.deepEqual(errors, []);
  console.log('jig overlay browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

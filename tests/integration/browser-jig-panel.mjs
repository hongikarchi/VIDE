// Declarative jig panel v0 (PLAN-22 T-048, SPEC-07.10): the example jig (extensions/jigs/example-grid)
// opens in a context tab and draws its panel.json with the official parts — steps, input roles,
// settings, KPI strip, 3D overlay layers with a verdict legend, plan, result tables. Table rows and
// 3D items select each other; a slider recomputes only the geometry steps while it is dragged and
// the rest when let go; a setting read by one step leaves the others as they were. The screen shows
// no server confirmation levels and fits a 320 px phone. Synthetic Sync, no real CLI or host.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-jig-panel-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [],
    runs = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/jig-instances\/[^/]+\/run$/.test(request.url()))
      runs.push(JSON.parse(request.postData() ?? '{}'));
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

  // A Rhino Sync: a 30 × 20 m slab outline with a void, and an empty layer for the jig's output.
  const b64 = (s) => Buffer.from(s).toString('base64');
  const ring = (x0, y0, x1, y1) => [x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0, x0, y0, 0];
  const scene = [
    { id: 'o1', nativeId: '00000001', line: ring(0, 0, 30, 20), layer: '슬래브 외곽' },
    { id: 'v1', nativeId: '00000002', line: ring(13, 6, 17, 14), layer: '보이드' },
  ].map(({ layer, ...row }) => ({ ...row, nativeType: 'Curve', layer64: b64(layer) }));
  const layer = (n, fullPath, objectCount) => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    parentId: null,
    fullPath,
    visible: true,
    locked: false,
    color: '#000000',
    order: n,
    objectCount,
  });
  app.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
    'rhino-sync',
    projectId,
    JSON.stringify({
      id: 'rhino-sync',
      body: 'rhino sync',
      pins: [],
      sketches: [],
      files: [],
      provider: 'codex-cli',
      model: 'codex-cli',
      effort: 'default',
      permission: 'review',
      host: 'rhino',
    }),
    'succeeded',
    JSON.stringify({
      hostExecuted: true,
      executionMode: 'sdk',
      host: 'rhino',
      scene,
      objects: scene.map((row) => ({
        id: row.id,
        name: row.id,
        kind: 'native',
        nativeId: row.nativeId,
      })),
      layers: [layer(1, '슬래브 외곽', 1), layer(2, '보이드', 1), layer(3, 'VIDE 출력', 0)],
      sourceDocument: { name: 'slab.3dm', capturedAt: 'test', instance: '1', documentId: 1 },
    }),
    new Date().toISOString(),
  );
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#task-list .task-row').length === 1);

  // The JIG list → the example jig → a new instance with its output layer → its context tab.
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  const card = dialog.locator('.jig-card', { hasText: '격자 골조 배치 예제' });
  await card.getByRole('button', { name: '새로 열기' }).click();
  await card.getByLabel('출력 레이어').fill('VIDE 출력');
  await card.getByRole('button', { name: '열기', exact: true }).click();
  const panel = dialog.locator('[data-jig-panel="project/example-grid"]');
  await panel.waitFor();
  const rail = (id, state) =>
    panel.locator(`.kit-rail li[data-step="${id}"]${state ? `[data-state="${state}"]` : ''}`);
  // panel.json → screen: the parts of its left column, and nothing computed without inputs.
  assert.deepEqual(
    await panel.locator('.kit-rail li').evaluateAll((rows) => rows.map((r) => r.dataset.step)),
    ['grid', 'confirmInputs', 'beams', 'summary'],
  );
  await rail('grid', 'failed').waitFor();
  assert.match(await rail('grid').textContent(), /필요한 입력이 없습니다/);

  // Input roles: candidates from the Sync layers that fit each role, confirmed by a person.
  for (const [role, title] of [
    ['site.outline', '슬래브 외곽선'],
    ['site.voids', '보이드'],
  ]) {
    const roleCard = panel.locator(`.kit-role[data-role="${role}"]`);
    await roleCard.getByRole('button', { name: '후보 찾기' }).click();
    await roleCard
      .getByRole('list', { name: `${title} 후보` })
      .getByRole('button', { name: '확인' })
      .first()
      .click();
    await panel.locator(`.kit-role[data-role="${role}"][data-state="confirmed"]`).waitFor();
  }
  assert.match(await panel.locator('.kit-roles').locator('..').textContent(), /2\/2 확인/);
  await rail('confirmInputs', 'waiting').getByRole('button', { name: '확인' }).click();
  await rail('summary', 'done').waitFor();

  // KPI strip and view switch above the 3D view, slider board over it, results below it.
  const top = page.locator('.kit-slot[data-slot="top"]');
  const board = page.locator('.kit-slot[data-slot="board"]');
  const drawer = page.locator('.kit-slot[data-slot="drawer"]');
  const kpi = (label) => top.locator(`.kit-kpi[data-kpi="${label}"] .kit-kpi-value`).textContent();
  assert.deepEqual(
    [await kpi('기둥'), await kpi('보'), await kpi('최대 경간'), await kpi('기둥당 면적')],
    ['8개', '10개', '8.0m', '75.0m²'],
  );
  assert.deepEqual(await drawer.getByRole('tab').allTextContents(), ['기둥8', '보10']);
  // The results are overlay layers on the model, not document objects.
  const overlays = () =>
    page.evaluate(() =>
      Object.fromEntries(
        window.videViewport.overlayInfo().map((layer) => [layer.key, layer.items.length]),
      ),
    );
  await page.waitForFunction(
    () => window.videViewport.overlayInfo().find((o) => o.key === 'beams')?.items.length === 10,
  );
  assert.deepEqual(await overlays(), { site: 1, beams: 10, columns: 8 });

  // 3D → table: a beam picked in the view opens the beam tab on its row. The point is one on a
  // beam that the view (not the slider board floating over it, nor a column tag) shows there.
  await page.evaluate(() => window.videViewport.focus({ overlay: 'beams' }));
  await page.waitForTimeout(700);
  const beamPick = await page.evaluate(() => {
    const beams = [
      [20, 12, 28, 12],
      [28, 4, 28, 12],
      [12, 4, 20, 4],
      [20, 4, 28, 4],
      [4, 4, 12, 4],
    ];
    for (const [x0, y0, x1, y1] of beams)
      for (const t of [0.5, 0.4, 0.6, 0.3, 0.7]) {
        const at = window.videViewport.screenOf([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 0]);
        const hit = window.videViewport.pickAt(at.x, at.y).source;
        if (
          hit.source === 'overlay' &&
          hit.key === 'beams' &&
          document.elementFromPoint(at.x, at.y)?.tagName === 'CANVAS'
        )
          return { at, id: hit.itemId };
      }
  });
  assert.ok(beamPick, 'a beam shows in the view');
  await page.mouse.click(beamPick.at.x, beamPick.at.y);
  const beamRow = drawer.getByRole('table', { name: '보' }).locator(`tr[data-id="${beamPick.id}"]`);
  await beamRow.and(page.locator('[aria-selected="true"]')).waitFor();
  assert.equal(
    await drawer.getByRole('tab', { name: /^보/ }).getAttribute('aria-selected'),
    'true',
  );

  // Table → 3D: a column row frames that column in the middle of the view.
  await drawer.getByRole('tab', { name: /^기둥/ }).click();
  const columnRow = drawer.getByRole('table', { name: '기둥' }).locator('tr[data-id="col:C4-2"]');
  await columnRow.click();
  assert.equal(await columnRow.getAttribute('aria-selected'), 'true');
  await page.waitForTimeout(700);
  const framed = await page.evaluate(() => {
    const r = document.querySelector('#canvas canvas').getBoundingClientRect();
    const at = window.videViewport.screenOf([28, 12, 0]);
    return { dx: at.x - (r.left + r.width / 2), dy: at.y - (r.top + r.height / 2) };
  });
  assert.ok(Math.hypot(framed.dx, framed.dy) < 40, JSON.stringify(framed));

  // The plan draws the same results; a column pressed there selects its row.
  await top.getByRole('tab', { name: '평면' }).click();
  const plan = top.getByRole('img', { name: '평면' });
  await plan.locator('[data-layer="columns"] [data-id="col:C2-1"]').click();
  await drawer
    .getByRole('table', { name: '기둥' })
    .locator('tr[data-id="col:C2-1"][aria-selected="true"]')
    .waitFor();
  assert.equal(await plan.locator('[data-layer="columns"] [data-selected]').count(), 1);
  await top.getByRole('tab', { name: '3D' }).click();

  // A setting only one step reads: that step and those after it recompute, the rest is reused.
  const report = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/run$/.test(r.url()),
  );
  await panel.getByRole('button', { name: '기둥 크기 늘리기' }).click();
  const recomputed = await (await report).json();
  assert.deepEqual(Object.fromEntries(recomputed.steps.map((s) => [s.id, [s.status, s.cached]])), {
    grid: ['done', true],
    confirmInputs: ['confirmed', false],
    beams: ['done', false],
    summary: ['done', false],
  });
  await rail('grid').and(page.locator('[data-cached="true"]')).waitFor();
  assert.match(await rail('grid').textContent(), /변경 없음/);

  // Dragging a slider computes the geometry steps only; letting go computes the rest.
  const slider = board.getByRole('slider', { name: '격자 간격 X' });
  const box = await slider.boundingBox();
  const y = box.y + box.height / 2;
  runs.length = 0;
  await page.mouse.move(box.x + box.width / 3, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++)
    await page.mouse.move(box.x + box.width / 3 - (i * box.width) / 36, y, { steps: 2 });
  for (let i = 0; i < 50 && !runs.length; i++) await page.waitForTimeout(100);
  assert.ok(runs.length, 'a drag computes while held');
  assert.ok(
    runs.every((run) => run.until === 'grid' && run.mode === 'geometry'),
    JSON.stringify(runs),
  );
  await page.mouse.up();
  for (let i = 0; i < 50 && !runs.some((run) => !run.until); i++) await page.waitForTimeout(100);
  assert.ok(
    runs.some((run) => !run.until),
    'letting go computes every step',
  );
  // Exactly 6 m: the columns overlay follows at once; the beams wait for the inputs to be rechecked.
  await slider.fill('6');
  await page.waitForFunction(
    () => window.videViewport.overlayInfo().find((o) => o.key === 'columns')?.items.length === 9,
  );
  await rail('confirmInputs', 'reconfirm').getByRole('button', { name: '다시 확인' }).click();
  await rail('beams', 'done').waitFor();
  await page.waitForFunction(
    () => window.videViewport.overlayInfo().find((o) => o.key === 'beams')?.items.length === 10,
  );
  assert.equal(await kpi('기둥'), '9개');

  // Verdict legend: bands from the jig, counts, one band only, verdict colours off.
  const legend = top.locator('.kit-legend');
  assert.match(await legend.locator('[data-band="ok"]').textContent(), /여유 < 7\s*6$/);
  assert.match(await legend.locator('[data-band="warn"]').textContent(), /주의 7~10\s*4$/);
  await legend.locator('[data-band="ok"]').click();
  await page.waitForFunction(
    () => window.videViewport.overlayInfo().find((o) => o.key === 'beams')?.items.length === 6,
  );
  await legend.getByRole('button', { name: '전체 보기' }).click();
  await legend.getByRole('button', { name: '판정색 끄기' }).click();
  await legend.getByRole('button', { name: '판정색 켜기' }).waitFor();
  // Layers (the view menu) go off and on without losing the result, and fade.
  await top.getByText('보기 3/3 켜짐', { exact: true }).click();
  const columnsLayer = top.getByRole('checkbox', { name: '기둥' });
  await columnsLayer.uncheck();
  await page.waitForFunction(
    () => !window.videViewport.overlayInfo().some((o) => o.key === 'columns'),
  );
  await top.getByText('보기 2/3 켜짐', { exact: true }).waitFor();
  await columnsLayer.check();
  await page.waitForFunction(
    () => window.videViewport.overlayInfo().find((o) => o.key === 'columns')?.items.length === 9,
  );
  const fade = top.getByRole('slider', { name: '기둥 투명도' });
  if (await fade.count()) {
    await fade.fill('0.5');
    await page.waitForFunction(
      () => window.videViewport.overlayInfo().find((o) => o.key === 'columns')?.opacity === 0.5,
    );
  }

  // Words on screen: no confirmation levels, no bindings or developer words.
  for (const node of [dialog, top, board, drawer]) {
    const text = await node.innerText();
    assert.doesNotMatch(text, /\bT[12]\b/);
    assert.doesNotMatch(text, /panel\.json|step\.|\$[a-z]|undefined|NaN|null/);
  }
  if (shot) await page.screenshot({ path: join(shot, 'jig-panel.png') });

  // A 320 px phone: the panel and the parts beside it fit without sideways scrolling.
  await page.setViewportSize({ width: 320, height: 760 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll('.jig-dialog, [data-jig-panel], .kit-slot')]
      .filter((node) => node.getClientRects().length)
      .map((node) => ({
        name: node.className,
        scroll: node.scrollWidth,
        client: node.clientWidth,
      }))
      .filter((node) => node.scroll > node.client + 1),
  );
  assert.deepEqual(overflow, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 321));
  assert.ok(await panel.locator('.kit-rail').isVisible());
  if (shot) await page.screenshot({ path: join(shot, 'jig-panel-320.png') });

  assert.deepEqual(errors, []);
  console.log('Declarative jig panel checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

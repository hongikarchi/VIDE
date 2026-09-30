// S-06 frame jig 0.1 in the browser (PLAN-23 T-051): two stored Rhino Syncs (a structure model with
// the slab, the drawn layout and a new joint; a civil model with the existing footings, the basin
// beams, the grid and an old joint — synthetic) → JIG list → new instance of project/s06-frame →
// role cards read and confirm every role → the human step confirmed → assembly, diagnosis, axes,
// columns, footprints and interference done → KPI strip, result tabs, 3D overlays, table ↔ 3D.
// Read-only: no request, no host, no AI. Not part of test:browser yet; run by hand after build:web.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import {
  CASES,
  fixtureFiles,
  gridRot21M1,
} from '../../extensions/jigs/s06-frame/fixtures/cases.ts';
import { HOME, LAYERS, buildCase } from '../../extensions/jigs/s06-frame/fixtures/synthetic.ts';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-s06-jig-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
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

  // The two synthetic documents as stored Syncs, with layer tables (the output layer must exist).
  const built = buildCase(gridRot21M1);
  const layerTable = (names) =>
    names.map((fullPath, n) => ({
      id: `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
      parentId: null,
      fullPath,
      visible: true,
      locked: false,
      color: '#000000',
      order: n,
      objectCount: fullPath === 'VIDE 출력' ? 0 : 1,
    }));
  const layersOf = (document) =>
    Object.entries(HOME)
      .filter(([, home]) => home === document)
      .map(([role]) => LAYERS[role]);
  const insert = (id, result, layers, createdAt) =>
    app.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
      id,
      projectId,
      JSON.stringify({
        id,
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
      JSON.stringify({ ...result, layers: layerTable(layers) }),
      createdAt,
    );
  insert(
    'structure-sync',
    built.structure,
    [...layersOf('structure'), 'VIDE 출력'],
    '2026-09-30T01:00:00.000Z',
  );
  insert('civil-sync', built.civil, layersOf('civil'), '2026-09-30T01:01:00.000Z');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#task-list .task-row').length === 2);
  const requests = () =>
    page.evaluate(
      async (id) => (await (await fetch(`/api/v1/projects/${id}/requests`)).json()).length,
      projectId,
    );
  const before = await requests();

  // JIG list → the S-06 jig → a new instance on the output layer → its context tab.
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  const card = dialog.locator('.jig-card', { hasText: 'S-06 골조 배치' });
  await card.getByRole('button', { name: '새로 열기' }).click();
  await card.getByLabel('출력 레이어').fill('VIDE 출력');
  await card.getByRole('button', { name: '열기', exact: true }).click();
  const panel = dialog.locator('[data-jig-panel="project/s06-frame"]');
  await panel.waitFor();
  const rail = (id, state) =>
    panel.locator(`.kit-rail li[data-step="${id}"]${state ? `[data-state="${state}"]` : ''}`);
  assert.deepEqual(
    await panel.locator('.kit-rail li').evaluateAll((rows) => rows.map((r) => r.dataset.step)),
    ['assemble', 'confirmInputs', 'diagnose', 'axes', 'columns', 'footprints', 'interference'],
  );
  // Nothing is read yet: the required roles are missing and the assembly step says so.
  await rail('assemble', 'failed').waitFor();
  assert.match(await rail('assemble').textContent(), /필요한 입력이 없습니다/);
  // The fire route and the requested zone a person sketches, and the fixture's cap clearance, set
  // through the instance routes: the same inputs as the grid-rot21 fixture (the numbers below).
  const fixture = fixtureFiles(CASES.find((c) => c.name === 'grid-rot21'));
  assert.deepEqual(
    await page.evaluate(
      async ({ id, zones, capClearance }) => {
        const base = `/api/v1/projects/${id}/jig-instances`;
        const [instance] = (await (await fetch(base)).json()).instances;
        const put = async (path, body) =>
          (
            await fetch(`${base}/${instance.id}/${path}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            })
          ).status;
        return [
          await put('zones', { zones }),
          await put('params', { values: [{ key: 'capClearance', value: capClearance }] }),
        ];
      },
      {
        id: projectId,
        zones: { fireRoute: fixture.input.fireRoute, requestedZones: fixture.input.requestedZones },
        capClearance: fixture.params.capClearance,
      },
    ),
    [200, 200],
  );

  // Every role: candidates from the Sync layers that fit its hints, the first one confirmed by a person.
  const roles = [
    ['site.slab', '슬래브 경계'],
    ['site.existingFootings', '기존 기초'],
    ['site.basinGirders', '유수지 보'],
    ['site.existingGrid', '기존 그리드'],
    ['site.newEJ', '신설 E.J.'],
    ['site.existingEJ', '기존 E.J.'],
    ['site.columns', '현재 배치 · 신설 기둥'],
    ['site.girders', '현재 배치 · 거더'],
    ['site.newFootings', '현재 배치 · 신설 기초'],
  ];
  for (const [role, title] of roles) {
    const roleCard = panel.locator(`.kit-role[data-role="${role}"]`);
    await roleCard.getByRole('button', { name: '후보 찾기' }).click();
    await roleCard
      .getByRole('list', { name: `${title} 후보` })
      .getByRole('button', { name: '확인' })
      .first()
      .click();
    await panel.locator(`.kit-role[data-role="${role}"][data-state="confirmed"]`).waitFor();
  }
  assert.match(await panel.locator('.kit-roles').locator('..').textContent(), /9\/10 확인/);
  await rail('confirmInputs', 'waiting').getByRole('button', { name: '확인' }).click();
  await rail('interference', 'done').waitFor();
  for (const id of ['assemble', 'diagnose', 'axes', 'columns', 'footprints'])
    await rail(id, 'done').waitFor();

  // KPI strip: the generated layout of the synthetic site (see tests/core/s06-jig.test.mjs).
  const top = page.locator('.kit-slot[data-slot="top"]');
  const drawer = page.locator('.kit-slot[data-slot="drawer"]');
  const kpi = (label) => top.locator(`.kit-kpi[data-kpi="${label}"] .kit-kpi-value`).textContent();
  assert.equal(await kpi('기둥'), '10개');
  assert.equal(await kpi('파일캡 불가'), '0곳');
  assert.equal(await kpi('경간 초과'), '0개');
  assert.equal(await kpi('유수지 보 경고'), '0곳');
  assert.match(await kpi('최대 경간'), /^11\.\d\dm$/);
  const tabs = await drawer.getByRole('tab').allTextContents();
  assert.ok(tabs[0].startsWith('간섭10'), tabs.join('|'));
  assert.ok(tabs.some((t) => t.startsWith('대안')));
  assert.ok(tabs.some((t) => t.startsWith('확인 목록')));

  // The results are overlay layers on the model: axes, columns, caps, footings and the open cuts to consult.
  const overlays = () =>
    page.evaluate(() =>
      Object.fromEntries(
        window.videViewport.overlayInfo().map((layer) => [layer.key, layer.items.length]),
      ),
    );
  await page.waitForFunction(
    () => window.videViewport.overlayInfo().find((o) => o.key === 'columns')?.items.length === 10,
  );
  const drawn = await overlays();
  assert.equal(drawn.axes, 6);
  assert.equal(drawn.caps, 8);
  assert.equal(drawn.existing, 6);
  assert.equal(drawn.basin, 2);
  assert.equal(drawn.missing, 5);
  assert.ok(drawn['cut-clash'] > 0, JSON.stringify(drawn));
  assert.equal(drawn['cap-clash'] ?? 0, 0);
  if (shot) await page.screenshot({ path: join(shot, 's06-jig.png') });

  // Table → 3D: an interference row selects its column and frames it.
  const row = drawer.getByRole('table', { name: '간섭' }).locator('tr[data-id="col:N1-NA"]');
  await row.click();
  assert.equal(await row.getAttribute('aria-selected'), 'true');
  assert.ok(
    (await page.evaluate(() => window.videViewport.overlayInfo())) // overlay item ids are the keys
      .find((o) => o.key === 'columns')
      .items.includes('col:N1-NA'),
  );
  // The column's line (bottom → top) from the step output; its middle comes to the view's centre.
  const column = await page.evaluate(async (id) => {
    const base = `/api/v1/projects/${id}/jig-instances`;
    const [instance] = (await (await fetch(base)).json()).instances;
    const { output } = await (await fetch(`${base}/${instance.id}/steps/columns/output`)).json();
    return output.columns.find((c) => c.key === 'col:N1-NA');
  }, projectId);
  const centre = column.line[0].map((v, k) => (v + column.line.at(-1)[k]) / 2);
  await page
    .waitForFunction(
      (centre) => {
        const r = document.querySelector('#canvas canvas').getBoundingClientRect();
        const at = window.videViewport.screenOf(centre);
        return Math.hypot(at.x - (r.left + r.width / 2), at.y - (r.top + r.height / 2)) < 60;
      },
      centre,
      { timeout: 5000 },
    )
    .catch(async () => {
      const framed = await page.evaluate((centre) => {
        const r = document.querySelector('#canvas canvas').getBoundingClientRect();
        const at = window.videViewport.screenOf(centre);
        return { dx: at.x - (r.left + r.width / 2), dy: at.y - (r.top + r.height / 2) };
      }, centre);
      assert.fail('the column is not framed: ' + JSON.stringify(framed));
    });

  // The plan turns with the frame and lists the same columns; the alternatives tab names both grids.
  await top.getByRole('tab', { name: '평면' }).click();
  const plan = top.getByRole('img', { name: '평면' });
  assert.equal(await plan.locator('[data-layer="columns"] [data-id]').count(), 10);
  await top.getByRole('tab', { name: '3D' }).click();
  await drawer.getByRole('tab', { name: /^대안/ }).click();
  const alternatives = await drawer.getByRole('table', { name: '대안' }).textContent();
  assert.match(alternatives, /직교 격자/);
  assert.match(alternatives, /엇갈림 격자/);
  assert.match(alternatives, /● 선택/);

  // A setting the layout reads recomputes from the axes on; the diagnosis of the drawn layout is reused.
  const report = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/run$/.test(r.url()),
  );
  await panel.getByRole('button', { name: '파일캡 한 변 늘리기' }).click();
  const recomputed = await (await report).json();
  const statuses = Object.fromEntries(recomputed.steps.map((s) => [s.id, [s.status, s.cached]]));
  assert.deepEqual(statuses.diagnose, ['done', true]);
  assert.deepEqual(statuses.axes, ['done', false]);
  assert.deepEqual(statuses.interference, ['done', false]);

  // Words on screen: no confirmation levels, bindings or developer words; the preliminary-value note.
  for (const node of [dialog, top, drawer]) {
    const text = await node.innerText();
    assert.doesNotMatch(text, /\bT[12]\b/);
    assert.doesNotMatch(text, /panel\.json|step\.|\$[a-z]|undefined|NaN|null/);
  }
  // Read-only: no request, candidate or host command was made by the jig.
  assert.equal(await requests(), before);

  // A 320 px phone: the panel and the parts beside it fit without sideways scrolling.
  await page.setViewportSize({ width: 320, height: 760 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll('.jig-dialog, [data-jig-panel], .kit-slot')]
      .filter((node) => node.getClientRects().length)
      .map((node) => ({ name: node.className, scroll: node.scrollWidth, client: node.clientWidth }))
      .filter((node) => node.scroll > node.client + 1),
  );
  assert.deepEqual(overflow, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 321));
  if (shot) await page.screenshot({ path: join(shot, 's06-jig-320.png') });

  assert.deepEqual(errors, []);
  console.log('s06 frame jig browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

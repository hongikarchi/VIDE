// S-06 frame jig 0.1 in the browser (PLAN-23 T-051): two stored Rhino Syncs (a structure model with
// the slab, the drawn layout and a new joint; a civil model with the existing footings, the basin
// beams, the grid and an old joint — synthetic) → JIG list → new instance of project/s06-frame →
// role cards read and confirm every role → the human step confirmed → assembly, diagnosis, axes,
// columns, footprints and interference done → KPI strip, result tabs, 3D overlays, table ↔ 3D.
// M3 (T-056): sizing, schedule, heights and the bake plan tabs. Read-only: no request, no host,
// no AI. Not part of test:browser yet; run by hand after build:web.
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
    [
      'assemble',
      'confirmInputs',
      'diagnose',
      'axes',
      'columns',
      'footprints',
      'interference',
      'girders',
      'cells',
      'beams',
      'model',
      'analysis',
      'confirmAnalysis',
      'analysisConfirmed',
      'sizing',
      'schedule',
      'heights',
      'bakePlan',
      'bakeMembers',
      'applySections',
      'sectionsApplied',
    ],
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
        // layoutSource stays 'drawn' (the default) until the drawn checks below are done.
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

  // M2 drawn mode (default): the drawn girders are corrected, cells and beams follow, the frame
  // model is analysed as a '미확정 미리보기' and 해석 확정 waits for a person (PLAN-23 T-053).
  for (const id of ['assemble', 'diagnose', 'girders', 'cells', 'beams', 'model', 'analysis'])
    await rail(id, 'done').waitFor();
  await rail('confirmAnalysis', 'waiting').waitFor();
  const top = page.locator('.kit-slot[data-slot="top"]');
  const drawer = page.locator('.kit-slot[data-slot="drawer"]');
  const kpi = (label) => top.locator(`.kit-kpi[data-kpi="${label}"] .kit-kpi-value`).textContent();
  // grid-rot21 as drawn (see tests/core/s06-m2.test.mjs for the drawn-two-bay numbers).
  assert.equal(await kpi('거더'), '6개');
  assert.equal(await kpi('기둥 없는 끝'), '1곳');
  assert.equal(await kpi('경간 초과'), '2개');
  assert.equal(await kpi('작은보'), '9개'); // back spans included since 2026-09-30 (VERIFY s06-frame-m2 추가)
  // The sandboxed jig child cannot start the analysis worker (steps/analysis.ts), so the preview
  // reports 'unavailable'; the '미확정 미리보기' label shows only beside a preview value (kpiNote).
  const ratioText = await top.locator('.kit-kpi[data-kpi="최대 검정비"]').textContent();
  assert.match(ratioText, /해석 전/);
  assert.doesNotMatch(ratioText, /미확정 미리보기/);
  const drawnTabs = await drawer.getByRole('tab').allTextContents();
  assert.deepEqual(
    drawnTabs.slice(0, 4).map((t) => t.replace(/\d+$/, '')),
    ['거더 보정 목록', '칸·작은보', '해석 요약', '참고 처짐'],
  );
  const overlays = () =>
    page.evaluate(() =>
      Object.fromEntries(
        window.videViewport.overlayInfo().map((layer) => [layer.key, layer.items.length]),
      ),
    );
  await page.waitForFunction(
    () => window.videViewport.overlayInfo().find((o) => o.key === 'girders')?.items.length === 6,
  );
  const corrected = await overlays();
  assert.equal(corrected.dangling, 1);
  assert.equal(corrected.beams, 9); // 5 infill beams + 4 back spans
  assert.equal(corrected.columns ?? 0, 0); // no proposed layout in drawn mode
  if (shot) await page.screenshot({ path: join(shot, 's06-jig-drawn.png') });

  // M3 (PLAN-23 T-056): sizing on the preview, schedule, heights and the lines plan run before
  // 해석 확정; the members plan waits for it. KPI 강재 (t), tabs 단면·일람표·높이·만들기, the
  // schedule saves as CSV. Numbers depend on the analysis: tests/core/s06-m3.test.mjs.
  for (const id of ['sizing', 'schedule', 'heights', 'bakePlan']) await rail(id, 'done').waitFor();
  await rail('bakeMembers', 'blocked').waitFor();
  const steel = await top.locator('.kit-kpi[data-kpi="강재"]').textContent();
  assert.match(steel, /\d[\d.,]*\s*t/);
  assert.match(steel, /예비 단면/);
  assert.deepEqual(
    drawnTabs.slice(4).map((t) => t.replace(/\d+$/, '')),
    [
      '단면',
      '일람표',
      '높이',
      '만들기',
      '간섭 · 제안',
      '배치 대안 · 제안',
      '확인 목록',
      '입력 조립',
    ],
  );
  await drawer.getByRole('tab', { name: /^일람표/ }).click();
  const scheduleTable = drawer.getByRole('table', { name: '일람표' });
  assert.ok((await scheduleTable.locator('tbody tr').count()) > 0);
  assert.match(await scheduleTable.textContent(), /S06-S[A-Z]+1/);
  const download = page.waitForEvent('download');
  await drawer.getByRole('button', { name: /CSV/ }).first().click();
  assert.equal((await download).suggestedFilename(), '부재일람표.csv');
  await drawer.getByRole('tab', { name: /^높이/ }).click();
  assert.ok((await drawer.getByRole('table', { name: '높이' }).locator('tbody tr').count()) > 0);
  await drawer.getByRole('tab', { name: /^만들기/ }).click();
  assert.ok((await drawer.getByRole('table', { name: '만들기' }).locator('tbody tr').count()) > 0);
  await drawer.getByRole('tab', { name: /^거더 보정 목록/ }).click();

  // The proposed layout (②~④) after switching the layout source.
  assert.equal(
    await page.evaluate(async (id) => {
      const base = `/api/v1/projects/${id}/jig-instances`;
      const [instance] = (await (await fetch(base)).json()).instances;
      return (
        await fetch(`${base}/${instance.id}/params`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [{ key: 'layoutSource', value: 'proposed' }] }),
        })
      ).status;
    }, projectId),
    200,
  );
  await panel.getByRole('button', { name: '다시 계산', exact: true }).click();
  await rail('interference', 'done').waitFor();
  for (const id of ['axes', 'columns', 'footprints']) await rail(id, 'done').waitFor();
  // The drawer holds the drawn and M3 tabs (eight at most); the proposed results are overlays,
  // the plan and the step outputs.

  // The results are overlay layers on the model: axes, columns, caps and footings.
  await page.waitForFunction(
    () => window.videViewport.overlayInfo().find((o) => o.key === 'columns')?.items.length === 10,
  );
  const drawn = await overlays();
  assert.equal(drawn.axes, 6);
  assert.equal(drawn.caps, 8);
  // Existing footings now come from the diagnosis (every footing, in drawn mode too), not only
  // those the proposed footprints step compared.
  assert.equal(drawn.existing, 8);
  assert.equal(drawn['cap-clash'] ?? 0, 0);
  if (shot) await page.screenshot({ path: join(shot, 's06-jig.png') });

  // Table → 3D: a corrected girder row selects its girder and frames it.
  await drawer.getByRole('tab', { name: /^거더 보정 목록/ }).click();
  const row = drawer.getByRole('table', { name: '거더 보정 목록' }).locator('tr[data-id="G01"]');
  await row.click();
  assert.equal(await row.getAttribute('aria-selected'), 'true');
  assert.ok(
    (await page.evaluate(() => window.videViewport.overlayInfo())) // overlay item ids are the keys
      .find((o) => o.key === 'girders')
      .items.includes('G01'),
  );
  // The girder's top line from the step output; its middle comes to the view's centre.
  const girder = await page.evaluate(async (id) => {
    const base = `/api/v1/projects/${id}/jig-instances`;
    const [instance] = (await (await fetch(base)).json()).instances;
    const { output } = await (await fetch(`${base}/${instance.id}/steps/girders/output`)).json();
    return output.girders.find((g) => g.id === 'G01');
  }, projectId);
  const centre = girder.points[0].map((v, k) => (v + girder.points.at(-1)[k]) / 2);
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
      assert.fail('the girder is not framed: ' + JSON.stringify(framed));
    });

  // The plan turns with the frame and lists the same columns; the alternatives name both grids.
  await top.getByRole('tab', { name: '평면' }).click();
  const plan = top.getByRole('img', { name: '평면' });
  assert.equal(await plan.locator('[data-layer="columns"] [data-id]').count(), 10);
  await top.getByRole('tab', { name: '3D' }).click();
  const alternatives = await page.evaluate(async (id) => {
    const base = `/api/v1/projects/${id}/jig-instances`;
    const [instance] = (await (await fetch(base)).json()).instances;
    const { output } = await (await fetch(`${base}/${instance.id}/steps/axes/output`)).json();
    return JSON.stringify(output.alternatives);
  }, projectId);
  assert.match(alternatives, /직교 격자/);
  assert.match(alternatives, /엇갈림 격자/);
  assert.match(alternatives, /● 선택/);

  // A setting the layout and the beams read recomputes them; the diagnosis and the girders are reused.
  const report = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/run$/.test(r.url()),
  );
  await panel.getByRole('button', { name: '바깥 축선에서 슬래브 끝까지 한도 늘리기' }).click();
  const recomputed = await (await report).json();
  const statuses = Object.fromEntries(recomputed.steps.map((s) => [s.id, [s.status, s.cached]]));
  assert.deepEqual(statuses.diagnose, ['done', true]);
  assert.deepEqual(statuses.girders, ['done', true]);
  assert.deepEqual(statuses.axes, ['done', false]);
  assert.deepEqual(statuses.beams, ['done', false]);
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

// 패널링 jig screen (PLAN-49 T-253, SPEC-16.1·16.3·16.4·16.8·16.9·16.10·16.11, Design SCR-33),
// against the contract with a fake engine and fixed results: the declared panel of `vide/paneling`
// is drawn by the real `JigPanel` and viewport in a bare page, and the engine routes
// (`…/jig-instances/:id`, `…/run`, `…/params`, `…/paneling/surface`, `…/bakes`) are answered here
// with step outputs shaped as `PanelLayout` · `MemberSet` · `PanelTyping`
// (tests/fixtures/paneling-result.mjs). Without a 기준 면 the card asks for one and nothing is
// drawn; a mesh pick is refused with its reason; a picked face draws the panels in 3D with their
// numbers, failures in colour and count; moving a setting recomputes; '다시 계산 필요' shows and
// clears; assumed values close [부재 만들기] with the reason until a person takes them (tag or
// question card); a schedule row selects its panel in 3D and a picked panel selects its row; the
// 색 기준 recolours; the CSV carries the contract head; a remote screen has no make or read
// buttons; a 400 px column reads rows in two lines. No host, no server.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { panelingFixture, panelingParams } from '../fixtures/paneling-result.mjs';

const shot = process.env.VIDE_SHOT_DIR;
const ORIGIN = 'http://vide.test';

const bundle = await build({
  configFile: false,
  logLevel: 'error',
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    write: false,
    minify: false,
    cssCodeSplit: false,
    lib: {
      entry: fileURLToPath(new URL('./browser-paneling-fixture.mjs', import.meta.url)),
      formats: ['es'],
      fileName: 'fixture',
    },
    rollupOptions: { output: { codeSplitting: false } },
  },
});
const output = (Array.isArray(bundle) ? bundle[0] : bundle).output;
const code = output.find((item) => item.type === 'chunk' && item.isEntry)?.code;
const css = output
  .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
  .map((item) => String(item.source))
  .join('\n');
assert.ok(code, 'fixture bundle');

const STAGE_OF = Object.fromEntries(
  panelingParams().map((p) => [
    p.key,
    p.group.startsWith('1') ? 'preview' : p.group.startsWith('2') ? 'members' : 'optimize',
  ]),
);
const AFTER = {
  preview: ['preview', 'members', 'optimize'],
  members: ['members', 'optimize'],
  optimize: ['optimize'],
};

/** The fake engine: one instance of `vide/paneling` and what its routes answer. */
function engine({ surface = false } = {}) {
  const state = {
    surface: surface ? read() : null,
    meshNext: false,
    holdMembers: false,
    by: { pattern: 'user', width: 'user', height: 'user' },
    values: {},
    runs: [],
    puts: [],
    picks: [],
  };
  // What T-251's routes answer (`src/server/paneling-routes.ts`): the kept reference and summary.
  function read() {
    return {
      key: 'surface',
      picked: {
        hash: 'h-surface',
        linkId: 'link-1',
        documentKey: 'link-1',
        objectId: '6f1c2a10-0000-4000-8000-000000000001',
        faces: [0],
        faceHashes: ['f0'],
        revisionKey: 'r1',
        grid: 128,
        readAt: '2026-10-08T09:12:00.000Z',
        syncHash: null,
      },
      documentName: '합성-쌍곡면.3dm',
      summary: { toMeters: 0.001, absTol: 0.001, points: 16384, extent: [30, 20, 4.5], faces: [] },
    };
  }
  const steps = (status) =>
    ['preview', 'members', 'optimize'].map((id, i) => ({
      id,
      title: ['미리보기', '부재', '최적화·타입화'][i],
      kind: 'code',
      speed: id === 'preview' ? 'live' : 'release',
      status: status(id),
    }));
  const view = () => ({
    id: 'i1',
    jig: { id: 'vide/paneling', version: '0.1.0', name: '패널링' },
    title: '패널링 1',
    status: 'done',
    body: { layerRoot: 'VIDE::패널링', assembly: {} },
    steps: steps(() => (state.surface ? 'done' : 'pending')),
    params: panelingParams(state.by, state.values),
    inputs: [{ key: 'surface', title: '기준 면', kind: 'host-surface', host: 'rhino' }],
    updatedAt: '2026-10-08T09:00:00.000Z',
  });
  async function answer(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : undefined;
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    const base = '/projects/p1/jig-instances/i1';
    if (path === base && method === 'GET') return json(view());
    if (path === `${base}/run` && method === 'POST') {
      state.runs.push(body);
      if (!state.surface)
        return json({
          steps: ['preview', 'members', 'optimize'].map((id) => ({
            id,
            kind: 'code',
            status: 'blocked',
            inputHash: 'h',
            cached: false,
            ms: null,
            gates: [],
          })),
          outputs: {},
          blocked: true,
          superseded: false,
        });
      const width = state.values.width ?? 1.2;
      const outputs = panelingFixture({ cols: width === 1.2 ? 3 : 4, module: [width, 0.6] });
      const held = state.holdMembers;
      return json({
        steps: ['preview', 'members', 'optimize'].map((id) => ({
          id,
          kind: 'code',
          status: held && id !== 'preview' ? 'skipped' : 'done',
          inputHash: `h-${width}`,
          cached: false,
          ms: 3,
          gates: [],
        })),
        outputs: held ? { preview: outputs.preview } : outputs,
        blocked: false,
        superseded: false,
      });
    }
    if (path === `${base}/params` && method === 'PUT') {
      state.puts.push(body);
      const affected = new Set();
      for (const { key, value } of body.values) {
        state.values[key] = value;
        state.by[key] = body.by ?? 'user';
        for (const step of AFTER[STAGE_OF[key]]) affected.add(step);
      }
      return json({ affected: [...affected], instance: view() });
    }
    // 보고서(HTML) of the jig's frame `reports/paneling.json` (PLAN-49 T-257).
    if (path === `${base}/reports/paneling` && method === 'GET')
      return json({
        report: { id: 'paneling', title: '패널링', file: 'reports/paneling.json' },
        model: { exportRefused: [] },
        html: '<!doctype html><title>패널링</title><h1>패널 8개를 타입 3개로 묶었습니다.</h1>',
      });
    if (path === '/projects/p1/paneling/surface' && method === 'GET') {
      assert.equal(url.searchParams.get('instanceId'), 'i1');
      return json(
        state.surface
          ? { ...state.surface, watching: false, changed: null }
          : { key: 'surface', picked: null, summary: null, watching: false, changed: null },
      );
    }
    if (path === '/projects/p1/paneling/surface/read' && method === 'POST') {
      state.picks.push(body);
      if (state.meshNext) {
        state.meshNext = false;
        return json({
          ok: false,
          key: 'surface',
          code: 'MESH_NOT_ACCEPTED',
          message: '메쉬 기준 면은 아직 받지 않습니다 · Rhino에서 서피스로 바꾸세요',
        });
      }
      state.surface = read();
      return json({ ok: true, ...state.surface });
    }
    if (path === `${base}/bakes` && method === 'GET')
      return json({
        offers: [
          { id: 'preview', template: 'vide.bake.panels-uv@1', layer: '패널링::미리보기' },
          { id: 'members', template: 'vide.bake.panel-solids@1', layer: '패널링::부재' },
          { id: 'types', template: 'vide.bake.block-instances@1', layer: '패널링::타입' },
        ],
        bakes: [],
        stale: false,
      });
    return json({ code: 'NOT_FOUND', message: path }, 404);
  }
  return { state, answer };
}

async function open(browser, options = {}, engineOptions = {}) {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1000 },
    acceptDownloads: true,
  });
  const errors = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => {
    // The fake engine's 400 for a mesh pick is an expected failed request.
    if (m.type() === 'error' && !/status of 400/.test(m.text()))
      errors.push('console: ' + m.text());
  });
  const fake = engine(engineOptions);
  await page.route(`${ORIGIN}/api/v1/**`, (route) => fake.answer(route));
  await page.route(`${ORIGIN}/fixture.mjs`, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: code }),
  );
  await page.route(`${ORIGIN}/`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${css}</style></head><body></body></html>`,
    }),
  );
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(async (options) => {
    const { mount } = await import('/fixture.mjs');
    window.paneling = mount(options);
  }, options);
  const panel = page.locator('[data-jig-panel="vide/paneling"]');
  await panel.waitFor();
  return { page, panel, fake, errors };
}

let browser;
try {
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });

  const { page, panel, fake, errors } = await open(browser);
  const overlay = () =>
    page.evaluate(() =>
      window.paneling.view
        .overlayInfo()
        .map((layer) => ({ key: layer.key, n: layer.items.length })),
    );
  const kpi = (label) => panel.locator(`.pnl-kpis .kit-kpi[data-kpi="${label}"] .kit-kpi-value`);
  const drawer = panel.locator('.pnl-drawer');

  // ── No 기준 면: the card asks for one, nothing is drawn ────────────────────────────────────
  const card = panel.locator('.pnl-surface');
  await card.getByText('Rhino에서 면을 고른 뒤 [고른 면 쓰기]를 누르세요.').waitFor();
  await drawer.getByText('기준 면을 고르면 패널이 여기에 보입니다.').waitFor();
  assert.match(await kpi('패널').textContent(), /계산 전/);
  assert.deepEqual(await overlay(), []);
  // Before any result every assumed value is '물어볼 것' with the recommended value in grey.
  await panel.locator('[data-ask="measure"]').getByText('추천 면 위 길이').waitFor();
  assert.equal(await panel.locator('[data-assumed]').count(), 0);
  await panel
    .locator('.pnl-make[data-make="preview"]')
    .getByText('이 단계를 계산한 뒤 만들 수 있습니다')
    .waitFor();

  // ── A mesh is refused with its reason; a face is read and the panels drawn ────────────────
  fake.state.meshNext = true;
  await card.getByRole('button', { name: '고른 면 쓰기' }).click();
  await card
    .getByRole('alert')
    .getByText('메쉬 기준 면은 아직 받지 않습니다 · Rhino에서 서피스로 바꾸세요')
    .waitFor();
  assert.equal(await card.locator('.pnl-warn[role="alert"]').count(), 1);
  await card.getByRole('button', { name: '고른 면 쓰기' }).click();
  await card.getByText('면 1 · 30.00 × 20.00 m 범위 · mm 문서').waitFor();
  await card.getByText('합성-쌍곡면.3dm').waitFor();
  assert.deepEqual(fake.state.picks, [
    { instanceId: 'i1', mode: 'pick' },
    { instanceId: 'i1', mode: 'pick' },
  ]);
  await kpi('패널').getByText('8').waitFor();
  assert.equal(await kpi('경계').textContent(), '2');
  assert.equal(await kpi('목표와 다름').textContent(), '2');
  assert.match(await kpi('크기').textContent(), /0\.3~1\.2 × 0\.6~0\.6\s*m/);
  assert.equal(await kpi('실패').textContent(), '1');
  await panel.locator('.pnl-kpis .kit-kpi[data-kpi="실패"] .pnl-bad').waitFor();
  assert.deepEqual(await overlay(), [{ key: 'paneling-panels', n: 8 }]);
  const tones = async () => {
    const record = await page.evaluate(() => window.paneling.record.overlay);
    return Object.fromEntries(
      record
        .filter((r) => r.key === 'paneling-panels' && r.tones)
        .at(-1)
        .tones.map((t) => t.split(':')),
    );
  };
  let tone = await tones();
  assert.equal(tone['P-2-4'], 'ov-clash', 'the failed panel is drawn, in --ov-clash');
  assert.equal(tone['P-1-3'], 'warn', '목표와 다름');
  // The failed panel is counted and listed, never left out.
  await drawer.getByRole('tab', { name: '실패 1' }).click();
  await drawer
    .getByRole('table', { name: '실패 패널' })
    .locator('tr[data-panel="P-2-4"]')
    .getByText('넓이 0 · 패널이 너무 작습니다', { exact: false })
    .waitFor();
  await drawer.getByRole('tab', { name: '패널 8' }).click();
  // Now the assumed values are '가정'; the preview can be made with them.
  await panel.locator('[data-assumed="measure"]').waitFor();
  assert.match(
    await panel.locator('.pnl-rail button[data-stage="preview"]').textContent(),
    /계산됨 · 가정 5/,
  );
  await panel.locator('.pnl-make').getByRole('button', { name: '미리보기 만들기' }).waitFor();
  await panel.locator('.pnl-make').getByText('가정 값 5개로 만듭니다', { exact: false }).waitFor();

  // ── A setting moved: recomputed ────────────────────────────────────────────────────────
  const runsBefore = fake.state.runs.length;
  const width = panel.getByRole('spinbutton', { name: '패널 가로' });
  await width.fill('1500');
  await width.press('Enter');
  await kpi('패널').getByText('10').waitFor();
  assert.ok(fake.state.runs.length > runsBefore, 'recomputed');
  // The screen computes its library steps (PLAN-49 T-258 F-1): no geometry run, which would skip them.
  assert.deepEqual([...new Set(fake.state.runs.map((r) => r.mode))], ['confirmed']);
  assert.deepEqual(fake.state.puts.at(-1), { values: [{ key: 'width', value: 1.5 }], by: 'user' });
  assert.deepEqual(await overlay(), [{ key: 'paneling-panels', n: 10 }]);
  assert.equal(await panel.locator('[data-notice]').count(), 0, 'no false 크기 바뀜 notice');

  // ── Stage 2: assumed values close [부재 만들기] until a person takes them ─────────────────
  await panel.locator('.pnl-rail button[data-stage="members"]').click();
  await panel.locator('.pnl-settings[data-stage="members"]').waitFor();
  assert.equal(await kpi('부재').textContent(), '9');
  assert.equal(await kpi('판재 초과').textContent(), '1');
  await panel.getByText('판 1,490 × 590 mm = 크기 − 줄눈').waitFor();
  const make = panel.locator('.pnl-make[data-make="members"]');
  assert.equal(await make.getByRole('button', { name: '부재 만들기' }).isDisabled(), true);
  await make.getByText('가정 값 9개를 확인하면 만들 수 있습니다').waitFor();
  // The question card asks the stage's missing values at once, recommended first.
  await panel.getByRole('button', { name: '빠진 값 묻기 4' }).click();
  const questions = panel.getByRole('group', { name: '빠진 값 질문' });
  assert.equal(await questions.locator('.qcard').count(), 4);
  const jointCard = questions.locator('.qcard', { hasText: '줄눈을(를) 정해 주세요' });
  assert.equal(await jointCard.getByRole('radio', { name: /10 mm/ }).isChecked(), true);
  await jointCard.getByPlaceholder('직접 입력').fill('12');
  await questions.getByRole('button', { name: '이 답으로 진행' }).click();
  await make.getByText('가정 값 5개를 확인하면 만들 수 있습니다').waitFor();
  const answered = fake.state.puts.at(-1);
  assert.equal(answered.by, 'decision');
  assert.deepEqual(
    answered.values.map((v) => `${v.key}=${v.value}`),
    ['thickness=0.05', 'thicknessSide=outside', 'joint=0.012', 'boundaryJoint=flush'],
  );
  await panel.locator('[data-source="question"]').first().waitFor();
  // [가정 값 보기] goes to the stage holding them; '가정' → [이 값으로 확인] takes each as is.
  await make.getByRole('button', { name: '가정 값 보기' }).click();
  await panel.locator('.pnl-settings[data-stage="preview"]').waitFor();
  for (const key of ['measure', 'axis', 'startCorner', 'flip', 'boundary']) {
    await panel.locator(`[data-assumed="${key}"]`).click();
    await panel.getByRole('button', { name: '이 값으로 확인' }).click();
    await panel.locator(`[data-assumed="${key}"]`).waitFor({ state: 'detached' });
  }
  assert.deepEqual(fake.state.puts.at(-1), {
    values: [{ key: 'boundary', value: 'trim' }],
    by: 'user',
  });
  assert.equal(fake.state.values.measure, 'arc-length', 'the value stays as it was');
  await panel.locator('.pnl-rail button[data-stage="members"]').click();
  await panel
    .locator('.pnl-make[data-make="members"]')
    .getByRole('button', { name: '부재 만들기' })
    .waitFor();
  assert.equal(await panel.locator('.pnl-make[data-blocked]').count(), 0);

  // ── '다시 계산 필요' shows, holds the result dimmed, and clears on [다시 계산] ──────────────
  fake.state.holdMembers = true;
  const thick = panel.getByRole('slider', { name: '두께' });
  await thick.focus();
  await thick.press('ArrowRight');
  const band = panel.locator('[data-stale-band]');
  await band.getByText('다시 계산 필요', { exact: false }).waitFor();
  assert.match(
    await panel.locator('.pnl-rail button[data-stage="members"]').textContent(),
    /다시 계산 필요/,
  );
  await panel
    .locator('.pnl-make[data-make="members"]')
    .getByText(/다시 계산 필요/)
    .waitFor();
  assert.equal(await drawer.getAttribute('data-stale'), 'true');
  await drawer.locator('[data-export-note]').getByText('다시 계산 필요').waitFor();
  fake.state.holdMembers = false;
  await band.getByRole('button', { name: '다시 계산' }).click();
  await band.waitFor({ state: 'detached' });

  // ── Schedule ↔ 3D ───────────────────────────────────────────────────────────────────────
  const table = drawer.getByRole('table', { name: '패널 일람표' });
  await table.locator('tr[data-panel="P-1-2"]').click();
  assert.equal(await table.locator('tr[data-panel="P-1-2"]').getAttribute('aria-selected'), 'true');
  let record = await page.evaluate(() => window.paneling.record);
  assert.deepEqual(record.focus.at(-1), { overlay: 'paneling-panels', itemId: 'P-1-2' });
  await page.evaluate(() =>
    window.paneling.view.focus({ overlay: 'paneling-panels', itemId: 'P-2-2' }),
  );
  const picked = await page.evaluate(() => {
    const box = document.querySelector('#panel-root').nextElementSibling.getBoundingClientRect();
    return window.paneling.view.pickAt(box.x + box.width / 2, box.y + box.height / 2).source;
  });
  assert.deepEqual(picked, { source: 'overlay', key: 'paneling-panels', itemId: 'P-2-2' });

  // ── Stage 3 and the 색 기준 ────────────────────────────────────────────────────────────────
  await panel.locator('.pnl-rail button[data-stage="optimize"]').click();
  assert.equal(await kpi('타입').textContent(), '3');
  assert.equal(await kpi('허용 오차 넘음').textContent(), '1');
  await drawer.getByLabel('색 기준', { exact: true }).selectOption('type');
  tone = await tones();
  assert.equal(tone['P-1-1'], 'ov-cat-1');
  assert.equal(tone['P-1-3'], 'ov-cat-2');
  assert.equal(tone['P-2-5'], 'ov-clash');
  assert.match(await drawer.locator('.pnl-legend').textContent(), /T-01\s*6.*T-02\s*2.*실패\s*1/);
  await drawer.getByLabel('색 기준', { exact: true }).selectOption('flatness');
  tone = await tones();
  assert.equal(tone['P-2-2'], 'warn');
  await drawer.getByRole('tab', { name: '타입 3' }).click();
  await drawer.getByRole('table', { name: '타입 일람표' }).locator('tr[data-type="T-02"]').click();
  record = await page.evaluate(() => window.paneling.record);
  assert.deepEqual(record.focus.at(-1), { overlay: 'paneling-panels', itemId: 'P-1-3' });
  await drawer.getByRole('tab', { name: /^결합부/ }).click();
  await drawer.getByRole('table', { name: '노드 타입' }).getByText('N-01').waitFor();
  await drawer.getByRole('table', { name: '줄눈 타입' }).getByText('J-01').waitFor();

  // ── CSV ─────────────────────────────────────────────────────────────────────────────────
  await drawer.locator('.pnl-csv > summary').click();
  const [csvFile] = await Promise.all([
    page.waitForEvent('download'),
    drawer.locator('[data-csv="panels"]').click(),
  ]);
  // The first line stays the column head; the export's marks go in the name (SPEC-16.11).
  const note = (await drawer.locator('[data-export-note]').textContent()) ?? '';
  assert.match(note, /가정 값 \d+개 포함/);
  assert.match(
    csvFile.suggestedFilename(),
    new RegExp(`^패널링-패널-\\d{8}-\\d{4}-${note.split(' · ').join('-')}\\.csv$`),
  );
  const csvText = await readFile(await csvFile.path(), 'utf8');
  assert.ok(csvText.startsWith('﻿번호,면,행,열,경계,타입,등급,가로(mm),세로(mm)'));
  assert.equal(csvText.trimEnd().split('\r\n').length, 11);
  // [보고서]: the engine's page of the jig's report frame, saved as HTML with the same marks.
  const [reportFile] = await Promise.all([
    page.waitForEvent('download'),
    drawer.locator('[data-report]').click(),
  ]);
  assert.match(reportFile.suggestedFilename(), /^패널링-보고서-\d{8}-\d{4}-.+\.html$/);
  assert.match(await readFile(await reportFile.path(), 'utf8'), /타입 3개로 묶었습니다/);
  if (shot) await page.screenshot({ path: `${shot}/paneling.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();

  // ── A remote screen: views only ─────────────────────────────────────────────────────────
  {
    const { page, panel, errors } = await open(browser, { remote: true }, { surface: true });
    await panel.getByText('만들기는 작업 PC 화면에서 합니다.').waitFor();
    await panel.getByText('면 읽기는 작업 PC 화면에서 합니다.').waitFor();
    assert.equal(await panel.getByRole('button', { name: /만들기$/ }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: '다시 읽기' }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: /빠진 값 묻기/ }).count(), 0);
    await panel.locator('.pnl-kpis .kit-kpi[data-kpi="패널"]').getByText('8').waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── A narrow jig column (420 px and less): rail chips and two-line rows ──────────────────
  {
    const { page, panel, errors } = await open(browser, { width: 400 }, { surface: true });
    const row = panel.locator('tr[data-panel="P-1-1"]');
    await row.waitFor();
    assert.equal(await row.evaluate((el) => getComputedStyle(el).display), 'grid');
    const rail = await panel
      .locator('.pnl-rail li')
      .evaluateAll((items) => items.map((li) => Math.round(li.getBoundingClientRect().top)));
    assert.equal(new Set(rail).size, 1, 'the rail is one row of chips');
    const width = await page.evaluate(() => {
      const root = document.querySelector('#panel-root');
      return { scroll: root.scrollWidth, client: root.clientWidth };
    });
    assert.ok(width.scroll <= width.client + 1, `no sideways scroll: ${JSON.stringify(width)}`);
    if (shot) await page.screenshot({ path: `${shot}/paneling-narrow.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('browser-paneling: ok');
} finally {
  await browser?.close();
}

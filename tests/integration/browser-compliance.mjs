// 법규 체크 jig screen (PLAN-48 T-239, SPEC-15.9·15.11·15.12·15.13·15.16, Design SCR-32), against
// the contract with a fake engine: the declared panel of `vide/compliance-check` is drawn by the real
// `JigPanel` and viewport in a bare page, and the engine routes (`…/jig-instances/:id`, `…/run`,
// `…/jig-outputs/:key`, `…/compliance/roles`, `…/compliance/proposals`) are answered here with a
// result shaped as `ComplianceResult` (tests/fixtures/compliance-result.mjs). Nothing runs on open;
// [법규 체크] computes; the table shows state chips, reasons, 근거 links and 법규 답 numbers, and
// unfolds 숫자 출처 · 경우 · 구간 · 초과 부분; a row selects its objects (`vide:select-native`)
// and frames its exceedance in the 3D overlay; the 최대 외피 outline turns on; CSV and the report
// download; taking an AI proposal makes the result '다시 체크 필요' (dimmed, exports off) until the
// next check; a remote screen has no [법규 체크] nor proposal buttons and its settings are locked; a
// 400 px column reads rows in two lines. 2026-10-08 보강: the panel reads the document once on open
// (role counts before any check) and again at [법규 체크]; what goes to the AI is shown before it is
// sent; a person sets a layer's or an object's role directly and takes objects out of a proposal; a
// failed check says why and keeps the earlier result dimmed; a changed Rhino document (the revision
// route) makes the result '다시 체크 필요'; an exceedance row is reached by keyboard. No host, no
// server.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { complianceFixture, LINK, OBJ } from '../fixtures/compliance-result.mjs';

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
      entry: fileURLToPath(new URL('./browser-compliance-fixture.mjs', import.meta.url)),
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

/** The fake engine: one instance of `vide/compliance-check` and what its routes answer. */
function engine() {
  const state = {
    checked: false,
    runs: [],
    rolesVersion: 3,
    limitsStatus: 'done',
    proposal: 'proposed',
    decided: [],
    proposed: 0,
    reads: 0,
    readFails: false,
    runFails: false,
    revision: 'rhino|doc-합성|7',
    putRoles: [],
  };
  const param = (key, title, type, value) => ({
    key,
    title,
    group: '설정',
    type,
    unit: '',
    displayUnit: '',
    value,
    displayValue: value,
    by: 'default',
    at: '2026-10-08T08:00:00.000Z',
  });
  const view = () => ({
    id: 'i1',
    jig: { id: 'vide/compliance-check', version: '0.1.0', name: '법규 체크', remote: 'view' },
    title: '법규 체크 1',
    status: 'done',
    body: { layerRoot: 'VIDE::법규 체크', assembly: {} },
    steps: [
      {
        id: 'check',
        title: '법규 체크',
        kind: 'code',
        speed: 'manual',
        status: state.checked ? 'done' : 'pending',
      },
    ],
    params: [
      param('exclusionsComplete', '산정 제외 면적 입력 끝남', 'toggle', false),
      param('includeHidden', '숨긴 객체 포함', 'toggle', false),
    ],
    inputs: [
      { key: 'model', title: '모델(Rhino 문서)', kind: 'host-document' },
      {
        key: 'limits',
        title: '규제 조건(건축 가능 영역·매스)',
        kind: 'jig-output',
        from: { jig: 'vide/buildable-mass', output: 'limits' },
      },
      {
        key: 'siteModel',
        title: '대지(사이트 모델링)',
        kind: 'jig-output',
        from: { jig: 'vide/site-model', output: 'summary' },
      },
    ],
    updatedAt: '2026-10-08T09:00:00.000Z',
  });
  const result = () => {
    const r = complianceFixture();
    r.inputs.model.rolesVersion = state.rolesVersion;
    return r;
  };
  const source = (key, jig, instanceId, title) => ({
    input: { key, title, from: { jig, output: key === 'limits' ? 'limits' : 'summary' } },
    chosen: null,
    current: {
      instanceId,
      title,
      jig,
      version: '0.5.0',
      updatedAt: '2026-10-08T08:00:00.000Z',
      step: 'x',
      status: key === 'limits' ? state.limitsStatus : 'done',
      at: '2026-10-08T08:00:00.000Z',
      hash: 'h',
    },
    ready: key === 'limits' ? state.limitsStatus === 'done' : true,
    reason: null,
    candidates: [],
    stale: false,
  });
  const proposal = () => ({
    id: 'pr1',
    scope: 'group',
    layer: 'Default',
    objectIds: [OBJ.stall],
    role: 'parking',
    floor: null,
    use: null,
    reason: '2.5 × 5.0 m 닫힌 사각형 9개',
    state: state.proposal,
  });
  async function answer(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : undefined;
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (path === '/projects/p1/jig-instances/i1' && method === 'GET') return json(view());
    if (path === '/projects/p1/jig-instances/i1/run' && method === 'POST') {
      state.runs.push(body);
      // Only [법규 체크] (a confirmed run up to `check`) computes; opening reads what is kept.
      const pressed = body?.mode === 'confirmed' && body?.until === 'check';
      // A step that fails (the engine answers 200 with the step's error, SPEC-15.14).
      if (pressed && state.runFails)
        return json({
          steps: [
            {
              id: 'check',
              kind: 'library',
              status: 'failed',
              inputHash: 'h2',
              cached: false,
              ms: 3,
              gates: [],
              error: { code: 'THROW', message: '시험: 계산 중 오류' },
            },
          ],
          outputs: {},
          blocked: true,
          superseded: false,
        });
      if (pressed) state.checked = true;
      return json({
        steps: [
          {
            id: 'check',
            kind: 'code',
            status: pressed ? 'done' : 'skipped',
            inputHash: 'h',
            cached: !pressed,
            ms: 4,
            gates: [],
          },
        ],
        outputs: state.checked ? { check: result() } : {},
        blocked: false,
        superseded: false,
      });
    }
    const out = /^\/projects\/p1\/jig-instances\/i1\/jig-outputs\/(\w+)$/.exec(path);
    if (out)
      return json(
        out[1] === 'limits'
          ? source('limits', 'vide/buildable-mass', 'mass-1', '매스 A')
          : source('siteModel', 'vide/site-model', 'site-1', '대지 1'),
      );
    if (path === '/projects/p1/compliance/roles' && method === 'GET')
      return json({
        records: [
          {
            documentKey: 'doc-합성',
            scope: 'layer',
            key: '건물::주차',
            role: 'parking',
            floor: null,
            use: null,
            by: 'person',
            at: '2026-10-08T08:30:00.000Z',
            geometryHash: null,
          },
        ],
        version: state.rolesVersion,
        proposals: [proposal()],
      });
    if (path === '/projects/p1/compliance/read' && method === 'POST') {
      state.reads++;
      if (state.readFails)
        return json({ code: 'HOST_NOT_CONNECTED', message: 'HOST_NOT_CONNECTED' }, 409);
      return json({
        readId: `r${state.reads}`,
        linkId: LINK,
        documentKey: 'doc-합성',
        revisionKey: state.revision,
        readAt: '2026-10-08T09:30:00.000Z',
        toMeters: 1,
        rolesVersion: state.rolesVersion,
        objects: 14,
        unclassified: 3,
        byRole: { mass: 2, floor: 3, parking: 9 },
        unusedByReason: { '역할 없음': 2, '닫히지 않음': 1 },
        aiAccepted: 0,
        hiddenWithRole: 0,
        geometryChanged: 0,
        missingRecords: [
          {
            documentKey: 'doc-합성',
            scope: 'object',
            key: '6f1c2b1e-1111-4a6b-9c1d-0000000000ff',
            role: 'mass',
            floor: null,
            use: null,
            by: 'person',
            at: '2026-10-08T08:00:00.000Z',
            geometryHash: null,
          },
        ],
        notes: [],
        rows: [
          {
            objectId: '6f1c2b1e-1111-4a6b-9c1d-0000000000a1',
            layer: 'Default',
            role: null,
            roleSource: null,
            hidden: false,
            reason: '역할 없음',
          },
          {
            objectId: '6f1c2b1e-1111-4a6b-9c1d-0000000000a2',
            layer: '고객사 A동::외피',
            role: null,
            roleSource: null,
            hidden: false,
            reason: '역할 없음',
          },
          {
            objectId: '6f1c2b1e-1111-4a6b-9c1d-0000000000a3',
            layer: '건물',
            role: 'mass',
            roleSource: null,
            hidden: false,
            reason: '닫히지 않음',
          },
        ],
      });
    }
    if (path === '/projects/p1/compliance/revision' && method === 'GET')
      return json(
        state.revision === null
          ? { linkId: url.searchParams.get('linkId'), revisionKey: null, reason: '문서가 닫힘' }
          : { linkId: url.searchParams.get('linkId'), revisionKey: state.revision },
      );
    if (path === '/projects/p1/compliance/roles' && method === 'PUT') {
      state.putRoles.push(body);
      state.rolesVersion++;
      return json({ records: [], version: state.rolesVersion, proposals: [proposal()] });
    }
    if (path === '/projects/p1/compliance/proposals' && method === 'POST') {
      state.proposed++;
      return json({ proposals: [proposal()], rejected: [{ why: '목록 밖 역할: 계단' }] });
    }
    if (path === '/projects/p1/compliance/proposals/pr1' && method === 'POST') {
      state.decided.push(body);
      state.proposal = body.action === 'accept' ? 'accepted' : 'rejected';
      state.rolesVersion++;
      return json({ ok: true });
    }
    return json({ code: 'NOT_FOUND', message: path }, 404);
  }
  return { state, answer };
}

async function open(browser, options = {}) {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1000 },
    acceptDownloads: true,
  });
  const errors = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  const fake = engine();
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
    window.compliance = mount(options);
  }, options);
  const panel = page.locator('[data-jig-panel="vide/compliance-check"]');
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

  // ── Opening: nothing is read or computed until [법규 체크] ──────────────────────────────
  const { page, panel, fake, errors } = await open(browser);
  const drawer = panel.locator('.cmp-drawer');
  await drawer
    .getByRole('status')
    .getByText('아직 체크하지 않았습니다', { exact: false })
    .waitFor();
  assert.equal(fake.state.checked, false, 'opening does not run the check');
  assert.ok(
    fake.state.runs.every((r) => r.mode !== 'confirmed'),
    'no confirmed run on open',
  );
  const kpi = (state) => panel.locator(`.cmp-kpis .kit-kpi[data-kpi="${state}"] .kit-kpi-value`);
  assert.match(await kpi('위반').textContent(), /체크 전/);
  assert.equal(await drawer.getByRole('button', { name: 'CSV' }).isDisabled(), true);
  await drawer.getByText('[법규 체크] 뒤 내보낼 수 있습니다').waitFor();
  assert.match(await panel.locator('[data-last-check]').textContent(), /아직 체크하지 않았습니다/);
  // The role check read the document once on open: counts before any check (SPEC-15.3 1).
  const roles = panel.locator('.cmp-roles');
  await roles.locator('[data-role="parking"]').waitFor();
  assert.match(await roles.locator('[data-role="parking"]').textContent(), /주차 구획\s*9/);
  assert.equal(fake.state.reads, 1, 'one read on open');
  assert.equal(await panel.getByLabel('숨긴 객체 포함').isDisabled(), false, 'settings on this PC');
  // Both earlier results are named by the jig-source cards.
  await panel.locator('.jig-source', { hasText: '매스 A' }).waitFor();
  await panel.locator('.jig-source', { hasText: '대지 1' }).waitFor();

  // ── [법규 체크]: a read that fails stops with its reason, nothing runs ─────────────────────
  fake.state.readFails = true;
  await panel.getByRole('button', { name: '법규 체크', exact: true }).click();
  await panel
    .locator('[data-check-failed]')
    .getByText('연결된 Rhino 문서가 없거나')
    .first()
    .waitFor();
  assert.ok(
    fake.state.runs.every((r) => r.mode !== 'confirmed'),
    'no check without a read',
  );
  fake.state.readFails = false;
  // ── [법규 체크] ───────────────────────────────────────────────────────────────────────
  await panel
    .getByRole('button', { name: /법규 체크/ })
    .first()
    .click();
  const table = panel.getByRole('table', { name: '법규 체크 결과' });
  await table.waitFor();
  assert.equal(fake.state.checked, true);
  assert.deepEqual(fake.state.runs.at(-1), { mode: 'confirmed', until: 'check' });
  assert.ok(fake.state.reads >= 3, 'the document is read again at [법규 체크]');
  assert.equal(await kpi('위반').textContent(), '5');
  assert.equal(await kpi('적합').textContent(), '3');
  assert.equal(await kpi('미확정').textContent(), '3');
  const head = await panel.locator('[data-headline]').textContent();
  assert.doesNotMatch(head, /위반 없음/);
  assert.match(head, /위반 5/);
  assert.match(
    await panel.locator('[data-last-check]').textContent(),
    /마지막 체크 .* · 문서 판 7/,
  );
  // The notice is on the screen.
  await panel
    .getByText('탐색용 법규 체크 — 인허가 검토·법규 검토를 대체하지 않음', { exact: false })
    .first()
    .waitFor();
  await panel.getByText('탐색용 법규 체크 · 인허가 검토 아님').waitFor();

  // Rows: groups, every check once (18 rows + 1 미적용), state chips and reasons.
  assert.deepEqual(
    await table.locator('tbody[data-group]').evaluateAll((g) => g.map((x) => x.dataset.group)),
    ['규모', '형상 제한', '주차·조경·공개공지'],
  );
  assert.equal(await table.locator('tr.cmp-row').count(), 18);
  const row = (check) => table.locator(`tr.cmp-row[data-check="${check}"]`);
  assert.equal(await row('coverage').locator('.cmp-state').getAttribute('data-tone'), 'ok');
  assert.equal(await row('sun').locator('.cmp-state').getAttribute('data-tone'), 'ng');
  assert.equal(await row('far').locator('.cmp-state').getAttribute('data-tone'), 'warn');
  assert.equal(await row('open-space').locator('.cmp-state').getAttribute('data-tone'), 'info');
  assert.equal(await row('zone:chamfer').locator('.cmp-state').getAttribute('data-tone'), 'na');
  assert.match(await row('sun').locator('.cmp-state').textContent(), /✕ 위반/);
  assert.match(await row('far').locator('.cmp-reason').textContent(), /완화 조건 미확정/);
  // A 위반 by 4 mm does not read as equal.
  assert.equal(await row('height:heightMax').locator('.cmp-planned').textContent(), '30.004 m');
  assert.match(await row('height:heightMax').locator('.cmp-limit').textContent(), /^30\.000 m/);
  assert.equal(await row('parking').locator('.cmp-margin').getAttribute('data-over'), '');
  // '가정' limit tag, 근거 link chip and 법규 답 number; an unsafe link stays words.
  await row('floors').locator('.cmp-tag', { hasText: '가정' }).waitFor();
  const link = row('coverage').getByRole('link', { name: '시험용 조항 제1조' });
  assert.equal(await link.getAttribute('href'), 'https://law.example/1');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await row('coverage').locator('[data-answer]').textContent(), 'L3');
  assert.equal(await row('sun').getByRole('link').count(), 0, 'javascript: is not a link');
  // 미적용 tab.
  await drawer.getByRole('tab', { name: /^미적용/ }).click();
  await drawer.getByRole('table', { name: '미적용 항목' }).getByText('높이 · 가로구역').waitFor();
  await drawer.getByRole('tab', { name: /^결과/ }).click();

  // ── 3D: exceedances drawn with the table's numbers; a row selects and frames ──────────────
  const overlay = () =>
    page.evaluate(() =>
      window.compliance.view.overlayInfo().map((layer) => ({
        key: layer.key,
        items: layer.items,
      })),
    );
  assert.deepEqual(await overlay(), [{ key: 'compliance-exceedance', items: ['x1', 'x2', 'x3'] }]);
  await row('sun').locator('.cmp-title').click();
  assert.equal(await row('sun').getAttribute('aria-expanded'), 'true');
  const detail = table.locator('tr.cmp-detail-row');
  await detail.getByRole('table', { name: '정북 일조 초과 부분' }).waitFor();
  assert.match(await detail.textContent(), /정북 일조 · 기준 · 기준 지반/);
  assert.match(await detail.textContent(), /24\.000 ㎥/);
  const record = await page.evaluate(() => window.compliance.record);
  assert.deepEqual(record.selected.at(-1), {
    label: '정북 일조',
    objects: [{ linkId: LINK, nativeIds: [OBJ.top] }],
  });
  assert.deepEqual(record.focus.at(-1), { overlay: 'compliance-exceedance', itemId: 'x1' });
  // An exceedance row is reached and opened by keyboard too.
  await page.evaluate(() =>
    window.compliance.view.focus({ overlay: 'compliance-exceedance', itemId: 'x2' }),
  );
  await detail.locator('tr[data-exceedance="1"]').focus();
  await page.keyboard.press('Enter');
  assert.deepEqual((await page.evaluate(() => window.compliance.record)).focus.at(-1), {
    overlay: 'compliance-exceedance',
    itemId: 'x1',
  });
  // The framed exceedance is under the screen centre: picking it opens its row.
  await row('coverage').locator('.cmp-title').click();
  assert.equal(await row('coverage').getAttribute('aria-expanded'), 'true');
  await page.evaluate(() =>
    window.compliance.view.focus({ overlay: 'compliance-exceedance', itemId: 'x2' }),
  );
  const picked = await page.evaluate(() => {
    const box = document.querySelector('#panel-root').nextElementSibling.getBoundingClientRect();
    return window.compliance.view.pickAt(box.x + box.width / 2, box.y + box.height / 2).source;
  });
  assert.deepEqual(picked, { source: 'overlay', key: 'compliance-exceedance', itemId: 'x2' });
  // Cases and parts unfold apart; numbers keep their source.
  await row('far').locator('.cmp-title').click();
  assert.match(
    await detail.locator('[data-cases]').textContent(),
    /완화 넣음 → ✓ 적합.*완화 뺌 → ✕ 위반/,
  );
  await detail
    .getByRole('table', { name: '용적률 숫자 출처' })
    .getByText('regulation:farBase')
    .waitFor();
  await row('zone:roadSetback').locator('.cmp-title').click();
  assert.match(
    await detail.locator('[data-parts]').textContent(),
    /도로 1 → ✕ 위반.*도로 2 → ✎ 사람 입력 필요/,
  );
  // 최대 외피 outline on demand.
  await drawer.getByLabel('최대 외피 윤곽').check();
  assert.deepEqual((await overlay()).map((l) => l.key).sort(), [
    'compliance-envelope',
    'compliance-exceedance',
  ]);

  // ── Exports ───────────────────────────────────────────────────────────────────────────
  const [csvFile] = await Promise.all([
    page.waitForEvent('download'),
    drawer.getByRole('button', { name: 'CSV' }).click(),
  ]);
  assert.match(csvFile.suggestedFilename(), /^법규-체크-\d{8}-\d{4}\.csv$/);
  const csvText = await readFile(await csvFile.path(), 'utf8');
  assert.match(csvText, /번호,검사,묶음,상태,계획 값,한계 값/);
  assert.equal(csvText.trimEnd().split('\r\n').length, 20);
  const [reportFile] = await Promise.all([
    page.waitForEvent('download'),
    drawer.getByRole('button', { name: '보고서' }).click(),
  ]);
  const html = await readFile(await reportFile.path(), 'utf8');
  for (const words of ['탐색용 법규 체크', '초과 부분', '미적용 항목', '분류 요약', '정북 일조'])
    assert.ok(html.includes(words), words);

  // ── The Rhino document changed after the check: '다시 체크 필요' (SPEC-15.13) ──────────────
  fake.state.revision = 'rhino|doc-합성|8';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await panel
    .locator('[data-stale-band]')
    .getByText('Rhino 모델이 바뀜', { exact: false })
    .waitFor();
  assert.equal(await drawer.getByRole('button', { name: 'CSV' }).isDisabled(), true);
  fake.state.revision = null;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await panel
    .locator('[data-stale-band]')
    .getByText('모델 판 확인 불가', { exact: false })
    .waitFor();
  fake.state.revision = 'rhino|doc-합성|7';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await panel.locator('[data-stale-band]').waitFor({ state: 'detached' });

  // ── Classification: proposals are taken one by one; then '다시 체크 필요' ─────────────────
  assert.match(await roles.locator('[data-role="parking"]').textContent(), /주차 구획\s*9/);
  await roles.getByText('역할 없음 1 · 닫히지 않음 1').waitFor();
  await roles.getByText('형상이 바뀐 객체 1 · 역할은 그대로').waitFor();
  await roles.getByText('확인한 분류 1개').waitFor();
  const proposal = roles.locator('[data-proposal="pr1"]');
  await proposal.getByText('2.5 × 5.0 m 닫힌 사각형 9개').waitFor();
  assert.equal(await roles.getByRole('button', { name: /모두 받기|전부 받기/ }).count(), 0);
  // What goes to the AI is shown first; nothing is sent until the person sends it (SPEC-15.4 1).
  await roles.getByRole('button', { name: '역할 제안 받기' }).click();
  const send = roles.locator('[data-send]');
  await send.getByText('레이어 이름 2개와 역할 없는 객체 2개의 묶음', { exact: false }).waitFor();
  await send.getByText('고객사 A동::외피').waitFor();
  assert.equal(fake.state.proposed, 0, 'not sent before the person sends it');
  await send.getByRole('button', { name: '보내고 제안 받기' }).click();
  await roles.getByText('버린 제안 1: 목록 밖 역할: 계단').waitFor();
  assert.equal(fake.state.proposed, 1);
  // A person sets roles directly and clears records of objects no longer in the model.
  await roles.locator('[data-own-roles] summary').click();
  await roles.getByLabel('Default 레이어 역할').selectOption('ignore');
  await roles.locator('[data-own-layer="Default"]').getByRole('button', { name: '정하기' }).click();
  await page.waitForFunction(() => true);
  await roles.getByRole('button', { name: '기록 지우기' }).click();
  await roles.locator('[data-own-roles]').waitFor();
  for (let i = 0; i < 50 && fake.state.putRoles.length < 2; i++) await page.waitForTimeout(50);
  assert.deepEqual(fake.state.putRoles[0].set, [
    { scope: 'layer', key: 'Default', role: 'ignore' },
  ]);
  assert.deepEqual(fake.state.putRoles[1].remove, [
    { scope: 'object', key: '6f1c2b1e-1111-4a6b-9c1d-0000000000ff' },
  ]);
  // The proposal keeps its objects unless one is taken out.
  await proposal.locator('.cmp-exclude summary').click();
  await proposal.locator('.cmp-exclude input[type="checkbox"]').first().uncheck();
  await proposal.locator('.cmp-exclude input[type="checkbox"]').first().check();
  // The mass work copy now needs computing: the band will say so.
  fake.state.limitsStatus = 'stale';
  await proposal.getByRole('button', { name: '받기' }).click();
  await panel
    .locator('[data-stale-band]')
    .getByText('규제 조건이 바뀜(건축 가능 영역·매스를 다시 계산)', { exact: false })
    .waitFor();
  assert.deepEqual(fake.state.decided, [{ action: 'accept' }]);
  const band = await panel.locator('[data-stale-band]').textContent();
  assert.match(band, /다시 체크 필요/);
  assert.match(band, /분류가 바뀜/);
  assert.match(band, /규제 조건이 바뀜\(건축 가능 영역·매스를 다시 계산\)/);
  assert.match(band, /먼저 건축 가능 영역·매스를 다시 계산하세요/);
  assert.equal(await drawer.getAttribute('data-stale'), 'true');
  assert.equal(
    await drawer.locator('.cmp-body').evaluate((el) => getComputedStyle(el).opacity),
    '0.6',
  );
  assert.equal(await drawer.getByRole('button', { name: 'CSV' }).isDisabled(), true);
  assert.equal(await drawer.getByRole('button', { name: '보고서' }).isDisabled(), true);
  await drawer.getByText('다시 체크한 뒤 내보낼 수 있습니다').waitFor();
  assert.equal(fake.state.runs.filter((r) => r.mode === 'confirmed').length, 1, 'no re-run');
  if (shot) await page.screenshot({ path: `${shot}/compliance-stale.png`, fullPage: true });
  // Checking again (the mass recomputed) clears it.
  fake.state.limitsStatus = 'done';
  await panel.locator('[data-stale-band]').getByRole('button', { name: '법규 체크' }).click();
  await panel.locator('[data-stale-band]').waitFor({ state: 'detached' });
  assert.equal(await drawer.getByRole('button', { name: 'CSV' }).isDisabled(), false);
  // A check that fails says why and keeps the earlier result dimmed, exports off (SPEC-15.14).
  fake.state.runFails = true;
  await panel.getByRole('button', { name: '법규 체크', exact: true }).first().click();
  await panel
    .locator('[data-check-failed]')
    .getByText('시험: 계산 중 오류', { exact: false })
    .first()
    .waitFor();
  await panel.locator('[data-stale-band]').getByText('마지막 체크 실패 · 이전 결과').waitFor();
  assert.match(
    await panel.locator('[data-last-check]').textContent(),
    /마지막 체크 실패 · 이전 결과/,
  );
  assert.equal(await drawer.getByRole('button', { name: 'CSV' }).isDisabled(), true);
  await table.waitFor();
  fake.state.runFails = false;
  await panel.getByRole('button', { name: '법규 체크 다시 누르기' }).click();
  await panel.locator('[data-stale-band]').waitFor({ state: 'detached' });
  if (shot) await page.screenshot({ path: `${shot}/compliance-result.png`, fullPage: true });
  // The one 409 is the read this test made fail on purpose.
  assert.deepEqual(
    errors.filter((e) => !/status of 409/.test(e)),
    [],
  );
  await page.close();

  // ── A remote screen: views only (SPEC-15.16) ──────────────────────────────────────────────
  {
    const { page, panel, errors, fake } = await open(browser, { remote: true });
    await panel.getByText('법규 체크는 작업 PC 화면에서 합니다.').waitFor();
    assert.equal(await panel.getByRole('button', { name: '법규 체크', exact: true }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: '역할 제안 받기' }).count(), 0);
    await panel.locator('[data-proposal="pr1"]').waitFor();
    assert.equal(
      await panel.locator('[data-proposal="pr1"]').getByRole('button').count(),
      0,
      'no 받기 · 버리기 on a remote screen',
    );
    // Settings are this PC's: locked on a remote screen; the document is never read from there.
    for (const name of ['산정 제외 면적 입력 끝남', '숨긴 객체 포함'])
      assert.equal(await panel.getByLabel(name).isDisabled(), true, name);
    assert.equal(await panel.locator('[data-own-roles]').count(), 0);
    assert.equal(fake.state.reads, 0, 'a remote screen never reads the document');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── A narrow jig column (420 px and less): rows in two lines ─────────────────────────────
  {
    const { page, panel, errors } = await open(browser, { width: 400 });
    await panel.getByRole('button', { name: '법규 체크', exact: true }).click();
    const narrow = panel.getByRole('table', { name: '법규 체크 결과' });
    await narrow.waitFor();
    const first = narrow.locator('tr.cmp-row').first();
    assert.equal(await first.evaluate((el) => getComputedStyle(el).display), 'grid');
    const width = await page.evaluate(() => {
      const root = document.querySelector('#panel-root');
      return { scroll: root.scrollWidth, client: root.clientWidth };
    });
    assert.ok(width.scroll <= width.client + 1, `no sideways scroll: ${JSON.stringify(width)}`);
    if (shot) await page.screenshot({ path: `${shot}/compliance-narrow.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('browser-compliance: ok');
} finally {
  await browser?.close();
}

// 만들기 tab (PLAN-22 T-063, SCR-16·18): '새로 만들기', the JIG list's last card (PLAN-26 T-099), is
// one button that opens the 시작 양식 (PLAN-40 T-185); [계획 받기] creates a blank draft, opens it in
// the 만들기 screen, which belongs to the rail's JIG, and sends the form as the make conversation's
// first turn; [만들기 시작] under the plan card sends '만들기 시작'; the draft shows in the list as
// a '작성 중' card that opens it again;
// the outline reads the manifest; 점검 · 시험 fill the console and unlock the pin; 미리보기 draws the
// draft's panel.json with the official parts; pinning and discarding ask first; [가져오기] sends a
// .vjig after a confirmation. The draft routes are mocked here (the engine side has its own tests);
// no real CLI or host.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
const directory = await mkdtemp(join(tmpdir(), 'vide-make-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [],
    calls = [];
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

  // A synthetic draft: a grid of columns from two spans.
  const manifest = {
    contractVersion: 3,
    id: 'project/grid-columns',
    version: '0.1.0',
    kind: 'tool',
    name: '격자 기둥 배치',
    summary: '두 방향 경간으로 기둥 격자를 만들어 개수를 셉니다.',
    inputs: [{ key: 'site', title: '대지 경계', kind: 'zone' }],
    params: [
      {
        key: 'spanX',
        title: 'X 경간',
        group: '격자',
        type: 'length',
        unit: 'm',
        display: { unit: 'mm', decimals: 0 },
        default: 8,
        range: { min: 4, max: 12, step: 0.5 },
        basis: { status: 'assumed' },
        affects: ['layout'],
      },
    ],
    steps: [{ id: 'layout', title: '기둥 배치', kind: 'code', reads: [], speed: 'live' }],
  };
  const panel = {
    layout: 'jig-run',
    left: [{ part: 'step-rail' }, { part: 'param-group', group: '격자' }],
    center: {
      kpis: {
        part: 'kpi-strip',
        items: [{ label: '기둥', from: 'step.layout.count', unit: 'EA' }],
      },
      views: [
        {
          part: 'plan-map',
          title: '평면',
          layers: [{ key: 'columns', from: 'step.layout.columns', shape: 'point' }],
        },
      ],
    },
    drawer: {
      part: 'result-tabs',
      tabs: [{ part: 'table', title: '기둥 목록', from: 'step.layout.columns' }],
    },
  };
  const columns = (span) =>
    [0, 1, 2].flatMap((i) => [0, 1].map((j) => ({ key: `C${i}${j}`, at: [i * span, j * 6, 0] })));
  // Made now with the starting point's files: nothing written after it (the plan comes first).
  const createdAt = new Date().toISOString();
  const draft = { id: 'draft-1', name: '격자 기둥 배치', version: '0.1.0', createdAt };
  let drafts = [];
  let state = { validate: null, test: null, preview: null };
  const files = ['jig.json', 'panel.json', 'skill.md', 'steps/layout.ts', 'fixtures/basic.json'];
  const detail = () => ({
    draft,
    manifest,
    files: files.map((path) => ({ path, updatedAt: createdAt })),
    skill: '# 격자 기둥 배치\n\n두 방향 경간으로 기둥을 둡니다.',
    conversationId: 'conv-make',
    ...state,
  });
  await page.route(/\/api\/v1\/projects\/[^/]+\/jig-drafts(\/.*)?$/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/jig-drafts/, '');
    const method = request.method();
    calls.push(`${method} ${path || '/'}`);
    if (path === '' && method === 'GET') return route.fulfill({ json: { drafts } });
    if (path === '' && method === 'POST') {
      assert.deepEqual(request.postDataJSON(), { name: '격자 기둥 배치', from: 'blank' });
      drafts = [draft];
      return route.fulfill({ status: 201, json: draft });
    }
    if (path === '/draft-1' && method === 'GET') return route.fulfill({ json: detail() });
    if (path === '/draft-1/icon' && method === 'PUT') {
      manifest.icon = request.postDataJSON().icon;
      return route.fulfill({ json: detail() });
    }
    if (path === '/draft-1/validate') {
      state.validate = { ok: true, issues: [], at: new Date().toISOString() };
      return route.fulfill({ json: state.validate });
    }
    if (path === '/draft-1/test') {
      state.test = {
        ok: true,
        cases: [{ name: 'basic', ok: true, steps: [], mismatches: [], ms: 12 }],
        at: new Date().toISOString(),
        ms: 12,
      };
      return route.fulfill({ json: state.test });
    }
    if (path === '/draft-1/preview') {
      const body = request.postDataJSON() ?? {};
      const span = body.params?.spanX ?? 8;
      state.preview = {
        panel,
        outputs: { layout: { count: 6, columns: columns(span) } },
        steps: [{ id: 'layout', status: 'done', ms: 3, gates: [] }],
        params: { spanX: span },
        fixture: 'basic',
        fixtures: ['basic'],
        at: new Date().toISOString(),
        ms: 3,
      };
      return route.fulfill({ json: state.preview });
    }
    if (path === '/draft-1/pin' && method === 'POST') {
      assert.deepEqual(request.postDataJSON(), { confirm: true });
      return route.fulfill({ json: { jigId: manifest.id, version: manifest.version } });
    }
    if (path === '/draft-1' && method === 'DELETE') {
      drafts = [];
      state = { validate: null, test: null, preview: null };
      return route.fulfill({ json: { deleted: true } });
    }
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  // Import installs on the engine's `/api/v1/jigs/import` (ARCH-03 §7), then pins to the project.
  let imported, importPinned;
  await page.route(/\/api\/v1\/jigs\/import\?confirm=true$/, (route) => {
    imported = route.request().postDataBuffer()?.toString();
    return route.fulfill({ json: { id: 'project/imported', version: '1.0.0' } });
  });
  await page.route(/\/api\/v1\/projects\/[^/]+\/jigs\/project%2Fimported\/pin$/, (route) => {
    importPinned = route.request().postDataJSON();
    return route.fulfill({ json: { pinned: { jigId: 'project/imported', version: '1.0.0' } } });
  });

  // The draft's make conversation, listed with the project's conversations; its turns are mocked.
  const makeEntry = {
    id: 'conv-make',
    kind: 'jig-make',
    title: '격자 기둥 배치 · 만들기',
    provider: null,
    model: null,
    effort: null,
    accountProfileId: null,
    mode: 'session',
    targets: null,
    state: 'open',
    requests: 0,
    pending: true,
    session: null,
    handover: null,
  };
  await page.route(/\/api\/v1\/projects\/[^/]+\/conversations(\/.*)?$/, async (route) => {
    const rest = /\/conversations(\/.*)?$/.exec(new URL(route.request().url()).pathname)[1] ?? '';
    if (route.request().method() !== 'GET') return route.continue();
    if (rest === '/conv-make')
      return route.fulfill({ json: { ...makeEntry, ledger: [], sessions: [] } });
    if (rest) return route.continue();
    const listed = await (await route.fetch()).json();
    return route.fulfill({ json: [...listed, makeEntry] });
  });
  const turns = new Map();
  await page.route(/\/api\/v1\/projects\/[^/]+\/requests(\/[^/]+)?$/, async (route) => {
    const request = route.request();
    const id = /\/requests\/([^/]+)$/.exec(new URL(request.url()).pathname)?.[1];
    if (request.method() === 'POST' && !id) {
      const input = request.postDataJSON();
      const turn = {
        id: input.id,
        input,
        state: 'succeeded',
        result: { text: '계획입니다.', hostExecuted: false },
      };
      turns.set(input.id, turn);
      return route.fulfill({ json: turn });
    }
    if (id && turns.has(id)) return route.fulfill({ json: turns.get(id) });
    return route.continue();
  });

  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const rail = page.locator('.rail');
  const jigRail = rail.locator('[data-workspace-target="jig"]');
  // No rail button of its own: 만들기 is part of JIG.
  assert.equal(await rail.locator('[data-workspace-target="make"]').count(), 0);

  // The JIG list: '새로 만들기' is its last card, one button with no field in it; [가져오기].
  await jigRail.click();
  const list = page.getByRole('dialog', { name: 'JIG', exact: true });
  const card = list.getByRole('button', { name: '새로 만들기', exact: true });
  await card.waitFor();
  assert.equal(
    await list.locator('.jig-grid > .jig-card').last().getAttribute('aria-label'),
    '새로 만들기',
  );
  assert.equal(await card.locator('input').count(), 0);
  await page.getByRole('button', { name: '가져오기', exact: true }).first().click();
  await page.locator('input[type="file"][accept=".vjig"]').setInputFiles({
    name: 'grid.vjig',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('VJIG-TEST'),
  });
  const importConfirm = page.getByRole('group', { name: '가져오기 확인' });
  await importConfirm.getByRole('button', { name: '가져오기' }).click();
  await page.getByText('가져왔습니다 · 버전 1.0.0.').waitFor();
  assert.equal(imported, 'VJIG-TEST');
  assert.deepEqual(importPinned, { version: '1.0.0', confirm: true });

  // The composer's AI (the person's last choice carries over to the new make conversation).
  await page.locator('#model').selectOption('codex-cli');
  // The card opens the 시작 양식 in the 만들기 screen; no draft is made yet.
  await card.click();
  const make = page.locator('.make-workspace');
  const brief = make.getByRole('form', { name: '시작 양식' });
  await brief.waitFor();
  assert.equal(await page.evaluate(() => document.body.dataset.workspace), 'make');
  assert.equal(await jigRail.getAttribute('aria-pressed'), 'true');
  assert.ok(!calls.includes('POST /'));
  const getPlan = brief.getByRole('button', { name: '계획 받기' });
  // Only the purpose is required.
  assert.equal(await getPlan.isDisabled(), true);
  // The structured parts: input chips (with the shapes of host layers), a setting row, a step
  // row, outputs, a pass condition, the starting point (blank by default).
  await brief.getByRole('button', { name: '호스트 레이어', exact: true }).click();
  await brief
    .getByRole('group', { name: '레이어에서 읽는 형상' })
    .getByRole('button', { name: '점' })
    .click();
  await brief.getByRole('button', { name: '설정값 추가' }).click();
  await brief.getByRole('textbox', { name: '설정값 이름' }).fill('X 경간');
  await brief.getByRole('textbox', { name: '기본값' }).fill('8');
  await brief.getByRole('button', { name: '단계 추가' }).click();
  await brief.getByRole('textbox', { name: '단계 이름' }).fill('기둥 배치');
  await brief.getByRole('button', { name: '단계 추가' }).click();
  await brief.getByRole('button', { name: '단계 지우기' }).last().click();
  assert.equal(await brief.getByRole('textbox', { name: '단계 이름' }).count(), 1);
  await brief.getByLabel('3D 미리보기선').check();
  await brief.getByLabel('기둥 돌출').check();
  await brief.getByRole('button', { name: '통과 조건 추가' }).click();
  await brief.getByRole('textbox', { name: '통과 조건' }).fill('경간 ≤ 12 m');
  assert.equal(await brief.getByLabel('빈 초안').isChecked(), true);
  assert.equal(await getPlan.isDisabled(), true);
  await brief.getByLabel('무엇을 하는 도구인가요?').fill('격자 기둥 배치');
  await getPlan.click();
  await make.getByRole('heading', { name: '격자 기둥 배치' }).waitFor();
  // The form goes as the make conversation's first turn by itself (SPEC-07.16 step 0).
  await page.waitForFunction(() => document.querySelector('#body')?.value === '');
  const firstTurn = await (async () => {
    for (let i = 0; i < 50 && !turns.size; i++) await page.waitForTimeout(100);
    return [...turns.values()][0]?.input;
  })();
  assert.ok(firstTurn, 'the first turn was sent');
  assert.equal(firstTurn.conversationId, 'conv-make');
  assert.match(firstTurn.body, /■ 목적: 격자 기둥 배치/);
  assert.match(firstTurn.body, /호스트 레이어 \[sync-layers\]: 점/);
  assert.match(firstTurn.body, /X 경간 · 길이 \(m\) · 기본값 8m/);
  assert.match(firstTurn.body, /1\. 기둥 배치 · 맡는 쪽 계산/);
  assert.match(firstTurn.body, /Rhino에 만들기: 기둥 돌출/);
  assert.match(firstTurn.body, /경간 ≤ 12 m \(어기면 막음\)/);
  assert.match(firstTurn.body, /코드와 파일을 쓰지 말고/);

  // Before [만들기 시작] the starting point's files are not 작성: 계획, and the plan card is the form.
  const side = page.locator('#right .make-side');
  const phases = side.getByRole('list', { name: '진행' });
  assert.equal(await phases.locator('[aria-current="step"]').textContent(), '계획');
  const planCard = side.getByRole('region', { name: '계획' });
  await planCard.getByText('목적 · 격자 기둥 배치').waitFor();
  await planCard.getByText('양식 6칸').waitFor();
  await planCard.getByText('통과 조건 1개').waitFor();
  // [만들기 시작] sends '만들기 시작' to the make conversation; writing starts.
  await planCard.getByRole('button', { name: '만들기 시작' }).click();
  for (let i = 0; i < 50 && turns.size < 2; i++) await page.waitForTimeout(100);
  const second = [...turns.values()][1]?.input;
  assert.equal(second?.body, '만들기 시작');
  assert.equal(second?.conversationId, 'conv-make');
  await planCard.getByRole('button', { name: '만들기 시작' }).waitFor({ state: 'detached' });
  assert.equal(await phases.locator('[aria-current="step"]').textContent(), '작성');

  // Back to the list: the draft is a '작성 중' card under 전체 and 내 초안 (with its count), and
  // [이어서 만들기] opens it again.
  await make.getByRole('button', { name: 'JIG 목록', exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.workspace === 'jig');
  const draftCard = list.locator('.jig-card[data-source="draft"]', { hasText: '격자 기둥 배치' });
  await draftCard.getByText('작성 중', { exact: true }).waitFor();
  const sources = list.getByRole('navigation', { name: '출처' });
  assert.match(await sources.getByRole('button', { name: /^내 초안/ }).textContent(), /1$/);
  await sources.getByRole('button', { name: /^내 초안/ }).click();
  assert.equal(await list.locator('.jig-card[data-source="official"]').count(), 0);
  await draftCard.waitFor();
  await sources.getByRole('button', { name: /^전체/ }).click();
  await draftCard.getByRole('button', { name: '이어서 만들기' }).click();
  await make.getByRole('heading', { name: '격자 기둥 배치' }).waitFor();
  assert.equal(await jigRail.getAttribute('aria-pressed'), 'true');
  const outline = make.getByLabel('도구 설명 개요');
  await outline.getByText('1. 기둥 배치').waitFor();
  await outline.getByText('X 경간').waitFor();
  assert.ok(await outline.getByText('steps/layout.ts').isVisible());

  // The icon (PLAN-26 T-100): the picker lists the fixed icons; the chosen one goes to jig.json.
  await outline.getByRole('button', { name: '아이콘 바꾸기' }).click();
  const icons = outline.getByRole('group', { name: '아이콘' });
  assert.equal(await icons.getByRole('button').count(), 32);
  assert.equal(
    await icons.getByRole('button', { name: '도구 아이콘' }).getAttribute('aria-pressed'),
    'true',
  );
  await icons.getByRole('button', { name: '골조 아이콘' }).click();
  await icons.waitFor({ state: 'detached' });
  assert.ok(calls.includes('PUT /draft-1/icon'));
  await outline.getByRole('button', { name: '아이콘 바꾸기' }).click();
  assert.equal(
    await icons.getByRole('button', { name: '골조 아이콘' }).getAttribute('aria-pressed'),
    'true',
  );
  await outline.getByRole('button', { name: '아이콘 바꾸기' }).click();

  // Pinning waits for 점검 and 시험.
  const pin = side.getByRole('button', { name: '이 프로젝트의 jig로 고정' });
  assert.equal(await pin.isDisabled(), true);
  await side.getByText('점검을 먼저 해야 합니다').waitFor();
  const consoleArea = make.getByLabel('점검·시험 결과');
  await consoleArea.getByRole('button', { name: '점검', exact: true }).click();
  await consoleArea.getByText('형식 점검을 통과했습니다').waitFor();
  await consoleArea.getByRole('button', { name: '시험', exact: true }).click();
  await consoleArea.getByText('시험 자료 basic').waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector('#right .make-side [data-action="pin"]')?.hasAttribute('disabled'),
  );

  // 미리보기: the draft's panel with the kit parts; moving a setting runs it again.
  await make.getByRole('button', { name: '미리보기', exact: true }).click();
  await make.locator('[data-preview]').waitFor();
  await make.getByText('미리보기 선만 · Rhino에 쓰지 않음').waitFor();
  assert.ok(await make.locator('.kit-kpi[data-kpi="기둥"]').isVisible());
  assert.ok(await make.getByText('C00').first().isVisible(), 'the preview table lists the columns');
  // 흐름 and 설명서.
  await make.getByRole('tab', { name: '흐름' }).click();
  await make.locator('.kit-rail').waitFor();
  await make.getByRole('tab', { name: '설명서' }).click();
  await make.getByLabel('설명서').getByText('두 방향 경간으로 기둥을 둡니다.').waitFor();

  // Pin asks first; the pinned jig shows in the JIG list.
  await pin.click();
  await side
    .getByRole('group', { name: '고정 확인' })
    .getByRole('button', { name: '고정' })
    .click();
  await page.waitForFunction(() => document.body.dataset.workspace === 'jig');
  assert.ok(calls.includes('POST /draft-1/pin'));

  // Discard asks first and deletes the draft (and its conversation's records on the engine).
  await draftCard.getByRole('button', { name: '이어서 만들기' }).click();
  await side.getByRole('button', { name: '버리기' }).click();
  await side
    .getByRole('group', { name: '버리기 확인' })
    .getByRole('button', { name: '버리기' })
    .click();
  await make.getByRole('form', { name: '시작 양식' }).waitFor();
  assert.ok(calls.includes('DELETE /draft-1'));
  assert.deepEqual(errors, []);
  console.log('Make tab checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

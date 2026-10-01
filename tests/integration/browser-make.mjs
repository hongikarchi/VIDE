// 만들기 tab (PLAN-22 T-063, SCR-16·18): '새로 만들기', the JIG list's last card (PLAN-26 T-099),
// creates a draft and opens it in the 만들기 screen, which belongs to the rail's JIG; the draft
// shows in the list as a '작성 중' card that opens it again;
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
  const draft = { id: 'draft-1', name: '격자 기둥 배치', version: '0.1.0' };
  let drafts = [];
  let state = { validate: null, test: null, preview: null };
  const files = ['jig.json', 'panel.json', 'skill.md', 'steps/layout.ts', 'fixtures/basic.json'];
  const detail = () => ({
    draft,
    manifest,
    files: files.map((path) => ({ path })),
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
      assert.deepEqual(request.postDataJSON(), { name: '격자 기둥 배치', from: 'example-grid' });
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

  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const rail = page.locator('.rail');
  const jigRail = rail.locator('[data-workspace-target="jig"]');
  // No rail button of its own: 만들기 is part of JIG.
  assert.equal(await rail.locator('[data-workspace-target="make"]').count(), 0);

  // The JIG list: '새로 만들기' is its last card; [가져오기].
  await jigRail.click();
  const list = page.getByRole('dialog', { name: 'JIG', exact: true });
  const card = list.getByRole('form', { name: '새로 만들기' });
  await card.waitFor();
  assert.equal(
    await list.locator('.jig-grid > .jig-card').last().getAttribute('aria-label'),
    '새로 만들기',
  );
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

  await card.getByLabel('무엇을 하는 도구인가요?').fill('격자 기둥 배치');
  await card.getByRole('button', { name: '만들기 시작' }).click();
  const make = page.locator('.make-workspace');
  await make.getByRole('heading', { name: '격자 기둥 배치' }).waitFor();
  assert.equal(await jigRail.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => document.body.dataset.workspace), 'make');

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
  const side = page.locator('#right .make-side');
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
  await make.getByRole('form', { name: '새로 만들기' }).waitFor();
  assert.ok(calls.includes('DELETE /draft-1'));
  assert.deepEqual(errors, []);
  console.log('Make tab checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

// 도면 반영 jig in the browser (SPEC-14.10·14.11, Design SCR-31, PLAN-47 T-234): opened from the JIG
// list; the target drawing, the Sync relation, the layer table (a '레이어 지정 필요' row gets a layer
// and the rows are computed again), the rows (deletes not chosen, conflicts and broken rows locked,
// [모델로 덮기], absolute-path xref and affected roots), the before/after picture, the save card
// (nothing written and no confirm before [저장]; [취소]), the result with the preservation check,
// '치수 확인 필요' and [되돌리기], the second confirmation past the delete limit, an old plugin's
// refusal, the [도곽 미리보기] tab, and a remote screen that offers no apply or save. The engine's
// drawing routes are faked here (their logic is tests/server/drawing-backflow*.test.mjs); no ZWCAD.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-backflow-browser-'));
const folder = join(directory, '2601 합성');
const root = join(folder, 'plan.dwg');
const child = join(folder, 'XREF', 'core.dwg');
const written = join(folder, 'plan-VIDE반영-20261008-1200.dwg');
const P = (x, y) => [x, y, 0];
const row = (id, kind, extra = {}) => ({
  id,
  kind,
  reason: null,
  sourceId: 'src-' + id,
  sourceLayer: 'A-WALL',
  path: root,
  handle: 'A' + id.slice(1),
  layer: 'A-WALL',
  before: { kind: 'line', points: [P(0, 0), P(1000, 0)] },
  after: { kind: 'line', points: [P(0, 0), P(1120, 0)] },
  via: 'backflow',
  selectable: true,
  selected: true,
  absoluteXref: false,
  affectedRoots: [],
  ...extra,
});
const summaryOf = (rows) => ({
  ...Object.fromEntries(
    ['add', 'modify', 'delete', 'conflict', 'broken', 'unsupported'].map((k) => [
      k,
      rows.filter((r) => r.kind === k).length,
    ]),
  ),
  pairs: rows.length,
  unchanged: 3,
  handEdited: 1,
  inSync: 0,
});
const diffOf = (id, rows) => ({
  id,
  root,
  sourceRevision: 'r1',
  drawings: [{ path: root, sha256: 'x' }],
  rows,
  copies: [],
  summary: summaryOf(rows),
  settled: true,
  changed: [],
  computedAt: '2026-10-08T12:00:00.000Z',
});
let mapped = false;
const firstRows = () => [
  row('B1', 'modify'),
  row('B2', 'add', {
    handle: null,
    before: null,
    after: { kind: 'arc', center: P(0, 0), radius: 650, start: 0, end: Math.PI / 2 },
  }),
  mapped
    ? row('B3', 'add', {
        handle: null,
        sourceLayer: 'Rhino::NEW',
        before: null,
        after: { kind: 'circle', center: P(50, 50), radius: 300 },
      })
    : row('B3', 'add', {
        reason: 'LAYER_NEEDED',
        handle: null,
        layer: null,
        sourceLayer: 'Rhino::NEW',
        before: null,
        after: { kind: 'circle', center: P(50, 50), radius: 300 },
        selectable: false,
        selected: false,
      }),
  row('B4', 'delete', { after: null, selected: false }),
  row('B5', 'conflict', { reason: 'BOTH_CHANGED', selectable: false, selected: false }),
  row('B6', 'broken', {
    reason: 'ENTITY_DELETED',
    handle: null,
    before: null,
    selectable: false,
    selected: false,
  }),
  row('B7', 'unsupported', {
    reason: 'XREF_INSERT_MOVE',
    path: child,
    selectable: false,
    selected: false,
  }),
  row('B8', 'modify', {
    path: child,
    layer: 'CORE',
    before: { kind: 'circle', center: P(0, 0), radius: 500 },
    after: { kind: 'circle', center: P(0, 0), radius: 650 },
    absoluteXref: true,
    affectedRoots: [root, join(folder, 'other.dwg')],
  }),
];
const check = (ok) => ({
  ok,
  differences: ok ? 0 : 1,
  version: { before: 'AC1032', after: 'AC1032', same: true },
  changed: { modified: 2, added: 1, deleted: 0, byType: { LINE: 1 } },
  entities: [],
  tables: ok
    ? [{ name: 'regApps', before: 2, after: 3, added: [], removed: [] }]
    : [{ name: 'layers', before: 5, after: 6, added: ['NEW'], removed: [] }],
  layouts: { before: 2, after: 2, same: true },
  xrefs: { before: 1, after: 1, same: true, changed: [] },
  unexpected: { added: [], removed: [], changed: [], counts: { added: 0, removed: 0, changed: 0 } },
});
const calls = [];
let diffs = 0;
let applyAnswer = 'confirm';
let bigDiff = false;

let app, browser;
try {
  app = await startServer({ filename: join(directory, 'data', 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
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
  const fake = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname.replace(/^\/api\/v1\/projects\/[^/]+/, '');
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    calls.push({ method, path, body, search: url.search });
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (path === '/links' && method === 'GET')
      return json([
        {
          id: 'link-cad',
          host: 'zwcad',
          name: 'plan.dwg',
          path: root,
          kind: 'host',
          connection: null,
          lastSync: { requestId: 'sync-cad', at: '2026-10-08T11:00:00.000Z' },
          display: null,
        },
        {
          id: 'link-rhino',
          host: 'rhino',
          name: 'model.3dm',
          path: join(folder, 'model.3dm'),
          kind: 'host',
          connection: null,
          lastSync: { requestId: 'sync-rhino', at: '2026-10-08T11:00:00.000Z' },
          display: null,
        },
      ]);
    if (path === '/drawing/layers' && method === 'GET' && !url.searchParams.get('path'))
      return json({
        state: 'done',
        done: 1,
        total: 1,
        error: null,
        drawings: [
          {
            path: root,
            name: 'plan.dwg',
            readAt: '2026-10-08T11:00:00.000Z',
            version: 'AC1032',
            release: '2018',
            units: 4,
            unitsAssumed: false,
            eligible: true,
            reason: null,
            error: null,
            counts: { layers: 3, linetypes: 1, textStyles: 1, dimStyles: 1, blocks: 1, xrefs: 1 },
            map: null,
          },
        ],
      });
    if (path === '/drawing/layers' && method === 'GET')
      return json({
        drawing: {},
        read: {
          layers: [{ name: 'A-WALL' }, { name: 'A-DOOR' }, { name: 'CORE|X', dependent: true }],
        },
        map: mapped
          ? {
              entries: [{ source: 'Rhino::NEW', layer: 'A-WALL', how: 'user' }],
              revision: 1,
            }
          : null,
      });
    if (path === '/drawing/layers' && method === 'PUT') {
      mapped = true;
      return json({ path: root, entries: [], sha256: 'x', revision: 1, updatedAt: '' });
    }
    if (path === '/jigs/sync')
      return json({
        alignment: {
          rotation: 0,
          translation: [1.5, -2],
          dz: 0,
          pairs: 2,
          residual: { max: 0.0004, rms: 0.0002 },
          ambiguous: false,
        },
        rows: [
          {
            id: 'R1',
            state: 'match',
            rhino: { id: 'a', nativeId: 'src-1' },
            cad: { id: 'b', nativeId: '2f' },
          },
          {
            id: 'R2',
            state: 'match',
            rhino: { id: 'c', nativeId: 'src-2' },
            cad: { id: 'd', nativeId: '30' },
          },
          { id: 'R3', state: 'offset', rhino: { id: 'e', nativeId: 'src-3' } },
        ],
      });
    if (path === '/drawing/backflow' && method === 'GET') return json({ baseline: null });
    if (path === '/drawing/backflow' && method === 'POST') {
      diffs += 1;
      if (bigDiff)
        return json(
          diffOf(
            'd'.repeat(23) + 'f',
            Array.from({ length: DELETES }, (_, i) =>
              row('B' + (i + 1), 'delete', { after: null, selected: false }),
            ),
          ),
        );
      return json(diffOf(String(diffs).padStart(24, '0'), firstRows()));
    }
    if (path === '/drawing/backflow/apply') {
      if (applyAnswer === 'plugin') return json({ code: 'ZWCAD_PLUGIN_UPDATE_REQUIRED' }, 409);
      if (applyAnswer === 'big' && !body.confirmDeletes)
        return json({ code: 'DELETE_CONFIRMATION_REQUIRED' }, 409);
      if (applyAnswer === 'big')
        return json({
          state: 'failed',
          code: 'OP_REFUSED',
          path: root,
          failed: [{ id: 'B1', code: 'LAYER_LOCKED' }],
          rolledBack: [],
          undoFailed: [],
        });
      return json({
        state: 'confirm',
        id: 'c'.repeat(24),
        expiresAt: '2026-10-08T12:30:00.000Z',
        files: [
          {
            path: root,
            mode: 'closed',
            written,
            version: 'AC1032',
            rows: ['B1', 'B2'],
            check: check(true),
            dimensions: [],
          },
          {
            path: child,
            mode: 'open',
            written: null,
            version: null,
            rows: ['B8'],
            check: null,
            dimensions: [],
          },
        ],
      });
    }
    if (/\/apply\/c+\/cancel$/.test(path)) return json({ cancelled: true });
    if (/\/apply\/c+\/confirm$/.test(path))
      return json({
        state: 'applied',
        id: 'e'.repeat(24),
        files: [
          {
            path: child,
            mode: 'open',
            written: null,
            rows: ['B8'],
            check: check(false),
            dimensions: [
              {
                handle: '3A',
                type: 'AcDbRotatedDimension',
                layer: 'DIM',
                associative: false,
                entity: 'A8',
                reason: 'NOT_LINKED',
              },
              {
                handle: '3B',
                type: 'AcDbRadialDimension',
                layer: 'DIM',
                associative: true,
                entity: 'A8',
                reason: 'NOT_FOLLOWED',
              },
            ],
            undoId: 'u1',
          },
          {
            path: root,
            mode: 'closed',
            written,
            rows: ['B1', 'B2'],
            check: check(true),
            dimensions: [],
            undoId: null,
          },
        ],
      });
    if (/\/apply\/e+\/undo$/.test(path))
      return json({
        files: [
          { path: root, undone: false, reason: 'closed' },
          { path: child, undone: true, reason: null },
        ],
      });
    return route.fallback();
  };
  const DELETES = 501;
  await page.route('**/api/v1/projects/*/links', fake);
  await page.route('**/api/v1/projects/*/drawing/**', fake);
  await page.route('**/api/v1/projects/*/drawing/layers?*', fake);
  await page.route('**/api/v1/projects/*/drawing/backflow?*', fake);
  await page.route('**/api/v1/projects/*/jigs/sync', fake);
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);

  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  await dialog
    .locator('.jig-card', { hasText: '도면 반영' })
    .getByRole('button', { name: '열기' })
    .click();
  const jig = page.locator('.drawing-jig');
  await jig.getByRole('tab', { name: '모델 변경 반영' }).waitFor();
  // The target: the linked drawing, its read, the Rhino document and the Sync relation.
  await jig.getByText('DWG 2018 · mm').waitFor();
  await jig
    .getByLabel('위치 관계')
    .getByText(/이동 \(1500, -2000\) mm · 짝 2/)
    .waitFor();
  await jig.getByText('반영 기준 없음 — Sync 일치 2행을 짝으로 씁니다').waitFor();
  const sync = calls.find((c) => c.path === '/jigs/sync');
  assert.deepEqual(sync.body, { rhino: 'sync-rhino', cad: 'sync-cad' });

  await jig.getByRole('button', { name: '차이 계산' }).click();
  const list = jig.getByRole('list', { name: '행 목록' });
  await list.getByRole('button', { name: 'B1 수정' }).waitFor();
  const diffCall = calls.filter((c) => c.path === '/drawing/backflow' && c.method === 'POST')[0];
  assert.deepEqual(diffCall.body.link, 'link-rhino');
  assert.deepEqual(diffCall.body.relation, { rotation: 0, translation: [1.5, -2], dz: 0 });
  assert.deepEqual(
    diffCall.body.pairs.map((p) => p.handle),
    ['2F', '30'],
  );
  const box = (id) => jig.getByRole('checkbox', { name: `${id} 선택` });
  // Default choice: adds and modifies; a delete waits; conflicts, broken, unsupported and rows
  // without a layer cannot be chosen.
  for (const id of ['B1', 'B2', 'B8']) assert.equal(await box(id).isChecked(), true, id);
  assert.equal(await box('B4').isChecked(), false);
  assert.equal(await box('B4').isDisabled(), false);
  for (const id of ['B3', 'B5', 'B6', 'B7']) assert.equal(await box(id).isDisabled(), true, id);
  await jig.getByText('절대 경로 xref — 같은 폴더의 새 파일을 그 루트가 보지 않음').waitFor();
  await jig.getByText('영향받는 루트: plan.dwg, other.dwg').waitFor();
  await list.getByText('원 반지름 500 → 650 mm').waitFor();
  await list.getByText('xref 삽입 이동').waitFor();

  // The layer table: the row waiting for a layer opens it; a layer is chosen and the rows come again.
  const layers = jig.locator('details.bf-layers');
  assert.equal(await layers.getAttribute('open'), '');
  await jig.getByRole('combobox', { name: 'Rhino::NEW 도면 레이어' }).selectOption('A-WALL');
  assert.deepEqual(
    await jig
      .getByRole('combobox', { name: 'Rhino::NEW 도면 레이어' })
      .locator('option')
      .allTextContents(),
    ['레이어 지정 필요', 'A-WALL', 'A-DOOR'],
  );
  await layers.getByRole('button', { name: '표 저장' }).click();
  await page.waitForFunction(() => {
    const b = document.querySelector('input[aria-label="B3 선택"]');
    return b && !b.disabled;
  });
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body, {
    path: root,
    sources: ['Rhino::NEW'],
    chosen: { 'Rhino::NEW': 'A-WALL' },
    revision: 0,
  });
  assert.equal(diffs, 2);

  // A conflict the model covers becomes chosen.
  await list
    .locator('li', { has: page.getByRole('button', { name: 'B5 충돌' }) })
    .getByRole('button', { name: '모델로 덮기' })
    .click();
  await list.getByText('충돌 → 모델로 덮음').waitFor();
  // The before/after picture of a row.
  await list.getByRole('button', { name: 'B8 수정' }).click();
  const overlay = jig.getByRole('figure', { name: '전·후 겹쳐 보기' });
  await overlay.waitFor();
  assert.equal(await overlay.locator('path.bf-before').count(), 1);
  assert.equal(await overlay.locator('path.bf-after').count(), 1);
  // Filters.
  await jig.getByRole('group', { name: '종류' }).getByRole('button', { name: '삭제 1' }).click();
  assert.equal(await list.locator('> li').count(), 1);
  await jig.getByRole('group', { name: '종류' }).getByRole('button', { name: /^전체/ }).click();
  if (shot) await page.screenshot({ path: join(shot, 'drawing-backflow-rows.png') });

  // [반영]: the save card; nothing is written and nothing confirmed before [저장].
  await jig.getByRole('button', { name: '반영', exact: true }).click();
  const card = jig.getByRole('dialog', { name: '저장 확인' });
  await card.getByText('새 파일로 저장할까요?').waitFor();
  const applyCall = calls.find((c) => c.path === '/drawing/backflow/apply');
  assert.deepEqual(applyCall.body.rows.sort(), ['B1', 'B2', 'B3', 'B8']);
  assert.deepEqual(applyCall.body.cover, ['B5']);
  assert.equal(applyCall.body.confirmDeletes, undefined);
  await card.getByText(written).waitFor();
  await card.getByText('형식 보존 차이 0').waitFor();
  assert.equal(calls.filter((c) => /\/confirm$/.test(c.path)).length, 0);
  assert.equal(existsSync(written), false);
  if (shot) await page.screenshot({ path: join(shot, 'drawing-backflow-card.png') });
  await card.getByRole('button', { name: '취소' }).click();
  await jig.getByText('저장하지 않았습니다. 쓴 파일이 없습니다.').waitFor();
  assert.equal(calls.filter((c) => /\/cancel$/.test(c.path)).length, 1);
  assert.equal(calls.filter((c) => /\/confirm$/.test(c.path)).length, 0);

  // Again, [저장]: the result with the preservation check, dimensions and [되돌리기].
  await jig.getByRole('button', { name: '반영', exact: true }).click();
  await card.getByRole('button', { name: '저장' }).click();
  const result = jig.getByLabel('반영 결과');
  await result.getByText('새 파일을 썼습니다').waitFor();
  await result.getByText('형식 보존 확인 — 차이 없음').waitFor();
  await result.getByText('레이어 5 → 6 (+NEW)').waitFor();
  assert.equal(await result.getByText(/응용 프로그램 이름/).count(), 0);
  await result.getByText('열린 도면 · 저장 안 됨 · 저장은 ZWCAD에서').waitFor();
  await result.getByText('치수 확인 필요 2').click();
  await result.getByText(/연동 안 됨 · 잰 개체/).waitFor();
  await result.getByText(/따라가지 않음/).waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'drawing-backflow-result.png') });
  await result.getByRole('button', { name: '되돌리기' }).click();
  await result.getByText('되돌렸습니다.').waitFor();

  // An installed plugin of the old release refuses the open drawing.
  applyAnswer = 'plugin';
  await result.getByRole('button', { name: '다시 계산' }).click();
  await jig.getByRole('button', { name: '반영', exact: true }).click();
  await jig.getByText(/연결 플러그인을 새 판으로 바꾼 뒤/).waitFor();

  // Past the delete limit: a second confirmation before anything is sent.
  bigDiff = true;
  applyAnswer = 'big';
  await jig.getByRole('button', { name: '차이 계산' }).click();
  await list.getByRole('button', { name: `B${DELETES} 삭제` }).waitFor();
  await page.evaluate(() =>
    document
      .querySelectorAll('.bf-rows input[type="checkbox"]:not(:checked)')
      .forEach((input) => input.click()),
  );
  await jig.getByText(`선택 ${DELETES}행 · 파일 1개`).waitFor();
  const applies = calls.filter((c) => c.path === '/drawing/backflow/apply').length;
  await jig.getByRole('button', { name: '반영', exact: true }).click();
  const ask = jig.getByRole('alertdialog', { name: '삭제 확인' });
  await ask.getByText(`삭제 ${DELETES}개는 한 번에 지우는 기준(500개)을 넘습니다.`).waitFor();
  assert.equal(calls.filter((c) => c.path === '/drawing/backflow/apply').length, applies);
  await ask.getByRole('button', { name: '삭제 포함해 반영' }).click();
  await jig.getByText(/반영하지 못했습니다 · 도면이 일부 행을 거절해/).waitFor();
  await jig.getByText('B1 · 잠긴 레이어').waitFor();
  const last = calls.filter((c) => c.path === '/drawing/backflow/apply').at(-1);
  assert.equal(last.body.confirmDeletes, true);
  assert.equal(last.body.rows.length, DELETES);

  // [도곽 미리보기] is the SCR-30 group in this jig (no drawing read by 도면 관계 here).
  await jig.getByRole('tab', { name: '도곽 미리보기' }).click();
  await jig.getByText('도면 관계가 읽은 도면이 없습니다').waitFor();
  assert.equal(await jig.getByRole('button', { name: '차이 계산' }).isVisible(), false);

  // A remote screen (https, the account site's tunnel) offers no reading, computing, apply or save.
  const http = new URL(app.launchUrl);
  const remotePage = await context.newPage();
  remotePage.setDefaultTimeout(10000);
  remotePage.on('pageerror', (error) => errors.push(error.message));
  await remotePage.route('https://vide.test/**', async (route) => {
    const url = new URL(route.request().url());
    const headers = {
      ...(await route.request().allHeaders()),
      host: http.host,
      origin: http.origin,
    };
    delete headers.referer;
    const response = await route.fetch({ url: http.origin + url.pathname + url.search, headers });
    await route.fulfill({ response });
  });
  for (const pattern of [
    '**/api/v1/projects/*/links',
    '**/api/v1/projects/*/drawing/**',
    '**/api/v1/projects/*/drawing/layers?*',
    '**/api/v1/projects/*/drawing/backflow?*',
    '**/api/v1/projects/*/jigs/sync',
  ])
    await remotePage.route(pattern, fake);
  await remotePage.route('**/api/v1/host', (route) =>
    route.fulfill({ json: { available: false } }),
  );
  await remotePage.goto('https://vide.test/' + http.hash);
  await remotePage.waitForFunction(() => document.querySelector('#project-picker')?.value);
  assert.equal(await remotePage.evaluate(() => location.protocol), 'https:');
  await remotePage.getByRole('button', { name: 'JIG', exact: true }).click();
  await remotePage
    .getByRole('dialog', { name: 'JIG', exact: true })
    .locator('.jig-card', { hasText: '도면 반영' })
    .getByRole('button', { name: '열기' })
    .click();
  const remoteJig = remotePage.locator('.drawing-jig');
  await remoteJig.getByText('반영과 저장은 작업 PC 화면에서 합니다.').first().waitFor();
  for (const name of ['차이 계산', '반영', '저장', '짝 기록', '도면 읽기'])
    assert.equal(await remoteJig.getByRole('button', { name, exact: true }).count(), 0, name);

  assert.deepEqual(errors, []);
  console.log('browser drawing backflow: ok');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

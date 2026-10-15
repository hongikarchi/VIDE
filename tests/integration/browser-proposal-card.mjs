// 갱신 제안 카드 and the map's 동기화 쌍 strip (PLAN-54 T-349·T-351, Design SCR-47): a card at the top
// of the work column with its head, sub line, rows in the Sync jig's format (5 shown, '나머지 n행'),
// a check box each, [적용]·[무시]·[나중에] and the viewport overlay toggle; [적용] sends the chosen
// rows and shows the result line; two cards fold into '갱신 제안 2건' with one opened at a time; a
// card whose drawing changed keeps [적용] off and points to the Sync jig. On the file map, pressing
// the Sync line shows [동기화 쌍으로 지정], and a designated pair '쌍 해제'. No internal words show.
// A synthetic project; the card and pair routes are stand-ins (the engine's are tested in
// tests/server/proposal-watch.test.mjs); no host.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { ProjectFolders } from '../../src/core/project-folders.ts';
import { soleDb } from '../fixtures/store.mjs';
import { seedWorkspaceMap } from '../fixtures/workspace-map.mjs';

const shot = process.env.VIDE_SHOT_DIR;
const FORBIDDEN =
  /SPEC-|PLAN-|proposal|pairId|sync-pair|overlay|stale|PROPOSAL_|PAIR_|guid-|nativeId|setHash/;
const directory = await mkdtemp(join(tmpdir(), 'vide-proposal-card-'));
const data = join(directory, 'data');
await mkdir(data);

const line = (x) => [
  [x, 0, 0],
  [x + 1, 0, 0],
];
const row = (n, state = 'offset') => ({
  id: 'R' + n,
  state,
  rhino: { id: 'o' + n, nativeId: 'guid-' + n, layer: '기둥', name: 'C' + n, type: 'curve' },
  ...(state === 'rhino-only'
    ? {}
    : { cad: { id: 'e' + n, nativeId: (40 + n).toString(16), layer: 'COL', type: 'LINE' } }),
  deviation: state === 'offset' ? 0.5 : undefined,
  length: 1,
  key: 'k' + n,
  overlay: { now: line(n), after: line(n + 0.5) },
});
const card = (id, side, rows, names = { model: 'A.3dm', drawing: 'A-평면.dwg' }) => ({
  id,
  pairId: 'pair' + id.slice(0, 8),
  changedSide: side,
  changedAt: '2026-10-15T05:02:00.000Z',
  rows,
  refused: [{ rowId: 'R7', reason: 'unsupported', code: 'SECTION_EDGE' }],
  computedAt: '2026-10-15T05:02:03.000Z',
  basis: { modelSync: 'sync-m', drawingSync: 'sync-d' },
  names,
});

let app, browser;
try {
  app = await startServer({ filename: join(data, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  for (const [pattern, json] of [
    ['**/api/v1/host', { available: false }],
    ['**/api/v1/providers', [{ id: 'codex-cli', available: true }]],
    [
      '**/api/v1/models',
      [{ id: 'test', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    ],
  ])
    await page.route(pattern, (route) => route.fulfill({ json }));

  // The engine's cards, as the stand-in holds them.
  const state = {
    cards: [
      card(
        'aaaaaaaaaaaa',
        'model',
        [1, 2, 3, 4, 5, 6, 7].map((n) => row(n, n === 6 ? 'cad-only' : 'offset')),
      ),
    ],
    calls: [],
    pairs: [],
  };
  await page.route('**/api/v1/projects/*/proposals', (route) =>
    route.fulfill({ json: { proposals: state.cards } }),
  );
  await page.route('**/api/v1/projects/*/proposals/*/*', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/');
    const action = parts.at(-1);
    const id = parts.at(-2);
    state.calls.push({ action, id, body: route.request().postDataJSON() });
    state.cards = state.cards.filter((entry) => entry.id !== id);
    if (action !== 'apply') return route.fulfill({ json: { proposal: null } });
    const rows = route.request().postDataJSON().rows;
    return route.fulfill({
      json: {
        proposal: null,
        result: {
          state: 'applied',
          id: 'a'.repeat(24),
          files: [{ path: 'C:\\x\\A-평면.dwg', rows }],
        },
      },
    });
  });

  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();

  // One card: head, sub line, 5 rows of 7 and '나머지 2행', the refused row's reason.
  const section = page.getByRole('region', { name: '갱신 제안' });
  await section.waitFor();
  await section.getByText('모델이 바뀌었어요. 도면도 맞출까요?').waitFor();
  assert.match(await section.innerText(), /A\.3dm → A-평면\.dwg · 바뀐 시각 \d\d-\d\d \d\d:\d\d/);
  const rows = section.getByRole('list', { name: '어긋남 목록' }).locator('li');
  assert.equal(await rows.count(), 5);
  assert.match(await rows.first().innerText(), /R1 · 오차 · C1 · 기둥 · 위치 500 mm/);
  await section.getByRole('button', { name: '나머지 2행' }).click();
  assert.equal(await rows.count(), 7);
  assert.match(await rows.nth(6).innerText(), /지원 안 함/);
  assert.equal(await rows.nth(6).locator('input').isDisabled(), true);
  // SPEC-14.10 3: a deletion (CAD에만) starts unticked; the others start ticked.
  assert.equal(await rows.nth(5).locator('input').isChecked(), false);
  assert.equal(await rows.nth(0).locator('input').isChecked(), true);
  assert.match(
    await section.innerText(),
    /프로그램 안에는 표시하지 못했습니다 · 여기에만 보입니다/,
  );
  // The overlay toggle and the three buttons.
  const toggle = section.getByLabel('뷰포트에 겹쳐 보기');
  assert.equal(await toggle.isChecked(), true);
  await toggle.uncheck();
  await toggle.check();
  for (const name of ['적용', '무시', '나중에'])
    assert.ok(await section.getByRole('button', { name, exact: true }).isVisible(), name);
  assert.doesNotMatch(await section.innerText(), FORBIDDEN);
  if (shot) await page.screenshot({ path: join(shot, 'proposal-card.png') });

  // [적용] with one row unticked: the chosen rows go, and the result line shows.
  await rows.nth(1).locator('input').uncheck();
  await section.getByRole('button', { name: '적용', exact: true }).click();
  await section.getByText(/도면에 4행을 맞췄습니다/).waitFor();
  const applied = state.calls.find((call) => call.action === 'apply');
  assert.deepEqual(applied.body.rows, ['R1', 'R3', 'R4', 'R5']);
  assert.match(await section.innerText(), /Ctrl\+Z 한 번/);

  // Two cards fold into one: '갱신 제안 2건', one pair opened at a time.
  state.cards = [
    card('bbbbbbbbbbbb', 'model', [row(1)]),
    card('cccccccccccc', 'drawing', [row(2), row(3, 'rhino-only')], {
      model: 'B.3dm',
      drawing: 'B-단면.dwg',
    }),
  ];
  await section.getByText('갱신 제안 2건').waitFor({ timeout: 8000 });
  const pairButtons = section.locator('.proposal-pair');
  assert.equal(await pairButtons.count(), 2);
  await pairButtons.nth(1).click();
  await section.getByText('도면이 바뀌었어요. 모델도 맞출까요?').waitFor();
  // The drawing side waits for the decision: [적용] is off, the Sync jig is pointed to.
  assert.equal(await section.getByRole('button', { name: '적용', exact: true }).isDisabled(), true);
  await section.getByText('Sync jig에서 맞추세요').waitFor();
  assert.match(await section.innerText(), /모델에서 지움/);
  await pairButtons.nth(0).click();
  assert.equal(await section.getByText('도면이 바뀌었어요. 모델도 맞출까요?').count(), 0);
  await section.getByRole('button', { name: '나중에', exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('갱신 제안 2건'));
  assert.ok(state.calls.some((call) => call.action === 'later' && call.id === 'bbbbbbbbbbbb'));
  // The one left shows alone; [무시] closes it.
  await section.getByText('도면이 바뀌었어요. 모델도 맞출까요?').waitFor();
  await section.getByRole('button', { name: '무시', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.proposal-rows'));
  assert.ok(state.calls.some((call) => call.action === 'dismiss'));

  // The map: the Sync line → [동기화 쌍으로 지정]; designated → '동기화 쌍 · …' and [쌍 해제].
  const folders = new ProjectFolders(app.store);
  const { file } = await seedWorkspaceMap({
    db: soleDb(app.store),
    projectId,
    directory,
    dataDirectory: data,
    addFolder: (path) => folders.add(projectId, path, 'project'),
  });
  await page.route('**/api/v1/projects/*/workspace/pairs', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      state.pairs.push({
        id: 'pairxxxxxxxx',
        absolute: body,
        names: { model: 'main.3dm', drawing: 'A-평면.dwg' },
        status: 'no-relation',
        createdBy: '김설계',
        createdAt: '2026-10-15T05:00:00.000Z',
        model: { role: 'rhino', path: 'main.3dm' },
        drawing: { role: 'cad', path: 'A-평면.dwg' },
      });
      return route.fulfill({ json: { pair: state.pairs[0] } });
    }
    return route.fulfill({ json: { pairs: state.pairs } });
  });
  await page.locator('.rail [data-workspace-target="files"]').click();
  const tab = page.getByRole('region', { name: '파일', exact: true });
  await tab.waitFor();
  await tab.getByRole('tablist', { name: '파일 보기' }).getByRole('tab', { name: '지도' }).click();
  const map = tab.getByRole('group', { name: '파일 지도' });
  await map.waitFor();
  await map.locator('.chart-link-hit[data-kind="sync-pair"]').first().click({ force: true });
  const strip = tab.getByRole('group', { name: '동기화 쌍' });
  await strip.waitFor();
  await strip.getByRole('button', { name: '동기화 쌍으로 지정' }).click();
  await strip.getByText(/동기화 쌍 · 김설계/).waitFor();
  assert.ok(await strip.getByRole('button', { name: '쌍 해제' }).isVisible());
  await strip.getByText(/위치 관계 없음/).waitFor();
  assert.ok(await strip.getByRole('button', { name: 'Sync jig 열기' }).isVisible());
  assert.equal((await map.locator('.chart-link-marked').count()) > 0, true);
  assert.equal(state.pairs[0].absolute.drawing.toLowerCase(), file.plan.toLowerCase());
  assert.doesNotMatch(await strip.innerText(), FORBIDDEN);
  if (shot) await page.screenshot({ path: join(shot, 'proposal-pair-strip.png') });
  assert.deepEqual(errors, []);
  console.log('browser proposal card: ok');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

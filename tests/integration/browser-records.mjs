// 기록 tab (PLAN-53 T-323·T-325, Design SCR-44): the rail's 기록 opens the list of a project's
// records (후보 + 남김 by default). Keys J/K move, O 남김, X 뺌, Backspace 표시 지움; filter chips
// narrow the list; [모두 X] asks first; the o/x/. string exported and brought back in gives the same
// marks. The 자세히 column sets the type and a part and joins records (a reversed join is refused).
// The 부위 사전 screen shows a broken layer with [다시 잇기], adds a part and a milestone. A remote
// screen reads only. No internal words show. Every sentence below is made up for this test.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Records } from '../../src/core/records.ts';

const shot = process.env.VIDE_SHOT_DIR;
const FORBIDDEN =
  /record|candidate|kept|dropped|chain|\bpart\b|JSON|세션|토큰|이벤트|타임스탬프|노드|그래프|매핑|스키마|SPEC-|PLAN-|undefined|null/;
const TOPICS = ['동측 옹벽', '2층 슬래브', '북측 계단실', '지붕 트러스', '남측 창호', '기초 보강'];
const TYPES = ['R', 'I', 'K', 'E', 'D', '?'];
const SOURCES = ['request', 'note', 'journal', 'meeting', 'sync', 'jig'];
const KEPT = new Set([3, 10, 17, 24, 31]);
const DROPPED = new Set([40, 41, 42]);
const textOf = (i) => `${TOPICS[i % 6]} 검토 메모 #${String(i + 1).padStart(3, '0')}`;

const directory = await mkdtemp(join(tmpdir(), 'vide-records-'));
const data = join(directory, 'data');
await mkdir(data);
let app, browser;
try {
  app = await startServer({ filename: join(data, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  const stubs = async (target) => {
    for (const [pattern, json] of [
      ['**/api/v1/host', { available: false }],
      ['**/api/v1/providers', [{ id: 'codex-cli', available: true }]],
      [
        '**/api/v1/models',
        [{ id: 'test', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
      ],
    ])
      await target.route(pattern, (route) => route.fulfill({ json }));
  };
  await stubs(page);

  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();

  // 120 made-up records: AI candidates of six sources and six types, 5 남김, 3 뺌; two parts.
  const records = new Records(app.store);
  const ids = [];
  for (let i = 0; i < 120; i++) {
    const day = String(1 + Math.floor(i / 4)).padStart(2, '0');
    const row = records.add(
      projectId,
      {
        date: `2026-09-${day}`,
        time: `${String(9 + (i % 4)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
        type: TYPES[i % 6],
        text: textOf(i),
      },
      { by: 'ai', source: SOURCES[i % 6], sourceKey: `test:${i}` },
    );
    ids.push(row.id);
    if (KEPT.has(i)) records.setState(projectId, row.id, 'kept', 'user');
    if (DROPPED.has(i)) records.setState(projectId, row.id, 'dropped', 'user');
  }
  const wall = records.addPart(projectId, {
    name: 'A동 옹벽',
    grp: '기존',
    roleFrom: '흙막이',
    roleTo: '지하 외벽',
    mapping: [{ kind: 'layer', linkId: 'link-test', layer: 'A-WALL' }],
  });
  records.addPart(projectId, { name: 'B동 계단', grp: '신설' });
  // The 부위 status route answers that the wall's layer is gone.
  // Re-joined to another layer, the wall is whole again.
  await page.route('**/api/v1/projects/*/parts/status', (route) => {
    const gone = records.part(projectId, wall.id).mapping[0]?.layer === 'A-WALL';
    return route.fulfill({
      json: {
        parts: [
          gone
            ? { partId: wall.id, broken: [0], reasons: ['layer-missing'], reason: 'layer-missing' }
            : { partId: wall.id, broken: [], reasons: [] },
        ],
      },
    });
  });
  const stateOf = (i) => records.get(projectId, ids[i]).state;

  // The rail's 기록: [목록] first, 후보 + 남김 (117 of 120), 뺌 hidden.
  await page.locator('.rail [data-workspace-target="records"]').click();
  const tab = page.getByRole('region', { name: '기록', exact: true });
  await tab.waitFor();
  const views = tab.getByRole('tablist', { name: '기록 보기' });
  assert.equal(
    await views.getByRole('tab', { name: '목록' }).getAttribute('aria-selected'),
    'true',
  );
  const rows = tab.locator('.records-row');
  await page.waitForFunction(() => document.querySelectorAll('.records-row').length === 117);
  assert.equal(await tab.locator('.records-row[data-state="dropped"]').count(), 0);
  await tab.getByText(textOf(0), { exact: true }).waitFor();
  assert.ok(await tab.getByText('제안').first().isVisible());
  assert.doesNotMatch(await tab.innerText(), FORBIDDEN);
  if (shot) await page.screenshot({ path: join(shot, 'records-list.png') });

  // Keys: the first 후보 is current; O 남김, X 뺌 (each moves on), K back, Backspace 표시 지움, J.
  await views.getByRole('tab', { name: '목록' }).click();
  const current = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.records-row')].findIndex(
        (row) => row.getAttribute('aria-selected') === 'true',
      ),
    );
  assert.equal(await current(), 0);
  await page.keyboard.press('o');
  await page.waitForFunction(
    () => document.querySelectorAll('.records-row')[0]?.dataset.state === 'kept',
  );
  assert.equal(await current(), 1);
  await page.keyboard.press('x');
  await page.waitForFunction(
    () => document.querySelectorAll('.records-row')[1]?.dataset.state === 'dropped',
  );
  assert.equal(stateOf(0), 'kept');
  assert.equal(stateOf(1), 'dropped');
  await page.keyboard.press('k');
  assert.equal(await current(), 1);
  await page.keyboard.press('Backspace');
  await page.waitForFunction(
    () => document.querySelectorAll('.records-row')[1]?.dataset.state === 'candidate',
  );
  assert.equal(stateOf(1), 'candidate');
  await page.keyboard.press('j');
  assert.equal(await current(), 3);

  // A chip narrows the list: 유형 D only.
  const filter = (name) => tab.getByRole('group', { name, exact: true });
  await filter('유형')
    .getByRole('button', { name: /^D 결정/ })
    .click();
  const expectedD = records.list(projectId, { state: ['candidate', 'kept'], type: ['D'] }).total;
  await page.waitForFunction(
    (count) => document.querySelectorAll('.records-row').length === count,
    expectedD,
  );
  assert.equal(await tab.locator('.records-row:not([data-record-type="D"])').count(), 0);
  await filter('유형')
    .getByRole('button', { name: /^D 결정/ })
    .click();

  // [모두 X] on the 근거 records asks first ('n건을 뺍니다'), then marks them all.
  await filter('유형')
    .getByRole('button', { name: /^E 근거/ })
    .click();
  const evidence = records.list(projectId, { state: ['candidate', 'kept'], type: ['E'] }).records;
  await page.waitForFunction(
    (count) => document.querySelectorAll('.records-row').length === count,
    evidence.length,
  );
  await tab.getByRole('button', { name: '모두 X', exact: true }).click();
  const confirm = tab.getByRole('group', { name: '모두 바꾸기 확인' });
  await confirm.getByText(`${evidence.length}건을 뺍니다`).waitFor();
  await confirm.getByRole('button', { name: '확인' }).click();
  await page.waitForFunction(
    () => !document.querySelector('.records-row:not([data-state="dropped"])'),
  );
  for (const row of evidence)
    assert.equal(records.get(projectId, row.id).state, 'dropped', row.text);
  await filter('유형')
    .getByRole('button', { name: /^E 근거/ })
    .click();

  // Export → bring back in: with every state shown the list is stable; changed marks come back.
  await filter('상태').getByRole('button', { name: /^뺌/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.records-row').length === 120);
  const before = records.exportMarks(projectId, {}).marks;
  await tab.getByRole('button', { name: '내보내기·불러오기' }).click();
  await page.getByRole('menuitem', { name: '표시 문자열 복사(o/x/.)' }).click();
  const shown = tab.getByRole('textbox', { name: '표시 문자열' });
  await shown.waitFor();
  const exported = await shown.inputValue();
  assert.equal(exported, before);
  assert.equal(exported.length, 120);
  await views.getByRole('tab', { name: '목록' }).click();
  for (const key of ['o', 'o', 'x', 'o']) await page.keyboard.press(key);
  for (let wait = 0; wait < 50 && records.exportMarks(projectId, {}).marks === exported; wait++)
    await page.waitForTimeout(100);
  assert.notEqual(records.exportMarks(projectId, {}).marks, exported);
  await tab.getByRole('button', { name: '내보내기·불러오기' }).click();
  await page.getByRole('menuitem', { name: '표시 불러오기' }).click();
  await tab.getByRole('textbox', { name: '불러올 표시' }).fill(exported);
  await tab.getByRole('button', { name: '불러오기', exact: true }).click();
  await tab.getByText(/건의 표시를 바꿨습니다/).waitFor();
  assert.equal(records.exportMarks(projectId, {}).marks, exported);
  // A string of another length is not brought in.
  await tab.getByRole('button', { name: '내보내기·불러오기' }).click();
  await page.getByRole('menuitem', { name: '표시 불러오기' }).click();
  await tab.getByRole('textbox', { name: '불러올 표시' }).fill('ox.');
  await tab.getByRole('button', { name: '불러오기', exact: true }).click();
  await tab.getByText(/표시 3자와 지금 보이는 기록 120건이 다릅니다/).waitFor();
  await tab.getByRole('button', { name: '취소', exact: true }).click();
  assert.equal(records.exportMarks(projectId, {}).marks, exported);

  // 자세히: a '미정' record gets type R and the part 'A동 옹벽'; it is joined to the next record,
  // and joining the other way round is refused.
  const unsure = ids[5];
  await tab.getByText(textOf(5), { exact: true }).click();
  const detail = tab.getByRole('complementary', { name: '자세히' });
  await detail.waitFor();
  await detail.getByRole('combobox', { name: '유형 고르기' }).selectOption('R');
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll('.records-row')].find((row) => row.textContent.includes(text))
        ?.dataset.recordType === 'R',
    textOf(5),
  );
  assert.equal(records.get(projectId, unsure).type, 'R');
  await detail.getByRole('textbox', { name: '부위 찾기' }).fill('A동');
  await detail.getByRole('button', { name: 'A동 옹벽' }).click();
  await detail.locator('.records-part', { hasText: 'A동 옹벽' }).waitFor();
  assert.deepEqual(records.get(projectId, unsure).parts, [wall.id]);
  await detail.getByRole('button', { name: '뒤 기록 잇기' }).click();
  await detail.getByRole('textbox', { name: '뒤 기록 찾기' }).fill(textOf(6));
  await detail.getByRole('button', { name: new RegExp(textOf(6)) }).click();
  await detail.locator('.records-chain-row', { hasText: textOf(6) }).waitFor();
  assert.deepEqual(records.get(projectId, unsure).follows, [ids[6]]);
  assert.doesNotMatch(await tab.innerText(), FORBIDDEN);
  if (shot) await page.screenshot({ path: join(shot, 'records-detail.png') });
  await tab.getByText(textOf(6), { exact: true }).first().click();
  await detail.locator('.records-body', { hasText: textOf(6) }).waitFor();
  await detail.getByRole('button', { name: '뒤 기록 잇기' }).click();
  await detail.getByRole('textbox', { name: '뒤 기록 찾기' }).fill(textOf(5));
  await detail.getByRole('button', { name: new RegExp(textOf(5)) }).click();
  await detail.getByText('이미 이어져 있어 거꾸로 이을 수 없습니다.').waitFor();
  assert.deepEqual(records.get(projectId, ids[6]).follows, []);
  await detail.getByRole('button', { name: '닫기' }).click();

  // 부위 사전: the wall's layer is shown broken with [다시 잇기]; a part and a milestone are added.
  await tab.getByRole('button', { name: '부위 사전' }).click();
  const parts = tab.getByRole('region', { name: '부위 사전' });
  await parts.waitFor();
  const wallRow = parts.locator(`tr[data-part-id="${wall.id}"]`);
  await wallRow.getByText('끊김 — 레이어 없음').waitFor();
  assert.ok(await wallRow.getByRole('button', { name: '다시 잇기' }).isVisible());
  await wallRow.getByRole('button', { name: '다시 잇기' }).click();
  const editor = parts.getByRole('group', { name: '레이어 잇기' });
  await editor.getByLabel('레이어 이름').fill('A-WALL-2');
  await editor.getByRole('button', { name: '잇기', exact: true }).click();
  await wallRow.getByText('A-WALL-2').waitFor();
  await page.waitForFunction(
    (id) => !document.querySelector(`tr[data-part-id="${id}"] .records-broken`),
    wall.id,
  );
  assert.equal(records.part(projectId, wall.id).mapping[0].layer, 'A-WALL-2');
  assert.equal((await wallRow.locator('.records-count-cell').innerText()).trim(), '1');
  await parts.getByRole('button', { name: '부위 추가' }).click();
  const form = parts.getByRole('form', { name: '부위 추가' });
  await form.getByLabel('이름').fill('남측 차양');
  await form.getByLabel('그룹').selectOption('신설');
  await form.getByLabel('역할(시작)').fill('없음');
  await form.getByLabel('역할(끝)').fill('여름 햇빛 가림');
  await form.getByRole('button', { name: '저장' }).click();
  await parts.getByRole('cell', { name: '남측 차양' }).waitFor();
  assert.ok(records.parts(projectId).some((part) => part.name === '남측 차양'));
  const milestone = parts.getByRole('form', { name: '마일스톤 추가' });
  await milestone.getByLabel('이름').fill('착공');
  await milestone.getByLabel('날짜').fill('2026-11-02');
  await milestone.getByRole('button', { name: '마일스톤 추가' }).click();
  await parts.getByText('2026-11-02').waitFor();
  assert.equal(records.milestones(projectId)[0]?.label, '착공');
  assert.doesNotMatch(await tab.innerText(), FORBIDDEN);
  if (shot) await page.screenshot({ path: join(shot, 'records-parts.png') });
  await parts.getByRole('button', { name: '기록으로' }).click();
  await tab.locator('.records-row').first().waitFor();

  // A remote screen (https, the account site's tunnel) reads only.
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
  await stubs(remotePage);
  await remotePage.goto('https://vide.test/' + http.hash);
  await remotePage.waitForFunction(() => document.querySelector('#project-picker')?.value);
  assert.equal(await remotePage.evaluate(() => location.protocol), 'https:');
  await remotePage.locator('.rail [data-workspace-target="records"]').click();
  const remoteTab = remotePage.getByRole('region', { name: '기록', exact: true });
  await remoteTab.locator('.records-row').first().waitFor();
  for (const name of ['보이는 것 모두 O', '모두 X'])
    assert.equal(await remoteTab.getByRole('button', { name, exact: true }).count(), 0, name);
  const firstState = await remoteTab.locator('.records-row').first().getAttribute('data-state');
  const firstId = records.list(projectId, { state: ['candidate', 'kept'] }).records[0].id;
  await remoteTab
    .getByRole('tablist', { name: '기록 보기' })
    .getByRole('tab', { name: '목록' })
    .click();
  await remotePage.keyboard.press('x');
  await remotePage.waitForTimeout(300);
  assert.equal(
    await remoteTab.locator('.records-row').first().getAttribute('data-state'),
    firstState,
  );
  assert.equal(records.get(projectId, firstId).state, firstState);
  await remoteTab.locator('.records-row').first().click();
  const remoteDetail = remoteTab.getByRole('complementary', { name: '자세히' });
  await remoteDetail.waitFor();
  for (const name of ['남김 O', '뺌 X', '고치기', '정정 기록 만들기', '뒤 기록 잇기'])
    assert.equal(await remoteDetail.getByRole('button', { name, exact: true }).count(), 0, name);
  await remoteTab.getByRole('button', { name: '부위 사전' }).click();
  await remoteTab.getByRole('region', { name: '부위 사전' }).getByText('A동 옹벽').waitFor();
  assert.equal(await remoteTab.getByRole('button', { name: '부위 추가' }).count(), 0);
  assert.equal(await remoteTab.getByRole('button', { name: '다시 잇기' }).count(), 0);
  assert.doesNotMatch(await remoteTab.innerText(), FORBIDDEN);

  assert.deepEqual(errors, []);
  console.log('browser records: ok');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

// 파일 tab and 요청 전 영향 미리보기 (PLAN-52 T-319, Design SCR-38·39): the rail's 파일 opens the list
// first; [지도] draws the files by role × time. Choosing a file keeps its chain and fades the rest,
// Esc clears; moving the time cursor back leaves fewer events on. Writing a request that names a
// mapped file shows '영향받는 파일 n' over the send button, which goes when the request is sent.
// No internal code words show. A synthetic project (tests/fixtures/workspace-map.mjs); no host, no
// real CLI (the request is answered by a stand-in).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { ProjectFolders } from '../../src/core/project-folders.ts';
import { soleDb } from '../fixtures/store.mjs';
import { MAP_EVENT_COUNT, seedWorkspaceMap } from '../fixtures/workspace-map.mjs';

const shot = process.env.VIDE_SHOT_DIR;
const FORBIDDEN =
  /SPEC-|PLAN-|JIG\b|hostUse|LINK_NOT_LIVE|세션|토큰|bake|overlay|handoff|stale|sync-pair|jig-io|data-report|request-change|server-updated/;
const directory = await mkdtemp(join(tmpdir(), 'vide-files-tab-'));
const data = join(directory, 'data');
await mkdir(data);
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
  // The request router answers nothing (the rules decide); the request is taken by a stand-in.
  await page.route('**/api/v1/projects/*/route', (route) =>
    route.fulfill({ status: 503, json: { code: 'ROUTE_UNAVAILABLE' } }),
  );
  const sent = [];
  await page.route('**/api/v1/projects/*/requests', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const input = route.request().postDataJSON();
    sent.push(input);
    await route.fulfill({ json: { id: input.id, input, state: 'succeeded', result: {} } });
  });
  await page.route('**/api/v1/projects/*/requests/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const input = sent.find((entry) => entry.id === id);
    return input
      ? route.fulfill({ json: { id, input, state: 'succeeded', result: {} } })
      : route.fallback();
  });

  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  const folders = new ProjectFolders(app.store);
  const { file } = await seedWorkspaceMap({
    db: soleDb(app.store),
    projectId,
    directory,
    dataDirectory: data,
    addFolder: (path) => folders.add(projectId, path, 'project'),
  });

  // The rail's 파일: the list view first, grouped by role.
  await page.locator('.rail [data-workspace-target="files"]').click();
  const tab = page.getByRole('region', { name: '파일', exact: true });
  await tab.waitFor();
  const views = tab.getByRole('tablist', { name: '파일 보기' });
  assert.equal(
    await views.getByRole('tab', { name: '목록' }).getAttribute('aria-selected'),
    'true',
  );
  await tab.getByText('A-평면.dwg', { exact: true }).first().waitFor();
  assert.ok(await tab.getByRole('region', { name: '도면' }).isVisible());

  // [지도]: rows × time; every mapped file is a point.
  await views.getByRole('tab', { name: '지도' }).click();
  const map = tab.getByRole('group', { name: '파일 지도' });
  await map.waitFor();
  const item = (name) => map.locator(`[aria-label^="${name} ·"]`);
  await item('A-평면.dwg').waitFor();
  assert.ok((await map.locator('.chart-item').count()) >= 12);
  assert.equal(await map.locator('.chart-item-faded').count(), 0);
  if (shot) await page.screenshot({ path: join(shot, 'files-map.png') });

  // Choosing the plan keeps its chain (model, base drawing, notes …) and fades the rest.
  await item('A-평면.dwg').click();
  await page.waitForFunction(() => document.querySelectorAll('.chart-item-faded').length > 0);
  for (const name of ['main.3dm', 'X-기준.dwg', '2026-10-04-협의.md'])
    assert.match(await item(name).first().getAttribute('class'), /chart-item-on/, name);
  assert.match(await item('개요.pdf').getAttribute('class'), /chart-item-faded/);
  assert.ok((await map.locator('.chart-link-on').count()) >= 3);
  assert.equal(await item('A-평면.dwg').getAttribute('aria-pressed'), 'true');
  if (shot) await page.screenshot({ path: join(shot, 'files-map-chosen.png') });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.chart-item-faded'));

  // The time cursor: at the end every placed event is on; moved back, fewer are.
  const onEvents = () => map.locator('.chart-event:not(.chart-event-later)').count();
  const allEvents = await map.locator('.chart-event').count();
  assert.ok(allEvents > 0 && allEvents <= MAP_EVENT_COUNT);
  assert.equal(await onEvents(), allEvents);
  const cursor = tab.getByRole('slider', { name: '시간 커서' });
  const min = Number(await cursor.getAttribute('min'));
  const max = Number(await cursor.getAttribute('max'));
  const step = Number(await cursor.getAttribute('step'));
  await cursor.fill(String(min + Math.round(((max - min) * 0.3) / step) * step));
  await page.waitForFunction(
    (count) => document.querySelectorAll('.chart-event:not(.chart-event-later)').length < count,
    allEvents,
  );
  assert.ok((await map.locator('.chart-link-later').count()) > 0);
  // The legend is folded until asked.
  await tab.getByText('범례', { exact: true }).click();
  await tab.getByText('동기화 쌍', { exact: true }).waitFor();
  const visible = await tab.innerText();
  assert.doesNotMatch(visible, FORBIDDEN);

  // Writing a request that names the plan: '영향받는 파일 n' over the send button.
  await page.locator('.rail [data-workspace-target="model"]').click();
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.locator('#model').selectOption('test');
  await page.locator('#body').fill('A-평면.dwg의 코어 벽을 1m 옮겨 줘');
  const strip = page.locator('#route-card.impact-strip');
  await strip.waitFor();
  const line = await strip.innerText();
  assert.match(line, /영향받는 파일 \d+/);
  assert.match(line, /동기화 쌍/);
  assert.match(line, /지도에서 보기/);
  assert.doesNotMatch(line, FORBIDDEN);
  assert.equal(await page.locator('#request').isEnabled(), true);
  if (shot) await page.screenshot({ path: join(shot, 'impact-strip.png') });
  // [지도에서 보기] opens the map with that chain chosen.
  await strip.getByRole('button', { name: '지도에서 보기' }).click();
  await page.waitForFunction(() => document.body.dataset.workspace === 'files');
  await page.waitForFunction(() => document.querySelectorAll('.chart-item-faded').length > 0);
  assert.equal(await item('A-평면.dwg').getAttribute('aria-pressed'), 'true');
  // Back to the request: sending it takes the strip away.
  await page.locator('.rail [data-workspace-target="model"]').click();
  await strip.waitFor();
  await page.locator('#request').click();
  await page.waitForFunction(() => document.querySelector('#body').value === '');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('#route-card.impact-strip').count(), 0);
  assert.equal(sent.length, 1);
  // A request naming no mapped file shows no strip.
  await page.locator('#body').fill('오늘 할 일을 정리해 줘');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('#route-card.impact-strip').count(), 0);
  // A project with no work folder (the map has records but no root): no strip, and the 파일 tab
  // only explains how to set a work folder (SPEC-02.17 7; SPEC-01.13 7 unchanged behaviour).
  await page.route('**/api/v1/projects/*/workspace/map*', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ json: { ...json, root: null } });
  });
  // The page keeps a fetched map for 15 s: wait that out rather than reload.
  await page.waitForTimeout(15500);
  await page.locator('#body').fill('A-평면.dwg의 코어 벽을 1m 옮겨 줘');
  await page.waitForTimeout(900);
  assert.equal(await page.locator('#route-card.impact-strip').count(), 0);
  await page.locator('.rail [data-workspace-target="files"]').click();
  await tab.getByRole('button', { name: '다시 읽기' }).click();
  await tab.getByText('이 프로젝트에는 작업 폴더가 없습니다', { exact: false }).waitFor();
  assert.equal(await tab.getByRole('group', { name: '파일 지도' }).count(), 0);
  assert.ok(file.plan);
  assert.deepEqual(errors, []);
  console.log('browser files tab: ok');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

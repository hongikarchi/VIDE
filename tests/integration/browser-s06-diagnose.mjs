// S-06 layout diagnosis (PLAN-23 T-044) in the browser: two stored Rhino Syncs (a structure model
// and a civil model with the basin, synthetic) → structure jig '배치 진단' → role layers guessed →
// KPI strip, tables, CSV, 3D overlays, row → 3D and overlay → row. No host, no AI, no writes.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import {
  buildCase,
  gridRot21,
  LAYERS,
} from '../../extensions/jigs/s06-frame/fixtures/synthetic.ts';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-s06-diagnose-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    }),
    errors = [];
  page.setDefaultTimeout(15000);
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

  const built = buildCase(gridRot21);
  const insert = (id, result, createdAt) =>
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
      JSON.stringify(result),
      createdAt,
    );
  insert('structure-sync', built.structure, '2026-09-29T01:00:00.000Z');
  insert('civil-sync', built.civil, '2026-09-29T01:01:00.000Z');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#task-list .task-row').length === 2);
  const requests = () =>
    page.evaluate(
      async (id) => (await (await fetch(`/api/v1/projects/${id}/requests`)).json()).length,
      projectId,
    );
  const before = await requests();

  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  await dialog
    .locator('.jig-card', { hasText: '구조 분석' })
    .getByRole('button', { name: '열기' })
    .click();
  await dialog.getByText('탐색용 예비값입니다').waitFor();
  await dialog.getByRole('button', { name: '배치 진단' }).click();

  // Both linked documents are read; each role gets its layer from the layer names.
  const sources = dialog.locator('.jig-s06-sources input[type=checkbox]');
  assert.equal(await sources.count(), 2);
  for (let k = 0; k < 2; k++) assert.ok(await sources.nth(k).isChecked());
  const role = (name) => dialog.getByLabel(name, { exact: true });
  const guessed = {
    '신설 기둥': `합성-구조.3dm · ${LAYERS.columns} — 곡선 10`,
    거더: `합성-구조.3dm · ${LAYERS.girders} — 곡선 6`,
    '신설 기초(파일캡·오픈컷)': `합성-구조.3dm · ${LAYERS.newFootings} — 블록 10`,
    '기존 기초': `합성-토목.3dm · ${LAYERS.existingFootings} — 블록 6`,
    '유수지 보': `합성-토목.3dm · ${LAYERS.basinGirders} — 솔리드 2`,
  };
  for (const [name, text] of Object.entries(guessed)) {
    await page.waitForFunction(
      (label) => document.querySelector(`select[aria-label="${label}"]`)?.value,
      name,
    );
    assert.equal((await role(name).locator('option:checked').textContent()).trim(), text);
  }

  const response = page.waitForResponse((r) => r.url().endsWith('/jigs/structure/diagnose'));
  await dialog.getByRole('button', { name: '진단', exact: true }).click();
  const output = await (await response).json();
  const result = dialog.getByRole('region', { name: '진단 결과' });
  await result.waitFor();
  const kpi = async (name) =>
    (
      await result.getByRole('group', { name, exact: true }).locator('.jig-kpi-value').textContent()
    ).trim();
  assert.equal(await kpi('신설 기둥'), '10개');
  assert.equal(await kpi('파일캡 간섭'), '4곳');
  assert.equal(await kpi('오픈컷 협의'), '7곳');
  assert.equal(await kpi('기둥↔유수지 보'), '2곳');
  assert.equal(await kpi('경간 초과'), '2개');
  assert.equal(await kpi('최대 경간'), '16.59m');
  assert.match(await result.getByRole('group', { name: '파일캡 간섭' }).textContent(), /✕ 불가 4/);
  assert.match(await result.textContent(), /탐색용 예비값 · 공식 구조 검토 아님/);

  // Tables: interference per column (worst first), spans, curve lengths.
  const rows = (name) => result.getByRole('table', { name }).locator('tbody tr');
  assert.equal(await rows('간섭 표').count(), 10);
  assert.match(await rows('간섭 표').first().textContent(), /✕ 불가/);
  assert.match(await rows('간섭 표').first().textContent(), /겹침 0\.\d\d/);
  if (shot) await page.screenshot({ path: join(shot, 's06-diagnose-interference.png') });

  // CSV of the open table.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    result.getByRole('button', { name: 'CSV' }).click(),
  ]);
  assert.equal(download.suggestedFilename(), 'VIDE-s06-interference.csv');
  const csv = await readFile(await download.path(), 'utf8');
  const lines = csv.replace(/^﻿/, '').trimEnd().split('\r\n');
  assert.equal(lines.length, 11);
  assert.match(lines[0], /^"기둥","이름","레이어","객체 ID","판정","파일캡↔기존 기초 판정"/);
  assert.equal(lines.filter((line) => line.includes('"불가"')).length, 4);

  await result.getByRole('tab', { name: /^경간/ }).click();
  assert.equal(await rows('경간 표').count(), 13);
  assert.match(await rows('경간 표').first().textContent(), /✕ 초과/);
  if (shot) await page.screenshot({ path: join(shot, 's06-diagnose-spans.png') });
  await result.getByRole('tab', { name: /^곡선 길이/ }).click();
  assert.equal(await rows('곡선 길이 표').count(), 6);
  assert.equal(await rows('곡선 길이 표').filter({ hasText: '참고 · 경간 초과 아님' }).count(), 4);

  // 3D overlays: existing footings and basin beams, caps / open cuts / columns, clashes, spans.
  const overlays = () =>
    page.evaluate(() =>
      Object.fromEntries(
        window.videViewport
          .overlayInfo()
          .filter((o) => o.key.startsWith('s06-'))
          .map((o) => [o.key, o.items.length]),
      ),
    );
  const drawn = await overlays();
  assert.deepEqual(drawn, {
    's06-existing': 8,
    's06-new': 30,
    's06-clash': output.overlays.find((o) => o.key === 's06-clash').items.length,
    's06-spans': 2,
  });
  assert.ok(drawn['s06-clash'] >= 4 + 7 + 2, 'caps, open cuts and basin overlaps are filled');
  await result.getByRole('checkbox', { name: '3D 겹침' }).uncheck();
  assert.deepEqual(await overlays(), {});
  await result.getByRole('checkbox', { name: '3D 겹침' }).check();
  assert.deepEqual(await overlays(), drawn);

  // A table row frames its column in 3D without changing the model selection.
  await result.getByRole('tab', { name: /^간섭/ }).click();
  const first = rows('간섭 표').first();
  const key = (await first.locator('td').first().textContent()).trim();
  await first.click();
  assert.equal(await first.getAttribute('aria-selected'), 'true');
  const box = await page.locator('#canvas canvas').boundingBox();
  const focus = output.tables.interference.find((r) => r.key === key).focus;
  const centre = focus.min.map((v, k) => (v + focus.max[k]) / 2);
  await page.waitForFunction(
    ({ centre, box }) => {
      const p = window.videViewport.screenOf(centre);
      return (
        Math.abs(p.x - (box.x + box.width / 2)) < box.width * 0.15 &&
        Math.abs(p.y - (box.y + box.height / 2)) < box.height * 0.15
      );
    },
    { centre, box },
  );
  if (shot) await page.screenshot({ path: join(shot, 's06-diagnose-focus.png') });

  // A click on a clash tag in 3D opens its row in the table.
  const tagged = output.overlays
    .find((o) => o.key === 's06-clash')
    .items.find((i) => i.label && i.label !== key);
  await page.evaluate(
    (id) => window.videViewport.focus({ overlay: 's06-clash', itemId: id }),
    tagged.id,
  );
  const anchor = [
    ...tagged.points
      .reduce((sum, p) => [sum[0] + p[0], sum[1] + p[1]], [0, 0])
      .map((v) => v / tagged.points.length),
    tagged.z,
  ];
  const tag = await page.evaluate((p) => window.videViewport.screenOf(p), anchor);
  assert.deepEqual(
    await page.evaluate(({ x, y }) => window.videViewport.pickAt(x, y).source, tag),
    { source: 'overlay', key: 's06-clash', itemId: tagged.id },
  );
  await page.mouse.click(tag.x, tag.y);
  await page.waitForFunction(
    (row) =>
      document.querySelector(`tr[data-row="${row}"]`)?.getAttribute('aria-selected') === 'true',
    tagged.label,
  );
  assert.equal(await first.getAttribute('aria-selected'), 'false');

  // Read-only: no request, candidate or host command was made.
  assert.equal(await requests(), before);
  // The analysis view is still there and keeps working beside the diagnosis.
  await dialog.getByRole('button', { name: '해석 모델' }).click();
  await dialog.getByLabel('입력 Sync').waitFor();
  await dialog.getByRole('button', { name: '배치 진단' }).click();
  assert.equal(await kpi('파일캡 간섭'), '4곳', 'switching views keeps the result');
  assert.deepEqual(errors, []);

  // Route limits (the browser logs these refusals, so they come after the error check).
  const status = (path, body) =>
    page.evaluate(
      async ({ path, body }) =>
        (
          await fetch(`/api/v1${path}`, {
            method: body ? 'POST' : 'GET',
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
          })
        ).status,
      { path, body },
    );
  const route = `/projects/${projectId}/jigs/structure`;
  assert.equal(await status(`${route}/layers?syncIds=`), 400);
  assert.equal(await status(`${route}/layers?syncIds=nothing`), 404);
  assert.equal(
    await status(`${route}/diagnose`, {
      sources: ['structure-sync'],
      roles: { columns: [{ syncId: 'civil-sync', layer: LAYERS.columns }] },
    }),
    400,
    'a role layer must come from a chosen Sync',
  );
  assert.equal(
    await status(`${route}/diagnose`, { sources: ['structure-sync'], roles: { walls: [] } }),
    400,
  );
  assert.equal(
    await status(`${route}/diagnose`, {
      sources: ['structure-sync'],
      roles: {},
      params: { spanMax: -1 },
    }),
    400,
  );
  assert.equal(await requests(), before);
  console.log('s06 diagnose browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

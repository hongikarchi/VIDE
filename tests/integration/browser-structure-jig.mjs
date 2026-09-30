// Structure jig (J-09) in the browser: stored Rhino Sync → draft → sections → roof loads → confirm &
// analyse → member table → select in model and verdict colours. No real CLI or host.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-structure-ui-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
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

  // Two bays of a one-storey steel frame as centre lines: 3 × 2 columns, girders, one secondary beam.
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  let n = 0;
  const curve = (layer, a, b) => ({
    id: 'r' + ++n,
    nativeId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    nativeType: 'Curve',
    name64: '',
    layer64: b64(layer),
    line: [...a, ...b],
  });
  const scene = [];
  for (const x of [0, 7, 14])
    for (const y of [0, 6]) scene.push(curve('기둥', [x, y, 0], [x, y, 5]));
  for (const y of [0, 6])
    scene.push(curve('보', [0, y, 5], [7, y, 5]), curve('보', [7, y, 5], [14, y, 5]));
  for (const x of [0, 7, 14]) scene.push(curve('보', [x, 0, 5], [x, 6, 5]));
  scene.push(curve('작은보', [3.5, 0, 5], [3.5, 6, 5]));
  app.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
    'frame-sync',
    projectId,
    JSON.stringify({
      id: 'frame-sync',
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
    JSON.stringify({
      hostExecuted: true,
      executionMode: 'sdk',
      host: 'rhino',
      sourceDocument: { name: 'frame.3dm', capturedAt: 'test', instance: '1', documentId: 1 },
      scene,
      objects: scene.map((row) => ({
        id: row.id,
        name: '',
        kind: 'native',
        nativeId: row.nativeId,
      })),
    }),
    new Date().toISOString(),
  );
  await page.reload();
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('#task-list .task-row').length === 1,
    );
  } catch (error) {
    console.log(
      'DEBUG api',
      JSON.stringify(
        await page.evaluate(async (id) => {
          const r = await fetch(`/api/v1/projects/${id}/requests`);
          return [r.status, (await r.text()).slice(0, 600)];
        }, projectId),
      ),
      'DEBUG errors',
      errors,
      await page.evaluate(() => document.querySelector('#task-list')?.outerHTML.slice(0, 800)),
    );
    throw error;
  }

  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  await dialog
    .locator('.jig-card', { hasText: '구조 분석' })
    .getByRole('button', { name: '열기' })
    .click();
  await dialog.getByText('탐색용 예비값입니다').waitFor();
  assert.match(
    await dialog.getByLabel('입력 Sync').locator('option:checked').textContent(),
    /frame\.3dm/,
  );
  await dialog.getByRole('button', { name: '초안 만들기' }).click();
  const draft = dialog.getByRole('region', { name: '해석 모델 초안' });
  await draft.waitFor();
  assert.match(await draft.locator('h3').textContent(), /부재 1[0-9]/);
  assert.match(await draft.textContent(), /단면이 없어 임시 단면/);
  assert.ok(
    await dialog.getByRole('button', { name: '확정하고 해석' }).isDisabled(),
    'placeholder sections block confirmation',
  );

  // Assign sections per group, then roof loads.
  const assign = async (label, name) => {
    const inputs = draft.getByLabel(label);
    const count = await inputs.count();
    for (let k = 0; k < count; k++) {
      const input = draft.getByLabel(label).first();
      await input.fill(name);
      await input.locator('xpath=..').getByRole('button', { name: '적용' }).click();
      await page.waitForTimeout(300);
    }
  };
  await assign('기둥 단면', 'H-300x300x10x15');
  await assign('거더 단면', 'H-400x200x8x13');
  await assign('보 단면', 'H-300x150x6.5x9');
  await draft.getByLabel('지붕 고정하중').fill('1.5');
  await draft.getByLabel('지붕 활하중').fill('1');
  await draft.getByRole('button', { name: '최상층 면하중 적용' }).click();
  await page.waitForTimeout(400);
  assert.match(await draft.textContent(), /면하중 2개/);
  await dialog.getByRole('button', { name: '확정하고 해석' }).click();
  const result = dialog.getByRole('region', { name: '해석 결과' });
  await result.waitFor();
  assert.match(await result.textContent(), /강재 [0-9.]+ t · 최대 검정비 [0-9.]+/);
  assert.match(await result.textContent(), /면하중 roof-D\(D\) 입력 126\.0 kN/);
  await result.getByRole('button', { name: '전체' }).click();
  const rows = result.getByRole('table', { name: '부재 검정' }).locator('tbody tr');
  assert.ok((await rows.count()) >= 12, 'every member has a check row');
  assert.match(await result.textContent(), /검토하지 않음: 풍하중/);
  // A confirmed result says so; the legend reads the analysis' colour bands (SPEC-06.7).
  assert.equal(await result.locator('h3 .pill[data-mode]').textContent(), '확정 결과');
  const bands = result.getByRole('group', { name: /판정 범례.*구간/ });
  assert.match(await bands.textContent(), /통과 < 0\.70.*주의 0\.70~1\.00.*초과 ≥ 1\.00/s);
  // The check table goes out as CSV with the result label on every row.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    result.getByRole('button', { name: 'CSV로 내보내기' }).click(),
  ]);
  const csv = await (await download.createReadStream()).toArray();
  const lines = Buffer.concat(csv).toString('utf8').replace(/^﻿/, '').trim().split('\r\n');
  assert.match(lines[0], /^결과,부재,역할,단면,검정비/);
  assert.ok(lines.length >= 13 && lines.slice(1).every((line) => line.startsWith('확정 결과,')));
  if (shot) await page.screenshot({ path: join(shot, 'structure-jig-result.png') });

  // A row selects its Rhino object while the jig stays open beside the model (non-modal).
  const rowCount = await rows.count();
  await rows.first().click();
  await page.waitForFunction(
    () => document.querySelector('#selection-count')?.textContent === '1개 선택',
  );
  assert.ok(await result.isVisible(), 'the jig keeps its result while the model is shown');
  assert.equal(await dialog.evaluate((node) => node.matches(':modal')), false);
  // Verdict colours paint the model and can be switched off again; the jig stays open.
  const verdicts = ['#3a9d5d', '#8a8f8c', '#d8a31a', '#d0453a'];
  const painted = () =>
    page.evaluate(
      (colors) =>
        window.videViewport
          .visibleIds()
          .filter((id) => colors.includes(window.videViewport.colorOf(id))).length,
      verdicts,
    );
  await result.getByRole('button', { name: '판정색 켜기' }).click();
  await page.waitForFunction(
    (colors) =>
      window.videViewport
        .visibleIds()
        .some((id) => colors.includes(window.videViewport.colorOf(id))),
    verdicts,
  );
  assert.ok((await painted()) >= 10, 'members carry verdict colours');
  if (shot) await page.screenshot({ path: join(shot, 'structure-jig-tint.png') });
  // A look around the 3D view (orbit) leaves the jig as it was.
  const canvas = await page.locator('#canvas canvas').boundingBox();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(canvas.x + canvas.width / 2 + 80, canvas.y + canvas.height / 2 + 30, {
    steps: 5,
  });
  await page.mouse.up({ button: 'right' });
  await result.getByRole('button', { name: '판정색 끄기' }).click();
  assert.equal(await painted(), 0, 'verdict colours are cleared');
  assert.equal(await rows.count(), rowCount);
  assert.equal(
    await result.getByRole('button', { name: '전체', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  assert.deepEqual(errors, []);
  console.log('structure jig browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

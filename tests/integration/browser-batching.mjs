// Draw batching (PLAN-17): many objects draw through a few merged meshes, while picking,
// selection highlight, hiding and display modes still act on single objects.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

import { soleDb } from '../fixtures/store.mjs';
const directory = await mkdtemp(join(tmpdir(), 'vide-batching-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const setup = await browser.newPage();
  await setup.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await setup.goto(app.launchUrl);
  await setup.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await setup.locator('#project-picker').inputValue();
  await setup.close();
  // 1,200 small flat squares on a grid (at survey-like coordinates) and 600 lines.
  const base = [200000, 500000, 30];
  const scene = [];
  for (let i = 0; i < 1200; i++) {
    const x = base[0] + (i % 40) * 2,
      y = base[1] + Math.floor(i / 40) * 2;
    scene.push({
      id: 's' + i,
      nativeId: 's' + i,
      nativeType: 'Brep',
      vertices: [
        x,
        y,
        base[2],
        x + 1.5,
        y,
        base[2],
        x + 1.5,
        y + 1.5,
        base[2],
        x,
        y + 1.5,
        base[2],
      ],
      indices: [0, 1, 2, 0, 2, 3],
      geometryHash: 'h' + i,
    });
  }
  for (let i = 0; i < 600; i++) {
    const x = base[0] + (i % 40) * 2,
      y = base[1] - 10 - Math.floor(i / 40);
    scene.push({
      id: 'c' + i,
      nativeId: 'c' + i,
      nativeType: 'Curve',
      segments: [x, y, base[2], x + 1.8, y, base[2]],
      geometryHash: 'hc' + i,
    });
  }
  const input = {
    id: 'sync',
    provider: 'codex-cli',
    host: 'rhino',
    source: 'document',
    permission: 'candidate',
    body: 'batching',
    pins: [],
    sketches: [],
    files: [],
  };
  const result = {
    host: 'rhino',
    hostExecuted: true,
    executionMode: 'sdk',
    displayOnly: true,
    objects: scene.map((item) => ({
      id: item.id,
      name: item.id,
      kind: 'native',
      nativeId: item.id,
    })),
    scene,
    sourceDocument: {
      name: 'grid.3dm',
      capturedAt: new Date().toISOString(),
      instance: '1:1',
      documentId: 1,
    },
  };
  soleDb(app.store)
    .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
    .run(
      input.id,
      projectId,
      JSON.stringify(input),
      'succeeded',
      JSON.stringify(result),
      new Date().toISOString(),
    );
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent.startsWith('1,800개'),
  );
  const stats = () => page.evaluate(() => window.videViewport.benchmark(2));
  const first = await stats();
  // 1,800 objects (plus their edges) draw in a handful of calls.
  assert.ok(first.calls < 30, JSON.stringify(first));
  assert.equal(first.triangles, 2400);
  // Picking still finds single objects: plan view, click the middle of the grid.
  await page.getByRole('button', { name: '위 · 직교', exact: true }).click();
  await page.locator('#fit-view').click();
  const box = await page.locator('#canvas canvas').boundingBox();
  // Squares have gaps between them; try a few points around the middle until one is hit.
  let hit;
  for (const [dx, dy] of [
    [0, 0],
    [7, 0],
    [0, 7],
    [7, 7],
    [-7, 3],
    [3, -7],
    [14, 14],
    [-14, -14],
  ]) {
    await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    await page.waitForTimeout(80);
    const text = (await page.locator('#selection').textContent()).trim();
    if (/^[sc]\d+$/.test(text)) {
      hit = [dx, dy];
      break;
    }
  }
  assert.ok(hit, 'picking a batched object');
  const picked = await page.locator('#selection').textContent();
  assert.match(picked, /^[sc]\d+$/);
  // The selected object is drawn on its own (highlight); the rest stay batched.
  const selected = await stats();
  assert.ok(selected.calls <= first.calls + 4, JSON.stringify(selected));
  assert.equal(selected.triangles, 2400);
  if (process.env.VIDE_SHOT_SELECTED)
    await page.screenshot({ path: process.env.VIDE_SHOT_SELECTED });
  // Hiding (H) removes it from the drawing.
  await page.keyboard.press('h');
  await page.waitForFunction(() => window.videViewport.hiddenCount() === 1);
  const hidden = await stats();
  assert.ok(hidden.triangles === 2398 || hidden.triangles === 2400, JSON.stringify(hidden));
  await page.keyboard.press('u');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: process.env.VIDE_SHOT || join(directory, 'batching.png') });
  console.log('Batching checks passed', JSON.stringify({ first, selected, hidden }));
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

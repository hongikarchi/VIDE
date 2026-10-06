// A large linked file on the screen (PLAN-27 3단계 T-085, PLAN-28 T-123): a synthetic Rhino Sync of
// 10,000 objects (about 1 M vertices) stored per object. The test plays the engine (it writes to the
// workspace directly, like browser-live-sync) and measures what the acceptance names:
//   - a Live Sync of 10 objects: engine time and the longest main-thread stall on the screen,
//   - five full Syncs in a row: screen heap and GPU buffers stay flat,
//   - select-all with 10,000 objects, then a key press: its latency,
//   - the request list and the model fetch carry no whole-model JSON.
// `--measure` only prints the numbers (no limits), for before/after comparisons.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { runDirectory } from './run-directory.mjs';

import { soleDb } from '../fixtures/store.mjs';
const measureOnly = process.argv.includes('--measure');
const COUNT = Number(process.env.VIDE_LARGE_COUNT || 10000);
const GRID = 10; // 10 x 10 vertices per object: 100 vertices, 162 triangles
const directory = runDirectory('browser-large-sync');
await mkdir(directory, { recursive: true });
const instance = '42:100:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const uuid = (i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
const layer64 = Buffer.from('Mass').toString('base64');
function item(i, shift = 0, hash = 'h') {
  const id = uuid(i);
  const x0 = 1000 + (i % 100) * 3 + shift,
    y0 = 2000 + Math.floor(i / 100) * 3;
  const vertices = [];
  for (let v = 0; v < GRID; v++)
    for (let u = 0; u < GRID; u++) vertices.push(x0 + u * 0.2, y0 + v * 0.2, ((u * v) % 7) * 0.1);
  const indices = [];
  for (let v = 0; v < GRID - 1; v++)
    for (let u = 0; u < GRID - 1; u++) {
      const a = v * GRID + u;
      indices.push(a, a + 1, a + GRID, a + 1, a + GRID + 1, a + GRID);
    }
  return {
    object: { id, nativeId: id, kind: 'native', name: 'Mass ' + i, origin: [x0, y0, 0] },
    scene: {
      id,
      nativeId: id,
      nativeType: 'Mesh',
      geometryHash: `${hash}-${i}-${shift}`,
      name64: '',
      origin: [x0, y0, 0],
      boundsSize: [1.8, 1.8, 0.6],
      vertices,
      indices,
      line: [],
      area: 3.24,
      volume: null,
      length: null,
      layer64,
      attributes64: [],
      attributesComplete: true,
      valid: true,
    },
  };
}
const sourceDocument = (revision) => ({
  instance,
  documentId: 7,
  documentHash: String(revision).padStart(64, '0'),
  revision,
  name: 'Large test',
  capturedAt: new Date().toISOString(),
  connection: 'attached-editor',
});

let app, browser;
const numbers = { count: COUNT };
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  const workspace = new Workspace(app.store);
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--js-flags=--expose-gc', '--enable-precise-memory-info'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(180000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.glBuffers = new Set();
    for (const type of [WebGLRenderingContext, WebGL2RenderingContext]) {
      const create = type.prototype.createBuffer,
        remove = type.prototype.deleteBuffer;
      type.prototype.createBuffer = function () {
        const buffer = create.call(this);
        window.glBuffers.add(buffer);
        return buffer;
      };
      type.prototype.deleteBuffer = function (buffer) {
        window.glBuffers.delete(buffer);
        return remove.call(this, buffer);
      };
    }
    // Main-thread stalls: every long task (> 50 ms) with its start time.
    window.longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        window.longTasks.push({ start: entry.startTime, ms: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  });
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'ChatGPT', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  const catalog = () => ({
    instance,
    documents: [
      {
        instance,
        id: 7,
        name: 'Large test',
        units: 'Meters',
        objectCount: COUNT,
        modified: true,
        host: 'rhino',
        connection: 'attached-editor',
        generation: 0,
        live: true,
        hostBusy: false,
      },
    ],
  });
  for (const path of ['documents', 'attached-documents'])
    await page.route(`**/api/v1/host/${path}`, (route) => route.fulfill({ json: catalog() }));
  // What the page fetched and how large each answer was.
  const fetched = [];
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.includes('/api/v1/projects/')) return;
    try {
      const body = await response.body();
      fetched.push({ path: url.pathname, search: url.search, bytes: body.byteLength });
    } catch {
      /* A redirected or aborted answer has no body. */
    }
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  const projectId = await page.locator('#project-picker').inputValue();
  const now = new Date().toISOString();
  soleDb(app.store)
    .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
    .run('link-large', projectId, 'rhino', 'Large test', null, instance, 7, now, now);
  await page.route('**/api/v1/projects/*/links*', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || !url.pathname.endsWith('/links'))
      return route.continue();
    const rows = await (await route.fetch()).json();
    await route.fulfill({
      json: rows.map((row) => ({
        ...row,
        connection: {
          instance,
          documentId: 7,
          live: true,
          generation: 0,
          objectCount: COUNT,
          units: 'Meters',
          modified: true,
          hostBusy: false,
        },
      })),
    });
  });
  const items = Array.from({ length: COUNT }, (_, i) => item(i));
  let revision = 1;
  const engineFullSync = (id) => {
    workspace.submit(projectId, {
      id,
      linkId: 'link-large',
      body: 'Sync',
      permission: 'candidate',
      provider: 'codex-cli',
      pins: [],
      sketches: [],
      files: [],
      source: 'document',
      host: 'rhino',
      sourceDocument: { instance, documentId: 7 },
    });
    const began = performance.now();
    workspace.update(projectId, id, 'succeeded', {
      host: 'rhino',
      hostExecuted: true,
      verified: false,
      displayOnly: true,
      executionMode: 'sdk',
      text: 'Sync complete',
      sourceDocument: sourceDocument(revision++),
      objects: items.map((entry) => entry.object),
      scene: items.map((entry) => entry.scene),
    });
    return performance.now() - began;
  };
  const summary = (count) =>
    page.waitForFunction(
      (text) => document.querySelector('.object-summary')?.textContent?.startsWith(text),
      count.toLocaleString() + '개 객체',
    );
  const heap = async () => {
    await page.evaluate(() => window.gc?.());
    await page.evaluate(() => window.gc?.());
    const metrics = await cdp.send('Performance.getMetrics');
    const used = metrics.metrics.find((row) => row.name === 'JSHeapUsedSize')?.value ?? 0;
    return Math.round(used / 1e6);
  };
  const longest = (since) =>
    page.evaluate(
      (since) =>
        Math.round(
          Math.max(0, ...window.longTasks.filter((t) => t.start >= since).map((t) => t.ms)),
        ),
      since,
    );
  const clock = () => page.evaluate(() => performance.now());

  // First Sync of the file, drawn without a click.
  const first = randomUUID();
  numbers.engineStoreMs = Math.round(engineFullSync(first));
  let mark = await clock();
  let start = Date.now();
  await summary(COUNT);
  await page.waitForFunction(() => (window.videViewport?.visibleIds().length ?? 0) > 0);
  numbers.firstShowMs = Date.now() - start;
  numbers.firstShowLongestTaskMs = await longest(mark);
  numbers.heapAfterFirstMB = await heap();
  numbers.glBuffersAfterFirst = await page.evaluate(() => window.glBuffers.size);

  // A Live Sync of 10 changed objects: the engine applies it in place, the page merges it.
  const changed = Array.from({ length: 10 }, (_, k) => item(k * 997, 0.5, 'live'));
  await page.waitForTimeout(1500);
  mark = await clock();
  const fetchesBefore = fetched.length;
  const began = performance.now();
  workspace.applyDelta(
    projectId,
    first,
    {
      objects: changed.map((entry) => entry.object),
      scene: changed.map((entry) => entry.scene),
      removed: [],
    },
    { sourceDocument: sourceDocument(revision++) },
  );
  numbers.liveEngineMs = Math.round(performance.now() - began);
  start = Date.now();
  while (!fetched.slice(fetchesBefore).some((entry) => entry.path.endsWith('/delta')))
    await new Promise((r) => setTimeout(r, 25));
  await page.waitForTimeout(800);
  numbers.liveScreenLongestTaskMs = await longest(mark);
  numbers.liveFetches = fetched.slice(fetchesBefore).map((entry) => entry.path.split('/').at(-1));

  // Select all, then press a key in the viewport (z: zoom to selection) and type in the composer.
  await page.locator('#canvas').click({ position: { x: 5, y: 5 } });
  start = Date.now();
  await page.keyboard.press('Control+a');
  await page.waitForFunction(
    (n) => document.body.textContent.includes(n.toLocaleString() + '개 객체 선택'),
    COUNT,
  );
  numbers.selectAllMs = Date.now() - start;
  start = Date.now();
  await page.locator('#body').press('a');
  await page.waitForFunction(() => document.querySelector('#body').value === 'a');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  numbers.typeAfterSelectAllMs = Date.now() - start;
  mark = await clock();
  await page.locator('#body').press('b');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  numbers.typeAfterSelectAllLongestTaskMs = await longest(mark);
  await page.locator('#body').fill('');
  await page.locator('#canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');

  // Five full Syncs in a row (each a new request): heap and GPU buffers stay where they were.
  const heaps = [];
  const buffers = [];
  for (let n = 0; n < 5; n++) {
    const id = randomUUID();
    engineFullSync(id);
    // The new Sync replaces the shown one once the links list names it.
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const hits = fetched.filter((entry) => entry.path.endsWith('/requests/' + id)).length;
      if (hits) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await summary(COUNT);
    await page.waitForTimeout(1200);
    heaps.push(await heap());
    buffers.push(await page.evaluate(() => window.glBuffers.size));
  }
  numbers.heapAfterFullSyncsMB = heaps;
  numbers.glBuffersAfterFullSyncs = buffers;

  // What the page fetched: the request list and the model are never one whole-model JSON.
  const list = fetched.filter((entry) => entry.path.endsWith('/requests') && !entry.search);
  numbers.listBytes = list.map((entry) => entry.bytes);
  const model = fetched.filter((entry) => /\/requests\/[^/]+$/.test(entry.path));
  numbers.modelFetchBytes = model.map((entry) => entry.bytes).slice(0, 2);
  const direct = await page.evaluate(async (projectId) => {
    const response = await fetch(`api/v1/projects/${projectId}/requests`);
    return (await response.arrayBuffer()).byteLength;
  }, projectId);
  numbers.listBytesNow = direct;

  console.log(JSON.stringify({ measure: numbers }));
  if (!measureOnly) {
    assert.deepEqual(errors, []);
    assert.ok(numbers.liveEngineMs <= 150, `Live Sync engine ${numbers.liveEngineMs} ms`);
    assert.ok(
      numbers.liveScreenLongestTaskMs <= 50,
      `Live Sync stalled the screen ${numbers.liveScreenLongestTaskMs} ms`,
    );
    assert.deepEqual(
      numbers.liveFetches.filter((name) => name !== 'delta' && name !== 'links'),
      [],
    );
    const growth = Math.max(...heaps) - heaps[0];
    assert.ok(growth <= 30, `screen heap grew ${growth} MB over five full Syncs (${heaps})`);
    assert.ok(Math.max(...buffers) - buffers[0] <= 4, `GPU buffers grew (${buffers})`);
    assert.ok(
      numbers.typeAfterSelectAllLongestTaskMs <= 100,
      `a key after select-all took ${numbers.typeAfterSelectAllLongestTaskMs} ms`,
    );
    assert.ok(numbers.listBytesNow < 200_000, `request list ${numbers.listBytesNow} bytes`);
  }
} finally {
  await browser?.close();
  await app?.close();
}

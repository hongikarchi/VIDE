// Spike (SPIKE-2026-09-29-render-perf): cost of showing one large Sync in the workspace.
// Synthetic model only (no user files). Usage: node tools/spikes/2026-09-29-render-perf/measure.mjs [surfaces] [curves]
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../../src/server/server.ts';

const surfaces = Number(process.argv[2] ?? 12000);
const curves = Number(process.argv[3] ?? 12000);
const b64 = (text) => Buffer.from(text).toString('base64');

/** A bumpy 10x10-cell surface patch (200 triangles) at grid position i. */
const cells = Number(process.env.CELLS ?? 10);
let surface = function (i) {
  const ox = (i % 120) * 3,
    oy = Math.floor(i / 120) * 3;
  const vertices = [],
    indices = [];
  for (let y = 0; y <= cells; y++)
    for (let x = 0; x <= cells; x++)
      vertices.push(ox + x * 0.25, oy + y * 0.25, Math.sin(x + i) * 0.1 + Math.cos(y) * 0.1);
  for (let y = 0; y < cells; y++)
    for (let x = 0; x < cells; x++) {
      const a = y * (cells + 1) + x;
      indices.push(a, a + 1, a + cells + 2, a, a + cells + 2, a + cells + 1);
    }
  return {
    id: 's' + i,
    nativeId: 's' + i,
    nativeType: 'Brep',
    vertices,
    indices,
    layer64: b64('Layer ' + (i % 40)),
    geometryHash: 'hs' + i,
    ...(process.env.FULL
      ? {
          origin: [ox, oy, 0],
          boundsSize: [cells * 0.25, cells * 0.25, 0.2],
          name64: '',
          line: [],
          area: null,
          volume: null,
          length: null,
          attributes64: [],
          attributesComplete: true,
          valid: true,
        }
      : {}),
  };
};
if (process.env.TRIANGLE)
  surface = (i) => ({
    id: 's' + i,
    nativeId: 's' + i,
    nativeType: 'Brep',
    vertices: [0, 0, 0, 2, 0, 0, 0, 3, 0],
    indices: [0, 1, 2],
    boundsSize: [2, 3, 4],
    area: 12.5,
    volume: 24,
  });
/** A 30-segment polyline. */
function curve(i) {
  const ox = (i % 120) * 3,
    oy = Math.floor(i / 120) * 3 + 400;
  const points = [];
  for (let k = 0; k <= 30; k++) points.push(ox + k * 0.1, oy + Math.sin(k * 0.3 + i), 0);
  const segments = [];
  for (let k = 0; k < 30; k++) segments.push(...points.slice(k * 3, k * 3 + 6));
  return {
    id: 'c' + i,
    nativeId: 'c' + i,
    nativeType: 'Curve',
    segments,
    layer64: b64('Curves ' + (i % 20)),
    geometryHash: 'hc' + i,
  };
}

const directory = await mkdtemp(join(tmpdir(), 'vide-render-perf-'));
const app = await startServer({ filename: join(directory, 'perf.sqlite') });
const browser = await chromium.launch({
  channel: 'chrome',
  headless: !process.env.HEADED,
  args: process.env.HEADED
    ? ['--window-position=-3000,0', '--window-size=1600,1000']
    : process.env.SOFTWARE
      ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : (process.env.GPU_ARGS ?? '').split(' ').filter(Boolean),
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  if (process.env.TRACE) {
    page.on('console', (m) => console.log('CONSOLE', m.type(), m.text().slice(0, 200)));
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 300)));
    page.on(
      'request',
      (r) => r.url().includes('/requests/') && console.log('REQ', r.url().slice(-60)),
    );
  }
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  const scene = [
    ...Array.from({ length: surfaces }, (_, i) => surface(i)),
    ...Array.from({ length: curves }, (_, i) => curve(i)),
  ];
  const objects = scene.map((item) => ({
    id: item.id,
    name: item.id,
    kind: 'native',
    nativeId: item.nativeId,
  }));
  const result = {
    host: 'rhino',
    hostExecuted: true,
    executionMode: 'sdk',
    displayOnly: true,
    objects,
    scene,
    sourceDocument: {
      name: 'perf.3dm',
      capturedAt: new Date().toISOString(),
      instance: '1:1',
      documentId: 1,
    },
  };
  const input = {
    id: 'perf-sync',
    provider: 'codex-cli',
    host: 'rhino',
    source: 'document',
    permission: 'candidate',
    body: 'perf',
    pins: [],
    sketches: [],
    files: [],
  };
  const stored = JSON.stringify(result);
  app.store.db
    .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
    .run(input.id, projectId, JSON.stringify(input), 'succeeded', stored, new Date().toISOString());
  // Transfer: the full request as the workspace fetches it.
  const transfer = await page.evaluate(async (id) => {
    const began = performance.now();
    const response = await fetch(`/api/v1/projects/${id}/requests/perf-sync`);
    const text = await response.text();
    const fetched = performance.now();
    JSON.parse(text);
    return { bytes: text.length, fetchMs: fetched - began, parseMs: performance.now() - fetched };
  }, projectId);
  // End to end: reload until the object list shows every object.
  // A fresh browser (no saved draft) opens the project and shows its latest Sync.
  const fresh = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const view = await fresh.newPage();
  await view.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  const began = Date.now();
  await view.goto(app.launchUrl);
  await view.waitForFunction(
    (count) =>
      document
        .querySelector('.object-summary')
        ?.textContent.startsWith(count.toLocaleString() + '개'),
    scene.length,
    { timeout: 180000 },
  );
  const shownMs = Date.now() - began;
  if (process.env.SHOT) {
    await view.locator('#fit-view').click();
    await view.waitForTimeout(500);
    await view.screenshot({ path: process.env.SHOT });
  }
  const render = await view.evaluate(() => window.videViewport.benchmark(40));
  const heap = await view.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
  console.log(
    JSON.stringify(
      {
        objects: scene.length,
        storedMB: +(stored.length / 1e6).toFixed(1),
        transfer: {
          MB: +(transfer.bytes / 1e6).toFixed(1),
          fetchMs: Math.round(transfer.fetchMs),
          parseMs: Math.round(transfer.parseMs),
        },
        reloadUntilShownMs: shownMs,
        render: { ...render, frameMs: +render.frameMs.toFixed(2) },
        heapMB: heap && +(heap / 1e6).toFixed(0),
      },
      null,
      1,
    ),
  );
} finally {
  await browser.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}

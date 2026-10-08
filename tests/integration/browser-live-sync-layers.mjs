// Live Sync keeps the layer tree current (SPEC-01.9 4, ARCH-01 「레이어 표」): the engine patches the
// stored Sync's layer table in place and every delta reply carries it, so a reorder, a layer turned
// off, a renamed parent or a layer moved under another parent shows without a reload. Here the test
// plays the engine by writing to the workspace directly.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { runDirectory } from './run-directory.mjs';
import { soleDb } from '../fixtures/store.mjs';

const directory = runDirectory('live-layers');
await mkdir(directory, { recursive: true });
const instance = '42:100:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const box = (nativeId, x, layer) => ({
  object: { id: nativeId, nativeId, kind: 'native', name: 'Mass ' + x, origin: [x, 0, 0] },
  scene: {
    id: nativeId,
    nativeId,
    nativeType: 'Brep',
    geometryHash: nativeId.slice(0, 4) + x,
    name64: '',
    origin: [x, 0, 0],
    boundsSize: [1, 1, 1],
    vertices: [x, 0, 0, x + 1, 0, 0, x, 1, 0],
    indices: [0, 1, 2],
    line: [],
    area: null,
    volume: null,
    length: null,
    layer64: Buffer.from(layer).toString('base64'),
    attributes64: [],
    attributesComplete: true,
    valid: true,
  },
});
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A layer table row: [fullPath, parent n, n, order, objectCount, visible]. */
const table = (rows) =>
  rows.map(([fullPath, parent, n, order, objectCount, visible = true]) => ({
    id: uuid(n),
    parentId: parent ? uuid(parent) : null,
    fullPath,
    visible,
    locked: false,
    color: '#336699',
    order,
    objectCount,
    expanded: true,
  }));
const sourceDocument = (revision) => ({
  instance,
  documentId: 7,
  documentHash: String(revision).padStart(64, '0'),
  revision,
  name: 'Layers test',
  capturedAt: new Date().toISOString(),
  connection: 'attached-editor',
});
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  const workspace = new Workspace(app.store);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
        name: 'Layers test',
        units: 'Millimeters',
        objectCount: 2,
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
  for (const path of ['capture', 'live-sync'])
    await page.route(`**/api/v1/projects/*/${path}`, (route) =>
      route.fulfill({ status: 500, json: { code: 'UNEXPECTED' } }),
    );
  const deltas = [];
  let fullFetches = 0;
  await page.route('**/api/v1/projects/*/requests/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname.endsWith('/delta'))
      deltas.push(url.search);
    else if (route.request().method() === 'GET' && /\/requests\/[^/]+$/.test(url.pathname))
      fullFetches++;
    await route.fallback();
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  const projectId = await page.locator('#project-picker').inputValue();
  const now = new Date().toISOString();
  soleDb(app.store)
    .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
    .run('link-l', projectId, 'rhino', 'Layers test', null, instance, 7, now, now);
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
          objectCount: 2,
          units: 'Millimeters',
          modified: true,
          hostBusy: false,
        },
      })),
    });
  });
  // First full Sync: Bldg (expanded) > L1, L2, one object each; Site after Bldg.
  const a = box('11111111-1111-4111-8111-111111111111', 0, 'Bldg::L1');
  const b = box('22222222-2222-4222-8222-222222222222', 3, 'Bldg::L2');
  const syncId = randomUUID();
  workspace.submit(projectId, {
    id: syncId,
    linkId: 'link-l',
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
  workspace.update(projectId, syncId, 'succeeded', {
    host: 'rhino',
    hostExecuted: true,
    verified: false,
    displayOnly: true,
    executionMode: 'sdk',
    text: 'Sync complete',
    sourceDocument: sourceDocument(1),
    objects: [a.object, b.object],
    scene: [a.scene, b.scene],
    layers: table([
      ['Bldg', null, 1, 0, 0],
      ['Bldg::L1', 1, 2, 1, 1],
      ['Bldg::L2', 1, 3, 2, 1],
      ['Site', null, 4, 3, 0],
    ]),
  });
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent?.startsWith('2개 객체'),
  );
  /** The layer list as 'path=count(off)' per row, top to bottom. */
  const layerRows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.object-groups .layer')].map(
        (wrap) =>
          `${wrap.dataset.path}=${wrap.querySelector(':scope > .layer-row .layer-count')?.textContent}${
            wrap.classList.contains('layer-off') ? '(off)' : ''
          }`,
      ),
    );
  const waitRows = async (expected, label) => {
    const until = Date.now() + 8000;
    let rows = await layerRows();
    while (rows.join('|') !== expected.join('|') && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await layerRows();
    }
    assert.deepEqual(rows, expected, label);
  };
  await waitRows(['Bldg=2', 'Bldg::L1=1', 'Bldg::L2=1'], 'first Sync');
  const fetchedOnce = fullFetches;

  // (1) Rhino reorders L2 above L1: no object changes, only the layer table.
  workspace.applyDelta(
    projectId,
    syncId,
    { objects: [], scene: [], removed: [] },
    {
      sourceDocument: sourceDocument(2),
      layers: table([
        ['Bldg', null, 1, 0, 0],
        ['Bldg::L1', 1, 2, 2, 1],
        ['Bldg::L2', 1, 3, 1, 1],
        ['Site', null, 4, 3, 0],
      ]),
    },
  );
  await waitRows(['Bldg=2', 'Bldg::L2=1', 'Bldg::L1=1'], 'reorder');

  // (2) L2 turned off in Rhino: its object leaves the Sync, the row greys with Rhino's count.
  workspace.applyDelta(
    projectId,
    syncId,
    { objects: [], scene: [], removed: [b.object.nativeId] },
    {
      sourceDocument: sourceDocument(3),
      layers: table([
        ['Bldg', null, 1, 0, 0],
        ['Bldg::L1', 1, 2, 2, 1],
        ['Bldg::L2', 1, 3, 1, 1, false],
        ['Site', null, 4, 3, 0],
      ]),
    },
  );
  await waitRows(['Bldg=2', 'Bldg::L2=1(off)', 'Bldg::L1=1'], 'layer off');

  // (3) Bldg renamed to Tower: the object rows and the table change together; no ghost Bldg.
  const a2 = box(a.object.nativeId, 0, 'Tower::L1');
  workspace.applyDelta(
    projectId,
    syncId,
    { objects: [a2.object], scene: [a2.scene], removed: [] },
    {
      sourceDocument: sourceDocument(4),
      layers: table([
        ['Tower', null, 1, 0, 0],
        ['Tower::L1', 1, 2, 2, 1],
        ['Tower::L2', 1, 3, 1, 1, false],
        ['Site', null, 4, 3, 0],
      ]),
    },
  );
  await waitRows(['Tower=2', 'Tower::L2=1(off)', 'Tower::L1=1'], 'rename');

  // (4) L1 dragged under Site: it moves there; Tower keeps only its off L2.
  const a3 = box(a.object.nativeId, 0, 'Site::L1');
  workspace.applyDelta(
    projectId,
    syncId,
    { objects: [a3.object], scene: [a3.scene], removed: [] },
    {
      sourceDocument: sourceDocument(5),
      layers: table([
        ['Tower', null, 1, 0, 0],
        ['Tower::L2', 1, 3, 1, 1, false],
        ['Site', null, 4, 3, 0],
        ['Site::L1', 4, 2, 4, 1],
      ]),
    },
  );
  // Site was never opened here and has no Rhino expanded state for the new parent: open it.
  await page.waitForFunction(() =>
    document.querySelector('.object-groups .layer[data-path="Site"]'),
  );
  await page.evaluate(() => {
    const row = document.querySelector('.object-groups .layer[data-path="Site"] > .layer-row');
    if (row.getAttribute('aria-expanded') !== 'true') row.click();
  });
  await waitRows(['Tower=1', 'Tower::L2=1(off)', 'Site=1', 'Site::L1=1'], 'moved');
  assert.equal(fullFetches, fetchedOnce, 'the layer changes came with the deltas, not whole');
  assert.ok(deltas.length >= 4, `deltas: ${deltas}`);

  // The reloaded page reads the same tree from the stored Sync.
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent?.startsWith('1개 객체'),
  );
  await page.evaluate(() => {
    const row = document.querySelector('.object-groups .layer[data-path="Site"] > .layer-row');
    if (row && row.getAttribute('aria-expanded') !== 'true') row.click();
  });
  await waitRows(['Tower=1', 'Tower::L2=1(off)', 'Site=1', 'Site::L1=1'], 'after reload');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      reorder: true,
      layerOff: true,
      rename: true,
      moved: true,
      noWholeFetch: true,
    }),
  );
} finally {
  await browser?.close();
  await app?.close();
}

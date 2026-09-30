// Rhino panel mode: the chat column only, bound to one attached document, sharing Rhino's pins.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';

const directory = resolve('.vide/browser-rhino-panel', randomUUID());
await mkdir(directory, { recursive: true });
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  const workspace = new Workspace(app.store);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 380, height: 760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'ChatGPT', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  const instance = '42:100:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const wall = randomUUID(),
    slab = randomUUID();
  let pinned = [],
    selected = [wall],
    selectionVersion = 1;
  const catalog = () => ({
    instance,
    documents: [
      {
        instance,
        id: 7,
        name: 'Panel test.3dm',
        units: 'Meters',
        objectCount: 2,
        modified: false,
        host: 'rhino',
        connection: 'attached-editor',
        generation: 0,
        live: true,
        hostBusy: false,
        selectionVersion,
        selectedIds: selected,
        pinnedIds: pinned,
      },
    ],
  });
  for (const path of ['documents', 'attached-documents'])
    await page.route(`**/api/v1/host/${path}`, (route) => route.fulfill({ json: catalog() }));
  const pinPosts = [];
  await page.route('**/api/v1/host/pins', async (route) => {
    const body = route.request().postDataJSON();
    pinPosts.push(body);
    pinned = body.ids;
    selectionVersion++;
    await route.fulfill({ json: { ok: true, pinnedIds: pinned, selectionVersion } });
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let captures = 0;
  await page.route('**/api/v1/projects/*/capture', async (route) => {
    captures++;
    // The first Sync of the linked file waits so a pin can be made before any Sync exists.
    await held;
    const target = route.request().postDataJSON(),
      projectId = new URL(route.request().url()).pathname.split('/')[4];
    const input = {
      id: target.id,
      linkId: target.linkId,
      body: 'Sync',
      permission: 'review',
      provider: 'codex-cli',
      pins: [],
      sketches: [],
      files: [],
      source: 'document',
      host: 'rhino',
    };
    workspace.submit(projectId, input);
    await route.fulfill({
      json: workspace.update(projectId, input.id, 'succeeded', {
        host: 'rhino',
        hostExecuted: true,
        displayOnly: true,
        executionMode: 'sdk',
        text: 'Sync complete',
        sourceDocument: {
          instance,
          documentId: 7,
          documentHash: 'a'.repeat(64),
          name: 'Panel test.3dm',
          capturedAt: new Date().toISOString(),
          connection: 'attached-editor',
        },
        objects: [
          { id: wall, name: 'North wall', kind: 'native', origin: [0, 0, 0] },
          { id: slab, name: 'Slab', kind: 'native', origin: [0, 0, 0] },
        ],
        scene: [],
      }),
    });
  });
  // The plugin linked this document to the project and opened the panel for it.
  const projectId = 'panel-project';
  app.store.db.prepare("INSERT INTO projects(id, name) VALUES(?, 'Panel')").run(projectId);
  const now = new Date().toISOString();
  app.store.db
    .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
    .run('link-panel', projectId, 'rhino', 'Panel test.3dm', null, instance, 7, now, now);
  await page.route('**/api/v1/projects/*/links', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
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
          modified: false,
          hostBusy: false,
        },
      })),
    });
  });
  const launch = new URL(app.launchUrl);
  await page.goto(
    `${launch.origin}/?panel=rhino&project=${projectId}&instance=${encodeURIComponent(instance)}&document=7&theme=dark${launch.hash}`,
  );
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  // Only the chat column is visible; the theme follows Rhino.
  assert.equal(await page.locator('#right').isVisible(), true);
  assert.equal(await page.locator('#left').isVisible(), false);
  assert.equal(await page.locator('#canvas').isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.waitForFunction(() =>
    document.querySelector('.host-panel-head strong')?.textContent.includes('Panel test'),
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  // Attach Rhino's selection (the composer chip) before any Sync: pending until the basis exists.
  await page.locator('#context .selection-chip').filter({ hasText: 'Rhino 선택 1개 첨부' }).click();
  await page.waitForFunction(() =>
    document.querySelector('#context').textContent.includes('Sync 대기 1개'),
  );
  assert.deepEqual(pinPosts.at(-1).ids, [wall]);
  // The linked file's Sync resolves the pending pin into the request draft.
  release();
  await page.waitForFunction(() =>
    document.querySelector('#context').textContent.includes('고정 객체 1개'),
  );
  // The panel's Sync button forces another Sync of the same linked file.
  await page.locator('.host-panel-head').getByRole('button', { name: 'Sync', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#right'));
  while (captures < 2) await new Promise((resolve) => setTimeout(resolve, 20));
  // Pins changed in Rhino (another client) appear in the panel without a reload.
  pinned = [wall, slab];
  selectionVersion++;
  await page.waitForFunction(() =>
    document.querySelector('#context').textContent.includes('고정 객체 2개'),
  );
  // Clearing the chip clears Rhino's shared pin set.
  await page.locator('#context .chip button').click();
  await page.waitForFunction(
    () => !document.querySelector('#context').textContent.includes('고정'),
  );
  assert.deepEqual(pinPosts.at(-1).ids, []);
  // Shift+Tab cycles the work mode.
  await page.locator('#body').focus();
  const before = await page.locator('#permission').inputValue();
  await page.keyboard.press('Shift+Tab');
  assert.notEqual(await page.locator('#permission').inputValue(), before);
  await page.screenshot({ path: join(directory, 'rhino-panel-dark.png') });
  // Removed from the project in VIDE (SPEC-01.11 9): the panel asks the plugin to drop its link.
  await page.evaluate(() => {
    window.__actions = [];
    window.addEventListener('vide-host-action', (event) => window.__actions.push(event.detail));
  });
  assert.deepEqual(await page.evaluate(() => window.__actions), []);
  await page.evaluate(
    (id) =>
      fetch(`/api/v1/projects/${id}/links/link-panel/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    projectId,
  );
  await page.waitForFunction(() => window.__actions.includes('unlink'));
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM document_links').get().n, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, panelOnly: true, sharedPins: true, directory }));
} finally {
  await browser?.close();
  await app?.close();
}

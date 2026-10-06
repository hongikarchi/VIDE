// Live Sync in the browser after T-084 (ARCH-01 §7 「엔진 주관 Sync」): the engine Syncs and changes
// the stored display in place; the page never starts a Sync or a Live Sync itself. It follows the
// links list: a new Sync is fetched once, a raised display revision brings only the changed objects
// (`…/delta?since=`), the engine's state shows on the row, and a draft on the file is reported as a
// lease. Here the test plays the engine by writing to the workspace directly.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { runDirectory } from './run-directory.mjs';

import { soleDb } from '../fixtures/store.mjs';
const directory = runDirectory('browser-live-sync');
await mkdir(directory, { recursive: true });
const instance = '42:100:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const box = (nativeId, x, hash) => ({
  object: { id: nativeId, nativeId, kind: 'native', name: 'Mass ' + x, origin: [x, 0, 0] },
  scene: {
    id: nativeId,
    nativeId,
    nativeType: 'Brep',
    geometryHash: hash,
    name64: '',
    origin: [x, 0, 0],
    boundsSize: [1, 1, 1],
    vertices: [x, 0, 0, x + 1, 0, 0, x, 1, 0],
    indices: [0, 1, 2],
    line: [],
    area: null,
    volume: null,
    length: null,
    layer64: Buffer.from('Walls').toString('base64'),
    attributes64: [],
    attributesComplete: true,
    valid: true,
  },
});
const a = box('11111111-1111-4111-8111-111111111111', 0, 'a1'),
  b = box('22222222-2222-4222-8222-222222222222', 3, 'b1');
const sourceDocument = (revision) => ({
  instance,
  documentId: 7,
  documentHash: String(revision).padStart(64, '0'),
  revision,
  name: 'Attached test',
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
        name: 'Attached test',
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
  // The page must not Sync on its own any more.
  const started = [];
  await page.route('**/api/v1/projects/*/capture', (route) => {
    started.push('capture');
    return route.fulfill({ status: 500, json: { code: 'UNEXPECTED' } });
  });
  await page.route('**/api/v1/projects/*/live-sync', (route) => {
    started.push('live-sync');
    return route.fulfill({ status: 500, json: { code: 'UNEXPECTED' } });
  });
  const deltas = [];
  let fullFetches = 0,
    slowFull = false;
  await page.route('**/api/v1/projects/*/requests/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname.endsWith('/delta'))
      deltas.push(url.search);
    else if (route.request().method() === 'GET' && /\/requests\/[^/]+$/.test(url.pathname)) {
      fullFetches++;
      if (slowFull) await new Promise((r) => setTimeout(r, 1500));
    }
    await route.fallback();
  });
  // The engine's Sync state (a scheduler needs a host; here the list carries it).
  let engineSync;
  const leases = [];
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  const projectId = await page.locator('#project-picker').inputValue();
  const now = new Date().toISOString();
  soleDb(app.store)
    .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
    .run('link-a', projectId, 'rhino', 'Attached test', null, instance, 7, now, now);
  await page.route('**/api/v1/projects/*/links*', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || !url.pathname.endsWith('/links'))
      return route.continue();
    leases.push(url.searchParams.get('hold') ?? '');
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
        ...(engineSync ? { sync: engineSync } : {}),
      })),
    });
  });
  // The engine's first Sync of the file: the page shows it without a click.
  const syncId = randomUUID();
  const engineFullSync = (id, objects) => {
    workspace.submit(projectId, {
      id,
      linkId: 'link-a',
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
    workspace.update(projectId, id, 'succeeded', {
      host: 'rhino',
      hostExecuted: true,
      verified: false,
      displayOnly: true,
      executionMode: 'sdk',
      text: 'Sync complete',
      sourceDocument: sourceDocument(1),
      objects: objects.map((item) => item.object),
      scene: objects.map((item) => item.scene),
    });
  };
  engineSync = { state: 'syncing', at: now };
  await page.waitForFunction(() =>
    document.querySelector('.link-row')?.textContent.includes('Sync 중'),
  );
  engineFullSync(syncId, [a, b]);
  engineSync = { state: 'idle', at: now };
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent?.startsWith('2개 객체'),
  );
  const objectSummary = () => page.locator('.object-summary').first().textContent();
  const messages = await page.locator('#task-list .task-row').count();
  const fetchedOnce = fullFetches;

  // The engine's Live Sync in place: one object moved. Only the change is fetched.
  const moved = box(b.object.nativeId, 5, 'b2');
  workspace.applyDelta(
    projectId,
    syncId,
    { objects: [moved.object], scene: [moved.scene], removed: [] },
    { sourceDocument: sourceDocument(2) },
  );
  while (deltas.length < 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(deltas[0], '?since=1');
  assert.match(await objectSummary(), /^2개 객체/);
  assert.equal(await page.locator('#task-list .task-row').count(), messages);

  // A deletion in Rhino removes the object from the list and the viewport.
  workspace.applyDelta(
    projectId,
    syncId,
    { objects: [], scene: [], removed: [a.object.nativeId] },
    { sourceDocument: sourceDocument(3) },
  );
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent?.startsWith('1개 객체'),
  );
  assert.equal(deltas.at(-1), '?since=2');
  assert.equal(fullFetches, fetchedOnce, 'a Live Sync must not fetch the model whole');

  // A draft on this file holds the engine's automatic Syncs: the page renews a lease with each
  // links poll while the draft lasts, and stops when it is cleared.
  await page.locator('#body').fill('이 파일의 벽을 올려줘');
  while (!leases.includes('link-a')) await new Promise((r) => setTimeout(r, 50));
  await page.locator('#body').fill('');
  const cleared = leases.length;
  await new Promise((r) => setTimeout(r, 3500));
  assert.ok(leases.slice(cleared + 1).every((hold) => hold === ''));

  // A moving document: the row says the engine will try again.
  engineSync = { state: 'waiting', code: 'SOURCE_CHANGED', at: now };
  await page.waitForFunction(() =>
    document.querySelector('.link-row')?.textContent.includes('변경 중 · 곧 다시 Sync'),
  );
  engineSync = { state: 'idle', at: now };

  // A full Sync by the engine (the Live Sync could not continue): the new Sync is shown.
  const second = randomUUID();
  engineFullSync(second, [a, b]);
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent?.startsWith('2개 객체'),
  );

  // Opened again while the meshes are still loading, then a Live Sync: the page waits for its
  // fetch and merges the change after it, staying responsive.
  slowFull = true;
  await page.reload();
  const moved2 = box(a.object.nativeId, 9, 'a9');
  await new Promise((r) => setTimeout(r, 300));
  workspace.applyDelta(
    projectId,
    second,
    { objects: [], scene: [], removed: [b.object.nativeId] },
    { sourceDocument: sourceDocument(4) },
  );
  const responsive = () =>
    Promise.race([page.evaluate(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
  const reopened = Date.now();
  while (Date.now() - reopened < 4000) {
    assert.equal(await responsive(), true, 'the page froze while the meshes loaded');
    await new Promise((r) => setTimeout(r, 200));
  }
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent?.startsWith('1개 객체'),
  );
  workspace.applyDelta(
    projectId,
    second,
    { objects: [moved2.object], scene: [moved2.scene], removed: [] },
    { sourceDocument: sourceDocument(5) },
  );
  const before = deltas.length;
  while (deltas.length === before) await new Promise((r) => setTimeout(r, 50));
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent?.startsWith('1개 객체'),
  );

  assert.deepEqual(started, [], 'the page started a Sync itself');
  assert.ok(leases.length > 3);

  // ⟳ asks only for what changed; Shift+⟳ and the row menu's 전체 다시 읽기 ask for the whole
  // document (`full`, T-123 review).
  await page.unroute('**/api/v1/projects/*/capture');
  const pressed = [];
  await page.route('**/api/v1/projects/*/capture', (route) => {
    pressed.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { code: 'HOST_BUSY' } });
  });
  const press = async (action) => {
    const count = pressed.length;
    await action();
    while (pressed.length === count) await new Promise((r) => setTimeout(r, 50));
    // The row leaves 'Sync 중' when the answer is in.
    await page.waitForFunction(
      () => !document.querySelector('.link-row')?.textContent.includes('Sync 중'),
    );
    return pressed.at(-1);
  };
  const sync = page.locator('.link-row .link-sync').first();
  let body = await press(() => sync.click());
  assert.equal(body.fresh, true);
  assert.equal(body.full, undefined);
  body = await press(() => sync.click({ modifiers: ['Shift'] }));
  assert.equal(body.full, true);
  await page.locator('.link-row').first().click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Attached test 메뉴' });
  await menu.waitFor();
  body = await press(() => menu.getByRole('menuitem', { name: '전체 다시 읽기' }).click());
  assert.equal(body.full, true);
  assert.equal(body.linkId, 'link-a');
  assert.equal(await menu.count(), 0);

  // ⟳ while a draft holds the file (T-127): the engine writes the change into a copy once; the
  // page builds the copy from the Sync it shows and the change (`delta?base=`), never fetching it
  // whole. The next ⟳ changes that copy in place and the page asks only that change at once.
  await page.unroute('**/api/v1/projects/*/capture');
  const copyId = randomUUID();
  const c = box('33333333-3333-4333-8333-333333333333', 6, 'c1');
  const light = (id) => {
    const { objects, ...result } = workspace.summary(projectId, id).result;
    return {
      ...workspace.summary(projectId, id),
      result: { ...result, objectsOmitted: true, objectCount: objects?.length ?? 0 },
    };
  };
  let copyPresses = 0;
  await page.route('**/api/v1/projects/*/capture', (route) => {
    copyPresses++;
    if (copyPresses === 1) {
      workspace.submit(projectId, {
        id: copyId,
        linkId: 'link-a',
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
      workspace.applyDelta(
        projectId,
        second,
        { objects: [c.object], scene: [c.scene], removed: [] },
        { sourceDocument: sourceDocument(6) },
        copyId,
      );
    } else
      workspace.applyDelta(
        projectId,
        copyId,
        { objects: [], scene: [], removed: [c.object.nativeId] },
        { sourceDocument: sourceDocument(7) },
      );
    return route.fulfill({ json: light(copyId) });
  });
  const fullBeforeCopy = fullFetches;
  const deltasBeforeCopy = deltas.length;
  await sync.click();
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent?.startsWith('2개 객체'),
  );
  assert.ok(
    deltas.slice(deltasBeforeCopy).some((search) => search.includes(`base=${second}`)),
    `the copy came from the shown Sync and its change: ${deltas.slice(deltasBeforeCopy)}`,
  );
  const deltasBeforeInPlace = deltas.length;
  await sync.click();
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent?.startsWith('1개 객체'),
  );
  assert.ok(deltas.length > deltasBeforeInPlace);
  assert.equal(fullFetches, fullBeforeCopy, 'a ⟳ into a copy must not fetch the model whole');
  assert.equal(copyPresses, 2);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(directory, 'live-sync.png') });
  console.log(
    JSON.stringify({
      passed: true,
      pageStartsNoSync: true,
      deltaOnly: true,
      removalApplied: true,
      engineStateShown: true,
      draftLease: true,
      reopenedWhileMeshesLoad: true,
      fullReread: true,
      heldCopyByDelta: true,
      directory,
    }),
  );
} finally {
  await browser?.close();
  await app?.close();
}

// Live Sync in the browser: a Rhino change updates the displayed Sync with only the changed
// objects (no full capture), and an untrackable connection falls back to a full Sync.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';

const directory = resolve('.vide/browser-live-sync', randomUUID());
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
  let generation = 0;
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
        generation,
        live: true,
        hostBusy: false,
      },
    ],
  });
  for (const path of ['documents', 'attached-documents'])
    await page.route(`**/api/v1/host/${path}`, (route) => route.fulfill({ json: catalog() }));
  let captures = 0,
    syncId;
  const sourceDocument = (revision) => ({
    instance,
    documentId: 7,
    documentHash: String(revision).padStart(64, '0'),
    revision,
    name: 'Attached test',
    capturedAt: new Date().toISOString(),
    connection: 'attached-editor',
  });
  await page.route('**/api/v1/projects/*/capture', async (route) => {
    captures++;
    const target = route.request().postDataJSON(),
      projectId = new URL(route.request().url()).pathname.split('/')[4];
    workspace.submit(projectId, {
      id: target.id,
      body: 'Sync',
      permission: 'candidate',
      provider: 'codex-cli',
      pins: [],
      sketches: [],
      files: [],
      source: 'document',
      host: 'rhino',
    });
    syncId = target.id;
    await route.fulfill({
      json: workspace.update(projectId, target.id, 'succeeded', {
        host: 'rhino',
        hostExecuted: true,
        verified: false,
        displayOnly: true,
        executionMode: 'sdk',
        text: 'Sync complete',
        sourceDocument: sourceDocument(1),
        objects: [a.object, b.object],
        scene: [a.scene, b.scene],
      }),
    });
  });
  const lives = [];
  let liveReply;
  await page.route('**/api/v1/projects/*/live-sync', async (route) => {
    const body = route.request().postDataJSON();
    lives.push(body);
    const reply = liveReply(body);
    await route.fulfill({ json: reply });
  });
  const moved = box(b.object.nativeId, 5, 'b2');
  const summary = (revision) => ({
    id: syncId,
    input: {
      id: syncId,
      body: 'Sync',
      permission: 'candidate',
      provider: 'codex-cli',
      pins: [],
      sketches: [],
      files: [],
      source: 'document',
      host: 'rhino',
    },
    state: 'succeeded',
    createdAt: new Date().toISOString(),
    result: {
      host: 'rhino',
      hostExecuted: true,
      displayOnly: true,
      executionMode: 'sdk',
      text: 'Sync complete',
      sourceDocument: sourceDocument(revision),
    },
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.locator('#refresh-documents').click();
  await page.locator('#capture-document').click();
  await page.waitForFunction(
    () => document.querySelector('#host-document-info').textContent === 'Sync 완료',
  );
  const objectSummary = () => page.locator('.object-summary').first().textContent();
  assert.match(await objectSummary(), /^2개 객체/);
  const messages = await page.locator('.chat-message').count();

  // One object moved in Rhino: only it is fetched and the same Sync is updated in place.
  liveReply = (body) => ({
    requestId: syncId,
    basisId: body.basisId,
    created: false,
    since: body.revision,
    revision: 2,
    request: summary(2),
    delta: { objects: [moved.object], scene: [moved.scene], removed: [] },
  });
  generation++;
  while (lives.length < 1) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(lives[0], { instance, documentId: 7, basisId: syncId, revision: 1 });
  await page.waitForFunction(
    () => document.querySelector('#host-document-info').textContent === 'Sync 완료',
  );
  assert.match(await objectSummary(), /^2개 객체/);
  assert.equal(captures, 1);
  assert.equal(await page.locator('.chat-message').count(), messages);

  // A deletion reported by Rhino removes the object from the list and the viewport.
  liveReply = (body) => {
    assert.equal(body.revision, 2);
    return {
      requestId: syncId,
      basisId: body.basisId,
      created: false,
      since: body.revision,
      revision: 3,
      request: summary(3),
      delta: { objects: [], scene: [], removed: [a.object.nativeId] },
    };
  };
  generation++;
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent?.startsWith('1개 객체'),
  );
  assert.equal(captures, 1);

  // A connection that cannot report changes falls back to a full Sync.
  liveReply = () => ({ resync: true });
  generation++;
  while (captures < 2) await new Promise((r) => setTimeout(r, 50));
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent?.startsWith('2개 객체'),
  );
  assert.equal(lives.length, 3);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(directory, 'live-sync.png') });
  console.log(
    JSON.stringify({
      passed: true,
      liveUpdateWithoutCapture: true,
      removalApplied: true,
      resyncFallback: true,
      directory,
    }),
  );
} finally {
  await browser?.close();
  await app?.close();
}

// Inline pins: selecting objects shows a translucent chip at the caret; clicking it writes a
// "[고정N · k개]" token into the sentence and pins those objects with the token's label. Deleting
// the token drops its pins, and the request sends only the pins whose token is in the message.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { runDirectory } from './run-directory.mjs';
import { soleDb } from '../fixtures/store.mjs';
// The links list, with or without a page's draft lease (`?page=&hold=`, T-084).
const linksUrl = /\/api\/v1\/projects\/[^/]+\/links(\?.*)?$/;

const directory = runDirectory('browser-pin-tokens');
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
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ json: [{ id: 'codex-cli', available: true }] }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
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
  const sourceDocument = (revision) => ({
    instance,
    documentId: 7,
    documentHash: String(revision).padStart(64, '0'),
    revision,
    name: 'Attached test',
    capturedAt: new Date().toISOString(),
    connection: 'attached-editor',
  });
  const posted = [];
  await page.route('**/api/v1/projects/*/requests', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, json: { code: 'INVALID_INPUT' } });
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  // The Rhino document is linked to the project; its first Sync needs no click.
  const projectId = await page.locator('#project-picker').inputValue();
  const now = new Date().toISOString();
  soleDb(app.store)
    .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
    .run('link-a', projectId, 'rhino', 'Attached test', null, instance, 7, now, now);
  await page.route(linksUrl, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const rows = await (await route.fetch()).json();
    await route.fulfill({
      json: rows.map((row) => ({
        ...row,
        connection: {
          instance,
          documentId: 7,
          live: true,
          generation,
          objectCount: 2,
          units: 'Millimeters',
          modified: true,
          hostBusy: false,
        },
      })),
    });
  });
  // The engine's first Sync of the file (T-084): written here, shown without a click.
  const syncId = 'engine-sync';
  workspace.submit(projectId, {
    id: syncId,
    linkId: 'link-a',
    body: 'Sync',
    permission: 'candidate',
    provider: 'codex-cli',
    pins: [],
    sketches: [],
    files: [],
    source: 'document',
    host: 'rhino',
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
  });
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent?.startsWith('2개 객체'),
  );
  const body = page.locator('#body'),
    ghost = page.locator('.pin-ghost');
  await body.click();
  await body.pressSequentially('벽 ');
  assert.equal(await ghost.isHidden(), true, 'no ghost without a selection');
  // Select all displayed objects in the viewport (Ctrl+A), then return to the sentence.
  await page.locator('#canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+a');
  await body.click();
  await page.keyboard.press('End');
  await ghost.waitFor({ state: 'visible' });
  assert.equal(await ghost.textContent(), '📌 고정 · 2개');
  // The ghost sits on the sentence's line right after the typed words, at the text's size.
  const [line, chip] = [await body.boundingBox(), await ghost.boundingBox()];
  assert.ok(chip.y - line.y < 30, 'ghost on the first line');
  assert.equal(
    await ghost.evaluate((node) => getComputedStyle(node).fontSize),
    await body.evaluate((node) => getComputedStyle(node).fontSize),
  );
  await page.screenshot({ path: join(directory, 'pin-ghost.png') });
  await ghost.click();
  assert.equal(await body.inputValue(), '벽 [고정1 · 2개]');
  assert.equal(await page.locator('.body-backdrop mark.pin-token').count(), 1);
  // The same selection is already that token: no second ghost.
  assert.equal(await ghost.isHidden(), true, 'ghost hidden for an existing token selection');
  await body.pressSequentially('을 옮겨줘');
  // Backspace removes the whole token atomically and drops its pins.
  await page.keyboard.press('Home');
  for (let i = 0; i < '벽 [고정1 · 2개]'.length; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Backspace');
  assert.equal(await body.inputValue(), '벽 을 옮겨줘');
  // Reinsert mid-sentence at the caret; the chip drops one line so it does not cover the words.
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await ghost.waitFor({ state: 'visible' });
  const [caretBox, ghostBox] = [await body.boundingBox(), await ghost.boundingBox()];
  assert.ok(ghostBox.y > caretBox.y + 10, 'mid-sentence ghost sits below the line');
  await ghost.click();
  const text = await body.inputValue();
  assert.equal(text, '벽 [고정1 · 2개] 을 옮겨줘');
  await page.locator('#model').selectOption('codex-cli');
  await page.locator('#request').click();
  while (!posted.length) await new Promise((r) => setTimeout(r, 50));
  const sent = posted[0];
  assert.equal(sent.body, text);
  assert.deepEqual(sent.pins.map((pin) => [pin.id, pin.label]).sort(), [
    [a.object.id, '고정1'],
    [b.object.id, '고정1'],
  ]);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(directory, 'pin-tokens.png') });
  console.log(
    JSON.stringify({
      passed: true,
      ghostAtCaret: true,
      tokenInserted: true,
      atomicDelete: true,
      pinsLabelled: true,
      directory,
    }),
  );
} finally {
  await browser?.close();
  await app?.close();
}

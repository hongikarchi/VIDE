// Rhino panel chat: a message queued in the attached Rhino panel becomes an ordinary VIDE request
// on a fresh Sync basis, and VIDE reports the request back to the panel.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';

const directory = resolve('.vide/browser-rhino-chat', randomUUID());
await mkdir(directory, { recursive: true });
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
      json: [
        { id: 'codex-cli', name: 'ChatGPT', provider: 'codex-cli', efforts: ['default', 'high'] },
      ],
    }),
  );
  const instance = '42:100:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const wall = randomUUID(),
    messageId = randomUUID();
  const catalog = {
    instance,
    documents: [
      {
        instance,
        id: 7,
        name: 'Panel chat test',
        units: 'Meters',
        objectCount: 1,
        modified: false,
        host: 'rhino',
        connection: 'attached-editor',
        generation: 0,
        live: false,
        hostBusy: false,
      },
    ],
  };
  for (const path of ['documents', 'attached-documents'])
    await page.route(`**/api/v1/host/${path}`, (route) => route.fulfill({ json: catalog }));
  let captureId;
  await page.route('**/api/v1/projects/*/capture', async (route) => {
    const target = route.request().postDataJSON(),
      projectId = new URL(route.request().url()).pathname.split('/')[4];
    captureId = target.id;
    const input = {
      id: target.id,
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
          name: 'Panel chat test',
          capturedAt: new Date().toISOString(),
          connection: 'attached-editor',
        },
        objects: [{ id: wall, name: 'North wall', kind: 'native', origin: [0, 0, 0] }],
        scene: [],
      }),
    });
  });
  let submitted;
  await page.route('**/api/v1/projects/*/requests', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const input = route.request().postDataJSON(),
      projectId = new URL(route.request().url()).pathname.split('/')[4];
    submitted = input;
    // Store without executing a real provider.
    workspace.submit(projectId, input);
    await route.fulfill({ json: workspace.get(projectId, input.id) });
  });
  const exchanges = [];
  let delivered = false;
  await page.route('**/api/v1/host/attached-bridge', async (route) => {
    const payload = route.request().postDataJSON();
    exchanges.push(payload);
    const outbox =
      !delivered || !payload.ack.includes(messageId)
        ? [
            {
              id: messageId,
              body: '선택한 벽을 3.2m로 높여줘',
              model: 'codex-cli',
              effort: 'high',
              permission: 'apply',
              pinIds: [wall],
              createdAt: new Date().toISOString(),
            },
          ]
        : [];
    if (payload.ack.includes(messageId)) delivered = true;
    if (delivered) outbox.length = 0;
    await route.fulfill({ json: { ok: true, outbox } });
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.waitForFunction(() => document.querySelector('[data-request-id]') !== null);
  for (let i = 0; i < 100 && !submitted; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(captureId, 'Sync basis captured before submission');
  assert.equal(submitted.id, messageId);
  assert.equal(submitted.applyToSource, true);
  assert.equal(submitted.permission, 'candidate');
  assert.equal(submitted.effort, 'high');
  assert.equal(submitted.baseRequestId, captureId);
  assert.deepEqual(
    submitted.pins.map((pin) => [pin.id, pin.role, pin.basis]),
    [[wall, 'target', captureId]],
  );
  await page.locator(`[data-request-id="${messageId}"]`).waitFor();
  for (let i = 0; i < 100 && !delivered; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(delivered, true, 'handled message is acknowledged');
  const lastState = () => exchanges.at(-1).state;
  for (let i = 0; i < 50 && !lastState().recent.some((item) => item.id === messageId); i++)
    await new Promise((r) => setTimeout(r, 100));
  const echoed = lastState().recent.find((item) => item.id === messageId);
  assert.equal(echoed.origin, 'rhino');
  assert.deepEqual(
    lastState().models.map((model) => model.id),
    ['codex-cli'],
  );
  assert.match(lastState().basis, /^Sync/);
  const submissions = exchanges.filter((item) => item.ack.includes(messageId)).length;
  assert.ok(submissions >= 1);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, captured: true, applyToSource: true, acknowledged: true }),
  );
} finally {
  await browser?.close();
  await app?.close();
}

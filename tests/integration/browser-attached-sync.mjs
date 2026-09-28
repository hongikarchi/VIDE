import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';

const directory = resolve('.vide/browser-attached', randomUUID());
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
      json: [{ id: 'codex-cli', name: 'ChatGPT', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  const instance = '42:100:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let generation = 0,
    captures = 0,
    connected = true,
    rejectCapture = true,
    releaseCapture;
  const catalog = () => ({
    instance,
    documents: connected
      ? [
          {
            instance,
            id: 7,
            name: 'Attached test',
            units: 'Millimeters',
            objectCount: 1,
            modified: true,
            host: 'rhino',
            connection: 'attached-editor',
            generation,
            live: true,
            hostBusy: false,
          },
        ]
      : [],
  });
  for (const path of ['documents', 'attached-documents'])
    await page.route(`**/api/v1/host/${path}`, (route) => route.fulfill({ json: catalog() }));
  await page.route('**/api/v1/projects/*/capture', async (route) => {
    captures++;
    const target = route.request().postDataJSON(),
      projectId = new URL(route.request().url()).pathname.split('/')[4];
    assert.equal(target.instance, instance);
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
    if (rejectCapture) {
      await new Promise((resolve) => {
        releaseCapture = resolve;
      });
      const failed = workspace.update(projectId, input.id, 'failed', {
        hostExecuted: false,
        code: 'IMPORT_LIMIT',
      });
      await route.fulfill({ json: failed });
      return;
    }
    const request = workspace.update(projectId, input.id, 'succeeded', {
      host: 'rhino',
      hostExecuted: true,
      verified: false,
      displayOnly: true,
      executionMode: 'sdk',
      text: 'Sync complete',
      sourceDocument: {
        instance,
        documentId: 7,
        documentHash: 'a'.repeat(64),
        name: 'Attached test',
        capturedAt: new Date().toISOString(),
        connection: 'attached-editor',
      },
      objects: [
        { id: 'box', name: 'Native mass', kind: 'box', origin: [0, 0, 0], size: [2, 3, 4] },
      ],
      scene: [],
    });
    await route.fulfill({ json: request });
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.locator('#refresh-documents').click();
  await page.waitForFunction(
    () => document.querySelector('#viewport-empty').dataset.state === 'connected',
  );
  assert.equal(
    await page.locator('#viewport-empty').evaluate((n) => getComputedStyle(n).pointerEvents),
    'none',
  );
  await page.locator('#capture-document').click();
  await page.waitForFunction(
    () => document.querySelector('#viewport-empty').dataset.state === 'loading',
  );
  while (!releaseCapture) await new Promise((resolve) => setTimeout(resolve, 10));
  releaseCapture();
  await page.waitForFunction(
    () => document.querySelector('#viewport-empty').dataset.state === 'failed',
  );
  assert.equal(await page.locator('#viewport-empty').isVisible(), true);
  await page.screenshot({ path: join(directory, 'empty-sync-failed.png') });
  await page.getByRole('button', { name: '오류 기록', exact: true }).click();
  const status = page.getByRole('dialog', { name: '상태 및 설정', exact: true });
  assert.match(await status.textContent(), /IMPORT_LIMIT/);
  await status.getByRole('button', { name: '닫기', exact: true }).click();
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  assert.equal(await page.locator('#viewport-empty').getAttribute('data-state'), 'failed');
  await page.locator('#refresh-documents').click();
  rejectCapture = false;
  captures = 0;
  await page.locator('#capture-document').click();
  await page.waitForFunction(
    () => document.querySelector('#host-document-info').textContent === 'Sync 완료',
  );
  assert.equal(await page.locator('#viewport-empty').isVisible(), false);
  assert.equal(
    await page.getByText('Rhino 화면 동기화 · 원본 변경 없음', { exact: true }).count(),
    1,
  );
  assert.equal(await page.getByRole('link', { name: '3dm 내려받기', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Rhino에서 열기', exact: true }).count(), 0);
  assert.equal(captures, 1);
  await page.locator('#body').fill('Do not lose my draft');
  generation++;
  await page.waitForFunction(() =>
    document.querySelector('#host-document-info').textContent.includes('보류'),
  );
  assert.equal(captures, 1);
  assert.equal(await page.locator('#body').inputValue(), 'Do not lose my draft');
  await page.locator('#body').fill('');
  await page.waitForFunction(
    () => document.querySelector('#host-document-info').textContent === 'Sync 완료',
  );
  assert.equal(captures, 2);
  await page.locator('#model').selectOption('codex-cli');
  await page.locator('#permission').selectOption('apply');
  await page.locator('#body').fill('Raise the selected mass');
  assert.equal(
    await page.locator('#request').isDisabled(),
    false,
    await page.locator('#request').getAttribute('title'),
  );
  let sent;
  await page.route('**/api/v1/projects/*/requests', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent = route.request().postDataJSON();
    await route.fulfill({
      json: {
        id: sent.id,
        input: sent,
        state: 'succeeded',
        result: { text: 'Mock response', hostExecuted: false },
      },
    });
  });
  await page.locator('#request').click();
  await page.waitForFunction(() => document.querySelector('#body').value === '');
  assert.equal(sent.applyToSource, true);
  assert.equal(sent.permission, 'candidate');
  assert.ok(sent.baseRequestId);
  connected = false;
  await page.waitForFunction(() => document.querySelector('#capture-document').disabled);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(directory, 'attached-sync.png') });
  console.log(
    JSON.stringify({
      passed: true,
      draftProtected: true,
      automaticSync: true,
      explicitApplyPacket: true,
      disconnectDisabled: true,
      directory,
    }),
  );
} finally {
  await browser?.close();
  await app?.close();
}

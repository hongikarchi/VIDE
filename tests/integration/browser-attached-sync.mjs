import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';

// A Rhino document linked to the project (SPEC-01.11): first Sync without a click, failure display,
// draft protection of automatic Sync, the explicit apply packet, and a closed file.
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
  const document = {
    instance,
    id: 7,
    name: 'Attached test',
    units: 'Millimeters',
    objectCount: 1,
    modified: true,
    host: 'rhino',
    connection: 'attached-editor',
    live: true,
    hostBusy: false,
  };
  await page.route('**/api/v1/host/attached-documents', (route) =>
    route.fulfill({
      json: { instance, documents: connected ? [{ ...document, generation }] : [] },
    }),
  );
  // The file is linked; the test engine has no host, so the open connection is added here.
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !window.document.querySelector('#body').disabled);
  const projectId = await page.locator('#project-picker').inputValue();
  const now = new Date().toISOString();
  app.store.db
    .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
    .run('link-a', projectId, 'rhino', 'Attached test', null, instance, 7, now, now);
  await page.route('**/api/v1/projects/*/links', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const rows = await (await route.fetch()).json();
    await route.fulfill({
      json: rows.map((row) => ({
        ...row,
        connection: connected
          ? {
              instance,
              documentId: 7,
              live: true,
              generation,
              objectCount: 1,
              units: 'Millimeters',
              modified: true,
              hostBusy: false,
            }
          : null,
      })),
    });
  });
  await page.route('**/api/v1/projects/*/capture', async (route) => {
    captures++;
    const target = route.request().postDataJSON(),
      project = new URL(route.request().url()).pathname.split('/')[4];
    assert.equal(target.instance, instance);
    assert.equal(target.linkId, 'link-a');
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
    workspace.submit(project, input);
    if (rejectCapture) {
      await new Promise((resolve) => {
        releaseCapture = resolve;
      });
      const failed = workspace.update(project, input.id, 'failed', {
        hostExecuted: false,
        code: 'IMPORT_LIMIT',
      });
      await route.fulfill({ json: failed });
      return;
    }
    const request = workspace.update(project, input.id, 'succeeded', {
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
  // The linked open file syncs without any click.
  await page.waitForFunction(
    () => window.document.querySelector('#viewport-empty').dataset.state === 'loading',
  );
  assert.equal(
    await page.locator('#viewport-empty').evaluate((n) => getComputedStyle(n).pointerEvents),
    'none',
  );
  while (!releaseCapture) await new Promise((resolve) => setTimeout(resolve, 10));
  releaseCapture();
  await page.waitForFunction(
    () => window.document.querySelector('#viewport-empty').dataset.state === 'failed',
  );
  assert.equal(await page.locator('#viewport-empty').isVisible(), true);
  await page.screenshot({ path: join(directory, 'empty-sync-failed.png') });
  await page.getByRole('button', { name: '오류 기록', exact: true }).click();
  const status = page.getByRole('dialog', { name: '상태 및 설정', exact: true });
  assert.match(await status.textContent(), /IMPORT_LIMIT/);
  await status.getByRole('button', { name: '닫기', exact: true }).click();
  // After a reload the file syncs again (first Sync not yet done).
  rejectCapture = false;
  captures = 0;
  await page.reload();
  const row = page.locator('.link-row[data-link-id="link-a"]');
  await page.waitForFunction(
    () => !window.document.querySelector('.link-row')?.textContent.includes('Sync 전'),
  );
  assert.match(await row.textContent(), /Live · Sync/);
  await page.waitForFunction(
    () => !window.document.querySelector('#viewport-empty').checkVisibility(),
  );
  assert.equal(
    await page.getByText('Rhino 화면 동기화 · 원본 변경 없음', { exact: true }).count(),
    1,
  );
  assert.equal(await page.getByRole('link', { name: '3dm 내려받기', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Rhino에서 열기', exact: true }).count(), 0);
  assert.equal(captures, 1);
  // A draft based on this file holds its automatic Sync; other input is kept.
  await page.locator('#body').fill('Do not lose my draft');
  generation++;
  await page.waitForFunction(() =>
    window.document.querySelector('.link-row')?.textContent.includes('보류'),
  );
  assert.equal(captures, 1);
  assert.equal(await page.locator('#body').inputValue(), 'Do not lose my draft');
  await page.locator('#body').fill('');
  await page.waitForFunction(
    () => !window.document.querySelector('.link-row')?.textContent.includes('보류'),
  );
  assert.equal(captures, 2);
  await page.locator('#model').selectOption('codex-cli');
  // 자동 (default): the AI edits the open document directly inside one undo record.
  await page.locator('#mode-toggle [data-mode="auto"]').click();
  assert.equal(
    await page.locator('#mode-toggle [data-mode="auto"]').getAttribute('aria-checked'),
    'true',
  );
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
  await page.waitForFunction(() => window.document.querySelector('#body').value === '');
  assert.equal(sent.mode, 'auto');
  assert.equal(sent.permission, 'candidate');
  assert.equal(sent.applyToSource, undefined);
  assert.ok(sent.baseRequestId);
  // A closed file stays listed with its last Sync; forced Sync needs the open file.
  connected = false;
  await page.waitForFunction(() => window.document.querySelector('.link-sync').disabled);
  assert.match(await row.textContent(), /닫힘 · Sync/);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(directory, 'attached-sync.png') });
  console.log(
    JSON.stringify({
      passed: true,
      draftProtected: true,
      automaticSync: true,
      directAutoPacket: true,
      disconnectDisabled: true,
      directory,
    }),
  );
} finally {
  await browser?.close();
  await app?.close();
}

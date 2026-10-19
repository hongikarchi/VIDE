// T-362: a document Rhino opened read-only. The links list row says '읽기 전용으로 열림 · 저장 불가'
// while the engine reports it (connection.readOnly) and drops it once the document is writable
// again. A ZWCAD row (no such signal) never shows it; the Rhino panel status line says the same.
// Mocked links and attached-documents routes, no host.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const linksUrl = /\/api\/v1\/projects\/[^/]+\/links(\?.*)?$/;
const directory = await mkdtemp(join(tmpdir(), 'vide-read-only-link-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ json: [{ id: 'codex-cli', available: true }] }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  let readOnly = true;
  const connection = (instance, extra = {}) => ({
    instance,
    documentId: 1,
    live: false,
    generation: 1,
    objectCount: 5,
    units: 'Millimeters',
    modified: false,
    hostBusy: false,
    ...extra,
  });
  const row = (id, host, name, instance, extra) => ({
    id,
    host,
    name,
    path: 'C:/p/' + name,
    instance,
    documentId: 1,
    hidden: false,
    kind: 'host',
    connection: connection(instance, extra),
    lastSync: null,
    display: null,
  });
  await page.route(linksUrl, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: [
            row('link-big', 'rhino', 'big.3dm', '1:2', readOnly ? { readOnly: true } : {}),
            row('link-plan', 'zwcad', 'plan.dwg', '3:4'),
          ],
        })
      : route.continue(),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const big = page.locator('.link-row[data-link-id="link-big"]');
  const plan = page.locator('.link-row[data-link-id="link-plan"]');
  await big.waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector('.link-row[data-link-id="link-big"]')
      ?.textContent.includes('읽기 전용으로 열림 · 저장 불가'),
  );
  assert.match(await big.textContent(), /Rhino · 연결됨 .* · 5개 · 읽기 전용으로 열림 · 저장 불가/);
  assert.doesNotMatch(await plan.textContent(), /읽기 전용/);
  // Rhino closed and reopened the file writable: the next poll drops the status.
  readOnly = false;
  await page.waitForFunction(
    () =>
      !document
        .querySelector('.link-row[data-link-id="link-big"]')
        ?.textContent.includes('읽기 전용'),
  );
  assert.match(await big.textContent(), /Rhino · 연결됨 .* · 5개$/);
  assert.deepEqual(errors, []);

  // The Rhino panel's status line says the same and drops it the same way.
  readOnly = true;
  const panel = await browser.newPage({ viewport: { width: 380, height: 760 } });
  panel.setDefaultTimeout(10000);
  panel.on('pageerror', (error) => errors.push(error.message));
  await panel.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await panel.route('**/api/v1/host/attached-documents', (route) =>
    route.fulfill({
      json: {
        instance: '1:2',
        documents: [
          {
            instance: '1:2',
            id: 1,
            host: 'rhino',
            name: 'big.3dm',
            units: 'mm',
            objectCount: 5,
            modified: false,
            live: false,
            ...(readOnly ? { readOnly: true } : {}),
          },
        ],
      },
    }),
  );
  const { origin, hash } = new URL(app.launchUrl);
  await panel.goto(`${origin}/?panel=rhino&instance=1:2&document=1${hash}`);
  const head = panel.locator('.host-panel-head');
  await head.getByText(/연결됨 · 동기화 필요 · 5개 · 읽기 전용으로 열림 · 저장 불가/).waitFor();
  readOnly = false;
  await head.getByText(/연결됨 · 동기화 필요 · 5개$/).waitFor();
  assert.deepEqual(errors, []);
  console.log('browser read-only link: ok');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

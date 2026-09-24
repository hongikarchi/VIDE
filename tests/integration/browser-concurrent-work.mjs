import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'vide-concurrent-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [
        {
          id: 'test',
          name: 'Test',
          provider: 'codex-cli',
          efforts: ['default'],
        },
      ],
    }),
  );
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  const pending = new Map();
  await page.route('**/requests', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const input = route.request().postDataJSON();
    const request = { id: input.id, input, state: 'running', result: { phase: 'ai' } };
    pending.set(input.id, request);
    await route.fulfill({ json: request });
  });
  await page.route('**/requests/*', async (route) => {
    const id = route.request().url().split('/').at(-1);
    const request = pending.get(id);
    return request ? route.fulfill({ json: request }) : route.continue();
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.locator('#model').selectOption('test');
  await page.locator('#body').fill('First independent document');
  await page.locator('#request').click();
  await page.waitForFunction(() => document.querySelector('#body').value === '');
  await page.locator('#body').fill('Second independent document');
  assert.equal(await page.locator('#request').isEnabled(), true);
  await page.locator('#request').click();
  await page.waitForFunction(() => document.querySelector('#body').value === '');
  await page.locator('#body').fill('New condition must survive');
  assert.equal(await page.locator('#request').isDisabled(), true);
  assert.match(await page.locator('#request').getAttribute('title'), /두 개/);
  for (const request of pending.values()) {
    request.state = 'succeeded';
    request.result = {
      hostExecuted: true,
      host: 'rhino',
      executionMode: 'sdk',
      objects: [],
      scene: [],
    };
  }
  await page.waitForFunction(() => !document.querySelector('#request').disabled);
  assert.equal(await page.locator('#body').inputValue(), 'New condition must survive');
  // A late result must not silently become the basis of the new condition.
  await page.locator('#request').click();
  await page.waitForFunction(() => document.querySelector('#body').value === '');
  assert.equal([...pending.values()].at(-1).input.baseRequestId, null);
  assert.deepEqual(pageErrors, []);
  console.log(
    'Concurrent browser requests: independent admission, capacity, late-result draft/basis preservation passed.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

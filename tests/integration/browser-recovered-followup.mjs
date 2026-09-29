import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'vide-recovered-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const input = {
    body: 'Keep the wall and finish the roof',
    provider: 'codex-cli',
    model: 'codex-cli',
    effort: 'default',
    permission: 'candidate',
    host: 'rhino',
    pins: [],
    sketches: [],
    files: [],
  };
  const result = {
    host: 'rhino',
    hostExecuted: true,
    executionMode: 'sdk',
    objects: [
      { id: 'wall', nativeId: 'native-wall', name: 'Wall', kind: 'native', origin: [0, 0, 0] },
    ],
    scene: [{ id: 'wall', nativeType: 'Point', origin: [0, 0, 0] }],
  };
  const requests = [
    { id: 'base', state: 'succeeded', input: { ...input, id: 'base' }, result },
    {
      id: 'recovered',
      state: 'succeeded',
      input: {
        ...input,
        id: 'recovered',
        baseRequestId: 'base',
        pins: [{ id: 'wall', name: 'Wall', basis: 'base', role: 'preserve' }],
        files: [{ name: 'rules', text: 'height 4 m' }],
      },
      result: { ...result, recovered: true },
    },
  ];
  let submitted;
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ json: [{ id: 'codex-cli', available: true }] }),
  );
  await page.route('**/api/v1/host', (route) =>
    route.fulfill({ json: { available: true, mode: 'sdk' } }),
  );
  await page.route('**/requests', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: requests });
    submitted = route.request().postDataJSON();
    return route.fulfill({
      json: { id: submitted.id, input: submitted, state: 'succeeded', result: { text: 'fixture' } },
    });
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  await page.getByRole('button', { name: '복구 후보에서 이어가기' }).click();
  assert.match(await page.locator('.work-view').textContent(), /목표 완료 미확인/);
  assert.match(await page.locator('#body').inputValue(), /Keep the wall and finish the roof/);
  assert.equal(submitted, undefined, 'Preparing a follow-up must not execute it');
  await page.locator('#request').click();
  await page.waitForFunction(() => document.querySelector('#body').value === '');
  assert.equal(submitted.baseRequestId, 'recovered');
  assert.equal(submitted.pins[0].basis, 'recovered');
  assert.equal(submitted.pins[0].role, 'preserve');
  assert.equal(submitted.files[0].text, 'height 4 m');
  assert.deepEqual(errors, []);
  console.log(
    'Recovered candidate label, preserved follow-up draft, no automatic execution and explicit submission passed.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

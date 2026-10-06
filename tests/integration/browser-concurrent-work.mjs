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
    const request = {
      id: input.id,
      input,
      state: 'running',
      result: { phase: 'host', progress: { queries: 2, attempts: 3, completed: 2 } },
    };
    pending.set(input.id, request);
    await route.fulfill({ json: request });
  });
  await page.route('**/requests/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const request = pending.get(id);
    return request ? route.fulfill({ json: request }) : route.continue();
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.locator('#model').selectOption('test');
  await page.locator('#body').fill('First independent document');
  await page.locator('#request').click();
  await page.waitForFunction(() => document.querySelector('#body').value === '');
  // The work view shows the running work's stages with real counts.
  await page.waitForFunction(() =>
    document.querySelector('.work-stages')?.textContent.includes('검증 성공 2회'),
  );
  // A default-conversation turn is a conversation turn (T-088): the wider turn limits apply.
  assert.match(await page.locator('.work-stages').textContent(), /조회 2회.*실행 3회/s);
  // SPEC-02.9: three AI turns run at once in a project.
  for (const body of ['Second independent document', 'Third independent document']) {
    await page.locator('#body').fill(body);
    assert.equal(await page.locator('#request').isEnabled(), true);
    await page.locator('#request').click();
    await page.waitForFunction(() => document.querySelector('#body').value === '');
  }
  // 자동 is the default mode; the old permission field goes along for older servers.
  assert.deepEqual(
    [...pending.values()].map(({ input }) => [input.mode, input.permission]),
    [
      ['auto', 'candidate'],
      ['auto', 'candidate'],
      ['auto', 'candidate'],
    ],
  );
  // A fourth is not refused: sending stays on and tells where it would wait.
  await page.locator('#body').fill('New condition must survive');
  assert.equal(await page.locator('#request').isEnabled(), true);
  assert.match(await page.locator('#request').getAttribute('title'), /대기 1번째/);
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
  // Once the turns end the draft no longer waits.
  await page.waitForFunction(
    () => !document.querySelector('#request').getAttribute('title')?.includes('대기'),
  );
  assert.equal(await page.locator('#request').isEnabled(), true);
  assert.equal(await page.locator('#body').inputValue(), 'New condition must survive');
  // A late result must not silently become the basis of the new condition.
  await page.locator('#request').click();
  await page.waitForFunction(() => document.querySelector('#body').value === '');
  assert.equal([...pending.values()].at(-1).input.baseRequestId, null);
  assert.deepEqual(pageErrors, []);
  console.log(
    'Concurrent browser requests: three AI turns, waiting place for the fourth, late-result draft/basis preservation passed.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'vide-intervention-'));
let app, browser, release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const received = [];
try {
  app = await startServer({
    filename: join(directory, 'workspace.sqlite'),
    providerFactory: () => ({
      status: async () => ({ available: true }),
      run: async (context) => {
        received.push(context);
        if (received.length === 1) {
          await gate;
          throw { code: 'CANCELLED' };
        }
        return { text: JSON.stringify({ message: 'Updated conditions reviewed', operations: [] }) };
      },
    }),
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.locator('#model').selectOption('test');
  await page.locator('#permission').selectOption('review');
  await page.locator('#body').fill('Keep the boundary');
  await page.locator('#request').click();
  const add = page
    .locator('.work-intervene')
    .getByRole('button', { name: '추가 지시', exact: true });
  await add.waitFor();
  assert.equal(await add.isDisabled(), true);
  await page.locator('#body').fill('Use height 4.5 m');
  await add.click();
  // The added instruction opens as the current work, waiting for the previous one to stop.
  await page.waitForFunction(() =>
    document.querySelector('.work-view').textContent.includes('이전 작업 종료 대기'),
  );
  assert.equal(received.length, 1);
  assert.equal(await page.locator('#body').inputValue(), '');
  const rows = () => app.store.db.prepare('SELECT * FROM workspace_requests ORDER BY rowid').all();
  assert.equal(rows().length, 2);
  assert.match(JSON.parse(rows()[1].input).body, /Keep the boundary[\s\S]*Use height 4.5 m/);
  release();
  await page.waitForFunction(
    () =>
      document.querySelector('.work-view')?.dataset.state === 'succeeded' &&
      !document.querySelector('.work-others'),
  );
  assert.deepEqual(
    rows().map((row) => row.state),
    ['cancelled', 'succeeded'],
  );
  assert.equal(received.length, 2);
  assert.deepEqual(errors, []);
  console.log(
    'Browser intervention API: stored condition, visible termination wait, preserved original input and one successor execution passed.',
  );
} finally {
  release();
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

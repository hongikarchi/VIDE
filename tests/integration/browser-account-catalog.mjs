import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

// When AccountSwitch changes a CLI's default login (ADR-025), the status bar notices it and the
// model list is read again (Codex keeps its model list per login). The draft stays, and a chosen
// model that the new list still has stays chosen; one it lost needs a new choice.
const directory = await mkdtemp(join(tmpdir(), 'vide-catalog-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  let codexEmail = 'one@example.com';
  const old = {
    id: 'old-model',
    name: 'Old model',
    provider: 'codex-cli',
    efforts: ['default', 'high'],
  };
  const next = { ...old, id: 'new-model', name: 'New model' };
  await page.route('**/api/v1/accounts/usage', (route) =>
    route.fulfill({
      json: {
        settings: { usageLookup: false },
        accounts: [
          { provider: 'claude-cli', signedIn: true, limitReached: false, state: 'off' },
          {
            provider: 'codex-cli',
            signedIn: true,
            email: codexEmail,
            limitReached: false,
            state: 'off',
          },
        ],
      },
    }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [
        { id: 'claude-cli', name: 'Claude', provider: 'claude-cli', efforts: ['default'] },
        codexEmail === 'one@example.com' ? old : next,
      ],
    }),
  );
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  const label = '.statusbar small[aria-label="현재 AI 계정"]';
  await page.locator('#model').selectOption('old-model');
  await page.locator('#body').fill('Keep my explicit model choice');
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.textContent === 'one@example.com',
    label,
  );
  // AccountSwitch selects another ChatGPT account: the indicator sees it and the list follows.
  codexEmail = 'two@example.com';
  await page.evaluate(() => window.dispatchEvent(new Event('vide-accounts-changed')));
  await page.waitForFunction(() =>
    [...document.querySelector('#model').options].some((o) => o.value === 'new-model'),
  );
  // The chosen model is gone from the new list: kept shown, sending waits for a new choice.
  assert.equal(await page.locator('#model').inputValue(), 'old-model');
  assert.equal(await page.locator('#request').isDisabled(), true);
  assert.equal(await page.locator('#body').inputValue(), 'Keep my explicit model choice');
  await page.locator('#model').selectOption('new-model');
  assert.equal(await page.locator('#request').isDisabled(), false);
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.textContent === 'two@example.com',
    label,
  );
  console.log(
    'A login changed in AccountSwitch refreshes the model catalog, keeps the draft and asks for a supported model.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

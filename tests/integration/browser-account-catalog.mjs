import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'vide-catalog-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const data = {
    profiles: [{ id: 'second', provider: 'codex-cli', label: 'Second' }],
    active: { 'codex-cli': 'default', 'claude-cli': 'default' },
    pending: { 'codex-cli': null, 'claude-cli': null },
  };
  const old = {
    id: 'old-model',
    name: 'Old model',
    provider: 'codex-cli',
    efforts: ['default', 'high'],
  };
  const next = { ...old, id: 'new-model', name: 'New model' };
  await page.route('**/api/v1/accounts', (route) => route.fulfill({ json: data }));
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [
        { id: 'claude-cli', name: 'Claude', provider: 'claude-cli', efforts: ['default'] },
        data.active['codex-cli'] === 'default' ? old : next,
      ],
    }),
  );
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  // A deferred switch for the other provider must also finish refreshing its catalog.
  data.pending['codex-cli'] = 'second';
  await page.evaluate(() => window.dispatchEvent(new Event('vide-accounts-changed')));
  await page.waitForTimeout(100);
  data.active['codex-cli'] = 'second';
  data.pending['codex-cli'] = null;
  await page.waitForFunction(() =>
    [...document.querySelector('#model').options].some((o) => o.value === 'new-model'),
  );
  assert.equal(await page.locator('#model').inputValue(), 'claude-cli');
  data.active['codex-cli'] = 'default';
  await page.evaluate(() => window.dispatchEvent(new Event('vide-accounts-changed')));
  await page.waitForFunction(() =>
    [...document.querySelector('#model').options].some((o) => o.value === 'old-model'),
  );
  await page.locator('#model').selectOption('old-model');
  await page.locator('#body').fill('Keep my explicit model choice');
  await page.waitForFunction(
    () => document.querySelector('[aria-label="현재 AI 계정"]')?.textContent === '기존 CLI 로그인',
  );
  data.pending['codex-cli'] = 'second';
  await page.evaluate(() => window.dispatchEvent(new Event('vide-accounts-changed')));
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="현재 AI 계정"]')?.textContent.includes('전환 대기'),
  );
  data.active['codex-cli'] = 'second';
  data.pending['codex-cli'] = null;
  await page.waitForFunction(() =>
    [...document.querySelector('#model').options].some((o) => o.value === 'new-model'),
  );
  assert.equal(await page.locator('#model').inputValue(), 'old-model');
  assert.equal(await page.locator('#request').isDisabled(), true);
  assert.equal(await page.locator('#body').inputValue(), 'Keep my explicit model choice');
  await page.locator('#model').selectOption('new-model');
  await page.waitForFunction(
    () => document.querySelector('[aria-label="현재 AI 계정"]')?.textContent === 'Second',
  );
  assert.equal(await page.locator('#request').isDisabled(), false);
  console.log(
    'Pending account switch refreshes model catalog, preserves draft and requires explicit supported selection.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

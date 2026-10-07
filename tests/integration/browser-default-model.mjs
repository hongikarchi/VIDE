// 기본 모델 Jev (PLAN-42 T-193, SPEC-02): a new project's first screen and a new conversation tab
// start at "자동 (Jev)" (`auto`), not the tab before's model; a model the user picked stays after a
// reload (the saved draft). A catalog without `auto` starts at its first model. Synthetic catalog;
// no real CLI or host.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const catalog = [
  { id: 'opus', name: 'Claude Opus', provider: 'claude-cli', efforts: ['default', 'high'] },
  { id: 'sonnet', name: 'Claude Sonnet', provider: 'claude-cli', efforts: ['default'] },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'claude-cli', efforts: ['default'] },
  { id: 'auto', name: '자동 (Jev)', provider: 'claude-cli', efforts: ['default'] },
];
const directory = await mkdtemp(join(tmpdir(), 'vide-default-model-'));
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'workspace.sqlite'),
    host: { status: async () => ({ available: true }) },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const open = async (models) => {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/v1/models', (route) => route.fulfill({ json: models }));
    await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
    await page.goto(app.launchUrl);
    await page.waitForFunction(() => !document.querySelector('#body').disabled);
    return page;
  };
  const model = (page) => page.locator('#model').inputValue();

  const page = await open(catalog);
  // The first screen of a new project: "자동 (Jev)", although the catalog lists it last.
  assert.equal(await model(page), 'auto');
  // The user's pick is kept in the draft and comes back after a reload.
  await page.locator('#model').selectOption('sonnet');
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.waitForFunction(() => document.querySelector('#model').value === 'sonnet');
  // A new conversation tab starts at "자동 (Jev)", not at the tab before's Sonnet.
  const tabs = page.locator('#conversation-chips [role="tab"]');
  await tabs.first().waitFor();
  const before = await tabs.count();
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await page.waitForFunction((count) => {
    const all = document.querySelectorAll('#conversation-chips [role="tab"]');
    return all.length === count + 1 && all[all.length - 1].getAttribute('aria-selected') === 'true';
  }, before);
  await page.waitForFunction(() => document.querySelector('#model').value === 'auto');
  // Back on the first tab, its own pick is still there.
  await tabs.first().click();
  await page.waitForFunction(() => document.querySelector('#model').value === 'sonnet');

  // Drafts saved with the old default (Claude Opus 5.5) move to Jev once; a later pick stays.
  // The seed runs before the page's scripts, after the page before it saved its draft on leaving.
  const setSaved = (page, again) =>
    page.context().addInitScript((again) => {
      const mark = 'seeded:' + again;
      if (sessionStorage.getItem(mark)) return;
      sessionStorage.setItem(mark, '1');
      for (const key of Object.keys(localStorage))
        if (key.startsWith('vide:draft:')) {
          const draft = JSON.parse(localStorage.getItem(key));
          localStorage.setItem(key, JSON.stringify({ ...draft, model: 'claude-opus-5-5' }));
        }
      if (!again) localStorage.removeItem('vide:default-model-auto');
    }, again);
  await setSaved(page, false);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.waitForFunction(() => document.querySelector('#model').value === 'auto');
  await setSaved(page, true);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.waitForFunction(() => document.querySelector('#model').value === 'claude-opus-5-5');

  // A catalog without "자동 (Jev)": the first model.
  const without = await open(catalog.filter((entry) => entry.id !== 'auto'));
  await without.evaluate(() => localStorage.clear());
  await without.reload();
  await without.waitForFunction(() => !document.querySelector('#body').disabled);
  assert.equal(await model(without), 'opus');

  assert.deepEqual(errors, []);
  console.log('default model browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

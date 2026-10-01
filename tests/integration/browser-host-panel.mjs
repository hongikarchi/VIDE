// Host panel (Design SCR-12): the Rhino panel and the ZWCAD palette show one web page. Header with
// file, status, project, Sync and the Live switch (plugin actions as vide:// requests), a Link card
// before linking, a "selection N개 첨부" chip and account usage bars. VIDE_SHOT=<folder> saves views.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'vide-host-panel-'));
let app, browser;
const shot = (page, name) =>
  process.env.VIDE_SHOT ? page.screenshot({ path: join(process.env.VIDE_SHOT, name) }) : null;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const origin = new URL(app.launchUrl).origin;
  const hash = new URL(app.launchUrl).hash;
  const selected = ['6f1d0c52-8a55-4a55-9d4b-000000000001', '6f1d0c52-8a55-4a55-9d4b-000000000002'];
  const documents = {
    instance: '1:1',
    documents: [
      {
        instance: '1:1',
        id: 1,
        host: 'rhino',
        name: '구조(터구조)_260928.3dm',
        units: 'm',
        objectCount: 531,
        modified: false,
        live: true,
        selectionVersion: 1,
        selectedIds: selected,
        pinnedIds: [],
      },
      {
        instance: '7:2',
        id: 1,
        host: 'zwcad',
        name: '평면도_2F.dwg',
        units: 'mm',
        objectCount: 2140,
        modified: false,
        live: false,
      },
    ],
  };
  const open = async (query, { dark = false } = {}) => {
    const page = await browser.newPage({ viewport: { width: 380, height: 760 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__actions = [];
      window.addEventListener('vide-host-action', (event) => window.__actions.push(event.detail));
    });
    await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
    await page.route('**/api/v1/host/attached-documents', (route) =>
      route.fulfill({ json: documents }),
    );
    await page.route('**/api/v1/host/selection**', (route) =>
      route.fulfill({
        json: {
          instance: '7:2',
          documentId: 1,
          documentHash: 'a'.repeat(64),
          selectedIds: ['cad-a', 'cad-b', 'cad-c'],
          observedAt: new Date().toISOString(),
        },
      }),
    );
    await page.route('**/api/v1/accounts/usage', (route) =>
      route.fulfill({
        json: {
          settings: { usageLookup: true },
          accounts: [
            {
              provider: 'claude-cli',
              signedIn: true,
              session: { percent: 62 },
              weekly: { percent: 91 },
              limitReached: false,
            },
            {
              provider: 'codex-cli',
              signedIn: true,
              session: { percent: 12 },
              weekly: { percent: 40 },
              limitReached: false,
            },
          ],
        },
      }),
    );
    await page.goto(`${origin}/?${query}${dark ? '&theme=dark' : ''}${hash}`);
    return { page, errors };
  };

  // Rhino, linked: one header (no duplicate status or Sync), Live switch on, usage bars below.
  const rhino = await open('panel=rhino&instance=1:1&document=1');
  const head = rhino.page.locator('.host-panel-head');
  await head.getByText('구조(터구조)_260928.3dm').waitFor();
  await head.getByText(/Live · Sync 필요 · 531개/).waitFor();
  assert.equal(await rhino.page.getByRole('button', { name: 'Sync', exact: true }).count(), 1);
  assert.equal(
    await head.getByRole('switch', { name: /Live/ }).getAttribute('aria-checked'),
    'true',
  );
  await rhino.page
    .locator('.usage-service[data-provider="claude-cli"]')
    .getByText('5h 62%')
    .waitFor();
  assert.equal(
    await rhino.page
      .locator('.usage-service[data-provider="claude-cli"] .usage-meter')
      .nth(1)
      .getAttribute('data-level'),
    'high',
  );
  // Rhino's selection: one chip to attach it.
  await rhino.page
    .locator('#context .selection-chip')
    .filter({ hasText: 'Rhino 선택 2개 첨부' })
    .waitFor();
  await shot(rhino.page, 'panel-rhino.png');
  // The switch and the menu ask the plugin to act.
  await head.getByRole('switch', { name: /Live/ }).click();
  await head.getByRole('button', { name: '패널 메뉴' }).click();
  await head.getByRole('menuitem', { name: '연결 해제' }).waitFor();
  await shot(rhino.page, 'panel-rhino-menu.png');
  await head.getByRole('menuitem', { name: '다른 프로젝트에 연결…' }).click();
  assert.deepEqual(await rhino.page.evaluate(() => window.__actions), ['live', 'link']);
  assert.deepEqual(rhino.errors, []);

  // Not linked: a Link card, no composer.
  const unlinked = await open(`panel=rhino&name=${encodeURIComponent('규모검토.3dm')}`);
  await unlinked.page.getByText('이 파일을 VIDE 프로젝트에 연결하세요').waitFor();
  await unlinked.page
    .locator('.host-panel-head')
    .getByText('아직 VIDE 프로젝트에 연결되지 않음')
    .waitFor();
  assert.equal(await unlinked.page.locator('.composer-wrap').isVisible(), false);
  await shot(unlinked.page, 'panel-unlinked.png');
  await unlinked.page.getByRole('button', { name: '이 파일 연결하기' }).click();
  assert.deepEqual(await unlinked.page.evaluate(() => window.__actions), ['link']);

  // ZWCAD palette: the same page for the CAD drawing, selection read from CAD, dark theme.
  const cad = await open('panel=zwcad&instance=7:2&document=1', { dark: true });
  const cadHead = cad.page.locator('.host-panel-head');
  await cadHead.getByText('평면도_2F.dwg').waitFor();
  assert.equal(await cadHead.locator('.host-badge').textContent(), 'CAD');
  await cadHead.getByText(/연결됨 · Sync 필요 · 2,140개/).waitFor();
  assert.equal(
    await cadHead.getByRole('switch', { name: /Live/ }).getAttribute('aria-checked'),
    'false',
  );
  await cad.page
    .locator('#context .selection-chip')
    .filter({ hasText: 'CAD 선택 3개 첨부' })
    .waitFor();
  await shot(cad.page, 'panel-cad-dark.png');
  assert.deepEqual(cad.errors, []);

  // The app's status bar shows the same usage bars.
  const main = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  await main.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await main.route('**/api/v1/accounts/usage', (route) =>
    route.fulfill({
      json: {
        settings: { usageLookup: true },
        accounts: [
          {
            provider: 'claude-cli',
            signedIn: true,
            session: { percent: 100 },
            weekly: { percent: 55 },
            limitReached: true,
          },
        ],
      },
    }),
  );
  await main.goto(app.launchUrl);
  await main
    .locator('.statusbar .usage-service[data-provider="claude-cli"]')
    .getByText('한도')
    .waitFor();
  console.log('Host panel checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

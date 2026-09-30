// 프로젝트 AI 지침 (PLAN-24 지침 묶음): the AI settings dialog shows the project's addendum editor;
// typing and saving stores it through the engine route, and it is shown again after a reload.
// Synthetic engine DB in a temp folder; provider status is answered here, so no CLI runs.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { installBrowserSupport } from './browser-support.mjs';

const directory = await mkdtemp(join(tmpdir(), 'vide-ai-instructions-'));
const note = '구조 레이어는 STR:: 아래에 둔다.\n치수는 mm로 답한다.';

let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.setDefaultTimeout(15000);
  await installBrowserSupport(page);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ json: [{ id: 'codex-cli', available: true }] }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );

  const openEditor = async () => {
    await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
    await page.evaluate(() => document.querySelector('#ai-settings').click());
    const dialog = page.getByRole('dialog', { name: 'AI 연결 설정', exact: true });
    await dialog.waitFor();
    const editor = dialog.getByRole('textbox', { name: '프로젝트 AI 지침' });
    await page.waitForFunction(
      () =>
        !document.querySelector('dialog.ai-settings textarea[aria-label="프로젝트 AI 지침"]')
          ?.disabled,
    );
    return { dialog, editor };
  };

  await page.goto(app.launchUrl);
  let { dialog, editor } = await openEditor();
  assert.equal(await editor.inputValue(), '');
  const save = dialog.getByRole('button', { name: '지침 저장', exact: true });
  assert.equal(await save.isDisabled(), true);
  await editor.fill(note);
  await save.click();
  await dialog.getByText('저장했습니다. 다음 요청부터 적용됩니다.').waitFor();
  assert.equal(await save.isDisabled(), true);
  const project = await page.evaluate(() => document.querySelector('#project-picker').value);
  const stored = await page.evaluate(
    (id) => window.testApi(`/projects/${encodeURIComponent(id)}/ai-instructions`),
    project,
  );
  assert.equal(stored.text, note);
  assert.ok(stored.updatedAt);

  await page.reload();
  ({ dialog, editor } = await openEditor());
  assert.equal(await editor.inputValue(), note);
  assert.deepEqual(errors, []);
  console.log('AI instructions addendum checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

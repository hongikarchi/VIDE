import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';

const provider = process.argv[2] || 'codex-cli';
assert.ok(['codex-cli', 'claude-cli'].includes(provider));
const directory = resolve('.vide/browser-zwcad-sdk', process.argv[3] || randomUUID());
await mkdir(directory, { recursive: true });
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    sdkOptions: sdkOptions(directory),
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  const existing = await page.evaluate(
    async (id) => (await fetch(`/api/v1/projects/${id}/requests`)).json(),
    projectId,
  );
  if (!existing.length) {
    await page.locator('#host-target').selectOption('zwcad');
    await page.locator('#model').selectOption(provider);
    assert.equal(await page.locator('#effort-label').textContent(), '기본값');
    await page.locator('#permission').selectOption('candidate');
    await page
      .locator('#body')
      .fill(
        'Create one closed XY polyline at the origin, width 20 m and depth 10 m. Query to verify 200 square metres, then modify that same polyline to width 24 m, preserving its Handle and depth. Query again to verify 240 square metres. Use two successful execute calls; do not replace the existing entity. This is a synthetic SDK test.',
      );
    await page.locator('#request').click();
  }
  let saved;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const rows = await page.evaluate(
      async (id) => (await fetch(`/api/v1/projects/${id}/requests`)).json(),
      projectId,
    );
    saved = rows.at(-1);
    if (saved && !['queued', 'running'].includes(saved.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await writeFile(join(directory, 'result.json'), JSON.stringify(saved, null, 2));
  assert.equal(saved?.state, 'succeeded', JSON.stringify(saved?.result));
  assert.equal(saved.result.executionMode, 'sdk');
  assert.equal(saved.result.host, 'zwcad');
  assert.equal(saved.result.scene.length, 1);
  assert.equal(saved.result.scene[0].area, 240);
  assert.equal(saved.result.scene[0].length, 68);
  await page.getByRole('button', { name: '이 후보 보기', exact: true }).last().click();
  await page.locator('#document-tree').evaluate((node) => {
    node.open = true;
    for (const row of node.querySelectorAll('.layer-row[aria-expanded="false"]')) row.click();
  });
  await page.locator('#objects .object').first().click();
  await page.screenshot({ path: join(directory, 'browser.png') });
  console.log(JSON.stringify({ passed: true, provider, directory, area: 240, length: 68 }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app?.close();
}

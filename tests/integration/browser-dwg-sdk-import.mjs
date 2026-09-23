// Import an existing synthetic DWG through the real UI and owned SDK inspector.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

if (!process.argv[2]) throw Error('Provide a synthetic 20x10 m DWG fixture');
const source = resolve(process.argv[2]),
  directory = resolve('.vide/browser-dwg-sdk', randomUUID());
await mkdir(directory, { recursive: true });
const fingerprint = async () =>
  createHash('sha256')
    .update(await readFile(source))
    .digest('hex');
const before = await fingerprint();
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/models', (route) => route.fulfill({ json: [] }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  await page.locator('#model-file').setInputFiles(source);
  const deadline = Date.now() + 120000;
  let imported;
  while (Date.now() < deadline) {
    const requests = await page.evaluate(
      async (id) => await (await fetch(`/api/v1/projects/${id}/requests`)).json(),
      projectId,
    );
    if (requests.length && !['queued', 'running'].includes(requests.at(-1).state)) {
      imported = requests.at(-1);
      break;
    }
    await new Promise((accept) => setTimeout(accept, 300));
  }
  assert.equal(imported?.state, 'succeeded', JSON.stringify(imported));
  assert.equal(imported.result.importMode, 'sdk');
  assert.equal(imported.result.scene[0].area, 200);
  assert.equal(imported.result.scene[0].length, 60);
  assert.equal(imported.result.dwgEditMode, 'polyline-vertices-v1');
  assert.equal(await fingerprint(), before);
  await page.getByRole('button', { name: '이 후보 보기', exact: true }).click();
  await page.locator('#document-tree').evaluate((node) => (node.open = true));
  await page.locator('#object-tree').evaluate((node) => (node.open = true));
  await page.locator('#objects button').first().click();
  await page.screenshot({ path: join(directory, 'import.png') });
  assert.deepEqual(failures, []);
  const evidence = {
    passed: true,
    directory,
    requestId: imported.id,
    sourceUnchanged: true,
    importMode: 'sdk',
    area: 200,
    length: 60,
    browserImported: true,
    objectSelected: true,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} catch (error) {
  await writeFile(
    join(directory, 'failure.json'),
    JSON.stringify({ error: error.message, directory }, null, 2),
  );
  throw error;
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
}

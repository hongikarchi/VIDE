import { installBrowserSupport } from './browser-support.mjs';
// Trusted read-only extension on an existing two-object candidate; no AI or host writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [playwright, launch, projectId] = process.argv.slice(2),
  { chromium } = await import(pathToFileURL(playwright).href),
  { url } = JSON.parse(await readFile(launch, 'utf8'));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await installBrowserSupport(page);
  await page.goto(url);
  await page.waitForFunction(() =>
    document.querySelector('#connection-status').textContent.includes('연결됨'),
  );
  await page.goto(new URL('/?project=' + projectId, url).href);
  await page.waitForFunction(() =>
    document.querySelector('#connection-status').textContent.includes('연결됨'),
  );
  await page.getByRole('button', { name: '확장', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '확장', exact: true });
  await dialog.waitFor();
  const enable = dialog.getByRole('button', { name: /^(등록|활성화)$/ });
  if (await enable.count()) await enable.click();
  await dialog.getByLabel('확장 대상').selectOption('all');
  await dialog.getByRole('button', { name: '실행', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const jobs = await page.evaluate(
      async (id) => (await fetch('/api/v1/projects/' + id + '/requests')).json(),
      projectId,
    ),
    result = jobs.at(-1);
  assert.equal(result.input.provider, 'extension');
  assert.equal(result.result.extensionExecuted, true);
  assert.equal(result.result.hostExecuted, false);
  assert.equal(
    result.result.extensionResult.rows.reduce((sum, row) => sum + row.count, 0),
    2,
  );
  const card = page.locator('.chat-message').last();
  await card.getByText('확장 완료', { exact: true }).waitFor();
  await card.locator('details').last().locator('summary').click();
  const objectName = result.input.pins[0].name;
  await card.getByRole('button', { name: objectName, exact: true }).click();
  assert.equal(await page.locator('#selection').innerText(), objectName);
  await page.screenshot({ path: 'docs/assets/native-workspace/extension-summary.png' });
  await page.getByRole('button', { name: '확장', exact: true }).click();
  await dialog.getByRole('button', { name: '비활성화', exact: true }).click();
  assert.equal(await dialog.getByRole('button', { name: '실행', exact: true }).isDisabled(), true);
  const checks = await page.evaluate(
    async ({ projectId, result }) => {
      const api = window.testApi;
      const payload = {
        id: result.id,
        requestId: result.input.baseRequestId,
        objectIds: result.input.pins.map((pin) => pin.id),
      };
      const repeat = await api(
        '/projects/' + projectId + '/extensions/object-summary/run',
        'POST',
        payload,
      );
      let blocked;
      try {
        await api('/projects/' + projectId + '/extensions/object-summary/run', 'POST', {
          ...payload,
          id: crypto.randomUUID(),
        });
      } catch (error) {
        blocked = error.code;
      }
      let bypass;
      try {
        await api('/projects/' + projectId + '/requests', 'POST', {
          ...result.input,
          id: crypto.randomUUID(),
        });
      } catch (error) {
        bypass = error.code;
      }
      return { repeat: repeat.id, blocked, bypass };
    },
    { projectId, result },
  );
  assert.deepEqual(checks, {
    repeat: result.id,
    blocked: 'EXTENSION_DISABLED',
    bypass: 'INVALID_INPUT',
  });
  console.log(
    JSON.stringify({
      projectId,
      requestId: result.id,
      objects: 2,
      registered: true,
      linkedSelection: true,
      disabled: true,
      retryIdempotent: true,
    }),
  );
} finally {
  await browser.close();
}

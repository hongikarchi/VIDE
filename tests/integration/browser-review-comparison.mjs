import { installBrowserSupport } from './browser-support.mjs';
// Existing synthetic 8x6x6 -> 8x6x4.5 candidates; no AI or native writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { evidencePath } from './run-directory.mjs';
const [playwright, launch, projectId] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(playwright).href),
  { url } = JSON.parse(await readFile(launch, 'utf8'));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installBrowserSupport(page);
  await page.goto(url);
  await page.waitForFunction(() =>
    document.querySelector('#connection-status').textContent.includes('연결됨'),
  );
  await page.goto(new URL('/?project=' + projectId, url).href);
  const buttons = page.getByRole('button', { name: '검토본 저장', exact: true });
  await buttons.first().waitFor();
  assert.equal(await buttons.count(), 2);
  const ids = [];
  for (let index = 0; index < 2; index++) {
    await buttons.nth(index).click();
    const creator = page.getByRole('dialog', { name: '검토본 저장', exact: true });
    await creator.getByLabel('검토본 제목').fill('A/B 검증 ' + index);
    await creator.getByRole('button', { name: '검토본 저장', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: '저장한 검토본', exact: true });
    await viewer.waitFor();
    ids.push((await viewer.locator('iframe').getAttribute('src')).split('/').at(-2));
    await viewer.getByRole('button', { name: '닫기', exact: true }).click();
  }
  await page
    .locator('#review-list')
    .locator('..')
    .evaluate((node) => (node.open = true));
  await page.getByRole('button', { name: '검토본 비교', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '검토본 비교', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '비교', exact: true }).waitFor({ state: 'visible' });
  const before = await page.evaluate(
    async ({ projectId, ids }) => {
      const api = window.testApi;
      const snapshots = await Promise.all(
        ids.map((id) => api('/projects/' + projectId + '/reviews/' + id)),
      );
      return snapshots
        .sort((a, b) => b.payload.table.rows[0].volume - a.payload.table.rows[0].volume)
        .map((row) => row.id);
    },
    { projectId, ids },
  );
  await dialog.getByLabel('검토본 A', { exact: true }).selectOption(before[0]);
  await dialog.getByLabel('검토본 B', { exact: true }).selectOption(before[1]);
  await dialog.getByRole('button', { name: '비교', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: '체적 -72 m³' }).waitFor();
  assert.equal(await dialog.locator('iframe').count(), 2);
  for (const frame of await dialog.locator('iframe').all())
    assert.equal(await frame.getAttribute('sandbox'), '');
  await page.screenshot({
    path: evidencePath('docs/assets/native-workspace/review-comparison.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await dialog.evaluate((node) => node.getBoundingClientRect().width <= 390));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      projectId,
      volumeDelta: -72,
      frozenSnapshots: true,
      sandboxFrames: 2,
      mobileFits: true,
    }),
  );
} finally {
  await browser.close();
}

import { installBrowserSupport } from './browser-support.mjs';
// Read-only live capture and persistent table UI; no AI calls or original writes.
// args: playwright launch.json instance documentId --run-live
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [playwright, launch, instance, serial, flag] = process.argv.slice(2);
if (flag !== '--run-live') throw Error('Explicit --run-live required');
const { chromium } = await import(pathToFileURL(playwright).href),
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
  const data = await page.evaluate(
    async ({ instance, documentId }) => {
      const api = window.testApi;
      const project = await api('/projects', 'POST', { name: '수량표 구성 검증' });
      const capture = await api(`/projects/${project.id}/capture`, 'POST', {
        id: crypto.randomUUID(),
        instance,
        documentId,
      });
      return { project, capture };
    },
    { instance, documentId: Number(serial) },
  );
  assert.equal(data.capture.state, 'succeeded');
  await page.goto(new URL('/?project=' + data.project.id, url).href);
  await page.getByRole('button', { name: '수량표', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '후보 수량표', exact: true });
  await dialog.waitFor();
  await dialog.getByLabel('객체 유형', { exact: true }).selectOption('Brep');
  await dialog.getByLabel('그룹 기준', { exact: true }).selectOption('layer');
  await dialog.getByRole('status').filter({ hasText: '1 / 2개 객체' }).waitFor();
  assert.ok((await dialog.locator('tbody').innerText()).includes('Default'));
  assert.ok(!(await dialog.locator('tbody').innerText()).includes('Unrelated test point'));
  await dialog.getByText('표 구성', { exact: true }).click();
  await dialog.getByLabel('표 구성 이름').fill('솔리드 레이어 합계');
  await dialog.getByRole('button', { name: '구성 저장', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: '표 구성을 저장했습니다.' }).waitFor();
  const viewId = await dialog.getByLabel('저장한 표 구성').inputValue();
  assert.ok(viewId);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '수량표', exact: true }).click();
  await dialog.getByText('표 구성', { exact: true }).click();
  await dialog.getByLabel('저장한 표 구성').selectOption(viewId);
  await dialog.getByRole('status').filter({ hasText: '1 / 2개 객체' }).waitFor();
  assert.equal(await dialog.getByLabel('그룹 기준').inputValue(), 'layer');
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'CSV 내려받기', exact: true }).click();
  const file = await downloaded,
    csv = await readFile(await file.path(), 'utf8');
  assert.ok(csv.includes('그룹 합계'));
  assert.ok(csv.includes('Default'));
  assert.ok(csv.includes(data.capture.id));
  assert.ok(!csv.includes('Unrelated test point'));
  await mkdir('docs/assets/native-workspace', { recursive: true });
  await page.screenshot({ path: 'docs/assets/native-workspace/quantity-filters.png' });
  await dialog.getByLabel('객체 검색').fill('no-such-object');
  await dialog.getByLabel('객체 검색').press('Enter');
  await dialog.getByRole('status').filter({ hasText: '0 / 2개 객체' }).waitFor();
  assert.equal(await dialog.locator('tbody tr').count(), 1);
  console.log(
    JSON.stringify({
      projectId: data.project.id,
      requestId: data.capture.id,
      savedView: viewId,
      filteredCount: 1,
      emptyCount: 0,
      csvMatches: true,
      restored: true,
    }),
  );
} finally {
  await browser.close();
}

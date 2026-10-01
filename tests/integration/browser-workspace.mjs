// Run against a populated live development workspace; no provider calls or host mutations.
// node tests/integration/browser-workspace.mjs <playwright-module-path> <launch.json>
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { evidencePath } from './run-directory.mjs';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const { url } = JSON.parse(await readFile(process.argv[3], 'utf8'));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(url);
  await page.waitForFunction(() =>
    document.querySelector('#connection-status').textContent.includes('연결됨'),
  );
  await page.locator('#attach-menu summary').click();
  await page.locator('#inspect-selection').click();
  await page.waitForFunction(() =>
    document.querySelector('#message').textContent.includes('연결 파일 목록에서 고르세요'),
  );
  const records = await page.evaluate(async () => {
    const projects = await (await fetch('/api/v1/projects')).json();
    return (await fetch(`/api/v1/projects/${projects[0].id}/requests`)).json();
  });
  assert.ok(
    records.some((r) => r.result?.hostExecuted),
    'Expected previously verified native work',
  );
  assert.ok(
    records.some((r) => r.input.pins.length),
    'Expected click/pin request',
  );
  assert.ok(
    records.some((r) => r.input.sketches.length),
    'Expected sketch request',
  );
  // Every request is listed once in the work history; the right shows one work at a time.
  assert.equal(
    await page.locator('#task-list .task-row').count(),
    records.filter((r) => !r.input.parentRequestId).length,
  );
  await page.locator('[data-view=front]').click();
  assert.equal(
    await page.locator('#canvas canvas').getAttribute('data-projection'),
    'orthographic',
  );
  await page.locator('[data-view=axon]').click();
  assert.equal(await page.locator('#canvas canvas').getAttribute('data-projection'), 'perspective');
  const download = page.waitForEvent('download');
  await page.locator('a[download]').last().click();
  const artifact = await download;
  assert.equal(await artifact.failure(), null);
  const data = await readFile(await artifact.path());
  assert.ok(data.subarray(0, 32).toString().startsWith('3D Geometry File Format'));
  await page.getByRole('button', { name: '이 후보 보기', exact: true }).first().click();
  const firstNative = records.find((r) => r.result?.hostExecuted);
  await page.locator('#document-tree').evaluate((node) => {
    node.open = true;
    for (const row of node.querySelectorAll('.layer-row[aria-expanded="false"]')) row.click();
  });
  assert.equal(await page.locator('#objects .object').count(), firstNative.result.objects.length);
  await page.getByRole('button', { name: '이 후보 보기', exact: true }).last().click();
  await page.locator('#objects .object').first().click();
  await page.locator('#inspector-toggle').click();
  assert.ok((await page.locator('#inspector-content').innerText()).includes('네이티브 ID'));
  await page.locator('[data-inspect=geometry]').click();
  assert.ok((await page.locator('#inspector-content').innerText()).includes('체적'));
  await page.locator('#inspector-toggle').click();
  assert.equal(await page.locator('.inspector-body').isVisible(), false);
  await page.locator('#inspector-toggle').click();
  await page.locator('[data-tool=sketch]').click();
  assert.equal(await page.locator('#sketch-tools').isVisible(), true);
  const canvasBox = await page.locator('#canvas canvas').boundingBox();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 320, canvasBox.y + 260, { steps: 8 });
  await page.mouse.up();
  assert.equal(await page.locator('#finish-sketch').isDisabled(), false);
  await page.locator('#cancel-sketch').click();
  assert.equal(await page.locator('#sketch-tools').isVisible(), false);
  await page.locator('[data-view=axon]').click();
  await page.locator('#projection-toggle').click();
  assert.equal(
    await page.locator('#canvas canvas').getAttribute('data-projection'),
    'orthographic',
  );
  await page.locator('#projection-toggle').click();
  assert.equal(await page.locator('#canvas canvas').getAttribute('data-projection'), 'perspective');
  await page.locator('#fit-selection').click();
  const heightBefore = await page.locator('#inspector').evaluate((n) => n.clientHeight);
  await page.locator('#inspector-resize').focus();
  await page.keyboard.press('ArrowUp');
  assert.ok((await page.locator('#inspector').evaluate((n) => n.clientHeight)) > heightBefore);
  const before = await page.locator('#body').inputValue();
  await page.fill('#body', '기존 폭은 유지해');
  await page.locator('#add-request').click();
  await page.fill('#body', '높이를 4 m로 변경해');
  await page.locator('#add-request').click();
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector('#connection-status').textContent.includes('연결됨'),
  );
  assert.equal(await page.locator('.pending-request').count(), 2);
  let submitted;
  await page.route('**/api/v1/projects/*/requests', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submitted = route.request().postDataJSON();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'TEST_UNAVAILABLE' }),
    });
  });
  await page.locator('#request').click();
  await page.waitForFunction(() => !document.querySelector('#request').disabled);
  assert.equal(submitted.body, '1. 기존 폭은 유지해\n\n2. 높이를 4 m로 변경해');
  assert.equal(await page.locator('.pending-request').count(), 2, 'Failed submit preserves draft');
  await page.unroute('**/api/v1/projects/*/requests');
  await page.locator('.pending-request button').first().click();
  await page.locator('.pending-request button').first().click();

  await page.fill('#body', '초안 복구 검증');
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector('#connection-status').textContent.includes('연결됨'),
  );
  assert.equal(await page.locator('#body').inputValue(), '초안 복구 검증');
  await page.fill('#body', before);
  await page.locator('#document-tree').evaluate((node) => {
    node.open = true;
    for (const row of node.querySelectorAll('.layer-row[aria-expanded="false"]')) row.click();
  });
  await page.locator('#objects .object').first().click();
  await page.locator('#inspector-toggle').click();
  await page.locator('[data-inspect=geometry]').click();
  await page.getByRole('button', { name: '수량표', exact: true }).last().click();
  await page
    .getByRole('dialog', { name: '후보 수량표', exact: true })
    .waitFor({ state: 'visible' });
  await page.getByLabel('비교할 이전 후보', { exact: true }).selectOption(firstNative.id);
  await page.getByRole('button', { name: '현재 후보와 비교', exact: true }).click();
  await page
    .locator('.comparison-result')
    .getByText(/비교 불가/)
    .first()
    .waitFor();
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'CSV 내려받기', exact: true }).click();
  const csvArtifact = await csvDownload;
  const csv = await readFile(await csvArtifact.path(), 'utf8');
  assert.ok(csv.includes('기하 면적 (m²)'));
  assert.ok(csv.includes('저장·재열기한 호스트 형상'));
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.screenshot({ path: evidencePath('docs/assets/native-workspace/desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '작업', exact: true }).click();
  assert.equal(await page.locator('#body').isVisible(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: evidencePath('docs/assets/native-workspace/mobile.png') });
  assert.deepEqual(errors, [
    'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
  ]);
  console.log(
    JSON.stringify({
      records: records.length,
      nativeResults: records.filter((r) => r.result?.hostExecuted).length,
      downloadBytes: data.length,
      expectedInjectedErrors: errors,
    }),
  );
} finally {
  await browser.close();
}

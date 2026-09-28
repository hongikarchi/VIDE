import { installBrowserSupport } from './browser-support.mjs';
// Reads an existing synthetic DWG copy; one subscription call creates an isolated Rhino candidate.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [playwright, launch, source, flag, existingProject] = process.argv.slice(2);
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
  const ready = () => page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await ready();
  const projectId =
    existingProject ||
    (await page.evaluate(async () => {
      const api = window.testApi;
      return (await api('/projects', 'POST', { name: 'DWG 참고 입력 연계 검증' })).id;
    }));
  console.log(JSON.stringify({ projectId }));
  await page.goto(new URL('/?project=' + projectId, url).href);
  await ready();
  const read = () =>
    page.evaluate(
      async (id) => (await fetch('/api/v1/projects/' + id + '/requests')).json(),
      projectId,
    );
  let rows = await read();
  if (!rows.length) {
    await page.locator('#model-file').setInputFiles(source);
    await page.getByText('작업 사본을 열었습니다.', { exact: true }).waitFor({ timeout: 110000 });
    rows = await read();
  }
  const reference = rows[0];
  assert.equal(reference.state, 'succeeded');
  assert.equal(reference.result.referenceOnly, true);
  assert.equal(reference.result.scene[0].area, 200);
  assert.equal(reference.result.scene[0].length, 60);
  if (rows.length === 1) {
    await page.locator('#document-tree').evaluate((node) => (node.open = true));
    await page.locator('#objects .object').first().click();
    await page.locator('#selection-pin').click();
    await page.locator('#context select').selectOption('reference');
    await page.locator('#host-target').selectOption('rhino');
    await page.locator('#model').selectOption('claude-cli');
    await page.locator('#permission').selectOption('candidate');
    await page
      .locator('#body')
      .fill(
        '첨부한 ZWCAD 경계의 확인된 점열을 그대로 사용해 Rhino에 높이 3 m인 닫힌 돌출 매스 하나를 만들어. 위치와 20 m × 10 m 경계 치수는 유지하고, CAD 원본은 수정하지 마.',
      );
    await page.locator('#request').click();
  }
  const deadline = Date.now() + 210000;
  while (true) {
    rows = await read();
    if (rows.length > 1 && !['queued', 'running'].includes(rows.at(-1).state)) break;
    if (Date.now() > deadline) throw Error('Inspect saved project before retry');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const candidate = rows.at(-1);
  assert.equal(candidate.state, 'succeeded', JSON.stringify(candidate.result));
  assert.equal(candidate.result.host, 'rhino');
  assert.equal(candidate.result.hostExecuted, true);
  assert.equal(candidate.result.verified, true);
  assert.equal(candidate.result.scene.length, 1);
  assert.ok(Math.abs(candidate.result.scene[0].volume - 600) < 1e-6);
  assert.equal(candidate.input.pins[0].basis, reference.id);
  assert.equal(candidate.input.pins[0].role, 'reference');
  await page.waitForFunction(() => document.querySelectorAll('#objects .object').length === 1);
  await page.waitForFunction(() => document.querySelector('#host-target').value === 'rhino');
  await page.screenshot({ path: 'docs/assets/native-workspace/dwg-import-rhino.png' });
  console.log(
    JSON.stringify({
      projectId,
      referenceId: reference.id,
      requestId: candidate.id,
      referenceArea: 200,
      referenceLength: 60,
      rhinoVolume: 600,
      subscription: 'claude-cli',
      savedAndReopened: true,
    }),
  );
} finally {
  await browser.close();
}

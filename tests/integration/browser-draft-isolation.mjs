// Uses existing projects, without submitting AI or host operations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const { url } = JSON.parse(await readFile(process.argv[3], 'utf8'));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url);
  const ready = () =>
    page.waitForFunction(() =>
      document.querySelector('#connection-status').textContent.includes('연결됨'),
    );
  await ready();
  const projects = await page.evaluate(async () => (await fetch('/api/v1/projects')).json());
  const [a, b] = projects;
  assert.ok(a && b);
  const navigate = async (id) => {
    await page.goto(new URL('?project=' + id, url).href);
    await ready();
  };
  const action = async (id) => {
    await page.getByLabel('초안 메뉴').click();
    await page.locator('#' + id).click();
  };
  await navigate(a.id);
  const candidates = page.getByRole('button', { name: '이 후보 보기', exact: true });
  assert.ok((await candidates.count()) >= 2);
  await candidates.first().click();
  await page.locator('#body').fill('Project A saved draft');
  await action('save');
  const key = 'vide:review:composer:v3:' + a.id;
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
  await candidates.last().click();
  assert.equal(
    await page.evaluate(
      (id) => JSON.parse(localStorage.getItem('vide:draft:' + id)).baseRequestId,
      a.id,
    ),
    saved.state.baseRequestId,
  );
  await page.getByRole('button', { name: '입력 기준 보기', exact: true }).click();
  await page.locator('#body').fill('Temporary text');
  await action('load');
  assert.equal(await page.locator('#body').inputValue(), 'Project A saved draft');
  assert.equal(
    await page.evaluate(
      (id) => JSON.parse(localStorage.getItem('vide:draft:' + id)).baseRequestId,
      a.id,
    ),
    saved.state.baseRequestId,
  );
  await navigate(b.id);
  await page.locator('#body').fill('Project B current draft');
  await action('load');
  await page
    .getByRole('status')
    .filter({ hasText: '이 프로젝트에서 읽을 수 있는 저장본이 없습니다.' })
    .waitFor();
  assert.equal(await page.locator('#body').inputValue(), 'Project B current draft');
  const menu = await page.getByLabel('초안 메뉴').boundingBox();
  assert.ok(menu.y >= 0);
  await page.screenshot({ path: 'docs/assets/native-workspace/draft-menu.png' });
  await page.getByLabel('초안 메뉴').click(); // Close after the failed load.
  await action('save');
  await navigate(a.id);
  await action('load');
  assert.equal(await page.locator('#body').inputValue(), 'Project A saved draft');
  await page.evaluate(
    ({ key, saved, b }) => localStorage.setItem(key, JSON.stringify({ ...saved, projectId: b })),
    { key, saved, b: b.id },
  );
  await page.locator('#body').fill('Preserve on invalid saved project');
  await action('load');
  assert.equal(await page.locator('#body').inputValue(), 'Preserve on invalid saved project');
  await page.evaluate(
    ({ key, saved }) =>
      localStorage.setItem(
        key,
        JSON.stringify({ ...saved, state: { ...saved.state, baseRequestId: null, pins: [] } }),
      ),
    { key, saved },
  );
  await page.getByLabel('초안 메뉴').click();
  await action('load');
  await page.reload();
  await ready();
  assert.equal(
    await page.evaluate(
      (id) => JSON.parse(localStorage.getItem('vide:draft:' + id)).baseRequestId,
      a.id,
    ),
    null,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-mobile="input"]').click();
  await page.getByLabel('초안 메뉴').click();
  const dropdown = await page.locator('.draft-actions').boundingBox();
  assert.ok(dropdown.x >= 0 && dropdown.x + dropdown.width <= 390 && dropdown.y >= 0);
  await page.getByLabel('초안 메뉴').click();
  assert.equal(await page.locator('#draft-menu').getAttribute('open'), null);
  console.log(
    JSON.stringify({
      projectIsolation: true,
      candidateBasisRestored: true,
      invalidLoadPreservesDraft: true,
    }),
  );
} finally {
  await browser.close();
}

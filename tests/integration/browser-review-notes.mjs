import { installBrowserSupport, savedReviews } from './browser-support.mjs';
// Local immutable review feedback, response-loss retry and draft adoption; no AI or host writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { evidencePath } from './run-directory.mjs';
const [playwright, launch, projectId] = process.argv.slice(2),
  { chromium } = await import(pathToFileURL(playwright).href),
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
  await page.evaluate(
    (projectId) => localStorage.removeItem('vide:draft:' + projectId + ':default'),
    projectId,
  );
  await page.goto(new URL('/?project=' + projectId, url).href);
  await (await savedReviews(page))
    .getByRole('button', { name: 'A/B 검증 0', exact: true })
    .first()
    .click();
  const viewer = page.getByRole('dialog', { name: '저장한 검토본', exact: true });
  await viewer.getByText('검토 의견', { exact: true }).first().click();
  await viewer
    .getByLabel('검토 의견 본문')
    .fill('높이를 4.5 m로 검토해주세요. 폭과 깊이는 유지합니다.');
  const target = viewer.getByLabel('의견 대상');
  await target.selectOption({ index: 1 });
  let submission;
  await page.route('**/reviews/*/notes', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submission = route.request().postDataJSON();
    await route.fetch();
    await route.abort('failed');
  });
  await viewer.getByRole('button', { name: '의견 저장', exact: true }).click();
  await viewer.getByRole('status').filter({ hasText: '같은 의견을 다시 확인' }).waitFor();
  await page.unroute('**/reviews/*/notes');
  await viewer.getByRole('button', { name: '동일 의견 다시 확인', exact: true }).click();
  await viewer.getByRole('status').filter({ hasText: '의견을 저장했습니다.' }).waitFor();
  const rows = await page.evaluate(
    async ({ projectId, submission }) => {
      const api = window.testApi;
      const reviews = await api('/projects/' + projectId + '/reviews');
      const review = reviews.find((row) => row.title === 'A/B 검증 0');
      return api('/projects/' + projectId + '/reviews/' + review.id + '/notes');
    },
    { projectId, submission },
  );
  assert.equal(rows.filter((row) => row.id === submission.id).length, 1);
  const last = viewer.locator('article').last();
  await last.getByRole('button', { name: '요청 초안에 첨부' }).click();
  await viewer.getByRole('status').filter({ hasText: '기준 후보를 먼저' }).waitFor();
  await last.getByRole('button', { name: '기준 후보 열기' }).click();
  await (await savedReviews(page))
    .getByRole('button', { name: 'A/B 검증 0', exact: true })
    .first()
    .click();
  await viewer.getByText('검토 의견', { exact: true }).first().click();
  await viewer.locator('article').last().getByRole('button', { name: '요청 초안에 첨부' }).click();
  await viewer.waitFor({ state: 'hidden' });
  const draft = await page.evaluate(
    (projectId) => JSON.parse(localStorage.getItem('vide:draft:' + projectId + ':default')),
    projectId,
  );
  assert.ok(draft.instructions.includes(submission.body));
  assert.equal(draft.pins[0].basis, rows.at(-1).requestId);
  assert.ok(draft.files.some((file) => file.name === 'Review-' + submission.id + '.md'));
  await page.reload();
  await page.getByRole('button', { name: '검토본 저장', exact: true }).first().waitFor();
  const restored = await page.evaluate(
    (projectId) => JSON.parse(localStorage.getItem('vide:draft:' + projectId + ':default')),
    projectId,
  );
  assert.equal(restored.baseRequestId, rows.at(-1).requestId);
  await page.screenshot({
    path: evidencePath('docs/assets/native-workspace/review-note-draft.png'),
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      responseLossRetry: true,
      storedOnce: true,
      oldBasisGuard: true,
      draftAttached: true,
      noExecution: true,
    }),
  );
} finally {
  await browser.close();
}

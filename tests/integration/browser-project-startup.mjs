// A fresh browser must open a CAD-only project without silently changing saved drafts.
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
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.goto(new URL('/?project=' + projectId, url).href);
  await page.waitForFunction(() => document.querySelectorAll('#objects button').length > 0);
  assert.equal(await page.locator('#host-target').inputValue(), 'zwcad');
  const basis = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem('vide:draft:' + id)).baseRequestId,
    projectId,
  );
  assert.ok(basis);
  await page.evaluate((id) => {
    const key = 'vide:draft:' + id,
      draft = JSON.parse(localStorage.getItem(key));
    draft.baseRequestId = null;
    draft.host = 'rhino';
    draft.body = 'Independent new task';
    localStorage.setItem(key, JSON.stringify(draft));
  }, projectId);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector('#body').value === 'Independent new task',
  );
  assert.equal(await page.locator('#host-target').inputValue(), 'rhino');
  assert.equal(await page.locator('#objects button').count(), 0);
  assert.equal(
    await page.evaluate(
      (id) => JSON.parse(localStorage.getItem('vide:draft:' + id)).baseRequestId,
      projectId,
    ),
    null,
  );
  console.log(
    JSON.stringify({
      freshCadProjectVisible: true,
      explicitEmptyBasisPreserved: true,
      hostAndDraftPreserved: true,
    }),
  );
} finally {
  await browser.close();
}

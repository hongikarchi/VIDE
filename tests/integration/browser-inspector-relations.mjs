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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.goto(new URL('/?project=' + projectId, url).href);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const rows = await page.evaluate(
      async (id) => (await fetch('/api/v1/projects/' + id + '/requests')).json(),
      projectId,
    ),
    candidate = rows.at(-1),
    pin = candidate.input.pins[0];
  assert.equal(candidate.result.host, 'rhino');
  await page.locator('#document-tree').evaluate((node) => {
    node.open = true;
    for (const row of node.querySelectorAll('.layer-row[aria-expanded="false"]')) row.click();
  });
  await page.locator('#objects .object').first().click();
  await page.locator('#inspector-toggle').click();
  await page.locator('[data-inspect="relations"]').click();
  await page.locator('#body').fill('Keep editing this Rhino candidate');
  const link = page.locator('#inspector-content').getByRole('button', { name: /참고 입력.*ZWCAD/ });
  assert.equal(await link.count(), 1);
  await page.screenshot({ path: 'docs/assets/native-workspace/inspector-relations.png' });
  await link.click();
  assert.equal(await page.locator('#document-host').innerText(), 'ZWCAD');
  assert.equal(await page.locator('#host-target').inputValue(), 'rhino');
  assert.equal(await page.locator('#body').inputValue(), 'Keep editing this Rhino candidate');
  assert.equal(await page.locator('#selection').innerText(), pin.name);
  const draft = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem('vide:draft:' + id)),
    projectId,
  );
  assert.equal(draft.baseRequestId, candidate.id);
  assert.equal(draft.host, 'rhino');
  await page.getByRole('button', { name: '입력 기준 보기', exact: true }).click();
  assert.equal(await page.locator('#document-host').innerText(), 'Rhino');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      requestReferences: true,
      sourceObjectOpened: true,
      hostAndBasisPreserved: true,
      returnToInputBasis: true,
    }),
  );
} finally {
  await browser.close();
}

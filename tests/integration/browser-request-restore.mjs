// Response fixtures exercise restoration without sending a new AI request or altering saved jobs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.argv[2]).href),
  { url } = JSON.parse(await readFile(process.argv[3], 'utf8'));
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
  const project = await page.locator('#project-picker').inputValue();
  const requests = await page.evaluate(
      async (id) => (await fetch('/api/v1/projects/' + id + '/requests')).json(),
      project,
    ),
    base = requests.find((request) => request.result?.hostExecuted);
  assert.ok(base);
  const input = {
    id: 'restore-fixture',
    body: 'Restore original instruction',
    baseRequestId: base.id,
    host: 'rhino',
    pins: [
      { id: base.result.objects[0].id, name: 'Original target', role: 'preserve', basis: base.id },
    ],
    sketches: [],
    files: [{ name: 'note.md', text: 'original note' }],
    model: 'retired-model',
    provider: 'codex-cli',
    effort: 'high',
    permission: 'candidate',
  };
  let posted = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/requests')) posted++;
  });
  await page.route('**/api/v1/projects/' + project + '/requests', (route) =>
    route.fulfill({
      json: [
        ...requests,
        {
          id: input.id,
          projectId: project,
          state: 'interrupted',
          input,
          result: { code: 'PROVIDER_INTERRUPTED' },
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  );
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.locator('#body').fill('Keep my current draft');
  const restore = page.getByRole('button', { name: '입력을 초안으로 복원', exact: true }).last();
  page.once('dialog', (dialog) => dialog.dismiss());
  await restore.click();
  assert.equal(await page.locator('#body').inputValue(), 'Keep my current draft');
  page.once('dialog', (dialog) => dialog.accept());
  await restore.click();
  assert.equal(await page.locator('#body').inputValue(), input.body);
  assert.equal(await page.locator('#model').inputValue(), 'retired-model');
  assert.ok(await page.locator('#request').isDisabled());
  const draft = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem('vide:draft:' + id + ':default')),
    project,
  );
  assert.equal(draft.baseRequestId, base.id);
  assert.deepEqual(draft.pins, input.pins);
  assert.deepEqual(draft.files, input.files);
  assert.equal(draft.permission, 'candidate');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  assert.equal(await page.locator('#body').inputValue(), input.body);
  assert.ok(await page.locator('#request').isDisabled());
  assert.equal(posted, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      originalBasis: true,
      preservedInput: true,
      replaceCanBeDeclined: true,
      missingModelRequiresSelection: true,
      noAutoExecution: true,
      reload: true,
    }),
  );
} finally {
  await browser.close();
}

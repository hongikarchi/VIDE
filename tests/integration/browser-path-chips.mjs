// Pasted paths become chips (SPEC-01.12 6, SPEC-01.13 5, PLAN-31 T-142): a file path and a folder
// path pasted into the composer turn into "[파일 · …]" / "[폴더 · …]" chips (a missing path stays
// text), hovering shows the full path, Backspace removes a chip whole, and sending copies the file
// as an attachment and sends the folder as the turn's `folders` (checked again by the engine, read
// by the gate without asking). Synthetic files in a temporary folder; a mocked provider.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { runDirectory } from './run-directory.mjs';

const directory = runDirectory('browser-path-chips');
await mkdir(directory, { recursive: true });
const files = await mkdtemp(join(tmpdir(), 'vide-path-chips-'));
const folder = join(files, '2601 자료');
const file = join(folder, '도면 A.dwg');
await mkdir(folder);
await writeFile(file, 'AC1032 synthetic drawing');
let app, browser;
const contexts = [];
try {
  app = await startServer({
    filename: join(directory, 'workspace.sqlite'),
    providerFactory: () => ({
      status: async () => ({ available: true }),
      run: async (context) => {
        contexts.push(context);
        return { text: JSON.stringify({ status: 'done', text: '네', questions: [] }) };
      },
    }),
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ json: [{ id: 'codex-cli', available: true }] }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  await page.route(/\/route$/, (route) =>
    route.fulfill({ json: { target: 'document', by: 'jev' } }),
  );
  const sent = [];
  await page.route(/\/requests$/, async (route) => {
    if (route.request().method() === 'POST') sent.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  await page.locator('#model').selectOption('codex-cli');
  const body = page.locator('#body');
  const paste = (text) =>
    body.evaluate((textarea, text) => {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      const data = new DataTransfer();
      data.setData('text/plain', text);
      textarea.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text);

  // A file path, a folder path with words after it, and a path that does not exist.
  await body.fill('이 파일 ');
  await paste(`"${file}"\r\n${folder} 이 폴더도 봐줘\r\nC:\\없는\\경로.txt`);
  await page.waitForFunction(
    () => document.querySelectorAll('.body-backdrop .path-token').length === 2,
  );
  assert.equal(
    await body.inputValue(),
    '이 파일 [파일 · 도면 A.dwg]\n[폴더 · 2601 자료] 이 폴더도 봐줘\nC:\\없는\\경로.txt',
  );
  assert.deepEqual(await page.locator('.body-backdrop .path-token').allTextContents(), [
    '[파일 · 도면 A.dwg]',
    '[폴더 · 2601 자료]',
  ]);
  // Hovering a chip shows its full path.
  const chip = await page.locator('.body-backdrop .path-token').nth(1).boundingBox();
  await page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2);
  await page.waitForFunction((path) => document.querySelector('#body').title === path, folder);
  await page.screenshot({ path: join(directory, 'path-chips.png') });

  // Backspace right after the file chip removes it whole; the draft forgets its path.
  const draft = () =>
    page.evaluate(
      (id) => JSON.parse(localStorage.getItem('vide:draft:' + id + ':default') ?? '{}'),
      projectId,
    );
  await body.evaluate((textarea) => {
    const end = textarea.value.indexOf(']') + 1;
    textarea.focus();
    textarea.setSelectionRange(end, end);
  });
  await page.keyboard.press('Backspace');
  assert.equal(
    await body.inputValue(),
    '이 파일 \n[폴더 · 2601 자료] 이 폴더도 봐줘\nC:\\없는\\경로.txt',
  );
  await page.waitForFunction(
    (id) =>
      JSON.parse(localStorage.getItem('vide:draft:' + id + ':default') ?? '{}').paths?.length === 1,
    projectId,
  );
  assert.equal((await draft()).paths[0].path, folder);

  // A typed path is checked once finished (a line break after it).
  await body.evaluate((textarea) => {
    textarea.focus();
    textarea.setSelectionRange(4, 4);
  });
  await page.keyboard.type(` ${file}`);
  assert.equal(await page.locator('.body-backdrop .path-token').count(), 1);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelectorAll('.body-backdrop .path-token').length === 2,
  );
  assert.match(await body.inputValue(), /^이 파일 \[파일 · 도면 A\.dwg\]\n/);

  // Sending: the file is copied as an attachment, the folder goes as the turn's folders.
  await page.locator('#request').click();
  for (let i = 0; i < 100 && !sent.length; i++) await page.waitForTimeout(50);
  assert.equal(sent.length, 1);
  const [input] = sent;
  assert.match(input.body, /\[파일 · 도면 A\.dwg\]/);
  assert.deepEqual(
    input.files.map((entry) => entry.name),
    ['도면 A.dwg'],
  );
  assert.deepEqual(input.folders, [{ name: '2601 자료', path: folder }]);
  await page.waitForFunction(() => document.querySelector('#body').value === '');
  // The engine kept the folder at its real path and gave the turn a 'folder' item.
  const stored = await page.evaluate(
    async ([project, id]) => (await fetch(`api/v1/projects/${project}/requests/${id}`)).json(),
    [projectId, input.id],
  );
  assert.deepEqual(stored.input.folders, [{ name: '2601 자료', path: await realpath(folder) }]);
  for (let i = 0; i < 100 && !contexts.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(contexts.length, 'the mocked provider ran');
  assert.ok(JSON.stringify(contexts[0]).includes('"type":"folder"'), 'the turn names the folder');
  // A folder that is not there, or a drive root, is refused on submission.
  const submit = (path) =>
    page.evaluate(
      async ([project, path]) =>
        (
          await (
            await fetch(`api/v1/projects/${project}/requests`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: crypto.randomUUID(),
                body: '폴더',
                pins: [],
                sketches: [],
                files: [],
                folders: [{ name: 'x', path }],
                provider: 'codex-cli',
                model: 'codex-cli',
                effort: 'default',
                permission: 'review',
              }),
            })
          ).json()
        ).code,
      [projectId, path],
    );
  assert.equal(await submit(join(files, '없음')), 'FOLDER_NOT_FOUND');
  assert.equal(await submit('C:\\'), 'FOLDER_NOT_ALLOWED');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      chips: true,
      hoverPath: true,
      atomicDelete: true,
      typedFinish: true,
      sendAttachesAndGrants: true,
    }),
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(files, { recursive: true, force: true });
}

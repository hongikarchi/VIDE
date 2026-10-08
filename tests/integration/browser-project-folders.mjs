// 대시보드 › 프로젝트 폴더 (SPEC-01.13, Design §03, PLAN-26 T-091): in a browser [폴더 추가] opens a
// path field; the engine's check decides (a drive root is refused with its reason), the row shows
// the folder and [빼기] takes it off. In the program window (a stand-in WebView2) the button asks
// the shell's folder dialog: cancel changes nothing, a chosen folder is added, and when no dialog
// opens the path field shows the shell's reason. Synthetic temporary folders only; no real CLI,
// host or Windows dialog.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-project-folders-'));
const folder = join(directory, '로컬 2601-합성 프로젝트');
await mkdir(folder);
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'data', 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.setDefaultTimeout(10000);
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
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.locator('.rail [data-workspace-target="dashboard"]').click();
  const board = page.getByRole('region', { name: '대시보드', exact: true });
  // The folders are a section of the dashboard's right column, under 할 일 (PLAN-42 T-192).
  const section = board.getByRole('region', { name: '프로젝트 폴더' });
  await section.getByText('프로젝트 폴더를 정하면 AI가 그 안의 파일을 직접 읽습니다.').waitFor();

  // Outside the program window the button opens a path field.
  await section.getByRole('button', { name: '폴더 추가' }).click();
  const field = section.getByRole('textbox', { name: '폴더 경로' });
  assert.equal(await field.evaluate((input) => input === document.activeElement), true);
  // A drive root is refused with its reason, and the field stays.
  await field.fill(parse(folder).root);
  await section.getByRole('button', { name: '추가', exact: true }).click();
  await section.getByRole('alert').getByText('드라이브 맨 위').waitFor();
  // A pasted path with quotes is the folder.
  await field.fill(`"${folder}"`);
  await section.getByRole('button', { name: '추가', exact: true }).click();
  const list = section.getByRole('list', { name: '프로젝트 폴더 목록' });
  await list.getByText(folder).waitFor();
  assert.equal(await field.count(), 0);
  assert.equal(await section.getByRole('alert').count(), 0);
  if (shot) await page.screenshot({ path: join(shot, 'dashboard-project-folders.png') });

  // It is kept: a reload shows it again; [빼기] takes it off.
  await page.reload();
  await page.locator('.rail [data-workspace-target="dashboard"]').click();
  await list.getByText(folder).waitFor();
  await section.getByRole('button', { name: `${folder} 빼기` }).click();
  await section.getByText('프로젝트 폴더를 정하면 AI가 그 안의 파일을 직접 읽습니다.').waitFor();
  assert.equal(await list.count(), 0);

  // In the program window [폴더 추가] asks the shell (`folder:pick`, the Windows Explorer-style
  // dialog); a stand-in WebView2 answers with the test's queued replies.
  const shell = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  shell.setDefaultTimeout(10000);
  shell.on('pageerror', (error) => errors.push(error.message));
  for (const [pattern, json] of [
    ['**/api/v1/host', { available: false }],
    ['**/api/v1/providers', [{ id: 'codex-cli', available: true }]],
    [
      '**/api/v1/models',
      [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    ],
  ])
    await shell.route(pattern, (route) => route.fulfill({ json }));
  await shell.addInitScript(() => {
    const target = new EventTarget();
    const answer = (data) =>
      setTimeout(() => target.dispatchEvent(new MessageEvent('message', { data })), 20);
    window.__picks = [];
    window.__replies = [];
    window.chrome = {
      webview: {
        addEventListener: (type, listener) => target.addEventListener(type, listener),
        removeEventListener: (type, listener) => target.removeEventListener(type, listener),
        postMessage(message) {
          if (message?.type === 'desktop:get')
            answer({
              type: 'desktop:state',
              version: '0.0.0',
              settings: { autostart: false, background: false },
              update: { state: 'unavailable' },
              folderPick: true,
            });
          if (message?.type === 'folder:pick') {
            window.__picks.push(message);
            const reply = window.__replies.shift();
            // `hold`: the dialog has not appeared yet; the test releases it.
            if (reply?.hold)
              window.__release = () =>
                answer({ type: 'folder:picked', id: message.id, path: null });
            else answer({ type: 'folder:picked', id: message.id, ...reply });
          }
        },
      },
    };
  });
  await shell.goto(app.launchUrl);
  await shell.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await shell.locator('.rail [data-workspace-target="dashboard"]').click();
  const picked = shell
    .getByRole('region', { name: '대시보드', exact: true })
    .getByRole('region', { name: '프로젝트 폴더' });
  const pickedList = picked.getByRole('list', { name: '프로젝트 폴더 목록' });
  const addButton = picked.getByRole('button', { name: '폴더 추가' });
  await picked.getByText('프로젝트 폴더를 정하면 AI가 그 안의 파일을 직접 읽습니다.').waitFor();
  // Cancel: nothing changes and no path field opens.
  await shell.evaluate(() => window.__replies.push({ path: null }));
  await addButton.click();
  await shell.waitForFunction(() => window.__picks.length === 1);
  await shell.waitForTimeout(200);
  assert.equal(await picked.getByRole('textbox', { name: '폴더 경로' }).count(), 0);
  assert.equal(await pickedList.count(), 0);
  // A chosen folder goes to the engine and shows in the list.
  await shell.evaluate((path) => window.__replies.push({ path }), folder);
  await addButton.click();
  await pickedList.getByText(folder).waitFor();
  assert.equal(await picked.getByRole('textbox', { name: '폴더 경로' }).count(), 0);
  // A double click before the dialog shows asks for one picker only, and the button waits for it.
  await shell.evaluate(() => window.__replies.push({ hold: true }, { path: null }));
  await addButton.dblclick();
  await shell.waitForTimeout(500);
  assert.equal(await shell.evaluate(() => window.__picks.length), 3);
  assert.equal(await addButton.isDisabled(), true);
  await shell.evaluate(() => window.__release());
  for (let i = 0; i < 100 && (await addButton.isDisabled()); i++) await shell.waitForTimeout(50);
  assert.equal(await addButton.isDisabled(), false);
  await shell.evaluate(() => window.__replies.shift());
  // No picker could open: the path field opens with the shell's reason.
  await shell.evaluate(() =>
    window.__replies.push({
      path: null,
      error: '폴더 선택 창을 열지 못했습니다. 경로를 붙여넣으세요.',
    }),
  );
  await addButton.click();
  await picked.getByRole('alert').getByText('폴더 선택 창을 열지 못했습니다').waitFor();
  await picked.getByRole('textbox', { name: '폴더 경로' }).waitFor();
  assert.equal(await shell.evaluate(() => window.__picks.length), 4);
  await picked.getByRole('button', { name: `${folder} 빼기` }).click();
  await picked.getByText('프로젝트 폴더를 정하면 AI가 그 안의 파일을 직접 읽습니다.').waitFor();

  assert.deepEqual(errors, []);
  console.log('project folder browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

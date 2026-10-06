// 대시보드 › 프로젝트 폴더 (SPEC-01.13, Design §03, PLAN-26 T-091): in a browser [폴더 추가] opens a
// path field; the engine's check decides (a drive root is refused with its reason), the row shows
// the folder and [빼기] takes it off. Synthetic temporary folders only; no real CLI or host.
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
  // The folders sit in the dashboard's folded line (PLAN-39 T-181); opened, it stays open.
  await board.locator('details.dash-more > summary').click();
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

  assert.deepEqual(errors, []);
  console.log('project folder browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

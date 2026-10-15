// 작업 폴더 만들기·열기 (SPEC-01.13 7, Design SCR-35, PLAN-52 T-308·T-314): the dashboard's 프로젝트
// 폴더 section has [폴더로 만들기] and [폴더 열기]. In the program window (a stand-in WebView2 answers
// the folder dialog) [폴더로 만들기] shows the template tree with editable names — an emptied name
// reads '만들지 않음', a repeated one warns and blocks [만들기] — and makes the folder; the new project
// opens with that folder as its first project folder. The project heading's [폴더 열기] opens the
// same panel; after the project's data is deleted the folder is opened again with the same id
// ('이 폴더의 프로젝트를 다시 엽니다', three progress lines). A folder without a settings file
// offers both ways. Synthetic temporary folders only; no real CLI, host or Windows dialog.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
const FORBIDDEN =
  /SPEC-|PLAN-|JIG\b|hostUse|LINK_NOT_LIVE|세션|토큰|bake|overlay|handoff|stale|WORKSPACE_|NO_WORKSPACE|undefined|null/;

const shot = process.env.VIDE_SHOT_DIR;
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const directory = await mkdtemp(join(tmpdir(), 'vide-workspace-create-ui-'));
const folder = join(directory, '2602 합성 작업 폴더');
const plain = join(directory, '그냥 폴더');
await mkdir(folder);
await mkdir(plain);
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'data', 'test.sqlite'),
    collectOptions: { plan: async () => null, dwgReader: null },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  for (const [pattern, json] of [
    ['**/api/v1/host', { available: false }],
    ['**/api/v1/providers', [{ id: 'codex-cli', available: true }]],
    [
      '**/api/v1/models',
      [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    ],
  ])
    await page.route(pattern, (route) => route.fulfill({ json }));
  // git is reported missing: the box is dim and nothing git-related happens.
  await page.route('**/api/v1/workspace/git', (route) =>
    route.fulfill({ json: { available: false } }),
  );
  await page.addInitScript(() => {
    const target = new EventTarget();
    const answer = (data) =>
      setTimeout(() => target.dispatchEvent(new MessageEvent('message', { data })), 20);
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
          if (message?.type === 'folder:pick')
            answer({ type: 'folder:picked', id: message.id, ...window.__replies.shift() });
        },
      },
    };
  });
  const dashboard = async () => {
    await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
    await page.locator('.rail [data-workspace-target="dashboard"]').click();
    return page
      .getByRole('region', { name: '대시보드', exact: true })
      .getByRole('region', { name: '프로젝트 폴더' });
  };
  await page.goto(app.launchUrl);
  let section = await dashboard();
  const firstProject = await page.locator('#project-picker').inputValue();

  // [폴더로 만들기]: the tree from the template, names editable.
  await page.evaluate((path) => window.__replies.push({ path }), folder);
  await section.getByRole('button', { name: '폴더로 만들기' }).click();
  const panel = section.getByRole('group', { name: '폴더로 만들기' });
  await panel.getByText('이 폴더 안에 아래 구조를 만듭니다. 이름은 바꿀 수 있습니다.').waitFor();
  await panel.getByText('설정과 안내 파일 · 자동으로 만듭니다').waitFor();
  const tree = panel.getByRole('list', { name: '만들 폴더 구조' });
  const ops = tree.getByRole('textbox', { name: '일지·회의록·할 일 폴더 이름' });
  await page.waitForFunction(
    () => document.querySelector('[aria-label="일지·회의록·할 일 폴더 이름"]')?.value === '01_운영',
  );
  assert.equal(
    await panel.getByRole('textbox', { name: '프로젝트 이름' }).inputValue(),
    '2602 합성 작업 폴더',
  );
  const gitBox = panel.getByRole('checkbox');
  await panel.getByText('git이 설치되어 있지 않습니다').waitFor();
  assert.equal(await gitBox.isDisabled(), true);
  // A repeated name warns and blocks; an emptied one is not made.
  const make = panel.getByRole('button', { name: '만들기', exact: true });
  await ops.fill('02_자료');
  await tree.getByText('같은 이름이 있습니다').first().waitFor();
  assert.equal(await make.isDisabled(), true);
  await ops.fill('01_일지');
  assert.equal(await tree.getByText('같은 이름이 있습니다').count(), 0);
  await tree.getByRole('textbox', { name: '검토본 폴더 이름' }).fill('');
  await tree.getByText('만들지 않음').waitFor();
  await panel.getByRole('textbox', { name: '프로젝트 이름' }).fill('합성 작업');
  assert.doesNotMatch(await panel.innerText(), FORBIDDEN);
  if (shot) await panel.screenshot({ path: join(shot, 'workspace-create.png') });
  await make.click();

  // The new project opens; its first project folder is the folder.
  await page.waitForFunction((first) => {
    const value = document.querySelector('#project-picker')?.value;
    return value && value !== first;
  }, firstProject);
  const madeId = await page.locator('#project-picker').inputValue();
  section = await dashboard();
  const list = section.getByRole('list', { name: '프로젝트 폴더 목록' });
  await list.getByText('2602 합성 작업 폴더').waitFor();
  const cfg = JSON.parse(await readFile(join(folder, 'project.config.json'), 'utf8'));
  assert.equal(cfg.vide.projectId, madeId);
  assert.equal(cfg.title, '합성 작업');
  assert.equal(cfg.paths.ops, '01_일지');
  assert.equal(cfg.paths.snapshots, undefined);
  assert.equal(cfg.git.mode, 'none');
  assert.ok(await exists(join(folder, '01_일지')));
  assert.ok(!(await exists(join(folder, '07_검토본'))));
  assert.ok(!(await exists(join(folder, '.git'))));
  assert.ok(await exists(join(folder, 'AGENTS.md')));

  // The project's data is deleted (its folder stays). The heading is in the model view's side.
  await page.locator('.rail [data-workspace-target="model"]').click();
  await page.locator('#delete-project').click();
  await page.locator('#confirm-delete-project').click();
  await page.waitForFunction((id) => {
    const value = document.querySelector('#project-picker')?.value;
    return value && value !== id;
  }, madeId);

  // The heading's [폴더 열기] opens the dashboard's panel; the folder's project comes back.
  await page.locator('.rail [data-workspace-target="model"]').click();
  await page.locator('#new-project').click();
  await page.evaluate((path) => window.__replies.push({ path }), folder);
  await page.locator('#project-heading').getByRole('button', { name: '폴더 열기' }).click();
  section = page
    .getByRole('region', { name: '대시보드', exact: true })
    .getByRole('region', { name: '프로젝트 폴더' });
  const confirm = section.getByRole('group', { name: '폴더 열기 확인' });
  await confirm.getByText('이 폴더의 프로젝트를 다시 엽니다').waitFor();
  await confirm.getByText('합성 작업 · ').waitFor();
  await confirm.getByText('역할 폴더 9개', { exact: false }).waitFor();
  await confirm
    .getByText('이 PC에 같은 프로젝트가 없어 새로 만들고, 자료 색인과 정리를 다시 돌립니다.')
    .waitFor();
  assert.doesNotMatch(await confirm.innerText(), FORBIDDEN);
  if (shot) await confirm.screenshot({ path: join(shot, 'workspace-open.png') });
  await confirm.getByRole('button', { name: '열기', exact: true }).click();
  const progress = section.getByRole('group', { name: '프로젝트 여는 중' });
  await progress.getByText('프로젝트 만들기 ✓').waitFor();
  await progress.getByText('파일 색인 · AI에 로그인하면 시작합니다').waitFor();
  await progress.getByText('자료 정리 대기').waitFor();
  await progress.getByRole('button', { name: '프로젝트로 이동' }).click();
  await page.waitForFunction(
    (id) => document.querySelector('#project-picker')?.value === id,
    madeId,
  );
  section = await dashboard();
  await section
    .getByRole('list', { name: '프로젝트 폴더 목록' })
    .getByText('2602 합성 작업 폴더')
    .waitFor();

  // A folder without a settings file: make it here, or just add it as before.
  await page.evaluate((path) => window.__replies.push({ path }), plain);
  await section.getByRole('button', { name: '폴더 열기' }).click();
  const none = section.getByRole('group', { name: '폴더 열기' });
  await none.getByText('이 폴더에는 프로젝트 설정 파일이 없습니다.').waitFor();
  await none.getByRole('button', { name: '이 폴더로 새로 만들기' }).waitFor();
  assert.doesNotMatch(await none.innerText(), FORBIDDEN);
  await none.getByRole('button', { name: '그냥 프로젝트 폴더로 추가' }).click();
  await section.getByRole('list', { name: '프로젝트 폴더 목록' }).getByText('그냥 폴더').waitFor();
  assert.ok(!(await exists(join(plain, 'project.config.json'))));

  // A folder a project already has cannot become another project: refused with its name.
  await page.evaluate((path) => window.__replies.push({ path }), plain);
  await section.getByRole('button', { name: '폴더로 만들기' }).click();
  await section
    .getByRole('alert')
    .getByText('이미 다른 프로젝트의 폴더입니다 — 합성 작업')
    .waitFor();
  assert.equal(await section.getByRole('group', { name: '폴더로 만들기' }).count(), 0);
  assert.doesNotMatch(await section.getByRole('alert').innerText(), FORBIDDEN);

  assert.deepEqual(errors, []);
  console.log('workspace create/open browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

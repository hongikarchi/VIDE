// 작업 폴더 이력 — 저장점·푸시·가져오기 (SPEC-05.11, Design SCR-42, PLAN-54 T-346): the dashboard's
// 프로젝트 폴더 section shows the history line of a work folder with its own git. Without GitHub
// [푸시] is dim with the hint to connect it; [저장점 만들기] opens a small card with the changed
// file count and the message draft; after GitHub is connected the first [푸시] asks for the
// repository (name from the folder, 비공개 by default, 3dm·dwg not uploaded) and pushes; when the
// remote moved on and so did this folder, the line stops with '로컬이 다릅니다 — 폴더를 git 도구로
// 여세요' and [폴더 열기]. A fake GitHub API makes local bare repositories; the token is plainly
// fake and never shows on the page or in `.git/config`. No real GitHub, CLI or host.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';

const TOKEN = 'ghp_test_fake_history_ui_01';
const LOGIN = 'vide-test-user';
const FORBIDDEN =
  /SPEC-|PLAN-|REMOTE_|GIT_|ACCOUNT_|WORKSPACE_|origin|HEAD|undefined|null|ghp_|x-access-token/;
const shot = process.env.VIDE_SHOT_DIR;

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Other PC', '-c', 'user.email=other@example.test', ...args],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

const directory = await mkdtemp(join(tmpdir(), 'vide-workspace-git-ui-'));
const folder = join(directory, 'Git Work 2603');
await mkdir(folder);

// Fake GitHub: `GET /user`, `POST /user/repos` (a bare repository on disk), `GET /repos/:o/:n`.
const repos = new Map();
const github = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fake');
  let body = '';
  for await (const chunk of request) body += chunk;
  const json = (status, value, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    response.end(JSON.stringify(value));
  };
  if (request.headers.authorization !== `Bearer ${TOKEN}`)
    return json(401, { message: 'Bad credentials' });
  if (request.method === 'GET' && url.pathname === '/user')
    return json(200, { login: LOGIN }, { 'X-OAuth-Scopes': 'repo' });
  if (request.method === 'POST' && url.pathname === '/user/repos') {
    const { name, private: isPrivate } = JSON.parse(body);
    if (repos.has(name))
      return json(422, { errors: [{ message: 'name already exists on this account' }] });
    const bare = join(directory, 'remotes', `${name}.git`);
    await mkdir(bare, { recursive: true });
    git(bare, 'init', '--bare', '--initial-branch=main');
    const row = {
      name,
      full_name: `${LOGIN}/${name}`,
      clone_url: pathToFileURL(bare).href,
      private: isPrivate,
    };
    repos.set(name, row);
    return json(201, row);
  }
  json(404, { message: 'Not Found' });
});
await new Promise((resolve) => github.listen(0, '127.0.0.1', resolve));

let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'data', 'test.sqlite'),
    collectOptions: { plan: async () => null, dwgReader: null },
    serviceOptions: {
      protector: testProtector,
      githubApi: `http://127.0.0.1:${github.address().port}`,
    },
  });
  // The engine's own API (a signed-in session): the work folder with git, and later the token.
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const headers = {
    Origin: app.origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const engine = async (path, method = 'GET', value) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: value ? JSON.stringify(value) : undefined,
    });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response.json();
  };
  const made = await engine('/workspace/create', 'POST', { dir: folder, git: true });
  assert.equal(made.git?.state, 'committed', JSON.stringify(made.git));
  const projectId = made.project.id;
  // A new note and an ignored model file before the page opens.
  await writeFile(join(folder, 'memo.md'), '메모\n');
  await writeFile(join(folder, 'A.3dm'), 'binary');

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.setDefaultTimeout(15000);
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
  // [폴더 열기] would start Explorer: answered here and counted.
  let opened = 0;
  await page.route('**/workspace/git/open', (route) => {
    opened++;
    return route.fulfill({ json: { opened: true } });
  });
  const open = async () => {
    const url = new URL(app.launchUrl);
    url.searchParams.set('project', projectId);
    if (page.url().startsWith(app.origin)) await page.reload();
    else await page.goto(url.href);
    await page.waitForFunction(
      (id) => document.querySelector('#project-picker')?.value === id,
      projectId,
    );
    await page.locator('.rail [data-workspace-target="dashboard"]').click();
    return page
      .getByRole('region', { name: '대시보드', exact: true })
      .getByRole('region', { name: '프로젝트 폴더' })
      .getByRole('group', { name: '작업 폴더 이력' });
  };

  // Without GitHub: the line, [푸시] dim with the hint.
  let line = await open();
  await line.getByText('저장점 1 · 원격 없음 · 바뀐 파일 1').waitFor();
  const push = line.getByRole('button', { name: '푸시', exact: true });
  assert.equal(await push.isDisabled(), true);
  await line.getByText('설정 → 외부 서비스에서 GitHub를 연결하세요').waitFor();
  assert.equal(await line.getByRole('button', { name: '가져오기' }).isDisabled(), true);
  assert.doesNotMatch(await line.innerText(), FORBIDDEN);

  // [저장점 만들기]: the count and the draft; the person's line is kept.
  await line.getByRole('button', { name: '저장점 만들기' }).click();
  const commitCard = line.getByRole('dialog', { name: '저장점 만들기' });
  await commitCard.getByText('새 파일 1').waitFor();
  const message = commitCard.getByRole('textbox', { name: '저장점 메시지' });
  assert.match(
    await message.inputValue(),
    /^작업 저장 \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 바뀐 파일 1$/,
  );
  await message.fill('메모 추가');
  if (shot) await line.screenshot({ path: join(shot, 'workspace-git-commit.png') });
  await commitCard.getByRole('button', { name: '만들기', exact: true }).click();
  await line.getByText('저장점 2 · 원격 없음', { exact: true }).waitFor();
  assert.equal(await commitCard.count(), 0);
  assert.equal(git(folder, 'log', '-1', '--format=%s').trim(), '메모 추가');
  assert.doesNotMatch(git(folder, 'ls-files'), /A\.3dm/);

  // GitHub connected (설정 → 외부 서비스): the first [푸시] asks for the repository.
  await engine('/settings/services', 'PUT', { github: { token: TOKEN } });
  line = await open();
  await line.getByText('저장점 2 · 원격 없음').waitFor();
  assert.equal(await line.getByText('GitHub를 연결하세요').count(), 0);
  await push.click();
  const remoteCard = line.getByRole('dialog', { name: '내 GitHub에 저장소를 만듭니다' });
  await remoteCard.getByText('3dm·dwg·pdf·이미지는 올리지 않습니다(이력 제외 목록)').waitFor();
  assert.equal(
    await remoteCard.getByRole('textbox', { name: '저장소 이름' }).inputValue(),
    'git-work-2603',
  );
  assert.equal(await remoteCard.getByRole('radio', { name: '비공개(기본)' }).isChecked(), true);
  assert.doesNotMatch(await remoteCard.innerText(), FORBIDDEN);
  if (shot) await line.screenshot({ path: join(shot, 'workspace-git-remote.png') });
  await remoteCard.getByRole('button', { name: '만들고 푸시' }).click();
  await line.getByText(/^저장점 2 · 원격과 같음 · 마지막 푸시 \d{2}-\d{2}$/).waitFor();
  assert.equal(repos.get('git-work-2603')?.private, true);
  assert.equal(await push.isDisabled(), true, 'nothing left to push');
  const config = await readFile(join(folder, '.git', 'config'), 'utf8');
  assert.ok(!config.includes(TOKEN), 'no token in .git/config');
  assert.ok(!(await page.content()).includes(TOKEN), 'no token on the page');

  // Both sides move on: the line stops and offers the folder.
  const other = join(directory, 'other');
  git(directory, 'clone', repos.get('git-work-2603').clone_url, other);
  await writeFile(join(other, 'other.md'), '다른 PC\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-m', '다른 PC');
  git(other, 'push', 'origin', 'main');
  await writeFile(join(folder, 'here.md'), '여기\n');
  await line.getByRole('button', { name: '저장점 만들기' }).click();
  await line
    .getByRole('dialog', { name: '저장점 만들기' })
    .getByRole('button', { name: '만들기', exact: true })
    .click();
  await line.getByText('저장점 3 · 원격보다 1 앞섬', { exact: false }).waitFor();
  await push.click();
  await line.getByText('로컬이 다릅니다 — 폴더를 git 도구로 여세요').waitFor();
  assert.equal(await push.isDisabled(), true);
  assert.equal(await line.getByRole('button', { name: '가져오기' }).isDisabled(), true);
  assert.doesNotMatch(await line.innerText(), FORBIDDEN);
  if (shot) await line.screenshot({ path: join(shot, 'workspace-git-diverged.png') });
  await line.getByRole('button', { name: '폴더 열기' }).click();
  for (let i = 0; i < 50 && !opened; i++) await page.waitForTimeout(100);
  assert.equal(opened, 1);
  assert.equal(git(folder, 'status', '--porcelain').trim(), '', 'nothing merged here');

  assert.deepEqual(errors, []);
  console.log('workspace git browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  github.closeAllConnections();
  await new Promise((resolve) => github.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

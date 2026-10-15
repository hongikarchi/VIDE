// 작업 폴더 이력 — 저장점·원격·푸시·가져오기 (PLAN-54 T-346, SPEC-05.11, SPEC-01.13 10, Design
// SCR-42): a temporary work folder with its local git (PLAN-52 T-314), a local bare repository as
// the remote (file://) and a fake GitHub API that "creates" it. The token is plainly fake and must
// never land in `.git/config`, the remote address or an answer. Divergence stops (never merged).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultTemplate, templateToPaths } from '../../src/core/workspace-template.ts';
import {
  commit,
  commitDraft,
  ensureRemote,
  gitAuth,
  gitStatus,
  initRepository,
  onServerShare,
  pull,
  push,
} from '../../src/server/workspace-git.ts';
import { GithubApi, repoNameOf } from '../../src/server/github-api.ts';
import { workspaceRoutes } from '../../src/server/workspace-routes.ts';
import { startServer } from '../../src/server/server.ts';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';

const TOKEN = 'ghp_test_fake_history_0001';
const LOGIN = 'vide-test-user';

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Other PC', '-c', 'user.email=other@example.test', ...args],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  );

async function temp(t, prefix = 'vide-git-remote-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A work folder like [폴더로 만들기] makes it: role folders, a manifest, git with a first commit. */
async function workFolder(t, base, name = 'work') {
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  const paths = templateToPaths(defaultTemplate());
  for (const relative of Object.values(paths))
    await mkdir(join(root, relative), { recursive: true });
  await writeFile(join(root, 'README.md'), '# 시험\n');
  const setup = await initRepository(root, paths);
  assert.equal(setup.state, 'committed', JSON.stringify(setup));
  return root;
}

/**
 * Fake GitHub: `GET /user`, `POST /user/repos` (makes a bare repository on disk and answers its
 * file:// address as clone_url), `GET /repos/:owner/:name`. A second create of a name is 422.
 */
async function fakeGithub(t, base) {
  const repos = new Map();
  const calls = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fake');
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, path: url.pathname, auth: request.headers.authorization });
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
        return json(422, {
          message: 'Repository creation failed.',
          errors: [
            {
              resource: 'Repository',
              field: 'name',
              message: 'name already exists on this account',
            },
          ],
        });
      const bare = join(base, 'remotes', `${name}.git`);
      await mkdir(bare, { recursive: true });
      git(bare, 'init', '--bare', '--initial-branch=main');
      const row = {
        name,
        full_name: `${LOGIN}/${name}`,
        clone_url: pathToFileURL(bare).href,
        html_url: `https://github.example.test/${LOGIN}/${name}`,
        private: isPrivate,
      };
      repos.set(name, row);
      return json(201, row);
    }
    const repo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && repo) {
      const row = repos.get(decodeURIComponent(repo[2]));
      return row && repo[1] === LOGIN ? json(200, row) : json(404, { message: 'Not Found' });
    }
    json(404, { message: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, repos, calls };
}

const github = (api) => async () => new GithubApi({ token: TOKEN, base: api.base });

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('저장점: status counts tracked changes only, commit takes them with the edited line', async (t) => {
  const base = await temp(t);
  const root = await workFolder(t, base);
  let status = await gitStatus(root);
  assert.equal(status.repository, true);
  assert.equal(status.branch, 'main');
  assert.equal(status.commits, 1);
  assert.equal(status.dirty, 0);
  assert.equal(status.remote, null);

  await writeFile(join(root, '05_검토', 'note.md'), '검토 메모\n');
  await writeFile(join(root, 'README.md'), '# 시험 2\n');
  await writeFile(join(root, '03_모델', 'A.3dm'), 'binary');
  status = await gitStatus(root);
  assert.equal(status.dirty, 2, 'the 3dm is ignored');
  assert.equal(status.added, 1);
  assert.equal(status.modified, 1);
  assert.match(status.draft, /^작업 저장 \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 바뀐 파일 2$/);

  status = await commit(root, '법규 체크 보고서 추가\n둘째 줄은 버립니다');
  assert.equal(status.commits, 2);
  assert.equal(status.dirty, 0);
  assert.equal(git(root, 'log', '-1', '--format=%s').trim(), '법규 체크 보고서 추가');
  assert.doesNotMatch(git(root, 'ls-files'), /A\.3dm/);
  await rejects(commit(root, 'x'), 'NOTHING_TO_COMMIT');

  // An empty message takes the draft.
  await writeFile(join(root, '05_검토', 'note2.md'), '둘\n');
  await commit(root, '  ');
  assert.match(git(root, 'log', '-1', '--format=%s').trim(), /^작업 저장 .* · 바뀐 파일 1$/);
  assert.equal(
    commitDraft(4, new Date(2026, 9, 15, 9, 5)),
    '작업 저장 2026-10-15 09:05 · 바뀐 파일 4',
  );
});

test('a folder without its own repository has no history line; actions refuse', async (t) => {
  const base = await temp(t);
  const plain = join(base, 'plain');
  await mkdir(plain);
  assert.equal((await gitStatus(plain)).repository, false);
  await rejects(commit(plain, 'x'), 'NO_REPOSITORY');
  await rejects(push(plain, TOKEN), 'NO_REPOSITORY');
  await rejects(pull(plain), 'NO_REPOSITORY');
});

test('server shares (UNC) never get git', async () => {
  assert.equal(onServerShare('\\\\fileserver\\프로젝트\\2601'), true);
  assert.equal(onServerShare('//fileserver/share'), true);
  assert.equal(onServerShare('C:\\work'), false);
  await rejects(gitStatus('\\\\fileserver\\프로젝트\\2601'), 'WORKSPACE_READ_ONLY');
  await rejects(commit('\\\\fileserver\\share\\x', 'm'), 'WORKSPACE_READ_ONLY');
  await rejects(push('\\\\fileserver\\share\\x', TOKEN), 'WORKSPACE_READ_ONLY');
});

test('원격 만들기 → 푸시 → 다른 PC 가져오기; the token stays out of .git/config', async (t) => {
  const base = await temp(t);
  const api = await fakeGithub(t, base);
  const root = await workFolder(t, base, '2601 Nonhyeon 시험');
  await rejects(push(root, TOKEN), 'NO_REMOTE');

  const made = await ensureRemote(root, {}, github(api));
  assert.equal(made.created, true);
  assert.equal(made.repository, `${LOGIN}/2601-nonhyeon`);
  assert.equal(api.repos.get('2601-nonhyeon').private, true, 'private by default');
  assert.equal(made.status.remote.pushed, false);
  assert.equal(made.status.remote.ahead, 1);
  // A second ask keeps the origin and makes nothing.
  const again = await ensureRemote(root, { name: 'other' }, github(api));
  assert.equal(again.created, false);
  assert.equal(api.repos.size, 1);

  let status = await push(root, TOKEN);
  assert.equal(status.remote.pushed, true);
  assert.equal(status.remote.ahead, 0);
  assert.equal(status.remote.behind, 0);
  assert.ok(status.remote.lastPush, 'git recorded the push');
  const config = await readFile(join(root, '.git', 'config'), 'utf8');
  assert.ok(!config.includes(TOKEN), '.git/config has no token');
  assert.doesNotMatch(config, /x-access-token|credential/);
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  assert.ok(api.calls.every((call) => call.auth === `Bearer ${TOKEN}`));

  // The other PC: a clone, a new 저장점 pushed there.
  const other = join(base, 'other');
  git(base, 'clone', made.status.remote.url, other);
  await writeFile(join(other, 'from-other.md'), '다른 PC\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-m', '다른 PC 저장점');
  git(other, 'push', 'origin', 'main');

  // Uncommitted changes here: [가져오기] asks for a 저장점 first.
  await writeFile(join(root, 'README.md'), '# 바뀜\n');
  await rejects(pull(root), 'UNCOMMITTED_CHANGES');
  git(root, 'checkout', '--', 'README.md');
  status = await pull(root);
  assert.equal(status.remote.behind, 0);
  assert.equal(status.commits, 2);
  assert.equal((await readFile(join(root, 'from-other.md'), 'utf8')).trim(), '다른 PC');

  // Both sides move on: push and pull stop, nothing merged.
  await writeFile(join(other, 'b.md'), 'other\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-m', 'other');
  git(other, 'push', 'origin', 'main');
  await writeFile(join(root, 'c.md'), 'here\n');
  await commit(root, '여기 저장점');
  await rejects(push(root, TOKEN), 'REMOTE_DIVERGED');
  await rejects(pull(root), 'REMOTE_DIVERGED');
  status = await gitStatus(root);
  assert.equal(status.remote.diverged, true);
  assert.equal(status.remote.ahead, 1);
  assert.equal(status.remote.behind, 1);
  assert.equal(git(root, 'log', '-1', '--format=%s').trim(), '여기 저장점', 'nothing merged');
  assert.equal(git(root, 'status', '--porcelain').trim(), '');
});

test('같은 이름의 저장소: REMOTE_EXISTS, then [이어 쓰기] sets origin to it', async (t) => {
  const base = await temp(t);
  const api = await fakeGithub(t, base);
  const first = await workFolder(t, base, 'one');
  await ensureRemote(first, { name: 'shared-name' }, github(api));
  const second = await workFolder(t, base, 'two');
  await rejects(ensureRemote(second, { name: 'shared-name' }, github(api)), 'REMOTE_EXISTS');
  assert.equal((await gitStatus(second)).remote, null, 'nothing set on refusal');
  const reused = await ensureRemote(second, { name: 'shared-name', reuse: true }, github(api));
  assert.equal(reused.created, false);
  assert.equal(reused.repository, `${LOGIN}/shared-name`);
  assert.equal(reused.status.remote.url, api.repos.get('shared-name').clone_url);
  // A wrong name, and a wrong token refused by the service.
  const third = await workFolder(t, base, 'three');
  await rejects(ensureRemote(third, { name: 'bad name!' }, github(api)), 'INVALID_INPUT');
  await rejects(
    ensureRemote(third, {}, async () => new GithubApi({ token: 'ghp_wrong', base: api.base })),
    'ACCOUNT_NOT_CONNECTED',
  );
});

test('repository names: kebab of the ASCII part', () => {
  assert.equal(repoNameOf('2601 Nonhyeon 164'), '2601-nonhyeon-164');
  assert.equal(repoNameOf('논현동 7-3'), '7-3');
  assert.equal(repoNameOf('논현'), 'vide-workspace');
});

test('the credential helper answers github.com only, from the environment', () => {
  const auth = gitAuth(TOKEN);
  assert.ok(!auth.args.join(' ').includes(TOKEN), 'no token in the arguments');
  assert.ok(
    auth.args.some((arg) => arg.startsWith('core.hooksPath=')),
    'the folder hooks do not run with the token',
  );
  const fill = (host) =>
    execFileSync('git', [...auth.args, 'credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...auth.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const answer = fill('github.com');
  assert.match(answer, new RegExp(`password=${TOKEN}`));
  assert.match(answer, /username=x-access-token/);
  assert.throws(() => fill('example.test'), 'no password for another host');
});

test('routes: status · commit · remote · push through the engine and the saved token', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-git-routes-'));
  const data = join(directory, 'data');
  await mkdir(data);
  const fake = await fakeGithub(t, directory);
  const app = await startServer({
    filename: join(data, 'store.sqlite'),
    collectOptions: { plan: async () => null, dwgReader: null },
    serviceOptions: { protector: testProtector, githubApi: fake.base },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
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
  const api = async (path, method = 'GET', value) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: value ? JSON.stringify(value) : undefined,
    });
    const text = await response.text();
    assert.ok(!text.includes(TOKEN), `no token in ${path}`);
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  const root = join(directory, 'Route Work');
  await mkdir(root);
  const made = await api('/workspace/create', 'POST', { dir: root, git: true });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const p = `/projects/${made.json.project.id}/workspace/git`;

  let status = await api(`${p}/status`);
  assert.equal(status.status, 200);
  assert.equal(status.json.repository, true);
  assert.equal(status.json.github, false);
  assert.equal(status.json.suggestedName, 'route-work');
  assert.equal((await api(`${p}/push`, 'POST', {})).json.code, 'ACCOUNT_NOT_CONNECTED');
  assert.equal((await api(`${p}/status`, 'POST', {})).status, 404);

  await writeFile(join(root, 'memo.md'), '메모\n');
  const committed = await api(`${p}/commit`, 'POST', { message: '메모 추가' });
  assert.equal(committed.status, 200, JSON.stringify(committed.json));
  assert.equal(committed.json.commits, 2);
  assert.equal((await api(`${p}/commit`, 'POST', {})).status, 409);

  assert.equal((await api('/settings/services', 'PUT', { github: { token: TOKEN } })).status, 200);
  status = await api(`${p}/status`);
  assert.equal(status.json.github, true);
  const remote = await api(`${p}/remote`, 'POST', { name: 'route-work', private: true });
  assert.equal(remote.status, 200, JSON.stringify(remote.json));
  assert.equal(remote.json.created, true);
  const pushed = await api(`${p}/push`, 'POST', {});
  assert.equal(pushed.status, 200, JSON.stringify(pushed.json));
  assert.equal(pushed.json.remote.pushed, true);
  const pulled = await api(`${p}/pull`, 'POST', {});
  assert.equal(pulled.status, 200);
  assert.ok(!(await readFile(join(root, '.git', 'config'), 'utf8')).includes(TOKEN));

  // A remote session (the tunnel) reads the history line; every action is refused before it runs.
  const projectId = made.json.project.id;
  let opened = 0;
  const remoteCall = async (step, method) => {
    let answer = null;
    try {
      const handled = await workspaceRoutes(
        new URL(`http://remote.test/api/v1/projects/${projectId}/workspace/git/${step}`),
        method,
        {
          folders: { list: () => [{ path: root, kind: 'project', addedAt: '' }] },
          project: () => ({}),
          isProject: (id) => id === projectId,
          dataDirectory: undefined,
          send: (status, value) => (answer = { status, value }),
          history: {
            body: async () => ({ message: '원격 저장점', name: 'remote-made' }),
            remote: true,
            github: async () => ({ api: fake.base, token: TOKEN }),
            launch: () => opened++,
          },
        },
      );
      assert.equal(handled, true, step);
    } catch (error) {
      answer = { code: error.code };
    }
    return answer;
  };
  const before = git(root, 'rev-parse', 'HEAD').trim();
  const seen = await remoteCall('status', 'GET');
  assert.equal(seen.status, 200);
  assert.equal(seen.value.repository, true);
  await writeFile(join(root, 'remote.md'), '원격\n');
  for (const step of ['commit', 'remote', 'push', 'pull', 'open'])
    assert.equal((await remoteCall(step, 'POST')).code, 'FORBIDDEN', step);
  assert.equal(opened, 0, 'no folder opened');
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), before, 'nothing committed');
  assert.equal(fake.repos.size, 1, 'no repository made');
});

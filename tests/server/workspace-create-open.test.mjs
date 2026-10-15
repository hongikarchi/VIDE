// 작업 폴더 만들기·열기 (PLAN-52 T-308, T-314; SPEC-01.13 7; ARCH-01 「작업 폴더(PLAN-52)」): [폴더로
// 만들기] makes the role tree, the manifest and the two guide files and registers the folder as the
// new project's first project folder (optionally a local git repository with a first commit);
// [폴더 열기] after the project's data is deleted makes it again with the same id and the same role
// paths and asks for 자료 정리. A real engine on a temporary data folder; synthetic folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

async function engine(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-workspace-create-'));
  const data = join(directory, 'data');
  await mkdir(data);
  let planCalls = 0;
  const app = await startServer({
    filename: join(data, 'store.sqlite'),
    // 자료 정리 is asked for but never runs a CLI here: no AI plan means AI_NOT_SIGNED_IN.
    collectOptions: {
      plan: async () => {
        planCalls++;
        return null;
      },
      dwgReader: null,
    },
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
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  return { directory, api, planCalls: () => planCalls };
}

test('create → delete the project → open: same id, same role paths, 자료 정리 asked', async (t) => {
  const { directory, api, planCalls } = await engine(t);
  const git = (await api('/workspace/git')).json;
  assert.equal(typeof git.available, 'boolean');

  const root = join(directory, '2601 논현 시험');
  await mkdir(root);
  const empty = (await api('/workspace/inspect', 'POST', { dir: root })).json;
  assert.equal(empty.state, 'none');
  assert.equal(empty.empty, true);
  assert.equal(empty.name, '2601 논현 시험');

  // The person renamed one folder and left 검토본 out.
  const made = await api('/workspace/create', 'POST', {
    dir: root,
    name: '논현 시험',
    folders: { references: '08_참고', snapshots: null },
    git: git.available,
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const id = made.json.project.id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(made.json.project.name, '논현 시험');
  for (const name of [
    '01_운영',
    '02_자료',
    '03_모델',
    '04_도면',
    '05_검토',
    '06_산출물',
    '08_참고',
    '09_도구',
    '10_아카이브',
  ])
    assert.ok(await exists(join(root, name)), name);
  assert.equal(await exists(join(root, '07_검토본')), false);
  assert.equal(await exists(join(root, '08_레퍼런스')), false);
  const cfg = JSON.parse(await readFile(join(root, 'project.config.json'), 'utf8'));
  assert.equal(cfg.schema, 'vide-workspace/1');
  assert.equal(cfg.vide.projectId, id);
  assert.equal(cfg.title, '논현 시험');
  assert.deepEqual(cfg.template, { name: 'vide-default', version: 1 });
  assert.equal(cfg.paths.snapshots, undefined);
  assert.equal(cfg.paths.references, '08_참고');
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  for (const text of [readme, agents]) {
    assert.match(text, /<!-- vide:start -->[\s\S]*`08_참고`[\s\S]*<!-- vide:end -->/);
    assert.doesNotMatch(text, /07_검토본/);
  }

  // The folder is the project's first project folder (the AI's working folder).
  const listed = (await api(`/projects/${id}/folders`)).json.folders;
  assert.equal(listed[0].kind, 'project');
  assert.equal(listed[0].path, made.json.root);
  const ws = (await api(`/projects/${id}/workspace`)).json;
  assert.equal(ws.matched, true);
  assert.deepEqual(ws.paths, made.json.paths);
  assert.equal(Object.keys(ws.paths).length, 9);

  if (git.available) {
    assert.equal(made.json.git.state, 'committed', JSON.stringify(made.json.git));
    assert.ok(await exists(join(root, '.git')));
    const ignore = await readFile(join(root, '.gitignore'), 'utf8');
    for (const line of ['/02_자료/', '/06_산출물/', '/10_아카이브/', '*.3dm', '*.dwg', '*.pdf'])
      assert.ok(ignore.split('\n').includes(line), line);
    assert.ok(!ignore.split('\n').includes('/05_검토/'));
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    assert.deepEqual(tracked.sort(), [
      '.gitignore',
      'AGENTS.md',
      'README.md',
      'project.config.json',
    ]);
    assert.equal(cfg.git.mode, 'project-local');
  } else assert.equal(made.json.git.state, 'unavailable');

  // The same folder again is opened, not made twice.
  const again = await api('/workspace/create', 'POST', { dir: root });
  assert.deepEqual([again.status, again.json.code], [409, 'WORKSPACE_EXISTS']);

  // A person writes in AGENTS.md outside the VIDE part; it must survive.
  await writeFile(join(root, 'AGENTS.md'), '# 우리 규칙\n\n도면은 금요일에 묶는다.\n\n' + agents);

  // The project's data goes; the folder stays.
  assert.equal((await api(`/projects/${id}`, 'DELETE')).status, 200);
  assert.ok(!(await api('/projects')).json.some((row) => row.id === id));
  assert.ok(await exists(join(root, 'project.config.json')));

  const seen = (await api('/workspace/inspect', 'POST', { dir: root })).json;
  assert.equal(seen.state, 'config');
  assert.equal(seen.projectId, id);
  assert.equal(seen.here, null);
  assert.equal(seen.roles, 9);

  const opened = await api('/workspace/open', 'POST', { dir: root });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.project.id, id);
  assert.equal(opened.json.project.name, '논현 시험');
  assert.equal(opened.json.created, true);
  assert.deepEqual(opened.json.paths, made.json.paths);
  assert.equal(opened.json.collect.requested, true);
  assert.equal(opened.json.collect.error, 'AI_NOT_SIGNED_IN');
  assert.ok(planCalls() >= 1);
  assert.ok((await api('/projects')).json.some((row) => row.id === id));
  assert.equal((await api(`/projects/${id}/folders`)).json.folders[0].path, made.json.root);
  const kept = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.match(kept, /^# 우리 규칙\n\n도면은 금요일에 묶는다\./);
  assert.equal(kept.match(/<!-- vide:start -->/g).length, 1);

  // Opening it again on this PC opens the project that is here; nothing is collected again.
  const twice = (await api('/workspace/open', 'POST', { dir: root })).json;
  assert.deepEqual([twice.project.id, twice.created, twice.collect.requested], [id, false, false]);
  assert.equal((await api('/workspace/inspect', 'POST', { dir: root })).json.here.id, id);
});

test('refusals: another project’s folder, a broken manifest, a 규모검토 manifest, denied places', async (t) => {
  const { directory, api } = await engine(t);

  // A folder another project already has.
  const other = (await api('/projects', 'POST', { name: '다른 프로젝트' })).json;
  const taken = join(directory, '다른 폴더');
  await mkdir(taken);
  assert.equal((await api(`/projects/${other.id}/folders`, 'POST', { path: taken })).status, 200);
  const owned = (await api('/workspace/inspect', 'POST', { dir: taken })).json;
  assert.equal(owned.owner.name, '다른 프로젝트');
  const conflict = await api('/workspace/create', 'POST', { dir: taken });
  assert.deepEqual([conflict.status, conflict.json.code], [409, 'WORKSPACE_PROJECT_CONFLICT']);

  // A broken manifest: inspect says where, open and create refuse.
  const broken = join(directory, '깨진 폴더');
  await mkdir(broken);
  await writeFile(
    join(broken, 'project.config.json'),
    '{\n  "schema": "vide-workspace/1",\n  oops\n}',
  );
  const bad = (await api('/workspace/inspect', 'POST', { dir: broken })).json;
  assert.equal(bad.state, 'invalid');
  assert.equal(bad.line, 3);
  const refused = await api('/workspace/open', 'POST', { dir: broken });
  assert.deepEqual([refused.status, refused.json.code], [422, 'WORKSPACE_CONFIG_INVALID']);
  assert.equal(
    (await api('/workspace/create', 'POST', { dir: broken })).json.code,
    'WORKSPACE_CONFIG_INVALID',
  );

  // A folder without a manifest cannot be opened as one.
  const plain = join(directory, '그냥 폴더');
  await mkdir(plain);
  assert.equal((await api('/workspace/open', 'POST', { dir: plain })).json.code, 'NO_WORKSPACE');

  // A 규모검토 manifest: opened only when the person agreed to convert it; its fields stay.
  const review = join(directory, '논현동 7-3');
  await mkdir(review);
  const architecture = {
    schema: 'architecture-workspace/1',
    project_id: 'nonhyeon-7-3',
    title: '논현동 7-3',
    paths: { raw: '10_원본자료', rhino: '20_라이노', analysis: '30_분석', engine: '00_엔진' },
    authority: { model: '20_라이노/모델구성.json' },
    git: { mode: 'project-local', root: '.', branch: 'main', remote: null },
    extra: { keep: true },
  };
  await writeFile(join(review, 'project.config.json'), JSON.stringify(architecture));
  const asked = await api('/workspace/open', 'POST', { dir: review });
  assert.deepEqual([asked.status, asked.json.code], [409, 'WORKSPACE_PROMOTE_REQUIRED']);
  assert.equal(
    JSON.parse(await readFile(join(review, 'project.config.json'), 'utf8')).schema,
    'architecture-workspace/1',
  );
  const promoted = await api('/workspace/open', 'POST', { dir: review, promote: true });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.json));
  assert.equal(promoted.json.project.name, '논현동 7-3');
  const written = JSON.parse(await readFile(join(review, 'project.config.json'), 'utf8'));
  assert.equal(written.schema, 'vide-workspace/1');
  assert.equal(written.vide.projectId, promoted.json.project.id);
  assert.equal(written.project_id, 'nonhyeon-7-3');
  assert.deepEqual(written.authority, architecture.authority);
  assert.deepEqual(written.extra, { keep: true });
  assert.equal(written.paths.review, '30_분석');
  assert.equal(written.paths.engine, '00_엔진');
  // The original 규모검토 key stays for the tools that read the same file.
  assert.equal(written.paths.analysis, '30_분석');

  // Places a project folder can never be.
  const root = await api('/workspace/create', 'POST', { dir: 'C:\\' });
  assert.equal(root.json.code, 'FOLDER_NOT_ALLOWED');
  const missing = await api('/workspace/inspect', 'POST', { dir: join(directory, '없음') });
  assert.equal(missing.json.code, 'FOLDER_NOT_FOUND');
  const relative = await api('/workspace/create', 'POST', { dir: '상대 경로' });
  assert.equal(relative.json.code, 'INVALID_INPUT');
  // Folder names that leave the folder or repeat are refused before anything is written.
  const fresh = join(directory, '새 폴더');
  await mkdir(fresh);
  for (const folders of [{ ops: '..\\밖' }, { ops: '같은', raw: '같은' }, { nope: 'x' }])
    assert.equal(
      (await api('/workspace/create', 'POST', { dir: fresh, folders })).json.code,
      'INVALID_INPUT',
    );
  assert.equal(await exists(join(fresh, 'project.config.json')), false);
});

test('a 규모검토 folder already added to a project is converted as that project; others refuse before writing', async (t) => {
  const { directory, api } = await engine(t);
  const architecture = {
    schema: 'architecture-workspace/1',
    project_id: 'nonhyeon-7-3',
    title: '논현동 7-3',
    paths: { rhino: '20_라이노', analysis: '30_분석' },
  };
  const review = join(directory, '논현동 7-3');
  await mkdir(review);
  await writeFile(join(review, 'project.config.json'), JSON.stringify(architecture));
  const own = (await api('/projects', 'POST', { name: '논현동' })).json;
  assert.equal((await api(`/projects/${own.id}/folders`, 'POST', { path: review })).status, 200);

  // The folder is this project's own: not blocked, opened as that project.
  const seen = (await api('/workspace/inspect', 'POST', { dir: review })).json;
  assert.equal(seen.owner, null);
  assert.equal(seen.here.id, own.id);
  const opened = await api('/workspace/open', 'POST', { dir: review, promote: true });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.project.id, own.id);
  assert.equal(opened.json.created, false);
  const written = JSON.parse(await readFile(join(review, 'project.config.json'), 'utf8'));
  assert.equal(written.vide.projectId, own.id);
  const workspace = (await api(`/projects/${own.id}/workspace`)).json;
  assert.equal(workspace.matched, true);

  // Two projects hold the same 규모검토 folder: refused and the file is left as it was.
  const shared = join(directory, '공유 폴더');
  await mkdir(shared);
  const original = JSON.stringify(architecture);
  await writeFile(join(shared, 'project.config.json'), original);
  for (const name of ['가', '나']) {
    const project = (await api('/projects', 'POST', { name })).json;
    assert.equal(
      (await api(`/projects/${project.id}/folders`, 'POST', { path: shared })).status,
      200,
    );
  }
  const refused = await api('/workspace/open', 'POST', { dir: shared, promote: true });
  assert.deepEqual([refused.status, refused.json.code], [409, 'WORKSPACE_PROJECT_CONFLICT']);
  assert.equal(await readFile(join(shared, 'project.config.json'), 'utf8'), original);
});

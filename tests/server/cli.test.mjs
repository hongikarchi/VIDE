// `vide` CLI (PLAN-52 T-315, SPEC-01.13 10, ARCH-01 「작업 폴더(PLAN-52)」 CLI 진입점): arguments,
// `vide data` offline from the manifest, `jig list`/`jig run`/`export` against a real engine on a
// temporary data folder (launch.json → session), HUMAN_STEP_REQUIRED from a stubbed engine answer,
// ENGINE_UNAVAILABLE, and OUTSIDE_WORKSPACE refusals with nothing written. Synthetic folders only;
// no host, no installed engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startServer } from '../../src/server/server.ts';
import { parseArgs, parseInput } from '../../src/cli/args.ts';
import { runCli } from '../../src/cli/cli.ts';
import { launchTarget } from '../../src/cli/engine.ts';
import { reviewFolder, outputFolder, safeName } from '../../src/cli/workspace.ts';

const exec = promisify(execFile);

function io(cwd, env = {}, extra = {}) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: {
      cwd,
      env,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      ...extra,
    },
    text: () => out.join(''),
    json: () => JSON.parse(out.join('').trim().split('\n').pop()),
  };
}

async function workFolder(t, projectId, paths) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(directory, '2601 작업');
  await mkdir(join(root, '05_검토', '부지'), { recursive: true });
  await writeFile(join(root, '05_검토', '메모.md'), '# 메모\n');
  await writeFile(
    join(root, 'project.config.json'),
    JSON.stringify({
      schema: 'vide-workspace/1',
      title: '시험 작업',
      paths: paths ?? {
        ops: '01_운영',
        review: '05_검토',
        output: '06_산출물',
        archive: '../밖',
      },
      vide: { projectId, createdBy: 'user', createdAt: '2026-10-15T00:00:00.000Z' },
    }),
  );
  return { directory, root };
}

test('arguments: commands, --input values, --kind, usage errors', () => {
  assert.deepEqual(parseArgs(['jig', 'list', '--json']).command, { kind: 'jig-list' });
  const run = parseArgs(['jig', 'run', 'example-grid', '--input', 'spacingX=10', '-i', 'on=true']);
  assert.deepEqual(run.command, {
    kind: 'jig-run',
    jig: 'example-grid',
    inputs: [
      { key: 'spacingX', value: 10 },
      { key: 'on', value: true },
    ],
  });
  assert.deepEqual(parseInput('markPrefix=P'), { key: 'markPrefix', value: 'P' });
  assert.deepEqual(parseInput('note= 가 나 '), { key: 'note', value: '가 나' });
  assert.deepEqual(parseArgs(['data']).command, { kind: 'data' });
  assert.deepEqual(parseArgs(['data', 'review']).command, { kind: 'data', role: 'review' });
  assert.deepEqual(parseArgs(['export', 'grid', '--kind=report']).command, {
    kind: 'export',
    jig: 'grid',
    exportKind: 'report',
  });
  assert.equal(parseArgs(['export', 'grid']).command.exportKind, 'review');
  assert.equal(parseArgs([]).command.kind, 'help');
  assert.equal(parseArgs(['jig', 'list', '--data', 'D:\\x']).dataDir, 'D:\\x');
  for (const bad of [
    ['jig'],
    ['jig', 'run'],
    ['export'],
    ['export', 'a', '--kind', 'pdf'],
    ['jig', 'run', 'a', '--input', 'novalue'],
    ['zip'],
    ['jig', 'list', '--wat'],
  ])
    assert.throws(() => parseArgs(bad), { code: 'USAGE' }, bad.join(' '));
  assert.equal(launchTarget('http://127.0.0.1:47821/#' + 'a'.repeat(64)).token, 'a'.repeat(64));
  assert.equal(launchTarget('http://example.com:1/#' + 'a'.repeat(64)), null);
  assert.equal(safeName('a/b:c*', 'x'), 'a_b_c_');
  assert.equal(safeName(' .. ', 'x'), 'x');
  const at = new Date(2026, 9, 15, 9, 5);
  assert.equal(
    reviewFolder('C:\\w\\05', 'project/example-grid', at, '0123456789ab'),
    'C:\\w\\05\\example-grid\\2026-10-15-0905-01234567',
  );
  assert.equal(outputFolder('C:\\w\\06', '격자 / 요약', at), 'C:\\w\\06\\2026-10-15-격자 _ 요약');
});

test('vide data works offline from the manifest; outside roles and missing manifests refused', async (t) => {
  const { directory, root } = await workFolder(t, '00000000-0000-4000-8000-000000000001');
  const deep = join(root, '05_검토', '부지');
  const listing = io(deep);
  assert.equal(await runCli(['data', 'review'], listing.io), 0);
  assert.match(listing.text(), /05_검토\n {2}부지\\\n {2}메모\.md\n/);

  const all = io(deep);
  assert.equal(await runCli(['data', '--json'], all.io), 0);
  const roles = all.json();
  assert.equal(roles.root, root);
  assert.equal(roles.roles.find((r) => r.role === 'review').path, join(root, '05_검토'));
  assert.equal(roles.roles.find((r) => r.role === 'cad').path, null);
  assert.equal(roles.roles.find((r) => r.role === 'archive').outside, true);

  const missing = io(root);
  assert.equal(await runCli(['data', 'ops', '--json'], missing.io), 0);
  assert.deepEqual(
    { exists: missing.json().exists, entries: missing.json().entries },
    { exists: false, entries: [] },
  );

  const outside = io(root);
  assert.equal(await runCli(['data', 'archive'], outside.io), 1);
  assert.match(outside.err.join(''), /OUTSIDE_WORKSPACE/);
  const none = io(root);
  assert.equal(await runCli(['data', 'cad', '--json'], none.io), 1);
  assert.equal(none.json().code, 'WORKSPACE_ROLE_MISSING');

  const elsewhere = io(directory);
  assert.equal(await runCli(['data'], elsewhere.io), 1);
  assert.match(elsewhere.err.join(''), /\(NO_WORKSPACE\)/);

  // The real entry point (what bin\vide.cmd runs), offline.
  const { stdout } = await exec(
    process.execPath,
    [join(import.meta.dirname, '../../src/cli/vide.ts'), 'data', 'review', '--json'],
    { cwd: deep },
  );
  assert.equal(JSON.parse(stdout).path, join(root, '05_검토'));
});

test('jig list, jig run and export against a real engine; writes stay in the work folder', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-cli-engine-'));
  const data = join(directory, 'data');
  await mkdir(data);
  const app = await startServer({ filename: join(data, 'store.sqlite') });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
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
    return response.json();
  };
  const project = await api('/projects', 'POST', { name: 'CLI 시험' });
  const draft = await api(`/projects/${project.id}/jig-drafts`, 'POST', {
    name: 'cli grid',
    from: 'example-grid',
  });
  const pinned = await api(`/projects/${project.id}/jig-drafts/${draft.id}/pin`, 'POST', {
    confirm: true,
  });
  assert.ok(pinned.id, JSON.stringify(pinned));

  const { root } = await workFolder(t, project.id);
  // The work folder is the project's folder, so the engine keeps its own copies there too.
  await api(`/projects/${project.id}/folders`, 'POST', { path: root });
  const env = { VIDE_DATA_DIR: data };

  // No launch file yet, then a wrong token: ENGINE_UNAVAILABLE.
  const early = io(root, env);
  assert.equal(await runCli(['jig', 'list', '--json'], early.io), 1);
  assert.equal(early.json().code, 'ENGINE_UNAVAILABLE');
  await writeFile(
    join(data, 'launch.json'),
    JSON.stringify({ url: `${app.origin}/#${'0'.repeat(64)}` }),
  );
  const wrong = io(root, env);
  assert.equal(await runCli(['jig', 'list', '--json'], wrong.io), 1);
  assert.equal(wrong.json().code, 'ENGINE_UNAVAILABLE');
  await writeFile(join(data, 'launch.json'), JSON.stringify({ url: app.launchUrl }));

  const list = io(root, env);
  assert.equal(await runCli(['jig', 'list', '--json'], list.io), 0, list.err.join(''));
  const listed = list.json();
  assert.equal(listed.projectId, project.id);
  const grid = listed.jigs.find((j) => j.id === pinned.id);
  assert.equal(grid?.scope, 'project');
  const plain = io(root, env);
  assert.equal(await runCli(['jig', 'list'], plain.io), 0);
  assert.match(plain.text(), new RegExp(`${pinned.id}.*\\(이 프로젝트\\)`));

  // Run by the id's last part; a setting given with --input reaches the instance.
  const run = io(root, env);
  const code = await runCli(
    ['jig', 'run', pinned.id.split('/').pop(), '--input', 'spacingX=10', '--json'],
    run.io,
  );
  const result = run.json();
  // No outline was given, so the first step's input check stops the run (shown, exit 1).
  assert.equal(code, 1, JSON.stringify(result));
  assert.equal(result.code, 'JIG_RUN_FAILED');
  assert.ok(result.instanceId, JSON.stringify(result));
  assert.equal(result.jig.id, pinned.id);
  assert.ok(result.steps.some((s) => s.id === 'grid' && s.title === '격자 기둥 배치'));
  const view = await api(`/projects/${project.id}/jig-instances/${result.instanceId}`);
  assert.equal(view.params.find((p) => p.key === 'spacingX').value, 10);
  // A second run takes the same instance; --new opens another.
  const again = io(root, env);
  await runCli(['jig', 'run', pinned.id, '--json'], again.io);
  assert.equal(again.json().instanceId, result.instanceId);
  const fresh = io(root, env);
  await runCli(['jig', 'run', pinned.id, '--new', '--json'], fresh.io);
  assert.notEqual(fresh.json().instanceId, result.instanceId);
  const unknown = io(root, env);
  assert.equal(await runCli(['jig', 'run', 'nothing-here', '--json'], unknown.io), 1);
  assert.equal(unknown.json().code, 'JIG_NOT_FOUND');

  // Export: the latest instance's report into the review role, then a report into output.
  const review = io(root, env);
  assert.equal(await runCli(['export', pinned.id, '--json'], review.io), 0, review.err.join(''));
  const saved = review.json();
  // The engine's own 검토용 copy folder (same name rule): one folder per run, never two.
  assert.ok(saved.folder.startsWith(join(root, '05_검토', pinned.id.split('/').pop()) + '\\'));
  assert.ok(!(await readdir(join(root, '05_검토'))).includes(pinned.id.replace('/', '-')));
  assert.match(saved.folder, /\\\d{4}-\d{2}-\d{2}-\d{4}-[0-9a-f]{8}$/);
  const html = await readFile(join(saved.folder, 'report.html'), 'utf8');
  assert.match(html, /<html/i);
  assert.equal(
    JSON.parse(await readFile(join(saved.folder, 'data.json'), 'utf8')).vide.jigId,
    pinned.id,
  );
  // Exporting the same run again keeps that one folder.
  const twice = io(root, env);
  assert.equal(await runCli(['export', pinned.id, '--json'], twice.io), 0);
  assert.equal(twice.json().folder, saved.folder);
  assert.ok(!(await readdir(join(root, '05_검토'))).includes(pinned.id.replace('/', '-')));

  // 보고용 goes through the engine's [보고용 만들기] (PLAN-54 T-342): a run that is not final (its
  // first step stopped) is refused and nothing lands in the output role.
  const report = io(root, env);
  assert.equal(await runCli(['export', pinned.id, '--kind', 'report', '--json'], report.io), 1);
  assert.equal(report.json().code, 'REPORT_NOT_FINAL');
  assert.equal(existsSync(join(root, '06_산출물')), false);

  await api(`/projects/${project.id}/folders/remove`, 'POST', { path: root });
  // A 규모검토 manifest names no VIDE project: the project whose folder it is answers.
  await writeFile(
    join(root, 'project.config.json'),
    JSON.stringify({
      schema: 'architecture-workspace/1',
      project_id: '2601',
      paths: { analysis: '05_검토' },
    }),
  );
  const orphan = io(root, env);
  assert.equal(await runCli(['jig', 'list', '--json'], orphan.io), 1);
  assert.equal(orphan.json().code, 'PROJECT_NOT_FOUND');
  await api(`/projects/${project.id}/folders`, 'POST', { path: root });
  const found = io(join(root, '05_검토'), env);
  assert.equal(await runCli(['jig', 'list', '--json'], found.io), 0, found.out.join(''));
  assert.equal(found.json().projectId, project.id);

  // A review role that is a junction to a folder outside the tree: refused, nothing written.
  const away = join(directory, '밖의 폴더');
  await mkdir(away);
  await symlink(away, join(root, '07_링크'), 'junction');
  await writeFile(
    join(root, 'project.config.json'),
    JSON.stringify({
      schema: 'vide-workspace/1',
      paths: { review: '07_링크', output: '../밖' },
      vide: { projectId: project.id },
    }),
  );
  const refused = io(root, env);
  assert.equal(await runCli(['export', pinned.id, '--json'], refused.io), 1);
  assert.equal(refused.json().code, 'OUTSIDE_WORKSPACE');
  const refusedReport = io(root, env);
  assert.equal(await runCli(['export', pinned.id, '--kind', 'report'], refusedReport.io), 1);
  assert.match(refusedReport.err.join(''), /OUTSIDE_WORKSPACE|REPORT_NOT_FINAL/);
  assert.deepEqual(await readdir(away), []);
  assert.equal(existsSync(join(directory, '밖')), false);
});

test('a run stopping at a person step exits 3 with the question (stubbed engine answer)', async (t) => {
  const projectId = '00000000-0000-4000-8000-000000000002';
  const { directory, root } = await workFolder(t, projectId);
  const token = 'b'.repeat(64);
  await writeFile(
    join(directory, 'launch.json'),
    JSON.stringify({ url: `http://127.0.0.1:59999/#${token}` }),
  );
  const calls = [];
  const reply = (status, value, extra = {}) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json', ...extra },
    });
  const fakeFetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method, path, client: init.headers['X-VIDE-Client'] });
    if (path === '/api/v1/session')
      return JSON.parse(init.body).token === token
        ? reply(200, { authenticated: true }, { 'Set-Cookie': 'vide_session_59999=s; HttpOnly' })
        : reply(401, { code: 'UNAUTHORIZED' });
    const base = `/api/v1/projects/${projectId}`;
    if (path === `${base}/skills`)
      return reply(200, {
        skills: [{ id: 'project/check', name: '검토 jig', scope: 'project' }],
      });
    if (path === `${base}/jig-instances` && init.method === 'GET')
      return reply(200, { instances: [] });
    if (path === `${base}/jig-instances` && init.method === 'POST')
      return reply(200, { id: 'i1', jigId: 'project/check', updatedAt: '2026-10-15T00:00:00Z' });
    if (path === `${base}/jig-instances/i1/run`)
      return reply(200, {
        status: 'stale',
        steps: [
          { id: 'read', kind: 'code', status: 'done' },
          { id: 'ask', kind: 'human', status: 'waiting' },
          { id: 'after', kind: 'code', status: 'blocked' },
        ],
      });
    if (path === `${base}/jig-instances/i1`)
      return reply(200, {
        steps: [
          { id: 'read', title: '읽기', kind: 'code', status: 'done' },
          { id: 'ask', title: '대지 경계 확인', kind: 'human', status: 'waiting' },
          { id: 'after', title: '계산', kind: 'code', status: 'pending' },
        ],
      });
    return reply(404, { code: 'NOT_FOUND' });
  };
  const env = { VIDE_DATA_DIR: directory };
  const human = io(root, env, { fetch: fakeFetch });
  assert.equal(await runCli(['jig', 'run', 'check'], human.io), 3);
  assert.match(human.text(), /대지 경계 확인: 확인 대기/);
  assert.match(
    human.err.join(''),
    /대지 경계 확인.*VIDE 화면에서 이어 가세요.*HUMAN_STEP_REQUIRED/,
  );
  assert.ok(calls.filter((c) => c.path !== '/api/v1/session').every((c) => c.client === 'cli'));

  const asJson = io(root, env, { fetch: fakeFetch });
  assert.equal(await runCli(['jig', 'run', 'project/check', '--json'], asJson.io), 3);
  const answer = asJson.json();
  assert.equal(answer.code, 'HUMAN_STEP_REQUIRED');
  assert.deepEqual(answer.question, { stepId: 'ask', title: '대지 경계 확인' });

  // A project id the engine does not know.
  const gone = io(root, env, {
    fetch: async (url, init) =>
      new URL(url).pathname === '/api/v1/session'
        ? fakeFetch(url, init)
        : reply(404, { code: 'NOT_FOUND' }),
  });
  assert.equal(await runCli(['jig', 'list', '--json'], gone.io), 1);
  assert.equal(gone.json().code, 'PROJECT_NOT_FOUND');
  // The engine went away between calls.
  const down = io(root, env, {
    fetch: async (url, init) => {
      if (new URL(url).pathname === '/api/v1/session') return fakeFetch(url, init);
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(await runCli(['jig', 'list', '--json'], down.io), 1);
  assert.equal(down.json().code, 'ENGINE_UNAVAILABLE');
});

test('export --kind report asks the engine to make the 보고용 (stubbed engine answer)', async (t) => {
  const projectId = '00000000-0000-4000-8000-000000000003';
  const { directory, root } = await workFolder(t, projectId);
  const token = 'c'.repeat(64);
  await writeFile(
    join(directory, 'launch.json'),
    JSON.stringify({ url: `http://127.0.0.1:59998/#${token}` }),
  );
  const folder = join(root, '06_산출물', '2026-10-15-격자 보고서');
  const calls = [];
  const reply = (status, value, extra = {}) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json', ...extra },
    });
  let written = true;
  const fakeFetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method, path, body: init.body });
    if (path === '/api/v1/session')
      return reply(
        200,
        { authenticated: true },
        { 'Set-Cookie': 'vide_session_59998=s; HttpOnly' },
      );
    const base = `/api/v1/projects/${projectId}`;
    if (path === `${base}/skills`) return reply(200, { skills: [] });
    if (path === `${base}/jig-reports`)
      return reply(200, {
        instances: [
          {
            instance: {
              id: 'i1',
              jigId: 'project/grid',
              version: '0.1.0',
              title: '격자',
              status: 'done',
              updatedAt: '2026-10-15T00:00:00Z',
            },
            reports: [{ id: 'grid-summary', title: '격자 보고서' }],
          },
        ],
      });
    if (path === `${base}/jig-instances/i1/reports/grid-summary` && init.method === 'GET')
      return reply(200, {
        report: { id: 'grid-summary', title: '격자 보고서' },
        instance: {
          id: 'i1',
          title: '격자',
          jig: { id: 'project/grid', version: '0.1.0', name: '격자' },
        },
        model: { sections: [] },
        html: '<!doctype html>',
        copy: null,
      });
    if (path === `${base}/jig-instances/i1/reports/grid-summary/public` && init.method === 'POST')
      return reply(200, {
        name: '2026-10-15-격자 보고서',
        folder: written ? folder : null,
        written,
        ...(written ? {} : { reason: 'no-output-role' }),
        files: ['index.html', '01-보.csv', 'report.json'],
      });
    return reply(404, { code: 'NOT_FOUND' });
  };
  const env = { VIDE_DATA_DIR: directory };
  const made = io(root, env, { fetch: fakeFetch });
  assert.equal(await runCli(['export', 'grid', '--kind', 'report', '--json'], made.io), 0);
  const answer = made.json();
  assert.equal(answer.folder, folder);
  assert.deepEqual(answer.files, [
    join(folder, 'index.html'),
    join(folder, '01-보.csv'),
    join(folder, 'report.json'),
  ]);
  assert.ok(calls.some((c) => c.method === 'POST' && c.path.endsWith('/public')));
  // The CLI writes nothing itself.
  assert.equal(existsSync(join(root, '06_산출물')), false);

  written = false;
  const loose = io(root, env, { fetch: fakeFetch });
  assert.equal(await runCli(['export', 'grid', '--kind', 'report', '--json'], loose.io), 1);
  assert.equal(loose.json().code, 'OUTPUT_NOT_WRITTEN');
});

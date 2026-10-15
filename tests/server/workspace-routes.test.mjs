// 작업 폴더 routes (PLAN-52 T-307, ARCH-01 「작업 폴더(PLAN-52)」): GET …/workspace and
// …/workspace/paths answer from the manifest in the project's folders (NO_WORKSPACE without one,
// WORKSPACE_CONFIG_INVALID for a broken one), and GET /settings/workspace-template gives the
// effective template. A real engine on a temporary data folder; synthetic work folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { startServer } from '../../src/server/server.ts';

test('workspace routes: NO_WORKSPACE, the manifest resolved, broken manifest, template', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-workspace-routes-'));
  const data = join(directory, 'data');
  await mkdir(data);
  const app = await startServer({ filename: join(data, 'store.sqlite') });
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

  const project = (await api('/projects', 'POST', { name: '작업 폴더' })).json;
  const base = `/projects/${project.id}`;
  // No folder at all, then a folder without a manifest: NO_WORKSPACE.
  assert.deepEqual(
    [(await api(`${base}/workspace`)).status, (await api(`${base}/workspace`)).json.code],
    [404, 'NO_WORKSPACE'],
  );
  const root = join(directory, '2601 작업');
  await mkdir(root);
  assert.equal((await api(`${base}/folders`, 'POST', { path: root })).status, 200);
  assert.equal((await api(`${base}/workspace/paths`)).json.code, 'NO_WORKSPACE');

  await writeFile(
    join(root, 'project.config.json'),
    JSON.stringify({
      schema: 'vide-workspace/1',
      title: '작업 폴더',
      paths: { ops: '01_운영', review: '05_검토', archive: '../밖' },
      server: {
        root: '\\\\fileserver\\share\\PROJECTS\\2601',
        paths: { cad: '05 도면' },
        targets: {},
        checkout: { rhino: 'local', cad: 'server' },
      },
      template: { name: 'vide-default', version: 1 },
      vide: { projectId: project.id, createdBy: 'user', createdAt: '2026-10-15T00:00:00.000Z' },
    }),
  );
  const listed = (await api(`${base}/folders`)).json.folders;
  const stored = listed[0].path;
  const ws = await api(`${base}/workspace`);
  assert.equal(ws.status, 200);
  assert.equal(ws.json.hasWorkspace, true);
  assert.equal(ws.json.schema, 'vide-workspace/1');
  assert.equal(ws.json.matched, true);
  assert.equal(ws.json.projectId, project.id);
  assert.equal(ws.json.root, stored);
  assert.deepEqual(ws.json.paths, {
    ops: win32.resolve(stored, '01_운영'),
    review: win32.resolve(stored, '05_검토'),
  });
  assert.deepEqual(ws.json.outside, ['archive']);
  assert.equal(ws.json.server.paths.cad, '05 도면');
  assert.deepEqual(ws.json.template, { name: 'vide-default', version: 1 });
  const paths = await api(`${base}/workspace/paths`);
  assert.deepEqual(paths.json, { root: stored, paths: ws.json.paths });
  assert.equal((await api(`${base}/workspace`, 'POST', {})).status, 404);

  // A broken manifest is reported, not taken as "no work folder".
  await writeFile(join(root, 'project.config.json'), '{ broken');
  const broken = await api(`${base}/workspace`);
  assert.deepEqual([broken.status, broken.json.code], [422, 'WORKSPACE_CONFIG_INVALID']);

  // Another project's manifest here conflicts.
  const other = (await api('/projects', 'POST', { name: '다른 프로젝트' })).json;
  await writeFile(
    join(root, 'project.config.json'),
    JSON.stringify({ schema: 'vide-workspace/1', paths: {}, vide: { projectId: other.id } }),
  );
  const conflict = await api(`${base}/workspace`);
  assert.deepEqual([conflict.status, conflict.json.code], [409, 'WORKSPACE_PROJECT_CONFLICT']);

  // Unknown project.
  assert.equal((await api('/projects/00000000-0000-4000-8000-000000000000/workspace')).status, 404);

  // The template: default, then the data folder's file.
  const template = await api('/settings/workspace-template');
  assert.equal(template.status, 200);
  assert.equal(template.json.source, 'default');
  assert.equal(template.json.template.folders.rhino, '03_모델');
  await writeFile(
    join(data, 'workspace-template.json'),
    JSON.stringify({ name: '회사', version: 3, folders: { rhino: 'M_모델' } }),
  );
  const custom = (await api('/settings/workspace-template')).json;
  assert.deepEqual(
    [
      custom.source,
      custom.template.name,
      custom.template.folders.rhino,
      custom.template.folders.ops,
    ],
    ['file', '회사', 'M_모델', '01_운영'],
  );
});

// 보고서 두 등급 · [보고용 만들기] (PLAN-54 T-342·T-343 폴더 저장, SPEC-07.11 두 등급, ARCH-01 산출물
// 경로 `<output>/<YYYY-MM-DD>-<제목>/`): on a real engine with a temporary data folder, a computed
// 건축개요 instance (the synthetic 규모검토 chain, no host) answers its 검토용 report with the
// `public` choice; the 보고용 preview carries only the chosen sections and no internal marks;
// [보고용 만들기] writes `index.html`, a CSV per table and `report.json` into the output role
// (`-2` on the second making) or, with no work folder, keeps them in the data folder with
// `written: false`; the outputs list and file routes serve them; a result that is not final is
// refused with REPORT_NOT_FINAL; a remote session may look (list, preview) but never make one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { closeJigRuntime, jigRoutes, jigRuntimeFor } from '../../src/server/jig-routes.ts';
import { dayOf } from '../../src/core/workspace-paths.ts';
import { WorkspaceOutputs, listPublicReports } from '../../src/server/workspace-outputs.ts';
import { seedMassInstance } from '../fixtures/summary-chain.mjs';

async function session(app) {
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
  const call = async (path, method = 'GET', value) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: value ? JSON.stringify(value) : undefined,
    });
    const type = response.headers.get('content-type') ?? '';
    return {
      status: response.status,
      headers: response.headers,
      body: type.includes('json') ? await response.json() : await response.text(),
    };
  };
  return call;
}

/** A computed 건축개요 instance (its mass instance seeded through the runtime). */
async function seedSummary(runtime, projectId) {
  await seedMassInstance(runtime, projectId, '매스 A');
  const view = await runtime.createInstance(projectId, {
    jig: 'vide/building-summary',
    title: '개요 A',
    layerRoot: 'VIDE::개요',
  });
  const report = await runtime.run(projectId, view.id, { mode: 'confirmed' });
  assert.equal(
    report.steps.find((s) => s.id === 'check')?.status,
    'done',
    JSON.stringify(report.steps),
  );
  return view.id;
}

async function workFolder(t, projectId) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-public-ws-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(directory, '2601 작업');
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'project.config.json'),
    JSON.stringify({
      schema: 'vide-workspace/1',
      title: '시험 작업',
      paths: { review: '05_검토', output: '06_산출물' },
      vide: { projectId, createdBy: 'user', createdAt: '2026-10-15T00:00:00.000Z' },
    }),
  );
  return root;
}

test('보고용: preview, making into the output role (-2), data copy without a work folder, refusals', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-public-report-'));
  const app = await startServer({ filename: join(directory, 'store.sqlite') });
  const seeded = new Workspace(app.store);
  t.after(async () => {
    await closeJigRuntime(seeded);
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const api = await session(app);
  const project = (await api('/projects', 'POST', { name: '보고용 시험' })).body;
  const runtime = jigRuntimeFor(seeded, directory);
  const instanceId = await seedSummary(runtime, project.id);
  const base = `/projects/${project.id}/jig-instances/${instanceId}/reports/summary`;

  // 검토용 (default): unchanged shape plus the 보고용 choice.
  const review = await api(base);
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.match(review.body.html, /VIDE에서 열기/);
  assert.equal(review.body.copy, null);
  const choice = review.body.public;
  assert.equal(choice.allowed, true, JSON.stringify(choice));
  assert.deepEqual(
    choice.sections.filter((s) => s.public).map((s) => s.id),
    ['overview', 'floors', 'check'],
  );
  assert.ok(choice.sections.some((s) => s.id === 'sources' && !s.public));
  assert.equal(choice.sourceRun.instanceId, instanceId);
  assert.match(choice.sourceRun.revision, /^[0-9a-f]{12}$/);
  assert.equal(choice.defaultTitle, '건축개요 보고서');
  assert.equal(choice.workFolder, null);

  // 보고용 preview: the chosen sections only, numbered again, no ids, no open line.
  const preview = await api(`${base}?tier=public&sections=floors`);
  assert.equal(preview.status, 200);
  const html = preview.body.html;
  assert.equal((html.match(/<section/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<section id=|VIDE에서 열기|\[S\d|<button|<script/);
  assert.match(html, /검토용 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 회차에서 만듦/);
  const page = await api(`${base}?tier=public&as=html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal((page.body.match(/<section/g) ?? []).length, 3);

  // No work folder: kept in the data folder only.
  const loose = await api(`${base}/public`, 'POST', { title: '개요 보고' });
  assert.equal(loose.status, 200, JSON.stringify(loose.body));
  assert.equal(loose.body.written, false);
  assert.equal(loose.body.folder, null);
  assert.equal(loose.body.reason, 'no-workspace');
  assert.equal(loose.body.name, `${dayOf(new Date())}-개요 보고`);
  assert.ok(loose.body.files.includes('index.html'));
  assert.ok(loose.body.files.includes('report.json'));
  const csvs = loose.body.files.filter((f) => f.endsWith('.csv'));
  assert.ok(csvs.length >= 1, JSON.stringify(loose.body.files));
  const listed = await api(`/projects/${project.id}/outputs`);
  assert.equal(listed.body.outputs.length, 1);
  assert.equal(listed.body.outputs[0].title, '개요 보고');
  assert.equal(listed.body.outputs[0].folder, null);
  assert.equal(listed.body.outputs[0].sourceRun.instanceId, instanceId);
  assert.ok(!listed.body.outputs[0].files.includes('vide.json'));
  const file = await api(
    `/projects/${project.id}/outputs/${encodeURIComponent(loose.body.name)}/files/index.html?download`,
  );
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /attachment/);
  assert.match(file.body, /vide-copy:public-report:/);
  const csv = await api(
    `/projects/${project.id}/outputs/${encodeURIComponent(loose.body.name)}/files/${encodeURIComponent(csvs[0])}`,
  );
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.body.startsWith('﻿') || csv.body.length > 0);
  for (const bad of ['..%2Fstore.sqlite', 'vide.json', 'nothing.html']) {
    const refused = await api(
      `/projects/${project.id}/outputs/${encodeURIComponent(loose.body.name)}/files/${bad}`,
    );
    assert.equal(refused.status, 404, bad);
  }

  // With a work folder: `<output>/<날짜>-<제목>/`, then `-2`.
  const root = await workFolder(t, project.id);
  assert.equal((await api(`/projects/${project.id}/folders`, 'POST', { path: root })).status, 200);
  const made = await api(`${base}/public`, 'POST', { title: '개요 보고', sections: ['floors'] });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.written, true);
  assert.equal(made.body.name, `${dayOf(new Date())}-개요 보고-2`);
  assert.equal(made.body.folder, join(root, '06_산출물', made.body.name));
  const meta = JSON.parse(await readFile(join(made.body.folder, 'report.json'), 'utf8'));
  assert.deepEqual(meta.sections, ['floors']);
  assert.deepEqual(meta.scenes, []);
  assert.equal(meta.sourceRun.instanceId, instanceId);
  assert.equal(meta.sourceRun.reportId, 'summary');
  assert.ok(meta.madeAt && meta.sourceRun.revision);
  const written = await readFile(join(made.body.folder, 'index.html'), 'utf8');
  assert.match(written, /^<!doctype html>\n<!-- VIDE 사본/i);
  assert.doesNotMatch(written, /VIDE에서 열기|\[S\d/);
  assert.ok((await readdir(made.body.folder)).some((f) => f.endsWith('.csv')));
  const again = await api(`${base}/public`, 'POST', { title: '개요 보고' });
  assert.equal(again.body.name, `${dayOf(new Date())}-개요 보고-3`);
  const rows = (await api(`/projects/${project.id}/outputs`)).body.outputs;
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.name === made.body.name).folder, made.body.folder);

  // Unknown sections only: nothing to make.
  const empty = await api(`${base}/public`, 'POST', { sections: ['nothing'] });
  assert.equal(empty.status, 422);
  assert.equal(empty.body.code ?? empty.body.error?.code, 'REPORT_SECTIONS_EMPTY');

  // Not final: a fresh instance (not computed) is refused, nothing written.
  const fresh = await runtime.createInstance(project.id, {
    jig: 'vide/building-summary',
    title: '개요 B',
    layerRoot: 'VIDE::개요',
  });
  const freshBase = `/projects/${project.id}/jig-instances/${fresh.id}/reports/summary`;
  const notYet = await api(freshBase);
  assert.equal(notYet.body.public.allowed, false);
  assert.match(notYet.body.public.reason, /계산/);
  const refused = await api(`${freshBase}/public`, 'POST', {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code ?? refused.body.error?.code, 'REPORT_NOT_FINAL');
  assert.equal((await api(`/projects/${project.id}/outputs`)).body.outputs.length, 3);

  // A remote session (the tunnel): it may look at the list and the preview, never make one.
  const remoteCall = async (path, method = 'GET', value = {}) => {
    let answer = null;
    try {
      const handled = await jigRoutes(
        new URL('http://remote.test/api/v1' + path),
        { method },
        {
          workspace: seeded,
          body: async () => value,
          send: (status, data) => (answer = { status, data }),
          dataDirectory: directory,
          remote: true,
        },
      );
      assert.equal(handled, true, path);
    } catch (error) {
      answer = { code: error.code };
    }
    return answer;
  };
  const remoteList = await remoteCall(`/projects/${project.id}/outputs`);
  assert.equal(remoteList.status, 200);
  assert.equal(remoteList.data.outputs.length, 3);
  assert.equal((await remoteCall(`${base}?tier=public`)).status, 200);
  assert.equal((await remoteCall(`${base}/public`, 'POST', { title: '원격' })).code, 'FORBIDDEN');
  assert.equal((await api(`/projects/${project.id}/outputs`)).body.outputs.length, 3);
});

test('writePublicReport: output role missing or outside the tree keeps the data copy only', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-public-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const projectId = '00000000-0000-4000-8000-0000000000a1';
  const root = join(directory, 'ws');
  await mkdir(root);
  const config = (paths) =>
    writeFile(
      join(root, 'project.config.json'),
      JSON.stringify({ schema: 'vide-workspace/1', paths, vide: { projectId } }),
    );
  const outputs = new WorkspaceOutputs({
    folders: { list: () => [{ path: root, kind: 'project', addedAt: '' }] },
    isProject: () => true,
    now: () => new Date(2026, 9, 15, 14, 20),
  });
  const files = {
    title: '보고/서:1',
    html: '<!doctype html><html><body>보고</body></html>',
    csvs: [{ name: '01-표.csv', text: '﻿a,b\r\n' }],
    reportJson: { title: '보고/서:1', sections: ['a'], scenes: [], madeAt: 'x' },
  };
  await config({ review: '05_검토' });
  const noRole = await outputs.writePublicReport(projectId, files, directory);
  assert.equal(noRole.written, false);
  assert.equal(noRole.reason, 'no-output-role');
  assert.equal(noRole.name, '2026-10-15-보고_서_1');
  assert.ok(existsSync(join(noRole.kept, '01-표.csv')));

  await config({ output: '../밖' });
  const outside = await outputs.writePublicReport(projectId, files, directory);
  assert.equal(outside.written, false);
  assert.equal(outside.name, '2026-10-15-보고_서_1-2');
  assert.equal(existsSync(join(directory, '밖')), false);

  await config({ output: '06_산출물' });
  const inside = await outputs.writePublicReport(projectId, files, directory);
  assert.equal(inside.written, true);
  assert.equal(inside.folder, join(root, '06_산출물', '2026-10-15-보고_서_1-3'));
  assert.deepEqual((await readdir(inside.folder)).sort(), [
    '01-표.csv',
    'index.html',
    'report.json',
  ]);
  const rows = await listPublicReports(directory, projectId);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.folder).length, 1);

  await assert.rejects(
    outputs.writePublicReport(
      projectId,
      { ...files, csvs: [{ name: '../x.csv', text: '' }] },
      directory,
    ),
    /INVALID_REQUEST/,
  );
});

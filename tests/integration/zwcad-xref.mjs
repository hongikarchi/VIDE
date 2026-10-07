// 도면 관계 with the real ZWCAD 2023 (SPEC-01.11 11, H-ZWCAD-12, PLAN-43 T-200). Skipped when ZWCAD
// 2023 or the built worker is missing. A hidden ZWCAD that this test starts writes SYNTHETIC
// drawings (VIDEXREFFIXTURE) into a new folder under .vide/; the engine then reads their copies
// ([다시 읽기]) and shows the parent in the model ([모델에 반영]) with hidden ZWCADs it starts and
// stops itself. No user drawing is opened; the user's own ZWCAD is never touched.
// Run: node tests/integration/zwcad-xref.mjs
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { writeXrefFixture, zwcadXrefReader } from '../../hosts/zwcad/xref-dwg.ts';
import { runDirectory } from './run-directory.mjs';

const reader = zwcadXrefReader();
if (!(await reader.available())) {
  console.log(JSON.stringify({ skipped: 'ZWCAD 2023 or the built worker is not available' }));
  process.exit(0);
}
const run = runDirectory('zwcad-xref');
const folder = join(run, 'drawings');
await mkdir(folder, { recursive: true });
const started = Date.now();
await writeXrefFixture(folder);
const fixtureMs = Date.now() - started;
const before = await readFile(join(folder, 'parent.dwg'));
const app = await startServer({ filename: join(run, 'data', 'vide.sqlite'), xrefReader: reader });
try {
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
  const api = async (path, method = 'GET', data) =>
    (
      await fetch(app.origin + '/api/v1' + path, {
        method,
        headers,
        body: data ? JSON.stringify(data) : undefined,
      })
    ).json();
  const settle = async (path) => {
    for (let i = 0; i < 1200; i++) {
      const state = await api(path);
      if (!['reading', 'applying'].includes(state.state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw Error('xref job did not end');
  };
  const project = await api('/projects', 'POST', { name: '도면 관계 실호스트' });
  await api(`/projects/${project.id}/folders`, 'POST', { path: folder });
  const base = `/projects/${project.id}/xref`;
  let at = Date.now();
  await api(`${base}/read`, 'POST', {});
  const read = await settle(base);
  const readMs = Date.now() - at;
  assert.equal(read.state, 'done', JSON.stringify(read));
  const parent = read.roots.find((root) => root.name === 'parent.dwg');
  assert.ok(parent, JSON.stringify({ ...read, readMs }));
  const byName = Object.fromEntries(parent.children.map((child) => [child.name, child]));
  assert.equal(byName['child.dwg'].how, 'absolute');
  assert.equal(byName['grand.dwg'].how, 'relative');
  assert.equal(byName['grand.dwg'].overlay, true);
  assert.equal(byName['missing.dwg'].missing, true);
  const loop = read.roots.find((root) => root.name.startsWith('loop-'));
  assert.ok(loop?.children[0]?.children[0]?.cycle, JSON.stringify(read.roots));

  at = Date.now();
  await api(`${base}/apply`, 'POST', { root: parent.path });
  const applied = await settle(base);
  const applyMs = Date.now() - at;
  assert.equal(applied.state, 'done', JSON.stringify(applied));
  assert.deepEqual(applied.applied.failed, []);
  const links = await api(`/projects/${project.id}/links`);
  const child = links.find((link) => link.name === 'child.dwg');
  assert.ok(child?.placement && child.lastSync, JSON.stringify(links));
  // child at (1000, 0) mm rotated 90° scale 2: its (0.5 m, 0) lands at (1 m, 1 m).
  const m = child.placement;
  const x = m[0] * 0.5 + m[3],
    y = m[4] * 0.5 + m[7];
  assert.ok(Math.abs(x - 1) < 1e-6 && Math.abs(y - 1) < 1e-6, JSON.stringify(m));
  assert.deepEqual(await readFile(join(folder, 'parent.dwg')), before);
  console.log(
    JSON.stringify({
      passed: true,
      fixtureMs,
      readMs,
      applyMs,
      links: links.map((link) => [link.name, !!link.placement]),
      evidence: run,
    }),
  );
} finally {
  await app.close();
}

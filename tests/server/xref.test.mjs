// 도면 관계 over HTTP (SPEC-01.11 11, PLAN-43 T-200): no folder or no ZWCAD is refused; [다시 읽기]
// lists the folders' drawings and reads them (only changed ones the next time); the tree; [모델에
// 반영] links the root and the drawings it shows, each with one display Sync and its placement in
// the links list; a second [모델에 반영] reads nothing again. Synthetic drawings and a fake reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { fakeXrefReader, writeSyntheticDrawings } from '../fixtures/xref.mjs';

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
  return async (path, method = 'GET', data) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
}
const settle = async (api, path) => {
  for (let i = 0; i < 200; i++) {
    const state = (await api(path)).json;
    if (!['reading', 'applying'].includes(state.state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error('xref job did not end');
};

test('read the xref relations of the project folders and show a root in the model', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-xref-http-'));
  const folder = join(directory, '합성 도면');
  await mkdir(folder);
  await writeSyntheticDrawings(folder);
  const before = await readFile(join(folder, 'parent.dwg'));
  const reader = fakeXrefReader();
  const app = await startServer({
    filename: join(directory, 'data', 'store.sqlite'),
    xrefReader: reader,
  });
  const none = await startServer({
    filename: join(directory, 'data2', 'store.sqlite'),
    xrefReader: null,
  });
  t.after(async () => {
    await app.close();
    await none.close();
    await rm(directory, { recursive: true, force: true });
  });
  const api = await session(app);
  const project = (await api('/projects', 'POST', { name: '도면 관계' })).json;
  const base = `/projects/${project.id}/xref`;
  assert.equal((await api(base)).json.state, 'idle');
  // No project folder.
  const empty = await api(`${base}/read`, 'POST', {});
  assert.deepEqual([empty.status, empty.json.code], [409, 'NO_PROJECT_FOLDER']);
  assert.equal(
    (await api(`/projects/${project.id}/folders`, 'POST', { path: folder })).status,
    200,
  );
  // No ZWCAD at another engine.
  const other = await session(none);
  const otherProject = (await other('/projects', 'POST', { name: 'x' })).json;
  await other(`/projects/${otherProject.id}/folders`, 'POST', { path: folder });
  const noZwcad = await other(`/projects/${otherProject.id}/xref/read`, 'POST', {});
  assert.deepEqual([noZwcad.status, noZwcad.json.code], [409, 'NO_ZWCAD']);

  assert.equal((await api(`${base}/read`, 'POST', {})).status, 200);
  const read = await settle(api, base);
  assert.equal(read.state, 'done');
  assert.ok(read.readAt);
  assert.deepEqual(reader.calls.graph, [8]);
  assert.deepEqual(
    read.roots.map((root) => root.name),
    ['loop-a.dwg', 'parent.dwg'],
  );
  assert.equal(read.standalone, 1);
  const parent = read.roots[1];
  assert.deepEqual(
    parent.children.map((child) => [
      child.name,
      child.how,
      child.missing,
      child.duplicate,
      child.overlay,
      child.inserts.model,
    ]),
    [
      ['child.dwg', 'absolute', false, false, false, 2],
      ['child.dwg', 'absolute', false, true, false, 1],
      ['grand.dwg', 'relative', false, false, true, 1],
      ['beam.dwg', 'folder', false, false, false, 1],
      ['missing.dwg', null, true, false, false, 0],
    ],
  );
  assert.equal(parent.children[0].children[0].name, 'nested.dwg');
  assert.equal(parent.children[3].stored, 'D:\\예전 PC\\도면\\beam.dwg');
  const loop = read.roots[0];
  assert.equal(loop.children[0].children[0].cycle, true);
  // Nothing changed: [다시 읽기] reads no drawing again.
  await api(`${base}/read`, 'POST', {});
  await settle(api, base);
  assert.deepEqual(reader.calls.graph, [8]);
  const alone = {
    units: 4,
    scale: 0.001,
    unitsAssumed: false,
    error: null,
    xrefs: [],
    inserts: [],
  };
  await writeFile(join(folder, 'alone.dwg'), 'AC1032' + JSON.stringify(alone) + ' ');
  await api(`${base}/read`, 'POST', {});
  await settle(api, base);
  assert.deepEqual(reader.calls.graph, [8, 1]);

  // [모델에 반영]: parent, child and its nested.dwg, grand, beam.
  const missingRoot = await api(`${base}/apply`, 'POST', { root: join(folder, 'nowhere.dwg') });
  assert.deepEqual([missingRoot.status, missingRoot.json.code], [404, 'NOT_FOUND']);
  assert.equal(
    (await api(`${base}/apply`, 'POST', { root: join(folder, 'parent.dwg') })).status,
    200,
  );
  const applied = await settle(api, base);
  assert.deepEqual(applied.applied, {
    root: join(folder, 'parent.dwg'),
    links: 5,
    read: 5,
    failed: [],
  });
  const links = (await api(`/projects/${project.id}/links`)).json;
  assert.deepEqual(
    links.map((link) => [link.name, link.kind, link.hidden, !!link.placement, !!link.lastSync]),
    [
      ['parent.dwg', 'file', false, false, true],
      ['child.dwg', 'file', false, true, true],
      ['nested.dwg', 'file', false, true, true],
      ['grand.dwg', 'file', false, true, true],
      ['beam.dwg', 'file', false, true, true],
    ],
  );
  const child = links[1];
  assert.equal(child.path, join(folder, 'child.dwg'));
  // child: (1000, 0) mm rotated 90° scale 2 → its (0.5 m, 0) lands at (1 m, 1 m).
  const m = child.placement;
  assert.ok(Math.abs(m[0] * 0.5 + m[3] - 1) < 1e-9 && Math.abs(m[4] * 0.5 + m[7] - 1) < 1e-9);
  const requestPath = `/projects/${project.id}/requests/${child.lastSync.requestId}`;
  const sync = (await api(`${requestPath}?view=summary`)).json;
  assert.equal(sync.state, 'succeeded');
  assert.equal(sync.input.linkId, child.id);
  assert.equal(sync.result.displayOnly, true);
  assert.equal(JSON.stringify((await api(`${requestPath}/objects`)).json).includes('cad-1'), true);
  // Again: same files, nothing read, no new Sync.
  await api(`${base}/apply`, 'POST', { root: join(folder, 'parent.dwg') });
  const again = await settle(api, base);
  assert.equal(again.applied.read, 0);
  assert.deepEqual(reader.calls.display, [5]);
  assert.equal((await api(`/projects/${project.id}/links`)).json.length, 5);
  // The originals are never written.
  assert.deepEqual(await readFile(join(folder, 'parent.dwg')), before);
});

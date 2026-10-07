// 역반영 차이 계산 over HTTP (SPEC-14.10, PLAN-47 T-232): a root read by T-227 with its layer table;
// [짝 기록] turns Sync jig matched rows into a baseline; the diff lists rows against it; a drawing
// changed while computing leaves the diff unsettled; no reader → NO_ZWCAD. Synthetic drawings and
// fake readers only; drawings keep their hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';

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
const inspection = {
  error: null,
  version: 'AC1032',
  units: 4,
  layers: [{ name: '0' }, { name: 'A-WALL' }],
  linetypes: [],
  textStyles: [],
  dimStyles: [],
  blocks: [],
  xrefs: [],
};
const inspector = {
  async available() {
    return true;
  },
  async inspect(files, work, progress) {
    progress(files.length);
    return new Map(files.map((file) => [file.id, { ...inspection, id: file.id }]));
  },
};
const P = (x, y) => [x, y, 0];
const line = (a, b) => ({ kind: 'line', points: [P(...a), P(...b)] });
const sha = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

test('backflow rows from confirmed pairs, unsettled when the drawing changes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-backflow-'));
  const folder = join(directory, '합성 도면');
  await mkdir(folder, { recursive: true });
  const root = join(folder, '평면.dwg');
  await writeFile(root, 'AC1032 synthetic');
  const hash = await sha(root);
  const state = {
    source: [{ id: 'S1', layer: '건축::벽', type: 'line', geometry: line([0, 0], [1, 0]) }],
    touch: false,
  };
  const reader = {
    async available() {
      return true;
    },
    async source(projectId, linkId) {
      return { linkId, revision: 'r' + state.source.length, objects: state.source };
    },
    async drawings(projectId, paths) {
      if (state.touch) await utimes(root, new Date(), new Date(Date.now() + 120_000));
      return new Map(
        paths.map((path) => [
          path,
          {
            path,
            units: 4,
            sha256: 'x',
            entities: [
              { handle: '1A', type: 'line', layer: 'A-WALL', geometry: line([0, 0], [1000, 0]) },
            ],
          },
        ]),
      );
    },
  };
  const app = await startServer({
    filename: join(directory, 'data', 'store.sqlite'),
    drawingInspector: inspector,
    backflowReader: reader,
  });
  const bare = await startServer({
    filename: join(directory, 'data2', 'store.sqlite'),
    drawingInspector: inspector,
    backflowReader: null,
  });
  t.after(async () => {
    await app.close();
    await bare.close();
    await rm(directory, { recursive: true, force: true });
  });
  const api = await session(app);
  const project = (await api('/projects', 'POST', { name: '역반영' })).json;
  const base = `/projects/${project.id}/drawing`;
  await api(`/projects/${project.id}/folders`, 'POST', { path: folder });
  const relation = { rotation: 0, translation: [0, 0], dz: 0 };
  const diffBody = { root, link: 'L1', relation };
  const notRead = await api(`${base}/backflow`, 'POST', diffBody);
  assert.deepEqual([notRead.status, notRead.json.code], [409, 'DRAWING_NOT_READ']);
  await api(`${base}/layers/read`, 'POST', { paths: [root] });
  for (let i = 0; i < 100 && (await api(`${base}/layers`)).json.state === 'reading'; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  await api(`${base}/layers`, 'PUT', {
    path: root,
    sources: ['건축::벽'],
    chosen: { '건축::벽': 'A-WALL' },
  });

  // Confirm the Sync jig's matched row, then change the model.
  assert.deepEqual((await api(`${base}/backflow?path=${encodeURIComponent(root)}`)).json, {
    baseline: null,
  });
  const paired = await api(`${base}/backflow/pairs`, 'POST', {
    root,
    link: 'L1',
    pairs: [
      { sourceId: 'S1', path: root, handle: '1a' },
      { sourceId: 'S9', path: root, handle: '2B' },
    ],
  });
  assert.equal(paired.status, 200);
  assert.deepEqual(paired.json.files[0].refused, [
    { sourceId: 'S9', handle: '2B', reason: 'SOURCE_MISSING' },
  ]);
  const short = (await api(`${base}/backflow?path=${encodeURIComponent(root)}`)).json.baseline;
  assert.deepEqual([short.pairs, short.entities, short.revision], [1, 1, 1]);

  state.source = [
    { id: 'S1', layer: '건축::벽', type: 'line', geometry: line([0, 0.5], [1, 0.5]) },
    { id: 'S2', layer: '건축::벽', type: 'line', geometry: line([0, 2], [1, 2]) },
  ];
  const diff = await api(`${base}/backflow`, 'POST', diffBody);
  assert.equal(diff.status, 200, JSON.stringify(diff.json));
  assert.equal(diff.json.settled, true);
  assert.deepEqual(
    diff.json.rows.map((row) => [row.sourceId, row.kind, row.layer, row.handle]),
    [
      ['S1', 'modify', 'A-WALL', '1A'],
      ['S2', 'add', 'A-WALL', null],
    ],
  );
  assert.ok(diff.json.id);

  // The drawing changed during the computation: rows are not settled.
  state.touch = true;
  const stale = (await api(`${base}/backflow`, 'POST', diffBody)).json;
  assert.deepEqual([stale.settled, stale.changed], [false, [root]]);

  // Bad input, no reader.
  const badHandle = await api(`${base}/backflow/pairs`, 'POST', {
    root,
    link: 'L1',
    pairs: [{ sourceId: 'S1', path: root, handle: 'not hex' }],
  });
  assert.equal(badHandle.status, 400);
  const other = await session(bare);
  const p2 = (await other('/projects', 'POST', { name: 'x' })).json;
  await other(`/projects/${p2.id}/folders`, 'POST', { path: folder });
  await other(`/projects/${p2.id}/drawing/layers/read`, 'POST', { paths: [root] });
  for (
    let i = 0;
    i < 100 && (await other(`/projects/${p2.id}/drawing/layers`)).json.state === 'reading';
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  const none = await other(`/projects/${p2.id}/drawing/backflow`, 'POST', diffBody);
  assert.deepEqual([none.status, none.json.code], [409, 'NO_ZWCAD']);
  assert.equal(await sha(root), hash, 'the drawing is never written');
});

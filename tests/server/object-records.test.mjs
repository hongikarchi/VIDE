// '이 객체의 기록'과 부위 끊김 (PLAN-53 T-324·T-325, SPEC-17.5·17.7, ARCH-01 §5 「프로젝트 기록」):
// an object picked in a linked file reaches its three records (two through requests, one through
// its part's layer); the index is kept 15 s; a part whose layer was renamed shows that mapping as
// broken, a removed link and a missing jig instance too, and a file with no Sync is unknown. Both
// routes answer over HTTP. All sentences and names are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { Records } from '../../src/core/records.ts';
import { requestUndone } from '../../src/server/records-routes.ts';
import { objectRecordsOf } from '../../src/server/object-records.ts';
import { partsStatusOf } from '../../src/server/parts-status.ts';
import { startServer } from '../../src/server/server.ts';

const layer64 = (name) => Buffer.from(name, 'utf8').toString('base64');
const insert = (store, projectId, id, input, result, at = '2026-10-01T00:00:00.000Z') =>
  store
    .db(projectId)
    .prepare(
      'INSERT INTO workspace_requests(id,projectId,input,state,result,createdAt) VALUES(?,?,?,?,?,?)',
    )
    .run(id, projectId, JSON.stringify(input), 'succeeded', JSON.stringify(result), at);

const syncInput = (id, linkId, host = 'rhino') => ({
  id,
  provider: 'codex-cli',
  host,
  source: 'document',
  permission: 'candidate',
  body: 'sync',
  pins: [],
  sketches: [],
  files: [],
  linkId,
});
const syncResult = (scene) => ({
  host: 'rhino',
  hostExecuted: true,
  displayOnly: true,
  objects: [],
  scene,
});

/** Two linked files with one Sync each, a third with none; requests that changed objects. */
function seed(store, projectId) {
  const links = new DocumentLinks(store);
  const link = (name, documentId, host = 'rhino') =>
    links.link(projectId, {
      host,
      name,
      path: `C:/work/${name}`,
      instance: `1:${documentId}`,
      documentId,
    });
  const a = link('mass.3dm', 1);
  const b = link('plan.dwg', 2, 'zwcad');
  const closed = link('site.3dm', 3);
  insert(
    store,
    projectId,
    'sync-a',
    syncInput('sync-a', a.id),
    syncResult([
      { id: 'beam-7', type: 'line', length: 9, layer64: layer64('S-BEAM') },
      { id: 'wall-1', type: 'line', length: 6, layer64: layer64('A-WALL') },
    ]),
  );
  insert(
    store,
    projectId,
    'sync-b',
    syncInput('sync-b', b.id, 'zwcad'),
    syncResult([{ id: 'beam-7', type: 'line', length: 3, layer64: layer64('A-DOOR') }]),
  );
  const run = (id, linkId, changes, state = 'applied', at) =>
    insert(
      store,
      projectId,
      id,
      { id, source: 'prompt', body: '보를 늘려 주세요' },
      {
        executions: [
          {
            executionId: `${id}-x`,
            host: 'rhino',
            state,
            file: { linkId, name: 'f' },
            changes: { added: [], removed: [], ...changes },
          },
        ],
      },
      at,
    );
  run('req-extend', a.id, { changed: [{ nativeId: 'beam-7', layer: 'S-BEAM' }] });
  run('req-undone', a.id, { changed: [{ nativeId: 'beam-7', layer: 'S-BEAM' }] }, 'undone');
  // Same id in the other file: never reaches file A's beam.
  run('req-door', b.id, { changed: [{ nativeId: 'beam-7', layer: 'A-DOOR' }] });
  return { a, b, closed };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-object-records-'));
  const store = new Store(join(directory, 'data.sqlite'));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = store.createProject('객체 기록');
  const workspace = new Workspace(store);
  const records = new Records(store, { undoneResolver: requestUndone(store) });
  return { store, workspace, records, project, ...seed(store, project.id) };
}

test('an object picked in a file reaches its three records, by date', async (t) => {
  const { store, workspace, records, project, a, b } = await fixture(t);
  const beams = records.addPart(project.id, {
    name: '구조 보',
    mapping: [{ kind: 'layer', linkId: a.id, layer: 'S-BEAM' }],
  });
  const add = (input, options = {}) => records.add(project.id, input, { by: 'user', ...options });
  add({
    date: '2026-09-03',
    type: 'D',
    text: '보를 9m로 늘림',
    attachments: { requestId: 'req-extend' },
  });
  add({
    date: '2026-09-04',
    type: 'D',
    text: '보 길이를 다시 바꿈',
    attachments: { requestId: 'req-undone' },
  });
  add({ date: '2026-09-01', type: 'K', text: '구조 보는 기존 철골을 따름', parts: [beams.id] });
  add({
    date: '2026-09-02',
    type: 'D',
    text: '문 위치 조정',
    attachments: { requestId: 'req-door' },
  });
  add({ date: '2026-09-05', type: 'R', text: '관계 없는 요청' });
  const of = objectRecordsOf({ store, workspace, records });
  const answer = await of(project.id, 'beam-7', a.id);
  assert.deepEqual(
    answer.records.map((row) => row.text),
    ['구조 보는 기존 철골을 따름', '보를 9m로 늘림', '보 길이를 다시 바꿈'],
  );
  assert.equal(answer.records[2].undone, true);
  assert.deepEqual(answer.via, { requestIds: ['req-extend', 'req-undone'], partIds: [beams.id] });
  // The other file's object with the same id reaches only its own request.
  const door = await of(project.id, 'beam-7', b.id);
  assert.deepEqual(
    door.records.map((row) => row.text),
    ['문 위치 조정'],
  );
});

test('the object index is kept 15 s per project', async (t) => {
  const { store, workspace, records, project, a } = await fixture(t);
  let now = 1_000_000;
  const of = objectRecordsOf({ store, workspace, records, now: () => now });
  assert.deepEqual((await of(project.id, 'wall-1', a.id)).via.requestIds, []);
  insert(
    store,
    project.id,
    'req-wall',
    { id: 'req-wall', source: 'prompt', linkId: a.id },
    { changes: { added: [], removed: [], modified: [{ id: 'wall-1', geometry: true }] } },
  );
  now += 14_000;
  assert.deepEqual((await of(project.id, 'wall-1', a.id)).via.requestIds, []);
  now += 2_000;
  assert.deepEqual((await of(project.id, 'wall-1', a.id)).via.requestIds, ['req-wall']);
});

test('parts status: a renamed layer, a removed link and a missing jig are broken; no Sync is unknown', async (t) => {
  const { store, workspace, records, project, a, closed } = await fixture(t);
  const part = records.addPart(project.id, {
    name: '벽과 기둥',
    mapping: [
      { kind: 'layer', linkId: a.id, layer: 'A-WALL' },
      { kind: 'layer', linkId: a.id, layer: 'S-COLUMN' },
    ],
  });
  const gone = records.addPart(project.id, {
    name: '지운 파일',
    mapping: [{ kind: 'layer', linkId: 'link-removed', layer: 'A-WALL' }],
  });
  const jig = records.addPart(project.id, {
    name: '구조 결과',
    mapping: [{ kind: 'jig-output', instanceId: 'no-such-instance', outputId: 'frame' }],
  });
  const later = records.addPart(project.id, {
    name: '대지',
    mapping: [{ kind: 'layer', linkId: closed.id, layer: 'C-SITE' }],
  });
  const status = partsStatusOf({ store, workspace, records });
  const byId = Object.fromEntries((await status(project.id)).parts.map((row) => [row.partId, row]));
  assert.deepEqual(byId[part.id], {
    partId: part.id,
    broken: [1],
    reasons: ['layer-missing'],
    reason: 'layer-missing',
  });
  assert.deepEqual(byId[gone.id].broken, [0]);
  assert.equal(byId[gone.id].reason, 'link-missing');
  assert.equal(byId[jig.id].reason, 'instance-missing');
  assert.deepEqual(byId[later.id], {
    partId: later.id,
    broken: [],
    reasons: [],
    unknown: true,
    unknownIndexes: [0],
  });
  // The layer renamed in a newer Sync: the mapping that reached it is now broken; renaming the
  // mapping (다시 잇기) clears it.
  insert(
    store,
    project.id,
    'sync-a2',
    syncInput('sync-a2', a.id),
    syncResult([{ id: 'wall-1', type: 'line', length: 6, layer64: layer64('A-WALL-EXT') }]),
  );
  const after = (await status(project.id)).parts.find((row) => row.partId === part.id);
  assert.deepEqual(after.broken, [0, 1]);
  records.setPart(project.id, part.id, {
    mapping: [{ kind: 'layer', linkId: a.id, layer: 'A-WALL-EXT' }],
  });
  const relinked = (await status(project.id)).parts.find((row) => row.partId === part.id);
  assert.deepEqual(relinked.broken, []);
});

test('20 parts over 60 layers: only the renamed layers break', async (t) => {
  const { store, workspace, records, project, a } = await fixture(t);
  const names = Array.from({ length: 60 }, (_, i) => `L-${String(i).padStart(2, '0')}`);
  insert(
    store,
    project.id,
    'sync-a60',
    syncInput('sync-a60', a.id),
    syncResult(
      names.map((name, i) => ({
        id: `o-${i}`,
        type: 'line',
        length: 1,
        layer64: layer64(i % 20 === 3 ? `${name}-NEW` : name),
      })),
    ),
  );
  const ids = [];
  for (let p = 0; p < 20; p++)
    ids[p] = records.addPart(project.id, {
      name: `부위 ${p}`,
      mapping: names
        .slice(p * 3, p * 3 + 3)
        .map((layer) => ({ kind: 'layer', linkId: a.id, layer })),
    }).id;
  const started = performance.now();
  const parts = (await partsStatusOf({ store, workspace, records })(project.id)).parts;
  const elapsed = performance.now() - started;
  assert.equal(parts.length, 20);
  // Layers 3, 23 and 43 were renamed: parts 1, 7 and 14 (three layers each) break at index 0, 2, 1.
  const broken = Object.fromEntries(parts.map((row) => [row.partId, row.broken]));
  assert.deepEqual(
    ids.map((id, p) => [p, broken[id]]).filter(([, list]) => list.length),
    [
      [1, [0]],
      [7, [2]],
      [14, [1]],
    ],
  );
  assert.ok(elapsed < 1000, `${elapsed} ms`);
});

test('over HTTP: parts/status and objects/:o/records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-object-records-http-'));
  const app = await startServer({ filename: join(directory, 'store.sqlite') });
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
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, json: await response.json() };
  };
  const project = (await api('/projects', 'POST', { name: '객체 기록 HTTP' })).json;
  const { a } = seed(app.store, project.id);
  const base = `/projects/${project.id}`;
  const part = (
    await api(`${base}/parts`, 'POST', {
      name: '구조 보',
      mapping: [
        { kind: 'layer', linkId: a.id, layer: 'S-BEAM' },
        { kind: 'layer', linkId: a.id, layer: 'S-OLD' },
      ],
    })
  ).json.part;
  for (const [date, text, extra] of [
    ['2026-09-03', '보를 9m로 늘림', { attachments: { requestId: 'req-extend' } }],
    ['2026-09-04', '보 길이를 다시 바꿈', { attachments: { requestId: 'req-undone' } }],
    ['2026-09-01', '구조 보는 기존 철골을 따름', { parts: [part.id] }],
  ])
    assert.equal(
      (await api(`${base}/records`, 'POST', { date, type: 'D', text, ...extra })).status,
      200,
    );
  const picked = await api(`${base}/objects/beam-7/records?linkId=${encodeURIComponent(a.id)}`);
  assert.equal(picked.status, 200);
  assert.equal(picked.json.records.length, 3);
  assert.deepEqual(picked.json.via.partIds, [part.id]);
  const status = await api(`${base}/parts/status`);
  assert.equal(status.status, 200);
  assert.deepEqual(status.json.parts[0].broken, [1]);
  assert.equal((await api('/projects/none/parts/status')).status, 404);
});

// 파일 지도 관계 모델 (PLAN-52 T-318, ARCH-01 「작업 폴더(PLAN-52)」): one read gathers the project's
// files (work folder roles, remembered server roles, folded others), every relation kind and the
// events, from the records VIDE keeps — and opens no host file (only VIDE's Markdown and JSON).
// A synthetic project: the work folder and the 'server' are temporary folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { ProjectFolders } from '../../src/core/project-folders.ts';
import { collectWorkspaceMap, nodeIo } from '../../src/server/workspace-map.ts';
import { startServer } from '../../src/server/server.ts';
import {
  ATTACHMENT,
  INSTANCE_A,
  INSTANCE_B,
  MAP_EVENT_COUNT,
  seedWorkspaceMap,
} from '../fixtures/workspace-map.mjs';

async function synthetic(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-workspace-map-'));
  const data = join(directory, 'data');
  await mkdir(data);
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = store.createProject('합성 작업');
  const folders = new ProjectFolders(store);
  const seeded = await seedWorkspaceMap({
    db: store.db(project.id),
    projectId: project.id,
    directory,
    dataDirectory: data,
    addFolder: (path) => folders.add(project.id, path, 'project'),
  });
  return { store, folders, project, data, ...seeded };
}

test('file map: nodes, every relation kind and 30 events in one read; no host file read', async (t) => {
  const { store, folders, project, data, file, root, server } = await synthetic(t);
  const read = [];
  const io = { ...nodeIo, readText: (path) => (read.push(path), nodeIo.readText(path)) };
  const map = await collectWorkspaceMap(
    { store, folders, dataDirectory: data, io, now: () => new Date('2026-10-15T00:00:00Z') },
    project.id,
  );
  assert.equal(map.root, root);
  assert.equal(map.generatedAt, '2026-10-15T00:00:00.000Z');
  assert.equal(map.truncated, false);
  // Shapes (ARCH-01): nodes {id, path, role, host, origin, checkout}, links {from, to, kind}.
  for (const node of map.nodes) {
    assert.equal(typeof node.id, 'string');
    assert.ok(['local', 'server'].includes(node.origin));
    assert.ok(['rhino', 'zwcad', 'vide', 'doc'].includes(node.host));
    assert.ok('checkout' in node && 'role' in node && 'path' in node);
  }
  const byPath = (path) => map.nodes.find((node) => node.path === path);
  for (const path of Object.values(file).filter((path) => !path.includes('attachments')))
    assert.ok(byPath(path), `node for ${path}`);
  assert.ok(map.nodes.length >= 12);
  // Roles and origins.
  assert.equal(byPath(file.model).role, 'rhino');
  assert.equal(byPath(file.model).origin, 'local');
  assert.equal(byPath(file.model).host, 'rhino');
  assert.equal(byPath(file.model).linkId, 'link-model');
  assert.equal(byPath(file.serverModel).origin, 'server');
  assert.equal(byPath(file.serverModel).role, 'rhino');
  assert.equal(byPath(file.elevation).role, 'cad');
  assert.equal(byPath(file.plan).host, 'zwcad');
  assert.equal(byPath(file.dataA).kind, 'jig');
  assert.equal(byPath(file.reportA).kind, 'report');
  assert.equal(byPath(file.minutes).kind, 'note');
  assert.equal(byPath(file.picture).kind, 'image');
  assert.equal(byPath(file.other).folded, true);
  assert.equal(byPath(file.other).role, null);
  assert.equal(byPath(file.serverModel).checkout.state, 'released');
  assert.equal(byPath(file.model).checkout.by, '홍길동');
  assert.ok(map.nodes.every((node) => !node.path || !node.path.startsWith(join(server, '없음'))));

  // Every relation kind, between the expected files.
  const id = (path) => byPath(path).id;
  const has = (from, to, kind) =>
    map.links.some((link) => link.from === from && link.to === to && link.kind === kind);
  assert.ok(has(id(file.plan), id(file.base), 'xref'), 'xref');
  assert.ok(has(id(file.model), id(file.plan), 'sync-pair'), 'sync pair');
  assert.ok(has(id(file.model), id(file.dataA), 'jig-io'), 'jig input → result');
  assert.ok(has(id(file.dataA), id(file.dataB), 'jig-io'), 'result → result');
  assert.ok(has(id(file.dataA), id(file.reportA), 'data-report'), 'data → report');
  assert.ok(has(id(file.model), id(file.serverModel), 'checkout'), 'checkout');
  assert.ok(has(id(file.attachment), id(file.model), 'reference'), 'reference image');
  assert.ok(has(id(file.minutes), id(file.plan), 'mention'), 'plain name');
  assert.ok(has(id(file.minutes), id(file.elevation), 'mention'), 'path chip');
  assert.equal(new Set(map.links.map((link) => link.kind)).size, 7);
  assert.equal(byPath(file.dataA).instanceId, INSTANCE_A);
  assert.equal(byPath(file.dataB).instanceId, INSTANCE_B);
  assert.equal(byPath(file.attachment).name, '참고.png');
  assert.ok(map.nodes.some((node) => node.path?.endsWith(ATTACHMENT + '.png')));

  // Events: 12 Syncs, 9 changes, 5 jig runs (one minute counted once), checkout and release, 2
  // server file times — in time order.
  assert.equal(map.events.length, MAP_EVENT_COUNT);
  const count = (kind) => map.events.filter((event) => event.kind === kind).length;
  assert.deepEqual(
    ['sync', 'request-change', 'jig-run', 'checkout', 'release', 'server-updated'].map(count),
    [12, 9, 5, 1, 1, 2],
  );
  assert.deepEqual(
    map.events.map((event) => event.at),
    [...map.events.map((event) => event.at)].sort(),
  );
  for (const event of map.events) {
    assert.ok(event.nodeIds.length >= 1);
    for (const nodeId of event.nodeIds) assert.ok(map.nodes.some((node) => node.id === nodeId));
  }
  assert.ok(
    map.events.some((event) => event.kind === 'sync' && event.nodeIds[0] === id(file.plan)),
  );

  // Only VIDE's own text was read: the notes and the reference board, never a model or drawing.
  assert.ok(read.length >= 2);
  for (const path of read) assert.match(path, /\.(md|json)$/i);
  assert.ok(read.every((path) => !/\.(3dm|dwg|dxf)$/i.test(path)));
});

test('file map: a project with no work folder still shows its records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-workspace-map-none-'));
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = store.createProject('폴더 없음');
  const map = await collectWorkspaceMap({ store, folders: new ProjectFolders(store) }, project.id);
  assert.deepEqual([map.nodes, map.links, map.events, map.root], [[], [], [], null]);
});

test('file map route: GET …/workspace/map answers the same shape', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-workspace-map-route-'));
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
  const project = (await api('/projects', 'POST', { name: '지도' })).json;
  await seedWorkspaceMap({
    db: app.store.db(project.id),
    projectId: project.id,
    directory,
    dataDirectory: data,
    addFolder: async (path) =>
      assert.equal((await api(`/projects/${project.id}/folders`, 'POST', { path })).status, 200),
  });
  const answer = await api(`/projects/${project.id}/workspace/map?fresh`);
  assert.equal(answer.status, 200);
  assert.deepEqual(Object.keys(answer.json).sort(), [
    'events',
    'generatedAt',
    'links',
    'nodes',
    'root',
    'truncated',
  ]);
  assert.equal(answer.json.events.length, MAP_EVENT_COUNT);
  assert.equal(new Set(answer.json.links.map((link) => link.kind)).size, 7);
  assert.equal((await api('/projects/없는-프로젝트/workspace/map')).status, 404);
});

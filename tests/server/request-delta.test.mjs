// GET …/requests/:r with binary geometry and GET …/requests/:r/delta?since=&base= on per-object
// storage (ARCH-01 §5 「API 응답」, PLAN-27 1단계 순서 7). Synthetic models only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { captureInput } from '../../src/server/import-model.ts';
import { GEOMETRY_TYPE, decodeGeometry } from '../../src/contracts/geometry-transfer.ts';
import { canonicalJson } from '../../src/core/model-store.ts';

const target = { instance: '1:2:356ff01d-b586-460c-8e2b-8c9f3c083e96', documentId: 7 };
const item = (key, x = 0) => ({
  object: { id: key, nativeId: key, kind: 'native', name: key },
  scene: {
    id: key,
    nativeId: key,
    nativeType: 'Brep',
    geometryHash: `h-${key}-${x}`,
    vertices: [x + 200000.1, 0.2, 0.3, x + 200001.7, 0, 0, x + 200000, 1.3, 0],
    indices: [0, 1, 2],
    line: [],
    valid: true,
  },
});
const result = (keys) => {
  const items = keys.map((key) => item(key));
  return {
    hostExecuted: true,
    displayOnly: true,
    executionMode: 'sdk',
    host: 'rhino',
    objects: items.map((entry) => entry.object),
    scene: items.map((entry) => entry.scene),
    definitions: { d1: { vertices: [0, 0, 0, 1, 0, 0], segments: [], texts: [] } },
    sourceDocument: { ...target, connection: 'attached-editor', documentHash: 'd', revision: 1 },
  };
};

test('request geometry and deltas over HTTP', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-request-delta-'));
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
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const get = async (path, accept) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      headers: { ...headers, ...(accept ? { Accept: accept } : {}) },
    });
    const type = response.headers.get('content-type') ?? '';
    return {
      status: response.status,
      type,
      body: type.startsWith(GEOMETRY_TYPE)
        ? decodeGeometry(new Uint8Array(await response.arrayBuffer()))
        : await response.json(),
    };
  };
  const workspace = new Workspace(app.store);
  const project = app.store.createProject('delta');
  const base = `/projects/${project.id}/requests`;
  workspace.submit(project.id, captureInput({ id: 's1', ...target }));
  workspace.update(project.id, 's1', 'succeeded', result(['a', 'b', 'c']));

  // The joined VGT1 decodes to the stored model; a display Sync is never sent whole as JSON
  // (T-127).
  const json = await get(`${base}/s1`);
  assert.equal(json.status, 406);
  assert.equal(json.body.code, 'GEOMETRY_BINARY_REQUIRED');
  const binary = await get(`${base}/s1`, GEOMETRY_TYPE);
  assert.ok(binary.type.startsWith(GEOMETRY_TYPE));
  assert.equal(
    canonicalJson(binary.body.result),
    canonicalJson(JSON.parse(JSON.stringify(workspace.get(project.id, 's1').result))),
  );
  assert.equal(binary.body.result.scene.length, 3);
  assert.deepEqual(Object.keys(binary.body.result.definitions), ['d1']);

  // Nothing changed since the current revision.
  const none = await get(`${base}/s1/delta?since=1`);
  assert.deepEqual([none.body.revision, none.body.objects, none.body.removed], [1, [], []]);
  // A Live Sync in place: one changed, one removed.
  const changed = item('b', 5);
  workspace.applyDelta(
    project.id,
    's1',
    { objects: [changed.object], scene: [changed.scene], removed: ['c'] },
    {},
  );
  const delta = await get(`${base}/s1/delta?since=1`);
  assert.ok(delta.type.startsWith(GEOMETRY_TYPE));
  assert.equal(delta.body.revision, 2);
  assert.deepEqual(
    delta.body.scene.map((entry) => entry.geometryHash),
    ['h-b-5'],
  );
  assert.deepEqual(delta.body.removed, ['c']);
  assert.ok(Math.abs(delta.body.scene[0].vertices[0] - 200005.1) < 1e-3);

  // A copy (the basis was referenced) continues from its parent's revision with `base`.
  workspace.submit(project.id, captureInput({ id: 's2', ...target }));
  const next = item('a', 9);
  workspace.applyDelta(
    project.id,
    's1',
    { objects: [next.object], scene: [next.scene], removed: [] },
    {},
    's2',
  );
  const continued = await get(`${base}/s2/delta?since=2&base=s1`);
  assert.deepEqual(
    continued.body.scene.map((entry) => entry.nativeId),
    ['a'],
  );
  // A new layer table alone (Rhino reordered or switched layers): the revision moves and the
  // delta carries the stored table and hidden layers, as binary and as rows.
  const layers = [
    { id: 'l1', parentId: null, fullPath: 'Bldg', visible: true, order: 0, objectCount: 0 },
    { id: 'l2', parentId: 'l1', fullPath: 'Bldg::L1', visible: false, order: 1, objectCount: 2 },
  ];
  workspace.applyDelta(
    project.id,
    's1',
    { objects: [], scene: [], removed: [] },
    { layers, displayCoverage: { hiddenLayers: [{ path: 'Bldg::L1', count: 2 }] } },
  );
  for (const view of ['', '&view=rows']) {
    const layered = await get(`${base}/s1/delta?since=2${view}`);
    assert.deepEqual(
      [layered.body.revision, layered.body.objects, layered.body.removed],
      [3, [], []],
    );
    assert.deepEqual(layered.body.layers, layers);
    assert.deepEqual(layered.body.displayCoverage.hiddenLayers, [{ path: 'Bldg::L1', count: 2 }]);
  }
  // Another basis, a revision ahead or not stored per object: read the request whole.
  assert.deepEqual((await get(`${base}/s2/delta?since=2&base=other`)).body, {
    requestId: 's2',
    revision: 3,
    full: true,
  });
  assert.equal((await get(`${base}/s1/delta?since=9`)).body.full, true);
  workspace.submit(project.id, captureInput({ id: 'plain', ...target }));
  workspace.update(project.id, 'plain', 'failed', { code: 'X' });
  assert.deepEqual((await get(`${base}/plain/delta?since=0`)).body, {
    requestId: 'plain',
    full: true,
  });
  assert.equal((await get(`${base}/missing/delta?since=0`)).status, 404);
});

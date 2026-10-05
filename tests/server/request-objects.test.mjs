// The request list carries no whole model (PLAN-28 T-123, ARCH-01 §5 「API 응답」): a display Sync
// is listed without its scene and object rows (`objectsOmitted`, `objectCount`); a screen that needs
// the rows reads `GET …/requests/:r/objects[?ids=]`. Synthetic models only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { captureInput } from '../../src/server/import-model.ts';

const target = { instance: '1:2:356ff01d-b586-460c-8e2b-8c9f3c083e96', documentId: 7 };
const key = (i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
function model(count, displayOnly) {
  const objects = Array.from({ length: count }, (_, i) => ({
    id: key(i),
    nativeId: key(i),
    kind: 'native',
    name: `Slab ${i}`,
    origin: [i, 0, 0],
  }));
  return {
    hostExecuted: true,
    executionMode: 'sdk',
    host: 'rhino',
    ...(displayOnly ? { displayOnly: true } : {}),
    objects,
    scene: objects.map((object, i) => ({
      id: object.id,
      nativeId: object.nativeId,
      nativeType: 'Brep',
      vertices: [i, 0, 0, i + 1, 0, 0, i, 1, 0],
      indices: [0, 1, 2],
      valid: true,
    })),
    sourceDocument: { ...target, connection: 'attached-editor', documentHash: 'd', revision: 1 },
  };
}

test('the request list leaves out display Sync rows; …/objects gives them on request', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-request-objects-'));
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
  const headers = { Origin: app.origin, Cookie: login.headers.get('set-cookie').split(';')[0] };
  const get = async (path) => {
    const response = await fetch(app.origin + '/api/v1' + path, { headers });
    const text = await response.text();
    return { status: response.status, bytes: text.length, body: JSON.parse(text) };
  };
  const workspace = new Workspace(app.store);
  const project = app.store.createProject('objects');
  const base = `/projects/${project.id}/requests`;
  // Five full Syncs of a 10,000-object document and one AI candidate with a model.
  for (let n = 0; n < 5; n++) {
    workspace.submit(project.id, captureInput({ id: `sync-${n}`, ...target }));
    workspace.update(project.id, `sync-${n}`, 'succeeded', model(10_000, true));
  }
  workspace.submit(project.id, {
    id: 'candidate',
    body: 'move',
    provider: 'claude-cli',
    permission: 'candidate',
    pins: [],
    sketches: [],
    files: [],
  });
  workspace.update(project.id, 'candidate', 'succeeded', model(3, false));

  const list = await get(base);
  assert.equal(list.status, 200);
  assert.ok(list.bytes < 50_000, `the request list is ${list.bytes} bytes`);
  const sync = list.body.find((row) => row.id === 'sync-4');
  assert.equal(sync.result.objects, undefined);
  assert.equal(sync.result.scene, undefined);
  assert.equal(sync.result.objectsOmitted, true);
  assert.equal(sync.result.objectCount, 10_000);
  assert.equal(sync.result.sceneOmitted, true);
  // A result that is not a display Sync keeps its rows (follow-up drafts and pins read them).
  const candidate = list.body.find((row) => row.id === 'candidate');
  assert.equal(candidate.result.objects.length, 3);
  assert.equal(candidate.result.objectsOmitted, undefined);

  const rows = await get(`${base}/sync-4/objects`);
  assert.equal(rows.body.requestId, 'sync-4');
  assert.equal(rows.body.objects.length, 10_000);
  assert.equal(rows.body.objects[0].vertices, undefined);
  const some = await get(`${base}/sync-4/objects?ids=${key(7)},${key(9999)},missing`);
  assert.deepEqual(
    some.body.objects.map((row) => row.name),
    ['Slab 7', 'Slab 9999'],
  );
  assert.equal((await get(`${base}/nope/objects`)).status, 404);
});

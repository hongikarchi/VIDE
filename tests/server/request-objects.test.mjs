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

  // The whole list comes in pages (T-127): the panel asks page after page.
  const rows = await get(`${base}/sync-4/objects`);
  assert.equal(rows.body.requestId, 'sync-4');
  assert.equal(rows.body.objects.length, 2000);
  assert.equal(rows.body.nextOffset, 2000);
  assert.equal(rows.body.objects[0].vertices, undefined);
  const names = [];
  for (let offset = 0; offset !== undefined; ) {
    const page = await get(`${base}/sync-4/objects?offset=${offset}`);
    names.push(...page.body.objects.map((row) => row.name));
    offset = page.body.nextOffset;
  }
  assert.equal(names.length, 10_000);
  assert.equal(names[9999], 'Slab 9999');
  const small = await get(`${base}/sync-4/objects?offset=9998&limit=5`);
  assert.deepEqual(
    small.body.objects.map((row) => row.name),
    ['Slab 9998', 'Slab 9999'],
  );
  assert.equal(small.body.nextOffset, undefined);
  const capped = await get(`${base}/sync-4/objects?limit=100000`);
  assert.equal(capped.body.objects.length, 2000);
  // A result that is not stored per object pages the same way.
  const candidateRows = await get(`${base}/candidate/objects?limit=2`);
  assert.equal(candidateRows.body.objects.length, 2);
  assert.equal(candidateRows.body.nextOffset, 2);
  // A display Sync's whole model never travels as JSON: binary (VGT1, request-delta) or the
  // summary (T-127). Other results still answer as JSON.
  const whole = await get(`${base}/sync-4`);
  assert.equal(whole.status, 406);
  assert.equal(whole.body.code, 'GEOMETRY_BINARY_REQUIRED');
  assert.equal((await get(`${base}/candidate`)).body.result.objects.length, 3);
  const some = await get(`${base}/sync-4/objects?ids=${key(7)},${key(9999)},missing`);
  assert.deepEqual(
    some.body.objects.map((row) => row.name),
    ['Slab 7', 'Slab 9999'],
  );
  assert.equal((await get(`${base}/nope/objects`)).status, 404);
  // A jig finds one Rhino object by its id in any case (`native`), not by reading the model.
  const native = await get(`${base}/sync-4/objects?native=${key(12).toUpperCase()}`);
  assert.deepEqual(
    native.body.objects.map((row) => row.name),
    ['Slab 12'],
  );

  // One request as the list shows it, and the user's Sync answer: no rows of a display Sync.
  const summary = await get(`${base}/sync-4?view=summary`);
  assert.equal(summary.body.result.objects, undefined);
  assert.equal(summary.body.result.objectsOmitted, true);
  assert.equal(summary.body.result.objectCount, 10_000);
  assert.ok(summary.bytes < 10_000, `the summary is ${summary.bytes} bytes`);
  const captured = await fetch(`${app.origin}/api/v1/projects/${project.id}/capture`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    // The stored Sync of this id answers (no host here): the answer's form is what is checked.
    body: JSON.stringify({ id: 'sync-4', ...target, fresh: true }),
  });
  const answer = await captured.json();
  assert.equal(captured.status, 200);
  assert.equal(answer.id, 'sync-4');
  assert.equal(answer.result.objects, undefined);
  assert.equal(answer.result.scene, undefined);
  assert.equal(answer.result.objectsOmitted, true);

  // The host panels ask a Live Sync's change as rows only (`view=rows`): no geometry.
  workspace.applyDelta(
    project.id,
    'sync-4',
    {
      objects: [{ id: key(3), nativeId: key(3), kind: 'native', name: 'Moved', origin: [9, 0, 0] }],
      scene: [
        {
          id: key(3),
          nativeId: key(3),
          nativeType: 'Brep',
          vertices: [9, 0, 0, 10, 0, 0, 9, 1, 0],
          indices: [0, 1, 2],
          valid: true,
        },
      ],
      removed: [],
    },
    {
      sourceDocument: { ...target, connection: 'attached-editor', documentHash: 'e', revision: 2 },
    },
  );
  const rowsDelta = await fetch(`${app.origin}/api/v1${base}/sync-4/delta?since=1&view=rows`, {
    headers,
  });
  assert.match(rowsDelta.headers.get('content-type'), /json/);
  const change = await rowsDelta.json();
  assert.deepEqual(
    change.objects.map((row) => row.name),
    ['Moved'],
  );
  assert.deepEqual(change.scene, []);
  assert.equal(change.definitions, undefined);
});

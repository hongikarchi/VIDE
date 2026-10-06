// Workspace writes and reads results with a scene through per-object storage (PLAN-27 1단계 순서 4,
// ARCH-01 §5): same shapes for `get`/`list`, manifests behind them, JSON for what cannot be stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { canonicalJson } from '../../src/core/model-store.ts';
import { storedForm } from '../../src/core/model-move.ts';
import { captureInput } from '../../src/server/import-model.ts';

import { soleDb } from '../fixtures/store.mjs';
const target = { instance: '1:2:356ff01d-b586-460c-8e2b-8c9f3c083e96', documentId: 7 };
const item = (key, x = 0) => ({
  object: { id: key, nativeId: key, kind: 'native', name: key },
  scene: {
    id: key,
    nativeId: key,
    nativeType: 'Brep',
    geometryHash: `h-${key}-${x}`,
    vertices: [x + 0.1, 0.2, 0.3, x + 1.7, 0, 0, x, 1.3, 0],
    indices: [0, 1, 2],
    line: [],
    valid: true,
  },
});
const result = (keys, revision = 1, x = 0) => {
  const items = keys.map((key) => item(key, x));
  return {
    hostExecuted: true,
    displayOnly: true,
    executionMode: 'sdk',
    host: 'rhino',
    objects: items.map((entry) => entry.object),
    scene: items.map((entry) => entry.scene),
    sourceDocument: { ...target, connection: 'attached-editor', documentHash: 'd', revision },
  };
};
function setup(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const project = store.createProject('wiring');
  const sync = (id, value, linkId) => {
    workspace.submit(project.id, captureInput({ id, ...target, linkId }));
    return workspace.update(project.id, id, 'succeeded', value);
  };
  return { store, db: soleDb(store), workspace, projectId: project.id, sync };
}
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const raw = (db, id) =>
  JSON.parse(db.prepare('SELECT result FROM workspace_requests WHERE id=?').get(id).result);

test('a result with a scene is stored per object and read back in the same shape', (t) => {
  const { db, workspace, projectId, sync } = setup(t);
  const written = result(['a', 'b']);
  const saved = sync('s1', written);
  // The row keeps the small fields and the marker; the model lives in the manifest.
  const stored = raw(db, 's1');
  assert.equal(stored.modelStore, 'manifest');
  assert.equal(stored.scene, undefined);
  assert.equal(stored.objects, undefined);
  assert.equal(stored.sourceDocument.revision, 1);
  assert.equal(count(db, 'sync_manifest_items'), 2);
  assert.equal(workspace.models(projectId).header(projectId, 's1').documentRevision, 1);
  // `get` (and update's answer) rebuild objects and scene in their float32 form.
  const expected = storedForm({ objects: written.objects, scene: written.scene });
  for (const work of [saved, workspace.get(projectId, 's1')]) {
    assert.equal(work.result.modelStore, undefined);
    assert.equal(canonicalJson(work.result.objects), canonicalJson(expected.objects));
    assert.equal(canonicalJson(work.result.scene), canonicalJson(expected.scene));
  }
  assert.equal(workspace.list(projectId, { full: true })[0].result.scene.length, 2);
  // `list`/`summary` carry the object rows only, read from the manifest's meta.
  const light = workspace.summary(projectId, 's1');
  assert.equal(light.result.sceneOmitted, true);
  assert.equal(light.result.scene, undefined);
  assert.deepEqual(
    light.result.objects.map((o) => o.id),
    ['a', 'b'],
  );
  assert.equal(workspace.brief(projectId, 's1').result.objects, undefined);
  // A lazy view reads one object.
  const view = workspace.model(projectId, 's1');
  assert.deepEqual(view.keys(), ['a', 'b']);
  assert.equal(view.scene('b').geometryHash, 'h-b-0');
});

test('a second Sync of the same file follows the first and writes no new version', (t) => {
  const { db, workspace, projectId, sync } = setup(t);
  const linkId = '9b2f3c1e-1111-4222-8333-444455556666';
  sync('s1', result(['a', 'b', 'c']), linkId);
  const versions = count(db, 'object_versions');
  sync('s2', result(['a', 'b', 'c'], 2), linkId);
  assert.equal(count(db, 'object_versions'), versions);
  assert.equal(workspace.models(projectId).header(projectId, 's2').parentId, 's1');
  assert.equal(workspace.models(projectId).header(projectId, 's2').documentRevision, 2);
});

test('the list cache sees an in-place change of the manifest even at the same result size', (t) => {
  const { workspace, projectId, sync } = setup(t);
  sync('s1', result(['a', 'b']));
  assert.deepEqual(
    workspace.summary(projectId, 's1').result.objects.map((o) => o.name),
    ['a', 'b'],
  );
  const changed = item('b');
  changed.object = { ...changed.object, name: 'B' };
  workspace.applyDelta(
    projectId,
    's1',
    {
      objects: [changed.object],
      scene: [],
      removed: [],
    },
    {},
  );
  assert.deepEqual(
    workspace.list(projectId)[0].result.objects.map((o) => o.name),
    ['a', 'B'],
  );
});

test('what cannot be stored per object stays JSON; a result without a scene drops the manifest', (t) => {
  const { db, workspace, projectId, sync } = setup(t);
  // Duplicate keys cannot be rebuilt from one position per key.
  const twice = result(['a']);
  twice.scene = [twice.scene[0], twice.scene[0]];
  sync('dup', twice);
  assert.equal(raw(db, 'dup').modelStore, undefined);
  assert.equal(raw(db, 'dup').scene.length, 2);
  assert.equal(workspace.model(projectId, 'dup'), undefined);
  sync('s1', result(['a']));
  assert.ok(workspace.model(projectId, 's1'));
  workspace.update(projectId, 's1', 'failed', { code: 'X' });
  assert.equal(workspace.model(projectId, 's1'), undefined);
  assert.equal(count(db, 'object_versions'), 0);
});

test('purge sweeps versions; a pruned Sync reads as an empty scene', (t) => {
  const { db, workspace, projectId, sync } = setup(t);
  sync('s1', result(['a', 'b']));
  sync('s2', result(['c'], 2, 5));
  db.prepare("DELETE FROM sync_manifests WHERE requestId='s2'").run();
  db.prepare(
    "UPDATE workspace_requests SET result=json_set(result,'$.modelStore','pruned') WHERE id='s2'",
  ).run();
  const pruned = workspace.get(projectId, 's2');
  assert.deepEqual(pruned.result.scene, []);
  assert.equal(pruned.result.modelPruned, true);
  assert.equal(workspace.summary(projectId, 's2').result.modelPruned, true);
  workspace.purge(projectId, ['s1', 's2']);
  assert.equal(count(db, 'object_versions'), 0);
});

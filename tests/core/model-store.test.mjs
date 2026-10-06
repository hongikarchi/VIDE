import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { ModelStore, canonicalJson, versionId } from '../../src/core/model-store.ts';
import { storedForm } from '../../src/core/model-move.ts';
import { applyDisplayDelta } from '../../src/core/display-delta.ts';
import { decodeGeometry, encodeGeometry } from '../../src/contracts/geometry-transfer.ts';

import { soleDb } from '../fixtures/store.mjs';
function setup(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const project = store.createProject('p');
  const db = soleDb(store);
  const request = (id, input = {}, result = { host: 'rhino' }, state = 'succeeded', at) =>
    db
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        id,
        project.id,
        JSON.stringify({ id, body: 'Sync', ...input }),
        state,
        JSON.stringify(result),
        at ?? new Date().toISOString(),
      );
  return { store, db, projectId: project.id, models: new ModelStore(db), request };
}

const mesh = (key, offset = 0, points = 4) => {
  const vertices = [];
  for (let i = 0; i < points; i++)
    vertices.push(200000 + offset + i * 0.37, 500000 + i * 0.11, (i % 3) * 0.5);
  return {
    id: key,
    nativeId: key,
    nativeType: 'Brep',
    geometryHash: `h-${key}-${offset}`,
    vertices,
    indices: Array.from({ length: (points - 2) * 3 }, (_, i) =>
      i % 3 === 0 ? 0 : (i % 3) + Math.floor(i / 3),
    ),
    line: [],
    valid: true,
  };
};
const object = (key, name = key) => ({ id: key, nativeId: key, kind: 'native', name, area: 1.5 });
const model = (keys, points = 4) => ({
  objects: keys.map((key) => object(key)),
  scene: keys.map((key) => mesh(key, 0, points)),
  definitions: { d1: { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], segments: [], texts: [] } },
});
const same = (a, b) => assert.equal(canonicalJson(a), canonicalJson(b));
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('a stored model loads back as its float32 form; an unchanged second Sync shares every version', (t) => {
  const { db, projectId, models, request } = setup(t);
  const first = model(['a', 'b', 'c']);
  request('s1');
  const written = models.store(projectId, 's1', first, { documentRevision: 7 });
  assert.equal(written.revision, 1);
  assert.equal(written.versions, 4);
  same(models.load(projectId, 's1'), storedForm(first));
  assert.equal(models.header(projectId, 's1').documentRevision, 7);
  // Same document again: no new version, only manifest rows.
  request('s2');
  assert.equal(
    models.store(projectId, 's2', model(['a', 'b', 'c']), { parentId: 's1' }).versions,
    0,
  );
  assert.equal(count(db, 'object_versions'), 4);
  assert.equal(models.header(projectId, 's2').parentId, 's1');
  // The fingerprint is stable and independent of key order.
  assert.equal(
    versionId('object', { a: 1, b: [1, 2] }, null),
    versionId('object', { b: [1, 2], a: 1 }, null),
  );
  // A result without objects or definitions keeps that shape.
  request('s3');
  models.store(projectId, 's3', { scene: [mesh('x')] });
  same(models.load(projectId, 's3'), storedForm({ scene: [mesh('x')] }));
  assert.ok(!('objects' in models.load(projectId, 's3')));
});

test('scene-only items keep their place; contradicting orders or duplicate keys are refused', (t) => {
  const { projectId, models, request } = setup(t);
  request('s1');
  const value = {
    objects: [object('a'), object('c')],
    scene: [mesh('a'), mesh('b'), mesh('c'), mesh('d')],
  };
  models.store(projectId, 's1', value);
  same(models.load(projectId, 's1'), storedForm(value));
  request('s2');
  assert.throws(
    () =>
      models.store(projectId, 's2', {
        objects: [object('a'), object('c')],
        scene: [mesh('c'), mesh('a')],
      }),
    { code: 'MODEL_STORE_UNSUPPORTED' },
  );
  assert.throws(() => models.store(projectId, 's2', { scene: [mesh('a'), mesh('a')] }), {
    code: 'MODEL_STORE_UNSUPPORTED',
  });
  assert.equal(models.header(projectId, 's2'), undefined);
});

test('a Live Sync delta changes, appends and removes as applyDisplayDelta would, in place', (t) => {
  const { db, projectId, models, request } = setup(t);
  const base = model(['a', 'b', 'c', 'd']);
  request('s1', {}, { host: 'rhino', sourceDocument: { revision: 1 } });
  models.store(projectId, 's1', base);
  const delta = {
    objects: [object('b', 'renamed'), object('e')],
    scene: [mesh('c', 5), mesh('e')],
    removed: ['d'],
    definitions: { d2: { vertices: [], segments: [0, 0, 0, 1, 1, 1], texts: [] } },
  };
  const out = models.applyDelta(projectId, 's1', delta, {
    sourceDocument: { revision: 9, documentHash: 'x' },
    layers: [{ name: 'L' }],
  });
  assert.equal(out.revision, 2);
  assert.equal(out.removed, 1);
  same(models.load(projectId, 's1'), storedForm(applyDisplayDelta(base, delta)));
  const result = JSON.parse(
    db.prepare("SELECT result FROM workspace_requests WHERE id='s1'").get().result,
  );
  assert.deepEqual(result.sourceDocument, { revision: 9, documentHash: 'x' });
  assert.deepEqual(result.layers, [{ name: 'L' }]);
  // The version 'd' used is gone, the one 'b'/'c' used before too.
  assert.equal(out.swept, 3);
  // An empty page leaves the revision.
  assert.equal(
    models.applyDelta(projectId, 's1', { objects: [], scene: [], removed: [] }).revision,
    2,
  );
  // Removed and re-added in one page: appended at the end, like applyDisplayDelta.
  const again = { objects: [object('a')], scene: [mesh('a')], removed: ['a'] };
  const before = models.load(projectId, 's1');
  models.applyDelta(projectId, 's1', again);
  same(models.load(projectId, 's1'), storedForm(applyDisplayDelta(before, again)));
  assert.throws(() => models.applyDelta(projectId, 'missing', again), { code: 'NOT_FOUND' });
});

test('a copy shares versions and inherits revisions; the referenced original does not change', (t) => {
  const { projectId, models, request } = setup(t);
  const base = model(['a', 'b']);
  request('s1');
  models.store(projectId, 's1', base);
  models.applyDelta(projectId, 's1', { objects: [object('a', 'x')], scene: [], removed: [] });
  request('s2');
  assert.equal(models.copyManifest(projectId, 's1', 's2').revision, 2);
  const delta = { objects: [], scene: [mesh('b', 3)], removed: ['a'] };
  models.applyDelta(projectId, 's2', delta);
  const original = models.load(projectId, 's1');
  assert.equal(original.objects[0].name, 'x');
  assert.equal(original.objects.length, 2);
  same(models.load(projectId, 's2'), storedForm(applyDisplayDelta(original, delta)));
  const header = models.header(projectId, 's2');
  assert.equal(header.parentId, 's1');
  assert.equal(header.revision, 3);
  // Holding the parent at revision 2, the copy's delta continues from there.
  const next = models.deltaSince(projectId, 's2', 2, 's1');
  assert.deepEqual(next.removed, ['a']);
  assert.deepEqual(
    next.objects.map((o) => o.id),
    ['b'],
  );
  assert.equal(models.deltaSince(projectId, 's2', 2, 'other').full, true);
});

test('deltaSince gives changed rows, removed keys and full when it cannot continue', (t) => {
  const { projectId, models, request } = setup(t);
  request('s1');
  const base = model(['a', 'b', 'c']);
  models.store(projectId, 's1', base);
  const delta = { objects: [object('b', 'n')], scene: [mesh('b', 1)], removed: ['c'] };
  models.applyDelta(projectId, 's1', delta);
  const changes = models.deltaSince(projectId, 's1', 1);
  assert.equal(changes.revision, 2);
  assert.deepEqual(changes.removed, ['c']);
  assert.deepEqual(
    changes.objects.map((o) => o.id),
    ['b'],
  );
  assert.equal(changes.scene.length, 1);
  // The VGT1 form decodes to the delta shape applyDisplayDelta takes.
  const decoded = decodeGeometry(ModelStore.deltaGeometry(changes));
  same(applyDisplayDelta(storedForm(base), decoded), models.load(projectId, 's1'));
  assert.equal(models.deltaSince(projectId, 's1', 2).objects.length, 0);
  assert.equal(models.deltaSince(projectId, 's1', 5).full, true);
  // A full store over the manifest is a delta too.
  // Unchanged 'a' keeps its row revision; 'b' leaves.
  models.store(projectId, 's1', model(['a']));
  const full = models.deltaSince(projectId, 's1', 2);
  assert.equal(full.revision, 3);
  assert.deepEqual(full.objects, []);
  assert.deepEqual(full.removed, ['b']);
});

test('lazy view reads one object; the joined VGT1 equals encoding the rebuilt request', (t) => {
  const { projectId, models, request } = setup(t);
  request('s1');
  const base = model(['a', 'b', 'c']);
  models.store(projectId, 's1', base);
  const view = models.view(projectId, 's1');
  assert.deepEqual(view.keys(), ['a', 'b', 'c']);
  assert.deepEqual(view.object('b'), object('b'));
  same(view.scene('b'), storedForm({ scene: [mesh('b')] }).scene[0]);
  assert.deepEqual(
    view.rows(['c', 'a']).map((row) => row.id),
    ['a', 'c'],
  );
  assert.deepEqual(view.definition('d1').vertices, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.equal(view.object('zz'), undefined);
  const root = { id: 's1', state: 'succeeded', result: { host: 'rhino', layers: [] } };
  const joined = view.geometry(root);
  const rebuilt = { ...root, result: { ...root.result, ...models.load(projectId, 's1') } };
  assert.deepEqual(Buffer.from(joined), Buffer.from(encodeGeometry(rebuilt)));
});

test('versions no manifest uses are swept; deleting requests or the project removes the rest', (t) => {
  const { store, db, projectId, models, request } = setup(t);
  request('s1');
  request('s2');
  models.store(projectId, 's1', model(['a', 'b']));
  models.store(projectId, 's2', model(['a', 'b']));
  models.applyDelta(projectId, 's1', { objects: [], scene: [mesh('a', 9)], removed: [] });
  // 'a' old version is still used by s2.
  assert.equal(count(db, 'object_versions'), 4);
  db.prepare("DELETE FROM workspace_requests WHERE id='s2'").run();
  assert.equal(count(db, 'sync_manifests'), 1);
  assert.equal(models.sweep(projectId), 1);
  assert.equal(count(db, 'object_versions'), 3);
  // Deleting the project drops its whole DB (ADR-032): nothing of it is left to count.
  store.deleteProject(projectId);
  assert.throws(() => store.db(projectId), { code: 'NOT_FOUND' });
  assert.equal(db.isOpen, false);
});

test('retention keeps the newest 20 Syncs per document and every referenced one', (t) => {
  const { db, projectId, models, request } = setup(t);
  for (let i = 0; i < 25; i++) {
    const id = `s${String(i).padStart(2, '0')}`;
    request(
      id,
      { source: 'document', linkId: 'L1' },
      { host: 'rhino' },
      'succeeded',
      `2026-10-02T00:00:${String(i).padStart(2, '0')}Z`,
    );
    models.store(projectId, id, model([`k${i}`]));
  }
  request(
    'other',
    { source: 'document', linkId: 'L2' },
    { host: 'rhino' },
    'succeeded',
    '2026-10-01T00:00:00Z',
  );
  models.store(projectId, 'other', model(['o']));
  // s01 is a pin basis of a later request; s02 is in a review.
  request('ask', { pins: [{ id: 'k1', basis: 's01', role: 'target' }] }, null);
  db.prepare("INSERT INTO review_snapshots VALUES('rv',?,'s02','t','now','{}')").run(projectId);
  const out = models.retain(projectId);
  assert.equal(out.manifests, 3);
  const kept = db
    .prepare('SELECT requestId FROM sync_manifests ORDER BY requestId')
    .all()
    .map((r) => r.requestId);
  assert.ok(kept.includes('s01') && kept.includes('s02') && kept.includes('other'));
  assert.ok(!kept.includes('s00') && !kept.includes('s03') && !kept.includes('s04'));
  assert.equal(kept.length, 23);
  const pruned = JSON.parse(
    db.prepare("SELECT result FROM workspace_requests WHERE id='s00'").get().result,
  );
  assert.equal(pruned.modelStore, 'pruned');
  // Their own versions went with them; the shared definition stays.
  assert.equal(out.versions, 3);
  assert.equal(models.load(projectId, 's00'), undefined);
});

test('10,000 objects: full store, Live Sync of 10 changes, load and join timings', (t) => {
  const { db, projectId, models, request } = setup(t);
  const keys = Array.from({ length: 10000 }, (_, i) => `obj-${i}`);
  // About one million vertices in all, as the measured user model.
  const base = model(keys, 100);
  request('big', {}, { host: 'rhino', sourceDocument: { revision: 1 } });
  let at = performance.now();
  models.store(projectId, 'big', base);
  const storeMs = performance.now() - at;
  request('again');
  at = performance.now();
  const again = models.store(projectId, 'again', base, { parentId: 'big' });
  const unchangedMs = performance.now() - at;
  assert.equal(again.versions, 0);
  const pages = () => db.prepare('PRAGMA page_count').get().page_count;
  const pagesBefore = pages();
  const delta = {
    objects: keys.slice(100, 110).map((key) => object(key, 'moved')),
    scene: keys.slice(100, 110).map((key) => mesh(key, 2, 100)),
    removed: [],
  };
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const page = { ...delta, scene: keys.slice(100, 110).map((key) => mesh(key, 3 + i, 100)) };
    at = performance.now();
    models.applyDelta(projectId, 'big', page, { sourceDocument: { revision: 2 + i } });
    runs.push(performance.now() - at);
  }
  const liveMs = Math.min(...runs);
  at = performance.now();
  const loaded = models.load(projectId, 'big');
  const loadMs = performance.now() - at;
  assert.equal(loaded.objects.length, 10000);
  at = performance.now();
  const bytes = models.geometry(projectId, 'big', { id: 'big', result: { host: 'rhino' } });
  const joinMs = performance.now() - at;
  at = performance.now();
  models.deltaSince(projectId, 'big', 5);
  const deltaMs = performance.now() - at;
  const versionBytes = db.prepare('SELECT sum(size) AS n FROM object_versions').get().n;
  const jsonBytes = JSON.stringify(base).length;
  t.diagnostic(
    `store ${storeMs.toFixed(0)} ms, unchanged store ${unchangedMs.toFixed(0)} ms, live delta(10) ${runs
      .map((v) => v.toFixed(1))
      .join('/')} ms, load ${loadMs.toFixed(0)} ms, join ${joinMs.toFixed(0)} ms (${(
      bytes.byteLength / 1e6
    ).toFixed(1)} MB), deltaSince ${deltaMs.toFixed(1)} ms, versions ${(versionBytes / 1e6).toFixed(
      1,
    )} MB vs JSON ${(jsonBytes / 1e6).toFixed(1)} MB, pages +${pages() - pagesBefore}`,
  );
  assert.ok(liveMs < 100, `live delta ${liveMs} ms`);
});

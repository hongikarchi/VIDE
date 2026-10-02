import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/core/store.ts';
import { ModelStore, canonicalJson } from '../../src/core/model-store.ts';
import {
  moveRow,
  moveRows,
  pendingRows,
  storedForm,
  vacuumWhenIdle,
} from '../../src/core/model-move.ts';

// A display Sync row as releases before schema 9 stored it (synthetic, not a user database).
const legacy = (keys) => ({
  displayOnly: true,
  hostExecuted: true,
  host: 'rhino',
  sourceDocument: {
    connection: 'attached-editor',
    instance: '1:2:x',
    documentId: 1,
    revision: 12,
    documentHash: 'abc',
  },
  objects: keys.map((key) => ({
    id: key,
    nativeId: key,
    kind: 'native',
    name: `이름 ${key}`,
    volume: 2.25,
  })),
  scene: keys.map((key, i) => ({
    id: key,
    nativeId: key,
    nativeType: i % 2 ? 'Mesh' : 'Curve',
    geometryHash: `g-${key}`,
    ...(i % 2
      ? {
          vertices: [
            210000.125 + i,
            450000.5,
            3.3,
            210001.5 + i,
            450000.75,
            3.3,
            210000.125 + i,
            450002,
            6.6,
          ],
          indices: [0, 1, 2],
        }
      : { line: [210000 + i, 450000, 0, 210003.25 + i, 450004.5, 0] }),
    valid: true,
  })),
  definitions: { blk: { vertices: [], segments: [0, 0, 0, 2, 0, 0], texts: [{ s: 'A' }] } },
  layers: [{ name: '벽', count: keys.length }],
  displayCoverage: { total: keys.length, displayed: keys.length, omitted: 0, omittedTypes: {} },
  measurementVersion: 3,
});

function fixture(t, file = ':memory:') {
  const store = new Store(file);
  t.after(() => store.close());
  const project = store.createProject('p');
  const insert = (id, result, state = 'succeeded') =>
    store.db
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        id,
        project.id,
        JSON.stringify({ id, body: 'Sync', source: 'document' }),
        state,
        JSON.stringify(result),
        't',
      );
  return { store, db: store.db, projectId: project.id, insert };
}
const resultOf = (db, id) =>
  JSON.parse(db.prepare('SELECT result FROM workspace_requests WHERE id=?').get(id).result);

test('a legacy row moves out of JSON and rebuilds equal to its float32 form', (t) => {
  const { db, projectId, insert } = fixture(t);
  const original = legacy(['a', 'b', 'c', 'd']);
  insert('sync', original);
  insert('text', { text: 'ok' });
  assert.deepEqual(pendingRows(db), ['sync']);
  const outcome = moveRow(db, 'sync');
  assert.equal(outcome.moved, true);
  assert.equal(outcome.versions, 5);
  const small = resultOf(db, 'sync');
  assert.equal(small.modelStore, 'manifest');
  assert.ok(!('scene' in small) && !('objects' in small) && !('definitions' in small));
  // Every other field stays in the request row.
  for (const field of ['sourceDocument', 'layers', 'displayCoverage', 'measurementVersion', 'host'])
    assert.deepEqual(small[field], original[field]);
  const models = new ModelStore(db);
  const rebuilt = models.load(projectId, 'sync');
  assert.equal(canonicalJson(rebuilt), canonicalJson(storedForm(original)));
  assert.equal(models.header(projectId, 'sync').documentRevision, 12);
  // Coordinates are within 0.001 mm of the original numbers.
  rebuilt.scene.forEach((item, i) =>
    (item.vertices ?? item.line).forEach((v, k) =>
      assert.ok(Math.abs(v - (original.scene[i].vertices ?? original.scene[i].line)[k]) < 1e-6),
    ),
  );
  // Moving again does nothing.
  assert.equal(moveRow(db, 'sync').moved, false);
  assert.deepEqual(pendingRows(db), []);
});

test('a row that cannot be stored stays JSON and is logged; running rows wait; a stopped run resumes', async (t) => {
  const { db, insert } = fixture(t);
  const odd = legacy(['a', 'b']);
  odd.scene.reverse(); // scene order contradicting the object order
  insert('odd', odd);
  insert('busy', legacy(['x']), 'running');
  for (let i = 0; i < 3; i++) insert(`s${i}`, legacy([`k${i}`, `m${i}`]));
  const logs = [];
  const first = await moveRows(db, {
    log: (event, data) => logs.push([event, data]),
    stop: () => logs.length >= 2,
  });
  assert.equal(first.moved, 1);
  assert.equal(first.failed, 1);
  assert.deepEqual(logs[0], [
    'model-move-failed',
    { request: 'odd', code: 'MODEL_STORE_UNSUPPORTED' },
  ]);
  assert.equal(logs[1][0], 'model-move');
  assert.deepEqual(Object.keys(logs[1][1]), ['request', 'bytes', 'versions', 'ms']);
  // The failed row is untouched JSON with nothing stored for it.
  assert.equal(canonicalJson(resultOf(db, 'odd')), canonicalJson(odd));
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM sync_manifests WHERE requestId='odd'").get().n,
    0,
  );
  // Next start: the rest moves; the running row is not a candidate.
  const second = await moveRows(db);
  assert.equal(second.moved, 2);
  assert.deepEqual(pendingRows(db), ['odd']);
  assert.ok(Array.isArray(resultOf(db, 'busy').scene));
});

test('VACUUM runs only when idle and nothing is waiting or running', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vide-model-move-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { store, db, insert } = fixture(t, join(root, 'vide.sqlite'));
  insert('s', legacy(Array.from({ length: 400 }, (_, i) => `k${i}`)));
  assert.equal(moveRow(db, 's').moved, true);
  assert.equal(
    vacuumWhenIdle(db, () => false),
    false,
  );
  insert('q', { text: '' }, 'queued');
  assert.equal(
    vacuumWhenIdle(db, () => true),
    false,
  );
  db.prepare("UPDATE workspace_requests SET state='succeeded' WHERE id='q'").run();
  assert.equal(
    vacuumWhenIdle(db, () => true),
    true,
  );
  store.close();
});

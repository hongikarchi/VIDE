// Live Sync on per-object storage (PLAN-27 1단계 검증): on a synthetic 10,000-object document a
// Live Sync of 10 changed objects goes through the real Workspace and LiveSync without reading the
// stored model whole, and the database grows by the changed versions only. Timings are printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { LiveSync } from '../../src/server/live-sync.ts';
import { captureInput } from '../../src/server/import-model.ts';
import { displayCoverage } from '../../src/core/display-delta.ts';

const target = { instance: '1:2:356ff01d-b586-460c-8e2b-8c9f3c083e96', documentId: 7 };
const OBJECTS = 10_000;
const POINTS = 100;
const mesh = (key, shift = 0) => {
  const vertices = [];
  for (let i = 0; i < POINTS; i++)
    vertices.push(200000 + shift + i * 0.37, 500000 + (i % 7) * 0.11, (i % 3) * 0.5);
  return {
    id: key,
    nativeId: key,
    nativeType: 'Brep',
    geometryHash: `h-${key}-${shift}`,
    layer64: Buffer.from('Layer ' + (Number(key.slice(1)) % 20)).toString('base64'),
    area: 1.5,
    volume: null,
    length: null,
    vertices,
    indices: Array.from({ length: (POINTS - 2) * 3 }, (_, i) =>
      i % 3 === 0 ? 0 : (i % 3) + Math.floor(i / 3),
    ),
    line: [],
    valid: true,
  };
};
const object = (key) => ({ id: key, nativeId: key, kind: 'native', name: key, origin: [0, 0, 0] });
const keys = Array.from({ length: OBJECTS }, (_, i) => `o${i}`);
const model = (revision) => {
  const scene = keys.map((key) => mesh(key));
  return {
    hostExecuted: true,
    displayOnly: true,
    executionMode: 'sdk',
    host: 'rhino',
    objects: keys.map(object),
    scene,
    displayCoverage: displayCoverage(scene),
    sourceDocument: {
      ...target,
      connection: 'attached-editor',
      documentHash: 'r'.repeat(64),
      revision,
      name: 'Doc',
      capturedAt: new Date().toISOString(),
    },
  };
};
const bytes = (db) =>
  db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;

test('10,000 objects: Live Sync of 10 changes stays small in time and storage', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const project = store.createProject('large');
  const sync = (id, revision) => {
    workspace.submit(project.id, captureInput({ id, ...target }));
    const started = performance.now();
    workspace.update(project.id, id, 'succeeded', model(revision));
    return performance.now() - started;
  };
  const before = bytes(store.db);
  const firstMs = sync('s1', 4);
  const afterFirst = bytes(store.db);
  // An unchanged document Synced again adds manifest rows only.
  const secondMs = sync('s2', 5);
  const afterSecond = bytes(store.db);
  const grown = afterSecond - afterFirst;
  // Manifest rows only (about 300 B per object with these keys, 400 B with Rhino GUIDs), never a
  // copy of the model (about 65 MB of JSON here before per-object storage).
  assert.ok(grown < 5 * 1024 * 1024, `full Sync of an unchanged document grew ${grown} bytes`);

  let reads = 0;
  const get = workspace.get.bind(workspace);
  workspace.get = (...args) => {
    reads++;
    return get(...args);
  };
  const changed = keys.slice(0, 10).map((key) => ({ object: object(key), scene: mesh(key, 3) }));
  const sdk = {
    async liveSync(where, basis, since) {
      return {
        delta: {
          objects: changed.map((entry) => entry.object),
          scene: changed.map((entry) => entry.scene),
          removed: ['o9999'],
        },
        survey: {},
        result: {
          sourceDocument: { ...basis.sourceDocument, ...where, revision: since + 1 },
        },
      };
    },
  };
  const live = new LiveSync(workspace, sdk);
  live.record(project.id, workspace.brief(project.id, 's2'));
  const beforeLive = bytes(store.db);
  const started = performance.now();
  const reply = await live.run(project.id, { ...target, basisId: 's2', revision: 5 });
  const liveMs = performance.now() - started;
  const liveGrown = bytes(store.db) - beforeLive;
  assert.equal(reply.requestId, 's2');
  assert.equal(reply.created, false);
  assert.equal(reads, 0, 'the stored model was read whole');
  assert.ok(liveMs < 500, `Live Sync took ${liveMs} ms`);
  assert.ok(liveGrown < 512 * 1024, `Live Sync grew ${liveGrown} bytes`);
  // The stored result follows: changed version, removed key, counts and revision.
  const view = workspace.model(project.id, 's2');
  assert.equal(view.scene('o3').geometryHash, 'h-o3-3');
  assert.equal(view.object('o9999'), undefined);
  const summary = workspace.brief(project.id, 's2').result;
  assert.equal(summary.sourceDocument.revision, 6);
  assert.equal(summary.displayCoverage.total, OBJECTS - 1);
  assert.equal(reply.displayRevision, workspace.models.header(project.id, 's2').revision);
  t.diagnostic(
    `first store ${Math.round(firstMs)} ms (+${Math.round((afterFirst - before) / 1024 / 1024)} MB), ` +
      `unchanged full Sync ${Math.round(secondMs)} ms (+${Math.round(grown / 1024)} KB), ` +
      `Live Sync ${liveMs.toFixed(1)} ms (engine ${reply.timing.engineMs} ms, +${Math.round(liveGrown / 1024)} KB)`,
  );
});

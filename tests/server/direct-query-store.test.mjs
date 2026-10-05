// The AI `query` of a Rhino direct turn (PLAN-28 T-123, ARCH-01 §4 「도구별」): pages come from the
// document's stored Sync with the objects Rhino reports changed since it laid over; the document is
// read whole only without a stored Sync or when Rhino cannot tell the changes. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { overlayDisplay } from '../../src/server/direct-mode.ts';
import { captureInput } from '../../src/server/import-model.ts';

const target = { instance: '1:2:356ff01d-b586-460c-8e2b-8c9f3c083e96', documentId: 7 };
const source = (revision) => ({
  ...target,
  connection: 'attached-editor',
  documentHash: 'd'.repeat(64),
  revision,
  name: 'Large',
  units: 'Millimeters',
  capturedAt: '2026-10-06T00:00:00.000Z',
});
const key = (i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
const entry = (i, x = 0) => ({
  object: { id: key(i), nativeId: key(i), kind: 'native', name: `Column ${i}` },
  scene: {
    id: key(i),
    nativeId: key(i),
    nativeType: 'Brep',
    geometryHash: `h${i}-${x}`,
    vertices: Array.from({ length: 300 }, (_, k) => i + x + k / 9),
    indices: Array.from({ length: 270 }, (_, k) => k % 100),
    line: [],
    area: i,
    valid: true,
  },
});

function setup(t, count) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const project = store.createProject('query');
  const calls = { readLayers: 0, liveSync: [] };
  let changes = { objects: [], scene: [], removed: [] };
  const sdk = {
    runDirect: async () => ({ ok: true }),
    undoDirect: async () => ({ ok: true }),
    fingerprint: async () => ({ documentHash: 'd'.repeat(64) }),
    directView: async () => ({}),
    readLayers: async () => {
      calls.readLayers++;
      const items = Array.from({ length: count }, (_, i) => entry(i));
      return {
        objects: items.map((item) => item.object),
        scene: items.map((item) => item.scene),
        sourceDocument: source(9),
      };
    },
    liveSync: async (where, basis, since) => {
      calls.liveSync.push(since);
      if (changes === 'resync')
        throw Object.assign(new Error('RESYNC_REQUIRED'), { code: 'RESYNC_REQUIRED' });
      return { delta: changes, survey: {}, result: { sourceDocument: source(9) } };
    },
  };
  const execution = new Execution(workspace, { sdk });
  const store3 = (revision) => {
    const items = Array.from({ length: count }, (_, i) => entry(i));
    workspace.submit(project.id, captureInput({ id: 'sync', ...target }));
    workspace.update(project.id, 'sync', 'succeeded', {
      host: 'rhino',
      hostExecuted: true,
      displayOnly: true,
      executionMode: 'sdk',
      objects: items.map((item) => item.object),
      scene: items.map((item) => item.scene),
      sourceDocument: source(revision),
    });
  };
  return {
    workspace,
    execution,
    calls,
    store: store3,
    change: (value) => {
      changes = value;
    },
  };
}

test('query pages a stored Sync with the changes since it, never reading the document', async (t) => {
  const { execution, calls, store, change } = setup(t, 10_000);
  store(4);
  const moved = entry(5, 100);
  const added = entry(20_000);
  change({
    objects: [moved.object, added.object],
    scene: [moved.scene, added.scene],
    removed: [key(2)],
  });
  const driver = execution.directDriverFor('rhino', source(4));
  const began = performance.now();
  const page = await driver.query({ limit: 10 });
  const ms = performance.now() - began;
  assert.equal(calls.readLayers, 0, 'the whole document was read');
  assert.deepEqual(calls.liveSync, [4]);
  assert.equal(page.page.total, 10_000);
  const ids = page.model.objects.map((row) => row.id);
  assert.ok(!ids.includes(key(2)), 'a removed object is listed');
  const five = page.model.scene.find((row) => row.id === key(5));
  assert.equal(five.geometryHash, 'h5-100', 'the changed object is not the stored one');
  assert.equal(five.vertices, undefined, 'a query row carries coordinates');
  const last = await driver.query({ objectIds: [key(20_000)] });
  assert.equal(last.model.objects[0].name, 'Column 20000');
  // One read per document revision of the turn: the second page asked Rhino nothing more.
  assert.deepEqual(calls.liveSync, [4]);
  console.log(`query over 10,000 stored objects: ${Math.round(ms)} ms`);
});

test('query reads the whole document without a stored Sync or when Rhino cannot tell', async (t) => {
  const { execution, calls, store, change } = setup(t, 50);
  let driver = execution.directDriverFor('rhino', source(4));
  let page = await driver.query({ limit: 5 });
  assert.equal(calls.readLayers, 1);
  assert.equal(page.page.total, 50);
  store(4);
  change('resync');
  driver = execution.directDriverFor('rhino', source(4));
  page = await driver.query({ limit: 5 });
  assert.deepEqual(calls.liveSync, [4]);
  assert.equal(calls.readLayers, 2);
});

test('overlayDisplay keeps display order, replaces, removes and appends like applyDisplayDelta', () => {
  const row = (id, v = 1) => ({ id, nativeId: id, v });
  const stored = ['a', 'b', 'c'].map((id) => ({
    object: row(id),
    scene: { ...row(id), vertices: [1] },
  }));
  const out = overlayDisplay(stored, {
    objects: [row('b', 2), row('d', 2)],
    scene: [{ ...row('b', 2), vertices: [0, 0, 0], indices: [0] }, row('d', 2)],
    removed: ['a'],
  });
  assert.deepEqual(
    out.objects.map((o) => [o.id, o.v]),
    [
      ['b', 2],
      ['c', 1],
      ['d', 2],
    ],
  );
  assert.equal(out.scene[0].vertices, undefined);
  assert.equal(out.scene[0].indices, undefined);
});

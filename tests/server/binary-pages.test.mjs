// T-128: Rhino display pages travel as VGT1 binary (ADR-031 5, ARCH-01 §5). The engine asks with
// `geometry: 'vgt1'`; an older plugin answers JSON and still works. The display Sync keeps the
// typed arrays up to ModelStore, which stores the same bytes as from a JSON page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendHostCommand } from '../../hosts/common/transport.ts';
import { readScenePages } from '../../hosts/rhino/scene-pages.ts';
import { editorMethods } from '../../hosts/rhino/editor-channel.ts';
import {
  decodeGeometry,
  encodeGeometry,
  encodeItem,
  isPacked,
} from '../../src/contracts/geometry-transfer.ts';
import { OVERSIZED_TYPE_SUFFIX } from '../../src/core/display-delta.ts';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import {
  changesPage,
  displayPage,
  fakePlugin,
  syntheticDocument,
} from '../fixtures/host-pages.mjs';

const readOver = (port, geometry) =>
  readScenePages(
    (params) => sendHostCommand('vide', params, { port, timeoutMs: 30000 }),
    {},
    Infinity,
    true,
    {},
    geometry,
  );
async function read(items, binary, geometry) {
  const asked = [];
  const plugin = await fakePlugin({
    binary,
    answer: (params) => {
      asked.push(params.geometry);
      return displayPage(items, params.offset, params.limit);
    },
  });
  try {
    const model = await readOver(plugin.port, geometry);
    return { model, bytes: plugin.replies.reduce((sum, n) => sum + n, 0), asked };
  } finally {
    await plugin.close();
  }
}
/**
 * Engine-side cost of one read (the plugin's replies are built once, before): mean time of three
 * reads, the per-object encoding ModelStore does, and with --expose-gc the memory a read model
 * holds (JS heap plus the frames its typed arrays still point into).
 */
async function measure(items, binary, geometry) {
  const plugin = await fakePlugin({
    binary,
    cache: true,
    answer: (params) => displayPage(items, params.offset, params.limit),
  });
  try {
    await readOver(plugin.port, geometry);
    const bytes = plugin.replies.reduce((sum, n) => sum + n, 0);
    const used = () => {
      globalThis.gc?.();
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.arrayBuffers;
    };
    const before = used();
    const kept = [];
    const began = performance.now();
    for (let i = 0; i < 3; i++) kept.push(await readOver(plugin.port, geometry));
    const ms = (performance.now() - began) / 3;
    const held = globalThis.gc ? `${((used() - before) / 3 / 2 ** 20).toFixed(1)} MB` : 'n/a';
    const encoding = performance.now();
    for (const item of kept[0].scene) encodeItem(item);
    return { bytes, ms, held, encodeMs: performance.now() - encoding };
  } finally {
    await plugin.close();
  }
}
const bytesEqual = (a, b) =>
  a === b || (!!a && !!b && a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b)));

test('a binary page decodes to the page an older plugin sends as JSON', async () => {
  const items = syntheticDocument(1200);
  const json = await read(items, false, { binary: true });
  const binary = await read(items, true, { binary: true });
  // The engine asked every page in binary; only the binary plugin answered so.
  assert.ok(json.asked.every((value) => value === 'vgt1'));
  assert.equal(binary.model.scene.length, 1200);
  for (let i = 0; i < 1200; i += 97) {
    const a = json.model.scene[i],
      b = binary.model.scene[i];
    assert.ok(Array.isArray(b.vertices) && Array.isArray(b.indices) && Array.isArray(b.line));
    assert.deepEqual(b.indices, a.indices);
    assert.equal(b.vertices.length, a.vertices.length);
    // float32 offsets from the first point: far below 1 µm at these sizes.
    for (let k = 0; k < a.vertices.length; k++)
      assert.ok(Math.abs(a.vertices[k] - b.vertices[k]) < 1e-6);
    assert.equal(b.geometryHash, a.geometryHash);
  }
  assert.deepEqual(binary.model.displayCoverage, json.model.displayCoverage);
  assert.ok(binary.bytes < json.bytes * 0.8, `${binary.bytes} < ${json.bytes} * 0.8`);
});

test('the display Sync keeps typed arrays and stores the same bytes as from JSON', async () => {
  const items = syntheticDocument(600);
  const json = await read(items, false, { binary: true, typed: true });
  const typed = await read(items, true, { binary: true, typed: true });
  const box = typed.model.scene.find((item) => item.nativeType === 'Brep');
  const curve = typed.model.scene.find((item) => item.nativeType === 'Curve');
  assert.ok(isPacked(box.vertices) && box.indices instanceof Uint16Array);
  assert.ok(isPacked(curve.line) && Array.isArray(curve.vertices) && curve.vertices.length === 0);
  // An older plugin's JSON page in the same read keeps plain numbers.
  assert.ok(Array.isArray(json.model.scene[0].vertices));
  // ModelStore's per-object encoding is byte for byte the same either way.
  for (let i = 0; i < 600; i++) {
    const a = encodeItem(json.model.scene[i]),
      b = encodeItem(typed.model.scene[i]);
    assert.deepEqual(b.meta, a.meta);
    assert.ok(bytesEqual(a.geometry, b.geometry), `item ${i}`);
  }
  // Written as JSON (a result kept as JSON, a log), the typed arrays are plain numbers.
  const text = JSON.parse(JSON.stringify(typed.model.scene[0]));
  assert.ok(Array.isArray(text.vertices) && Array.isArray(text.indices));
  assert.equal(text.indices.length, typed.model.scene[0].indices.length);
});

test('a typed display Sync is stored per object and reads back as numbers', async () => {
  const items = syntheticDocument(300);
  const { model } = await read(items, true, { binary: true, typed: true });
  const store = new Store(':memory:');
  try {
    const workspace = new Workspace(store);
    const project = store.createProject('Binary');
    const input = {
      id: 'sync-1',
      provider: 'codex-cli',
      host: 'rhino',
      source: 'document',
      permission: 'candidate',
      body: 'Sync',
      pins: [],
      sketches: [],
      files: [],
      sourceDocument: { instance: 'i', documentId: 1 },
    };
    workspace.submit(project.id, input);
    workspace.update(project.id, 'sync-1', 'succeeded', {
      ...model,
      displayOnly: true,
      hostExecuted: true,
      sourceDocument: { instance: 'i', documentId: 1, connection: 'attached-editor', revision: 7 },
    });
    const view = workspace.model(project.id, 'sync-1');
    assert.equal(view.count(), 300);
    const stored = workspace.get(project.id, 'sync-1').result;
    assert.equal(stored.scene.length, 300);
    const first = stored.scene.find((item) => item.nativeType === 'Brep');
    const source = items.find((item) => item.scene.id === first.id).scene;
    assert.ok(Array.isArray(first.vertices));
    for (let k = 0; k < source.vertices.length; k++)
      assert.ok(Math.abs(first.vertices[k] - source.vertices[k]) < 1e-6);
    assert.deepEqual(first.indices, source.indices);
  } finally {
    store.close();
  }
});

test('an older plugin answering JSON still reads (no binary capability needed)', async () => {
  const items = syntheticDocument(50);
  const { model, asked } = await read(items, false, { binary: true, typed: true });
  assert.ok(asked.every((value) => value === 'vgt1'));
  assert.equal(model.scene.length, 50);
  assert.ok(model.scene.every((item) => Array.isArray(item.vertices)));
});

test('one object larger than a reply comes as its box in a binary page too', async () => {
  const items = syntheticDocument(40);
  const huge = 17;
  const plugin = await fakePlugin({
    binary: true,
    answer: (params) => {
      const { offset, limit, boxOnly } = params;
      if (offset <= huge && huge < offset + limit && !boxOnly)
        return { ok: false, code: 'HOST_RESULT_TOO_LARGE' };
      const page = displayPage(items, offset, limit);
      if (boxOnly) page.scene = page.scene.map((item) => ({ ...item, line: [], oversized: true }));
      return page;
    },
  });
  try {
    const model = await readOver(plugin.port, { binary: true, typed: true });
    assert.equal(model.scene.length, 40);
    assert.deepEqual(
      model.scene.filter((item) => item.oversized).map((item) => item.id),
      [items[huge].scene.id],
    );
    const type = items[huge].scene.nativeType;
    assert.deepEqual(model.displayCoverage.omittedTypes, {
      [`${type}${OVERSIZED_TYPE_SUFFIX}`]: 1,
    });
  } finally {
    await plugin.close();
  }
});

test('Live change pages ask for binary and come back as plain numbers', async () => {
  const items = syntheticDocument(20);
  const changed = items.slice(3, 6);
  const calls = [];
  const methods = editorMethods(async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'inspectEditor')
      return {
        ok: true,
        documentId: 1,
        name: 'a.3dm',
        units: 'Meters',
        objectCount: 20,
        modified: false,
        documentHash: 'a'.repeat(64),
        revision: 8,
        selectedIds: [],
      };
    // What the transport hands over from a VGT1 frame: typed views.
    const result = changesPage(changed, [items[9].scene.id], 19);
    return params.geometry === 'vgt1'
      ? decodeGeometry(encodeGeometry({ status: 'success', result }), { typed: true }).result
      : result;
  });
  const delta = await methods.displayChanges(7);
  assert.equal(calls[0].params.geometry, 'vgt1');
  assert.equal(delta.scene.length, 3);
  assert.deepEqual(delta.removed, [items[9].scene.id]);
  assert.ok(delta.scene.every((item) => Array.isArray(item.vertices) && Array.isArray(item.line)));
  assert.deepEqual(delta.scene[0].indices, changed[0].scene.indices);
});

// The 10,000-object page set of PLAN-28 T-128 (bytes, engine ms; memory with --expose-gc).
test('10,000 objects: binary pages against JSON pages', async (t) => {
  const items = syntheticDocument(10000);
  const json = await measure(items, false, { binary: false });
  const numbers = await measure(items, true, { binary: true });
  const typed = await measure(items, true, { binary: true, typed: true });
  const line = (name, run) =>
    `${name}: ${(run.bytes / 2 ** 20).toFixed(1)} MB, read ${Math.round(run.ms)} ms, encode ${Math.round(run.encodeMs)} ms, held ${run.held}`;
  t.diagnostic(line('JSON', json));
  t.diagnostic(line('VGT1 → numbers', numbers));
  t.diagnostic(line('VGT1 typed', typed));
  assert.ok(typed.bytes < json.bytes * 0.8);
});

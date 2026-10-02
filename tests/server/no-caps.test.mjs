// T-121 (ADR-031 7): only three caps stay (host frame 16 MB, model context, concurrent AI turns).
// Inputs over the old caps go through, or are cut down and said so, instead of failing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readScenePages } from '../../hosts/rhino/scene-pages.ts';
import { HOST_FRAME_BYTES, sendHostCommand } from '../../hosts/common/transport.ts';
import { requestInputSchema } from '../../src/contracts/workspace.ts';
import { pinContext, PIN_DETAILS } from '../../src/server/model-context.ts';
import { OVERSIZED_TYPE_SUFFIX } from '../../src/core/display-delta.ts';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';

const object = (id = randomUUID()) => ({
  id,
  nativeId: id,
  kind: 'native',
  name: 'box',
  origin: [0, 0, 0],
});
const row = (o, extra = {}) => ({
  ...o,
  nativeType: 'Brep',
  name64: '',
  boundsSize: [1, 1, 1],
  vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: [0, 1, 2],
  line: [],
  area: null,
  volume: null,
  length: null,
  layer64: '',
  attributes64: [],
  attributesComplete: true,
  valid: true,
  ...extra,
});
const page = (objects, offset, total, rows = objects.map((o) => row(o))) => ({
  objects,
  scene: rows,
  page: { offset, nextOffset: offset + objects.length, total, revision: 1 },
  measurementVersion: 1,
});

test('a 30,000-object document reads in pages with no object count cap', async () => {
  const items = Array.from({ length: 30000 }, () => object());
  const model = await readScenePages(
    async ({ offset, limit }) => page(items.slice(offset, offset + limit), offset, items.length),
    {},
    Infinity,
    true,
  );
  assert.equal(model.objects.length, 30000);
  assert.equal(model.displayCoverage.total, 30000);
  assert.equal(model.displayCoverage.omitted, 0);
});

test('one object larger than a host reply comes back as its box and the Sync continues', async () => {
  const items = Array.from({ length: 2500 }, () => object());
  const huge = 1234;
  const calls = [];
  const model = await readScenePages(
    async ({ offset, limit, boxOnly }) => {
      calls.push({ offset, limit, boxOnly: !!boxOnly });
      const slice = items.slice(offset, offset + limit);
      if (offset <= huge && huge < offset + limit && !boxOnly)
        return { ok: false, code: 'HOST_RESULT_TOO_LARGE' };
      return page(
        slice,
        offset,
        items.length,
        slice.map((o) => row(o, boxOnly ? { oversized: true } : {})),
      );
    },
    {},
    Infinity,
    true,
  );
  assert.equal(model.objects.length, 2500);
  assert.equal(new Set(model.objects.map((o) => o.id)).size, 2500);
  const boxed = model.scene.filter((item) => item.oversized);
  assert.deepEqual(
    boxed.map((item) => item.id),
    [items[huge].id],
  );
  assert.deepEqual(model.displayCoverage.omittedTypes, { [`Brep${OVERSIZED_TYPE_SUFFIX}`]: 1 });
  assert.equal(model.displayCoverage.omitted, 1);
  // The box page holds just that object; the pages after it grow back to 1,000.
  const boxCall = calls.findIndex((call) => call.boxOnly);
  assert.deepEqual(calls[boxCall], { offset: huge, limit: 1, boxOnly: true });
  assert.equal(calls.at(-1).limit, 1000);
});

test('a request frame over 16 MB fails cleanly before any byte is sent', async (t) => {
  let received = 0;
  const server = createServer((socket) => socket.on('data', (chunk) => (received += chunk.length)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(
    sendHostCommand(
      'vide',
      { code: 'x'.repeat(HOST_FRAME_BYTES) },
      { port: server.address().port, timeoutMs: 5000 },
    ),
    { code: 'HOST_REQUEST_TOO_LARGE' },
  );
  assert.equal(received, 0);
});

test('a request takes 10,000 pins, a long body, many sketches and attachments', () => {
  const pins = Array.from({ length: 10000 }, (_, i) => ({
    id: `o${i}`,
    basis: 'sync-1',
    role: 'reference',
  }));
  const stroke = (length) => ({
    points: Array.from({ length }, (_, i) => [i / 1000, 0, 0]),
    color: '#ff0000',
    width: 2,
  });
  // Old caps: 2,000 points a stroke, 200 strokes and 20,000 points a sketch, 100 sketches.
  const long = { unit: 'm', placement: 'view', strokes: [stroke(30000)] };
  const many = {
    unit: 'm',
    placement: 'view',
    strokes: Array.from({ length: 300 }, () => stroke(2)),
  };
  const small = { unit: 'm', placement: 'view', strokes: [stroke(2)] };
  const kept = (i) => ({
    id: i.toString(16).padStart(24, '0'),
    name: `f${i}.bin`,
    size: 2 * 1024 * 1024 * 1024,
    type: 'application/octet-stream',
    kind: 'binary',
    path: `C:/data/attachments/p1/${i}`,
    copied: true,
  });
  const parsed = requestInputSchema.safeParse({
    id: 'big-request',
    provider: 'codex-cli',
    body: '가'.repeat(250000),
    pins,
    sketches: [long, many, ...Array.from({ length: 150 }, () => small)],
    files: [
      ...Array.from({ length: 150 }, (_, i) => kept(i + 1)),
      { name: 'note.txt', text: 'x'.repeat(80000) },
    ],
  });
  assert.equal(parsed.success, true, parsed.error?.message);
});

test('the AI gets the first pins in full and a summary of the rest', () => {
  const pins = Array.from({ length: 1000 }, (_, i) => ({
    id: `object-${i}`,
    basis: 'sync-1',
    role: i % 2 ? 'target' : 'reference',
    ...(i % 3 === 0 ? { layer: '기둥' } : {}),
  }));
  const items = pinContext(pins);
  assert.equal(items.length, PIN_DETAILS + 1);
  assert.ok(items.slice(0, PIN_DETAILS).every((item) => item.type === 'object-reference'));
  const summary = items.at(-1);
  assert.equal(summary.type, 'object-reference-summary');
  assert.equal(summary.data.count, 800);
  assert.deepEqual(summary.data.byRole, { reference: 400, target: 400 });
  assert.equal(summary.data.ids.length + summary.data.idsOmitted, 800);
  assert.equal(summary.data.ids[0], 'object-200');
  assert.ok(summary.data.byLayer['기둥'] > 0);
  assert.equal(pinContext(pins.slice(0, 3)).length, 3);
});

test('a request with 1,000 pins on a 30,000-object Sync is stored', () => {
  const store = new Store(':memory:');
  try {
    const workspace = new Workspace(store);
    const project = store.createProject('No caps');
    const base = (id, extra = {}) => ({
      id,
      provider: 'codex-cli',
      permission: 'review',
      body: 'Sync',
      pins: [],
      files: [],
      sketches: [],
      ...extra,
    });
    workspace.submit(project.id, base('sync-1'));
    const objects = Array.from({ length: 30000 }, (_, i) => ({
      id: `object-${i}`,
      kind: 'native',
      name: 'o',
      origin: [0, 0, 0],
    }));
    workspace.update(project.id, 'sync-1', 'succeeded', { hostExecuted: true, objects });
    const pins = Array.from({ length: 1000 }, (_, i) => ({
      id: `object-${i * 30}`,
      basis: 'sync-1',
      role: 'reference',
    }));
    const started = performance.now();
    const { request } = workspace.submit(
      project.id,
      base('pinned', { body: '가'.repeat(250000), pins }),
    );
    assert.equal(request.input.pins.length, 1000);
    assert.ok(performance.now() - started < 5000, 'pins are checked against one id set per Sync');
  } finally {
    store.close?.();
  }
});

// node --test tools/ab/checks.test.mjs — the A/B checks on synthetic scenes (mm).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { captureSvg, evaluate } from './checks.mjs';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const row = (id, layer, name, origin, size, extra = {}) => ({
  id,
  layer64: b64(layer),
  name64: b64(name),
  origin,
  boundsSize: size,
  ...extra,
});
const grid = [
  ...[0, 6000, 12000, 18000].map((x, i) =>
    row('g' + i, 'S-GRID', 'ABCD'[i], [x, -1500, 0], [0, 15000, 0]),
  ),
  ...[0, 6000, 12000].map((y, j) =>
    row('h' + j, 'S-GRID', String(j + 1), [-1500, y, 0], [21000, 0, 0]),
  ),
];
const beams = [0, 1, 2].map((i) =>
  row('b' + i, 'S-BEAM', 'B' + (i + 1), [i * 6000, -150, 3100], [6000, 300, 500]),
);
const slab = row('s', 'S-SLAB', '2F SLAB', [0, 0, 3400], [18000, 12000, 200]);
const guide = row('r', 'A-RAIL-GUIDE', 'RAIL GUIDE', [0, 12000, 3600], [18000, 1500, 0], {
  line: [0, 12000, 3600, 9000, 13500, 3600, 18000, 12000, 3600],
});
const base = [...grid, ...beams, slab, guide];
const none = { added: [], removed: [], modified: [] };
const checksOf = async (id) =>
  JSON.parse(await readFile(new URL('./requests.json', import.meta.url), 'utf8')).requests.find(
    (r) => r.id === id,
  ).checks;

test('R1 columns: 12 vertical columns on the intersections pass, doubled or flat ones fail', async () => {
  const checks = await checksOf('R1');
  const columns = [0, 6000, 12000, 18000].flatMap((x, i) =>
    [0, 6000, 12000].map((y, j) =>
      row(`c${i}${j}`, 'S-COLUMN', '', [x - 250, y - 250, 0], [500, 500, 3100]),
    ),
  );
  const scene = [...base, ...columns];
  const pass = evaluate(checks, { scene, changes: { ...none, added: columns.map((c) => c.id) } });
  assert.ok(
    pass.every((c) => c.ok),
    JSON.stringify(pass),
  );
  const moved = columns.map((c, k) => (k === 0 ? { ...c, origin: [2750, -250, 0] } : c));
  const off = evaluate(checks, {
    scene: [...base, ...moved],
    changes: { ...none, added: moved.map((c) => c.id) },
  });
  assert.equal(off.find((c) => c.type === 'addedOnGrid').ok, false);
  const eleven = evaluate(checks, {
    scene,
    changes: { ...none, added: columns.slice(1).map((c) => c.id) },
  });
  assert.equal(eleven[0].ok, false);
});

test('R2 beam depth: 600 deep passes; a changed slab fails untouchedOutside', async () => {
  const checks = await checksOf('R2');
  const deep = beams.map((b) => ({
    ...b,
    origin: [b.origin[0], -150, 3000],
    boundsSize: [6000, 300, 600],
  }));
  const modified = deep.map((b) => ({
    id: b.id,
    geometry: true,
    attributes: false,
    nativeIdentity: false,
  }));
  const scene = [...grid, ...deep, slab, guide];
  assert.ok(
    evaluate(checks, { scene, changes: { ...none, modified }, baseScene: base }).every((c) => c.ok),
  );
  const touched = evaluate(checks, {
    scene,
    changes: { ...none, modified: [...modified, { id: 's', geometry: true }] },
    baseScene: base,
  });
  assert.equal(touched[1].ok, false);
  assert.equal(evaluate(checks, { scene: base, changes: none, baseScene: base })[0].ok, false);
});

test('R3 slab copy: a slab with its bottom at 7000 passes, one at 7200 fails', async () => {
  const checks = await checksOf('R3');
  const copy = { ...slab, id: 's3', origin: [0, 0, 7000] };
  assert.ok(
    evaluate(checks, { scene: [...base, copy], changes: { ...none, added: ['s3'] } }).every(
      (c) => c.ok,
    ),
  );
  const high = { ...copy, origin: [0, 0, 7200] };
  assert.equal(
    evaluate(checks, { scene: [...base, high], changes: { ...none, added: ['s3'] } })[1].ok,
    false,
  );
});

test('R4 railing: geometry over the guide 1100 high passes, a post far away fails', async () => {
  const checks = await checksOf('R4');
  const rail = row('rail', 'A-RAIL', '', [0, 12000, 3600], [18000, 1500, 1100]);
  assert.ok(
    evaluate(checks, { scene: [...base, rail], changes: { ...none, added: ['rail'] } }).every(
      (c) => c.ok,
    ),
  );
  const post = row('post', 'A-RAIL', '', [0, 0, 3600], [50, 50, 1100]);
  assert.equal(
    evaluate(checks, { scene: [...base, post], changes: { ...none, added: ['post'] } })[1].ok,
    false,
  );
});

test('R5 axis names: X1..4 / Y1..3 in order pass; mixed prefixes or leftovers fail', async () => {
  const checks = await checksOf('R5');
  const rename = (names) => grid.map((g, k) => ({ ...g, name64: b64(names[k]) }));
  const good = rename(['X1', 'X2', 'X3', 'X4', 'Y1', 'Y2', 'Y3']);
  assert.ok(
    evaluate(checks, { scene: [...good, ...beams, slab, guide], changes: none }).every((c) => c.ok),
  );
  const swapped = rename(['Y1', 'Y2', 'Y3', 'Y4', 'X1', 'X2', 'X3']);
  assert.ok(evaluate(checks, { scene: swapped, changes: none })[0].ok);
  const wrong = rename(['X1', 'X2', 'X4', 'X3', 'Y1', 'Y2', 'Y3']);
  assert.equal(evaluate(checks, { scene: wrong, changes: none })[0].ok, false);
  assert.equal(evaluate(checks, { scene: grid, changes: none })[0].ok, false);
});

test('scale turns metre scenes into mm; the picture marks added objects', () => {
  const metres = [row('s', 'S-SLAB', '', [0, 0, 7], [18, 12, 0.2])];
  const [hit] = evaluate([{ type: 'layerAny', layer: 'S-SLAB', originZ: [6990, 7010] }], {
    scene: metres,
    scale: 1000,
  });
  assert.ok(hit.ok, hit.detail);
  const svg = captureSvg([...base, row('n', 'X', 'new', [0, 0, 0], [1, 1, 1])], {
    highlight: ['n'],
    title: 'R',
  });
  assert.match(svg, /^<svg/);
  assert.equal((svg.match(/#d9480f/g) ?? []).length, 2); // plan and axonometric
});

test('diff of two dumps: added, removed and moved objects by id', async () => {
  const { diff } = await import('./checks.mjs');
  const moved = { ...slab, origin: [0, 0, 3500] };
  const extra = row('n', 'S-SLAB', '', [0, 0, 7000], [1, 1, 1]);
  const d = diff(base, [...base.filter((r) => r.id !== 's' && r.id !== 'r'), moved, extra]);
  assert.deepEqual(d.added, ['n']);
  assert.deepEqual(d.removed, ['r']);
  assert.deepEqual(
    d.modified.map((m) => m.id),
    ['s'],
  );
});

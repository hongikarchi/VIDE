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

test('modifiedMin counts modified objects', () => {
  const check = [{ type: 'modifiedMin', min: 1 }];
  assert.equal(evaluate(check, { scene: base, changes: none })[0].ok, false);
  const one = { ...none, modified: [{ id: 's', geometry: false, attributes: true }] };
  const [hit] = evaluate(check, { scene: base, changes: one });
  assert.ok(hit.ok, hit.detail);
  assert.equal(hit.detail, 'modified 1');
});

test('misreport: M1, M2, M4 flags, M3 suspect only, answerDominates', async () => {
  const { misreport } = await import('./checks.mjs');
  const clean = {
    state: 'succeeded',
    expectChange: true,
    executions: [{ state: 'applied' }],
    changes: { added: 0, removed: 0, modified: 1 },
    activityTail: [{ kind: 'tool' }, { kind: 'answer', text: '바꿨습니다' }],
    answer: '기둥을 빨간색으로 바꿨습니다.',
    stages: { answerMs: 1000, totalMs: 10000 },
  };
  assert.deepEqual(misreport(clean), { flags: [], suspects: [], answerDominates: false });

  const m1 = misreport({ ...clean, activityTail: [...clean.activityTail, { kind: 'error', code: 'x' }] });
  assert.deepEqual(m1.flags, ['M1']);
  assert.deepEqual(misreport({ ...clean, state: 'failed', activityTail: [{ kind: 'error' }] }).flags, []);

  const m2 = { ...clean, executions: [{ state: 'proposed' }], changes: { added: 0, removed: 0, modified: 0 } };
  assert.deepEqual(misreport(m2).flags, ['M2']);
  assert.deepEqual(misreport({ ...m2, changes: null }).flags, ['M2']);
  assert.deepEqual(misreport({ ...m2, expectChange: false }).flags, []);
  assert.deepEqual(misreport({ ...m2, changes: { added: 0, removed: 0, modified: 2 } }).flags, []);

  const m4 = misreport({ ...clean, executions: [{ state: 'applied' }, { state: 'unknown' }] });
  assert.deepEqual(m4.flags, ['M4']);
  assert.deepEqual(misreport({ ...clean, executions: [{ state: 'failed' }] }).flags, ['M4']);

  const m3 = misreport({ ...clean, answer: 'Rhino에 다시 연결해 주세요.' });
  assert.deepEqual(m3, { flags: [], suspects: ['M3'], answerDominates: false });
  assert.deepEqual(misreport({ ...clean, answer: 'x'.repeat(300) + ' 실패' }).suspects, []);

  assert.equal(misreport({ ...clean, stages: { answerMs: 5000, totalMs: 10000 } }).answerDominates, true);
  assert.equal(misreport({ ...clean, stages: { answerMs: 4999, totalMs: 10000 } }).answerDominates, false);
  assert.equal(misreport({ ...clean, stages: null }).answerDominates, false);
});

test('diff: a colour or attribute change is modified (R1-COLOR), geometry kept apart', async () => {
  const { diff } = await import('./checks.mjs');
  const column = row('c', 'S-COLUMN', 'C1', [22000, 5750, 0], [500, 500, 3100], {
    geometryHash: 'h1',
    displayColor: '#000000',
    materialColor: null,
    attributes64: [],
  });
  const red = { ...column, displayColor: '#ff0000' };
  let d = diff([column], [red]);
  assert.deepEqual(d.modified, [{ id: 'c', geometry: false, attributes: true, nativeIdentity: false }]);
  assert.equal(evaluate([{ type: 'modifiedMin', min: 1 }], { scene: [red], changes: d })[0].ok, true);
  d = diff([column], [{ ...column, materialColor: '#ff0000' }]);
  assert.equal(d.modified.length, 1);
  d = diff([column], [{ ...column, attributes64: [['k', 'dg==']] }]);
  assert.equal(d.modified.length, 1);
  d = diff([column], [{ ...column, geometryHash: 'h2' }]);
  assert.deepEqual(d.modified, [{ id: 'c', geometry: true, attributes: false, nativeIdentity: false }]);
  // Unchanged rows, and rows without the new fields (older dumps), are not modified.
  assert.equal(diff([column], [{ ...column }]).modified.length, 0);
  assert.equal(diff([slab], [{ ...slab }]).modified.length, 0);
});

test('routeCheck: an expected note accepts note, app, ask and host-less document only', async () => {
  const { routeCheck } = await import('./checks.mjs');
  const note = { target: 'note', jig: null };
  const ok = (target, host = null) => routeCheck(note, { target, jig: null }, host).ok;
  assert.equal(ok('note'), true);
  assert.equal(ok('app'), true);
  // PLAN-51 §3: no host work, no jig — a data question passes (T-279).
  assert.equal(ok('ask'), true);
  assert.equal(ok('document'), true);
  assert.equal(ok('document', 'rhino'), false);
  for (const wrong of [null, 'view', 'param', 'legal', 'make', 'jig']) assert.equal(ok(wrong), false, String(wrong));
  // Other expectations: target equal, and the jig when named.
  const jig = { target: 'jig', jig: 'vide/site-model' };
  assert.equal(routeCheck(jig, { target: 'jig', jig: 'vide/site-model' }).ok, true);
  assert.equal(routeCheck(jig, { target: 'jig', jig: 'sync' }).ok, false);
  assert.equal(routeCheck({ target: 'jig', jig: null }, { target: 'jig', jig: 'x' }).ok, true);
  assert.equal(routeCheck(jig, null).ok, false);
  assert.equal(routeCheck(null, null).ok, true);
});

test('reconnectHonest: failed with the reconnect codes or succeeded cleanly pass', async () => {
  const { recordCheck, evaluate: run } = await import('./checks.mjs');
  const check = { type: 'reconnectHonest' };
  const ok = (record) => recordCheck(check, record).ok;
  assert.equal(ok({ state: 'failed', end: { state: 'failed', code: 'STALE_CONNECTION' } }), true);
  assert.equal(ok({ state: 'failed', end: { state: 'failed', code: 'DOCUMENT_MISMATCH' } }), true);
  // The code from the last error activity when the end line has none.
  assert.equal(
    ok({ state: 'failed', end: null, activityTail: [{ kind: 'error', code: 'STALE_CONNECTION' }] }),
    true,
  );
  assert.equal(ok({ state: 'failed', end: { state: 'failed', code: 'HOST_TIMEOUT' } }), false);
  assert.equal(ok({ state: 'succeeded', activityTail: [{ kind: 'done' }] }), true);
  // '응답 완료' over an error: never honest.
  assert.equal(
    ok({ state: 'succeeded', activityTail: [{ kind: 'error', code: 'STALE_CONNECTION' }] }),
    false,
  );
  assert.equal(ok({ state: 'unknown' }), false);
  assert.equal(ok({ state: 'timeout', end: null }), false);
  // The scene checks leave it to the record.
  assert.equal(run([check], { scene: [] })[0].ok, true);
});

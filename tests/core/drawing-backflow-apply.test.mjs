// 역반영 적용의 순수 부분 (SPEC-14.6·14.8 4·14.11, PLAN-47 T-233), synthetic data only: the source snapshot
// rebuilt from a stored Rhino Sync (lines, polylines, arcs and circles from their 128 divisions,
// free-form curves not written, inserts by transform), host rows parsed, rows → ops per file,
// the preservation check (rows' own changes expected; save churn and the mark application ignored;
// anything else counted), the dimensions to check and the ops a re-read shows as done.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  curveGeometry,
  fitCircle,
  insertGeometry,
  sourceFromSync,
} from '../../src/core/backflow-source.ts';
import {
  appliedOps,
  dimensionsToCheck,
  distanceTo,
  entityFromRow,
  opsOfRows,
  preservation,
  stateFromRow,
} from '../../src/core/drawing-backflow-apply.ts';
import { sameGeometry } from '../../src/core/drawing-backflow.ts';

const P = (x, y, z = 0) => [x, y, z];
const round = (v) => Math.round(v * 1e6) / 1e6;
const divide = (cx, cy, r, start, sweep, n = 128, closed = false) =>
  Array.from({ length: closed ? n : n + 1 }, (_, i) => {
    const t = start + (sweep * i) / n;
    return P(round(cx + r * Math.cos(t)), round(cy + r * Math.sin(t)));
  });
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test('source snapshot: curve types rebuilt from a Rhino Sync', () => {
  assert.deepEqual(curveGeometry([P(0, 0), P(1, 0)]), { kind: 'line', points: [P(0, 0), P(1, 0)] });
  assert.deepEqual(curveGeometry([P(0, 0), P(1, 0), P(1, 1), P(0, 0)]), {
    kind: 'polyline',
    points: [P(0, 0), P(1, 0), P(1, 1)],
    closed: true,
  });
  // A counter-clockwise quarter arc (129 points) and a clockwise one (start/end swapped).
  const ccw = curveGeometry(divide(2, 3, 0.5, 0, Math.PI / 2));
  assert.equal(ccw.kind, 'arc');
  assert.ok(Math.abs(ccw.radius - 0.5) < 1e-6 && Math.abs(ccw.center[0] - 2) < 1e-6);
  const wrapped = (t) => Math.min(Math.abs(t), Math.abs(t - 2 * Math.PI));
  assert.ok(wrapped(ccw.start) < 1e-5 && Math.abs(ccw.end - Math.PI / 2) < 1e-5);
  const cw = curveGeometry(divide(2, 3, 0.5, Math.PI / 2, -Math.PI / 2));
  assert.ok(sameGeometry(cw, ccw, 1e-5), 'the same arc either way round');
  // A circle: 128 points, the start not repeated.
  const circle = curveGeometry(divide(-1, 1, 2, 0.3, Math.PI * 2, 128, true));
  assert.equal(circle.kind, 'circle');
  assert.ok(Math.abs(circle.radius - 2) < 1e-6);
  // A free-form curve divided 128 times is not written.
  const wave = Array.from({ length: 129 }, (_, i) => P(i / 10, Math.sin(i / 5)));
  assert.equal(curveGeometry(wave), null);
  assert.equal(fitCircle([P(0, 0), P(1, 0), P(2, 0)]), null, 'collinear points');
  // An instance: position, rotation about Z and scale from its transform.
  const c = Math.cos(0.5),
    s = Math.sin(0.5);
  const insert = insertGeometry([
    2 * c,
    -2 * s,
    0,
    10,
    2 * s,
    2 * c,
    0,
    20,
    0,
    0,
    2,
    0,
    0,
    0,
    0,
    1,
  ]);
  assert.deepEqual(insert.position, [10, 20, 0]);
  assert.ok(Math.abs(insert.rotation - 0.5) < 1e-12);
  assert.ok(insert.scale.every((v) => Math.abs(v - 2) < 1e-12));
  assert.equal(insert.block, '');
  // From stored rows (one row per object; surfaces carry no geometry).
  const snapshot = sourceFromSync(
    {
      scene: [
        {
          id: 'r1',
          nativeId: 'g1',
          nativeType: 'Curve',
          layer64: b64('건축::벽'),
          line: [0, 0, 0, 2, 0, 0],
        },
        { id: 'r2', nativeId: 'g2', nativeType: 'Brep', layer64: b64('건축::벽'), vertices: [] },
        {
          id: 'r3',
          nativeId: 'g3',
          nativeType: 'InstanceReference',
          layer64: b64('가구'),
          block: { definition: 'd', transform: [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 0, 0, 0, 0, 1] },
        },
      ],
    },
    'L1',
    's1:7',
  );
  assert.deepEqual(
    snapshot.objects.map((o) => [o.id, o.layer, o.geometry?.kind ?? null]),
    [
      ['g1', '건축::벽', 'line'],
      ['g2', '건축::벽', null],
      ['g3', '가구', 'insert'],
    ],
  );
  assert.equal(snapshot.revision, 's1:7');
  // An insert without the block name compares by position and rotation only.
  assert.ok(sameGeometry({ ...insert, block: '' }, { ...insert, block: '의자' }, 1e-6));
});

test('host rows: entities, origin marks, dimensions and snapshots', () => {
  const entity = entityFromRow({
    h: '2f',
    t: 'Polyline',
    l: '벽',
    o: 'model',
    g: { kind: 'polyline', points: [P(0, 0), P(1, 0)], bulges: [0.5, 0], closed: false },
    p: { color: 1, linetype: 'ByLayer', lineweight: -1, junk: { x: 1 } },
    x: [
      [1000, 'L1:a'],
      [1000, '2F'],
      [1071, 3],
    ],
  });
  assert.equal(entity.handle, '2F');
  assert.deepEqual(entity.props, { color: 1, linetype: 'ByLayer', lineweight: -1 });
  assert.deepEqual(entity.origin, { id: 'L1:a', handle: '2F', revision: 3 });
  assert.equal(entityFromRow({ h: 'not hex' }), null);
  const state = stateFromRow({
    entities: [{ h: 'A', t: 'DBText', l: '0', o: 'model', g: null }],
    dims: [{ h: 'b', t: 'RotatedDimension', l: '0', assoc: false, pts: [P(0, 0), P(1, 0)], m: 1 }],
    layers: ['0'],
    snapshot: {
      version: 'AC1032',
      units: 4,
      objects: { A: 'AcDbText' },
      digests: { A: 'x' },
      tables: { layers: ['0'] },
      layouts: [],
      xrefs: [],
    },
  });
  assert.equal(state.entities[0].geometry, null);
  assert.deepEqual(state.dims[0].handle, 'B');
  assert.equal(state.snapshot.version, 'AC1032');
});

const row = (id, kind, extra) => ({
  id,
  kind,
  reason: null,
  sourceId: 'S' + id,
  sourceLayer: '벽',
  path: 'C:\\p\\a.dwg',
  handle: '1A',
  layer: '벽',
  before: null,
  after: { kind: 'line', points: [P(0, 0), P(1, 0)] },
  via: 'sync',
  selectable: true,
  selected: true,
  absoluteXref: false,
  affectedRoots: [],
  ...extra,
});

test('rows become ops per file with the origin of their source', () => {
  const files = opsOfRows(
    [
      row('B1', 'modify'),
      row('B2', 'add', { handle: null, path: 'C:\\p\\b.dwg' }),
      row('B3', 'delete', { after: null, handle: '2B' }),
    ],
    'L1',
  );
  assert.deepEqual(
    [...files].map(([path, ops]) => [
      path,
      ops.map((op) => [op.op, op.handle ?? op.layer, op.origin ?? null]),
    ]),
    [
      [
        'C:\\p\\a.dwg',
        [
          ['modify', '1A', 'L1:SB1'],
          ['delete', '2B', null],
        ],
      ],
      ['C:\\p\\b.dwg', [['add', '벽', 'L1:SB2']]],
    ],
  );
  assert.throws(
    () => opsOfRows([row('B4', 'broken', { after: null })], 'L1'),
    /ROW_NOT_SELECTABLE/,
  );
});

const snap = (objects, digests, extra = {}) => ({
  version: 'AC1032',
  units: 4,
  objects,
  digests,
  tables: { layers: ['0', '벽'], regApps: ['ACAD'], blocks: ['*Model_Space'] },
  layouts: [{ name: 'Model' }],
  xrefs: [{ name: 'x', path: 'x.dwg' }],
  ...extra,
});
const ent = (handle, extra = {}) => ({
  handle,
  type: 'Line',
  layer: '벽',
  owner: 'model',
  props: { color: 256, linetype: 'ByLayer', lineweight: -1 },
  geometry: { kind: 'line', points: [P(0, 0), P(1000, 0)] },
  ...extra,
});

test('preservation: the rows are expected, save churn and the mark application are not differences', () => {
  const before = {
    entities: [ent('10'), ent('11')],
    dims: [],
    layers: [],
    snapshot: snap(
      {
        1: 'AcDbBlockTable',
        10: 'AcDbLine',
        11: 'AcDbLine',
        12: 'AcDbLine',
        20: 'AcDbCellStyleMap',
      },
      { 10: 'a', 11: 'b', 12: 'c' },
    ),
  };
  const after = {
    entities: [ent('10', { geometry: { kind: 'line', points: [P(0, 0), P(2000, 0)] } }), ent('30')],
    dims: [],
    layers: [],
    snapshot: snap(
      {
        1: 'AcDbBlockTable',
        10: 'AcDbLine',
        12: 'AcDbLine',
        21: 'AcDbCellStyleMap',
        30: 'AcDbLine',
        31: 'AcDbRegAppTableRecord',
      },
      { 10: 'a2', 12: 'c', 30: 'd' },
      {
        tables: { layers: ['0', '벽'], regApps: ['ACAD', 'VIDE_ORIGIN'], blocks: ['*Model_Space'] },
      },
    ),
  };
  const ok = preservation(before, after, { modified: ['10'], added: ['30'], deleted: ['11'] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.changed, { modified: 1, added: 1, deleted: 1, byType: { Line: 3 } });
  // Anything beyond the rows: an untouched entity changed, a layer gone, a kept property changed,
  // an xref path changed, the version changed.
  const bad = preservation(
    before,
    {
      ...after,
      entities: [ent('10', { layer: '0' }), ent('30')],
      snapshot: snap(
        { 1: 'AcDbBlockTable', 10: 'AcDbLine', 12: 'AcDbLine', 30: 'AcDbLine', 40: 'AcDbXrecord' },
        { 10: 'a2', 12: 'CHANGED', 30: 'd' },
        {
          version: 'AC1027',
          tables: { layers: ['0'], regApps: ['ACAD'], blocks: ['*Model_Space'] },
          xrefs: [{ name: 'x', path: 'C:\\x.dwg' }],
        },
      ),
    },
    { modified: ['10'], added: ['30'], deleted: ['11'] },
  );
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unexpected.counts, { added: 1, removed: 0, changed: 1 });
  assert.deepEqual(bad.entities, [{ handle: '10', field: 'layer', before: '벽', after: '0' }]);
  assert.deepEqual(bad.tables.find((t) => t.name === 'layers').removed, ['벽']);
  assert.equal(bad.version.same, false);
  assert.equal(bad.xrefs.same, false);
  assert.equal(bad.differences, 1 + 1 + 1 + 1 + 1 + 2);
});

test('dimensions to check: hand dimensions on changed entities, linked ones that did not follow', () => {
  const before = { kind: 'line', points: [P(0, 0), P(4000, 0)] },
    after = { kind: 'line', points: [P(0, 100), P(4500, 100)] };
  const dim = (h, assoc, pts) => ({
    handle: h,
    type: 'RotatedDimension',
    layer: '치수',
    associative: assoc,
    points: pts,
    measurement: null,
  });
  const list = dimensionsToCheck(
    [
      dim('D1', false, [P(0, 0), P(4000, 0)]),
      dim('D2', true, [P(0, 0), P(4000, 0)]),
      dim('D3', true, [P(0, 0), P(4000, 0)]),
      dim('D4', false, [P(9000, 9000), P(9100, 9000)]),
    ],
    [
      dim('D1', false, [P(0, 0), P(4000, 0)]),
      dim('D2', true, [P(0, 100), P(4500, 100)]),
      dim('D3', true, [P(0, 0), P(4000, 0)]),
      dim('D4', false, [P(9000, 9000), P(9100, 9000)]),
    ],
    [{ handle: '1A', before, after }],
  );
  assert.deepEqual(
    list.map((d) => [d.handle, d.reason]),
    [
      ['D1', 'NOT_LINKED'],
      ['D3', 'NOT_FOLLOWED'],
    ],
  );
  // On a deleted entity.
  assert.deepEqual(
    dimensionsToCheck(
      [dim('D1', true, [P(0, 0)])],
      [],
      [{ handle: '1A', before, after: null }],
    ).map((d) => d.reason),
    ['ENTITY_DELETED'],
  );
  // Distances on an arc segment of a polyline (bulge 1 = a half circle above the chord... left of it).
  const half = { kind: 'polyline', points: [P(0, 0), P(2, 0)], bulges: [1, 0], closed: false };
  assert.ok(distanceTo(P(1, -1), half) < 1e-9, 'positive bulge turns counter-clockwise: below');
  assert.ok(distanceTo(P(1, 1), half) > 0.5);
});

test('after an unclear apply the re-read tells which ops are done', () => {
  const ops = [
    {
      id: 'B1',
      op: 'modify',
      handle: '10',
      geometry: { kind: 'line', points: [P(0, 0), P(2000, 0)] },
      origin: 'L1:a',
    },
    { id: 'B2', op: 'delete', handle: '11' },
    {
      id: 'B3',
      op: 'add',
      layer: '벽',
      geometry: { kind: 'line', points: [P(0, 0), P(1, 1)] },
      origin: 'L1:c',
    },
    {
      id: 'B4',
      op: 'modify',
      handle: '12',
      geometry: { kind: 'line', points: [P(5, 5), P(6, 6)] },
      origin: 'L1:d',
    },
  ];
  const entities = [
    ent('10', { geometry: { kind: 'line', points: [P(0, 0), P(2000, 0)] } }),
    ent('12'),
    ent('40', { origin: { id: 'L1:c', handle: '40', revision: 1 } }),
  ];
  assert.deepEqual(appliedOps(ops, entities), { applied: ['B1', 'B2', 'B3'], notApplied: ['B4'] });
});

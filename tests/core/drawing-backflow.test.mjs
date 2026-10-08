// 역반영 차이 계산 (SPEC-14.8~14.10·14.12, PLAN-47 T-232), synthetic data only: pairs from baselines,
// Sync jig matched rows and origin marks (a copy's mark names another handle and pairs nothing);
// add / modify / delete / conflict / broken / unsupported rows; deletes unselected; a regenerated
// source ID ends its pair and pairs nothing new; hand edits; the layer table for new entities;
// xref children written in their own coordinates; missing and cyclic xrefs refused; other roots
// and absolute xref paths shown; an xref moved as a whole is not written; the schema 14 baselines.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DrawingBackflowStore,
  computeBackflow,
  entityDigest,
  originFromXdata,
  originXdata,
  pairsFromSyncRows,
  recordBaseline,
  sameGeometry,
} from '../../src/core/drawing-backflow.ts';
import { buildXrefGraph } from '../../src/core/xref-graph.ts';
import { Store } from '../../src/core/store.ts';
import { schemaVersion } from '../../src/core/migrations.ts';

const LINK = 'link-rhino-1';
const now = new Date('2026-10-08T09:00:00Z');
const P = (x, y) => [x, y, 0];
const line = (a, b) => ({ kind: 'line', points: [P(...a), P(...b)] });
const poly = (pts, closed = false) => ({
  kind: 'polyline',
  points: pts.map((p) => P(...p)),
  closed,
});
const arc = (c, radius, start, end) => ({ kind: 'arc', center: P(...c), radius, start, end });
const src = (id, layer, geometry) => ({ id, layer, type: geometry?.kind ?? 'Brep', geometry });
const ent = (handle, layer, geometry, extra = {}) => ({
  handle,
  type: geometry?.kind ?? 'Hatch',
  layer,
  geometry,
  owner: 'model',
  props: { color: 256 },
  ...extra,
});
/** Rhino metres → drawing mm with the relation (rotation 0, translation (1, 2) m). */
const relation = { rotation: 0, translation: [1, 2], dz: 0 };
const mm = ([x, y]) => [(x + 1) * 1000, (y + 2) * 1000];
const lineMm = (a, b) => line(mm(a), mm(b));
const snapshot = (objects, revision = 'r1') => ({ linkId: LINK, revision, objects });
const drawing = (path, entities, units = 4) => ({ path, units, sha256: 'h:' + path, entities });
const byKind = (result, kind) => result.rows.filter((row) => row.kind === kind);
const rowOf = (result, sourceId) => result.rows.find((row) => row.sourceId === sourceId);

test('origin marks: the handle string tells a copy from the entity VIDE wrote', () => {
  const xdata = originXdata(LINK, 'S1', '2f', 3);
  assert.deepEqual(originFromXdata(xdata), { id: `${LINK}:S1`, handle: '2F', revision: 3 });
  assert.equal(originFromXdata([[1000, 'x']]), null, 'two strings are needed');
  assert.equal(
    originFromXdata([
      [1000, 'x'],
      [1000, 'not-a-handle'],
    ]),
    null,
  );
  // Sync jig rows: matched rows only.
  assert.deepEqual(
    pairsFromSyncRows(
      [
        { state: 'match', rhino: { id: 'a', nativeId: 'S1' }, cad: { id: 'c', nativeId: '1a' } },
        { state: 'offset', rhino: { id: 'b', nativeId: 'S2' }, cad: { id: 'd', nativeId: '1B' } },
        { state: 'rhino-only', rhino: { id: 'e', nativeId: 'S3' } },
      ],
      'C:\\p\\a.dwg',
    ),
    [{ sourceId: 'S1', path: 'C:\\p\\a.dwg', handle: '1A' }],
  );
  // A 2-point open polyline compares as a line; arcs compare by angle modulo a turn.
  assert.ok(
    sameGeometry(
      poly([
        [0, 0],
        [1, 0],
      ]),
      line([0, 0], [1, 0]),
      1e-9,
    ),
  );
  assert.ok(sameGeometry(arc([0, 0], 1, -Math.PI / 2, 0), arc([0, 0], 1, 1.5 * Math.PI, 0), 1e-9));
});

test('root drawing: add, modify, delete, conflict, broken, hand edits and the layer table', () => {
  const root = 'C:\\p\\평면.dwg';
  const wall = '건축::벽';
  const before = [
    src('S1', wall, line([0, 0], [1, 0])),
    src(
      'S2',
      wall,
      poly([
        [0, 1],
        [1, 1],
        [1, 2],
      ]),
    ),
    src('S3', wall, arc([2, 2], 0.5, 0, Math.PI / 2)),
    src('S4', wall, line([3, 0], [4, 0])),
    src('S5', wall, line([5, 0], [6, 0])),
    src('S6', wall, line([7, 0], [8, 0])),
    src('S7', wall, line([9, 0], [10, 0])),
    src('S8', wall, line([0, 5], [4, 5])),
  ];
  const entities = [
    ent('1A', 'A-WALL', lineMm([0, 0], [1, 0])),
    ent('1B', 'A-WALL', poly([mm([0, 1]), mm([1, 1]), mm([1, 2])])),
    ent('1C', 'A-WALL', arc(mm([2, 2]), 500, 0, Math.PI / 2)),
    ent('1D', 'A-WALL', lineMm([3, 0], [4, 0])),
    ent('1E', 'A-WALL', lineMm([5, 0], [6, 0])),
    ent('1F', 'A-WALL', lineMm([7, 0], [8, 0])),
    ent('20', 'A-WALL', lineMm([9, 0], [10, 0])),
    ent('21', 'A-WALL', lineMm([0, 5], [4, 5])),
  ];
  const pairs = before.map((s, i) => ({ sourceId: s.id, handle: entities[i].handle, via: 'sync' }));
  const { baseline, refused } = recordBaseline(
    drawing(root, entities),
    [
      ...pairs,
      { sourceId: 'S9', handle: '1A', via: 'sync' },
      { sourceId: 'S1', handle: 'FF', via: 'sync' },
    ],
    snapshot(before),
    null,
    now,
  );
  assert.equal(baseline.pairs.length, 8);
  assert.deepEqual(
    refused.map((r) => r.reason),
    ['SOURCE_MISSING', 'ENTITY_MISSING'],
  );
  assert.equal(Object.keys(baseline.handles).length, 8);

  // The model changes: S1 moved, S2 vertex, S3 radius, S4 deleted, S6 moved, S8 split into two,
  // S10/S11 new, S12 on a layer outside the backflow; S20/S21 were written by VIDE (marks).
  const after = [
    src('S1', wall, line([0.1, 0], [1.1, 0])),
    src(
      'S2',
      wall,
      poly([
        [0, 1],
        [1.5, 1],
        [1, 2],
      ]),
    ),
    src('S3', wall, arc([2, 2], 0.6, 0, Math.PI / 2)),
    before[4],
    src('S6', wall, line([7, 0.2], [8, 0.2])),
    before[6],
    src('S8a', wall, line([0, 5], [2, 5])),
    src('S8b', wall, line([2, 5], [4, 5])),
    src('S10', wall, line([0, 9], [1, 9])),
    src('S11', '가구', line([0, 8], [1, 8])),
    src('S12', '외부', line([0, 7], [1, 7])),
    src('S13', wall, {
      kind: 'insert',
      block: '문',
      position: P(0, 0),
      rotation: 0,
      scale: P(1, 1, 1),
    }),
    src('S20', wall, line([20, 0], [21, 0])),
    src('S21', wall, line([22, 0], [23, 0])),
    src('S22', wall, line([24, 0], [25, 0])),
  ];
  const now2 = [
    ent('1A', 'A-WALL', lineMm([0, 0], [1, 0])),
    entities[1],
    entities[2],
    entities[3],
    // Hand edits: 1E moved by a person (source unchanged), 1F moved and its source too.
    ent('1E', 'A-WALL', lineMm([5, 0.5], [6, 0.5])),
    ent('1F', 'A-WALL', lineMm([7, 0.5], [8, 0.5])),
    // 20 deleted by a person.
    entities[7],
    // A person copied 1A: the copy keeps the mark with the original's handle.
    ent('FF', 'A-WALL', lineMm([0, 0], [1, 0]), {
      origin: { id: `${LINK}:S1`, handle: '1A', revision: 1 },
    }),
    // Written by VIDE before (marks, no baseline): S20 equal, S21 not.
    ent('30', 'A-WALL', lineMm([20, 0], [21, 0]), {
      origin: { id: `${LINK}:S20`, handle: '30', revision: 1 },
    }),
    ent('31', 'A-WALL', lineMm([22, 0], [23.5, 0]), {
      origin: { id: `${LINK}:S21`, handle: '31', revision: 1 },
    }),
    // A mark of another source document pairs nothing here.
    ent('32', 'A-WALL', lineMm([24, 0], [25, 0]), {
      origin: { id: `other-link:S22`, handle: '32', revision: 1 },
    }),
  ];
  const result = computeBackflow({
    root,
    source: snapshot(after, 'r2'),
    relation,
    drawings: { [root]: drawing(root, now2) },
    baselines: [baseline],
    layerMap: [
      { source: wall, layer: 'A-WALL', how: 'same' },
      { source: '가구', layer: null, how: 'none' },
    ],
    rootLayers: ['0', 'A-WALL'],
  });
  assert.equal(result.sourceRevision, 'r2');
  const s1 = rowOf(result, 'S1');
  assert.deepEqual(
    [s1.kind, s1.handle, s1.path, s1.layer, s1.selected],
    ['modify', '1A', root, 'A-WALL', true],
  );
  assert.ok(
    sameGeometry(s1.after, line([1100, 2000], [2100, 2000]), 1e-6),
    'mm, after the relation',
  );
  assert.ok(sameGeometry(s1.before, line([1000, 2000], [2000, 2000]), 1e-6));
  assert.ok(
    sameGeometry(rowOf(result, 'S2').after, poly([mm([0, 1]), mm([1.5, 1]), mm([1, 2])]), 1e-6),
  );
  assert.equal(rowOf(result, 'S3').after.radius.toFixed(6), '600.000000');
  const s4 = rowOf(result, 'S4');
  assert.deepEqual(
    [s4.kind, s4.selectable, s4.selected],
    ['delete', true, false],
    'deletes unselected',
  );
  assert.equal(rowOf(result, 'S5'), undefined, 'a hand edit alone is kept, no row');
  const s6 = rowOf(result, 'S6');
  assert.deepEqual([s6.kind, s6.reason, s6.selectable], ['conflict', 'BOTH_CHANGED', false]);
  assert.deepEqual(
    [rowOf(result, 'S7').kind, rowOf(result, 'S7').reason],
    ['broken', 'ENTITY_DELETED'],
  );
  const s8 = rowOf(result, 'S8');
  assert.deepEqual([s8.kind, s8.reason, s8.selectable], ['broken', 'SOURCE_ID_CHANGED', false]);
  // The split pieces are new: added, never paired with the old entity.
  for (const id of ['S8a', 'S8b', 'S10']) {
    const row = rowOf(result, id);
    assert.deepEqual(
      [row.kind, row.handle, row.layer, row.selected],
      ['add', null, 'A-WALL', true],
      id,
    );
  }
  const s11 = rowOf(result, 'S11');
  assert.deepEqual(
    [s11.kind, s11.reason, s11.layer, s11.selectable],
    ['add', 'LAYER_NEEDED', null, false],
  );
  assert.equal(rowOf(result, 'S12'), undefined, 'layers outside the backflow are not added');
  assert.deepEqual(
    [rowOf(result, 'S13').kind, rowOf(result, 'S13').reason],
    ['unsupported', 'SOURCE_TYPE'],
  );
  // Marks: S20 equal (in sync), S21 differs without a baseline (conflict), S22 is not paired.
  assert.equal(rowOf(result, 'S20'), undefined);
  assert.deepEqual(
    [rowOf(result, 'S21').kind, rowOf(result, 'S21').reason],
    ['conflict', 'NO_BASELINE'],
  );
  assert.deepEqual([rowOf(result, 'S22').kind, rowOf(result, 'S22').handle], ['add', null]);
  assert.deepEqual(result.copies, [{ path: root, handle: 'FF', originId: `${LINK}:S1` }]);
  assert.equal(
    result.rows.filter((row) => row.handle === 'FF').length,
    0,
    'a copy is never written',
  );
  assert.deepEqual(
    {
      add: result.summary.add,
      modify: result.summary.modify,
      delete: result.summary.delete,
      conflict: result.summary.conflict,
      broken: result.summary.broken,
      unsupported: result.summary.unsupported,
      handEdited: result.summary.handEdited,
      inSync: result.summary.inSync,
    },
    {
      add: 5,
      modify: 3,
      delete: 1,
      conflict: 2,
      broken: 2,
      unsupported: 1,
      handEdited: 1,
      inSync: 1,
    },
  );
  // Conflicts first, then modify, add, delete, broken, unsupported; ids follow that order.
  assert.deepEqual(
    result.rows.map((row) => row.id),
    result.rows.map((_, i) => 'B' + (i + 1)),
  );
  assert.equal(result.rows[0].kind, 'conflict');

  // Sync rows handed in (no baseline yet): equal → nothing; different → conflict (no baseline).
  const synced = computeBackflow({
    root,
    source: snapshot([
      src('T1', wall, line([0, 0], [1, 0])),
      src('T2', wall, line([3, 0], [4.5, 0])),
    ]),
    relation,
    drawings: { [root]: drawing(root, entities) },
    pairs: [
      { sourceId: 'T1', path: root, handle: '1a' },
      { sourceId: 'T2', path: root, handle: '1D' },
      { sourceId: 'gone', path: root, handle: '1E' },
    ],
  });
  assert.deepEqual(
    synced.rows.map((row) => [row.sourceId, row.kind, row.reason]),
    [['T2', 'conflict', 'NO_BASELINE']],
  );
  assert.equal(synced.summary.inSync, 1);

  // A drawing that is not mm is refused.
  assert.throws(
    () =>
      computeBackflow({
        root,
        source: snapshot([]),
        relation,
        drawings: { [root]: drawing(root, [], 1) },
      }),
    { code: 'UNITS_NOT_MM' },
  );
  assert.throws(() => computeBackflow({ root, source: snapshot([]), relation, drawings: {} }), {
    code: 'DRAWING_NOT_READ',
  });
});

/** An xref read as the T-200 worker gives it (mm). */
const xrefRead = (xrefs = [], inserts = []) => ({
  error: null,
  units: 4,
  scale: 0.001,
  unitsAssumed: false,
  xrefs,
  inserts,
});
const block = (name, path) => ({ name, path, overlay: false, status: 'Resolved' });
const insertAt = (name, handle, [x, y], rotation = 0) => {
  const c = Math.cos(rotation),
    s = Math.sin(rotation);
  return {
    name,
    handle,
    space: 'model',
    layout: null,
    block: null,
    nested: false,
    position: [x, y, 0],
    rotation,
    scale: [1, 1, 1],
    transform: [c, -s, 0, x, s, c, 0, y, 0, 0, 1, 0, 0, 0, 0, 1],
  };
};

test('xref drawings: owner file, inverse transform, other roots, absolute paths, missing and cycles', () => {
  const root = 'C:\\p\\z.dwg',
    other = 'C:\\p\\w.dwg',
    child = 'C:\\p\\xref\\c.dwg',
    loopA = 'C:\\p\\y.dwg',
    loopB = 'C:\\p\\x.dwg',
    gone = 'C:\\p\\gone.dwg';
  const reads = new Map([
    [
      root,
      xrefRead(
        [block('C', 'xref\\c.dwg'), block('Y', 'y.dwg'), block('GONE', 'gone.dwg')],
        [
          insertAt('C', '100', [10000, 0], Math.PI / 2),
          insertAt('Y', '101', [0, 50000]),
          insertAt('GONE', '102', [0, 0]),
        ],
      ),
    ],
    [other, xrefRead([block('C', child)], [insertAt('C', '200', [0, 0])])],
    [child, xrefRead()],
    [loopA, xrefRead([block('X', 'x.dwg')], [insertAt('X', '300', [0, 0])])],
    [loopB, xrefRead([block('Y', 'y.dwg')], [insertAt('Y', '301', [0, 0])])],
  ]);
  const graph = buildXrefGraph(reads, () => false);
  assert.ok(
    graph.edges.some((e) => e.cycle && e.child === loopB),
    'x.dwg is reached only by a cycle',
  );

  // Child coordinates: source (9,-2)→(10,-2) m sits at child (0,0)→(0,-1000) mm.
  const before = [src('C1', '건축::벽', line([9, -2], [10, -2]))];
  const childEntities = [ent('5A', 'A-WALL', line([0, 0], [0, -1000]))];
  const childBase = recordBaseline(
    drawing(child, childEntities),
    [{ sourceId: 'C1', handle: '5A', via: 'sync' }],
    snapshot(before),
    null,
    now,
  ).baseline;
  // Pairs recorded against a missing and a cyclic drawing.
  const goneBase = {
    path: gone,
    sha256: '',
    handles: {},
    revision: 1,
    updatedAt: '',
    pairs: [
      {
        sourceId: 'G1',
        handle: '1',
        via: 'sync',
        sourceLayer: '건축::벽',
        source: null,
        sourceDigest: 'x',
        entityDigest: 'y',
      },
    ],
  };
  const loopBase = { ...goneBase, path: loopB, pairs: [{ ...goneBase.pairs[0], sourceId: 'L1' }] };
  const result = computeBackflow({
    root,
    source: snapshot([
      src('C1', '건축::벽', line([9, -1.5], [10, -1.5])),
      src('G1', '건축::벽', line([0, 0], [1, 0])),
      src('L1', '건축::벽', line([0, 0], [1, 0])),
    ]),
    relation,
    drawings: {
      [root]: drawing(root, []),
      [child]: drawing(child, childEntities),
      [gone]: drawing(gone, [ent('1', 'A-WALL', line([0, 0], [1, 0]))]),
      [loopB]: drawing(loopB, [ent('1', 'A-WALL', line([0, 0], [1, 0]))]),
    },
    graph,
    baselines: [childBase, goneBase, loopBase],
    scope: [],
  });
  const c1 = rowOf(result, 'C1');
  assert.deepEqual(
    [c1.kind, c1.path, c1.handle],
    ['modify', child, '5A'],
    'written to the owning xref only',
  );
  assert.ok(sameGeometry(c1.after, line([500, 0], [500, -1000]), 1e-6), JSON.stringify(c1.after));
  assert.deepEqual(c1.affectedRoots, [other], 'the other root that shows the child');
  assert.equal(c1.absoluteXref, true, 'w.dwg attaches the child by an absolute path');
  assert.deepEqual(
    [rowOf(result, 'G1').kind, rowOf(result, 'G1').reason],
    ['unsupported', 'XREF_MISSING'],
  );
  assert.deepEqual(
    [rowOf(result, 'L1').kind, rowOf(result, 'L1').reason],
    ['unsupported', 'XREF_CYCLE'],
  );
  assert.equal(rowOf(result, 'G1').selectable, false);

  // The xref moved as a whole: every pair of the child moved by one translation → not written.
  const pair2 = [
    src('M1', '건축::벽', line([9, -2], [10, -2])),
    src('M2', '건축::벽', line([9, -3], [10, -3])),
    src('R1', '건축::벽', line([0, 0], [1, 0])),
  ];
  const ents2 = [
    ent('5A', 'A-WALL', line([0, 0], [0, -1000])),
    ent('5B', 'A-WALL', line([-1000, 0], [-1000, -1000])),
  ];
  const base2 = recordBaseline(
    drawing(child, ents2),
    [
      { sourceId: 'M1', handle: '5A', via: 'sync' },
      { sourceId: 'M2', handle: '5B', via: 'sync' },
    ],
    snapshot(pair2),
    null,
    now,
  ).baseline;
  const rootEnts = [ent('7', 'A-WALL', lineMm([0, 0], [1, 0]))];
  const rootBase = recordBaseline(
    drawing(root, rootEnts),
    [{ sourceId: 'R1', handle: '7', via: 'sync' }],
    snapshot(pair2),
    null,
    now,
  ).baseline;
  const shifted = computeBackflow({
    root,
    source: snapshot([
      src('M1', '건축::벽', line([9, -1], [10, -1])),
      src('M2', '건축::벽', line([9, -2], [10, -2])),
      src('R1', '건축::벽', line([0, 1], [1, 1])),
    ]),
    relation,
    drawings: { [root]: drawing(root, rootEnts), [child]: drawing(child, ents2) },
    graph,
    baselines: [base2, rootBase],
  });
  assert.deepEqual(
    ['M1', 'M2', 'R1'].map((id) => [rowOf(shifted, id).kind, rowOf(shifted, id).reason]),
    [
      ['unsupported', 'XREF_INSERT_MOVE'],
      ['unsupported', 'XREF_INSERT_MOVE'],
      ['modify', null],
    ],
  );
});

test('unsupported entities and kinds are listed, not written', () => {
  const root = 'C:\\p\\a.dwg';
  const before = [
    src('A', 'L', line([0, 0], [1, 0])),
    src('B', 'L', line([0, 1], [1, 1])),
    src('C', 'L', {
      kind: 'insert',
      block: '문',
      position: P(0, 0),
      rotation: 0,
      scale: P(1, 1, 1),
    }),
    src('D', 'L', line([0, 2], [1, 2])),
  ];
  const ents = [
    ent('1', 'L', null, { type: 'Hatch' }),
    ent('2', 'L', lineMm([0, 1], [1, 1])),
    ent(
      '3',
      'L',
      { kind: 'insert', block: '문', position: P(1000, 2000), rotation: 0, scale: P(1, 1, 1) },
      { dynamic: true },
    ),
    ent('4', 'L', lineMm([0, 2], [1, 2]), { owner: 'block' }),
  ];
  const base = recordBaseline(
    drawing(root, ents),
    before.map((s, i) => ({ sourceId: s.id, handle: ents[i].handle, via: 'sync' })),
    snapshot(before),
    null,
    now,
  ).baseline;
  const result = computeBackflow({
    root,
    source: snapshot([
      src('A', 'L', line([0, 0], [2, 0])),
      src('B', 'L', arc([0, 1], 1, 0, 1)),
      src('C', 'L', {
        kind: 'insert',
        block: '문',
        position: P(1, 0),
        rotation: 0,
        scale: P(1, 1, 1),
      }),
      src('D', 'L', line([0, 2], [2, 2])),
    ]),
    relation,
    drawings: { [root]: drawing(root, ents) },
    baselines: [base],
  });
  assert.deepEqual(
    ['A', 'B', 'C', 'D'].map((id) => rowOf(result, id).reason),
    ['ENTITY_TYPE', 'TYPE_CHANGED', 'DYNAMIC_BLOCK', 'BLOCK_CONTENT'],
  );
  assert.ok(result.rows.every((row) => !row.selectable));
});

test('baselines live in the project DB (schema 14) with a revision', () => {
  assert.ok(schemaVersion >= 15);
  const store = new Store(':memory:');
  const project = store.createProject('역반영').id;
  const baselines = new DrawingBackflowStore(store);
  const root = 'C:\\p\\평면.dwg';
  assert.equal(baselines.baseline(project, root), null);
  const read = drawing(root, [ent('1A', 'A-WALL', line([0, 0], [1, 0]))]);
  const { baseline } = recordBaseline(
    read,
    [{ sourceId: 'S1', handle: '1a', via: 'sync' }],
    snapshot([src('S1', 'L', line([0, 0], [1, 0]))]),
    null,
    now,
  );
  const saved = baselines.save(project, baseline, 0);
  assert.equal(saved.revision, 1);
  const loaded = baselines.baseline(project, 'c:\\P\\평면.DWG');
  assert.deepEqual(
    loaded.pairs.map((p) => [p.sourceId, p.handle]),
    [['S1', '1A']],
  );
  assert.equal(loaded.handles['1A'], entityDigest(read.entities[0]));
  assert.throws(() => baselines.save(project, baseline, 0), { code: 'REVISION_CONFLICT' });
  // A later record keeps earlier pairs whose entity is still there.
  const next = recordBaseline(read, [], snapshot([]), loaded, now).baseline;
  assert.equal(next.pairs.length, 1);
  assert.equal(baselines.save(project, next, 1).revision, 2);
  store.close();
});

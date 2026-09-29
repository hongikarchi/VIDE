import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDraft, roleFromText, solidAxis } from '../../src/jigs/structure/input.ts';
import { distributeAreaLoads } from '../../src/jigs/structure/loads.ts';
import { checkModel } from '../../src/jigs/structure/review.ts';
import {
  analyzeConfirmed,
  applyEdits,
  documentKey,
  StructureStore,
} from '../../src/jigs/structure/index.ts';
import { structureModelSchema } from '../../src/contracts/structure-model.ts';
import { parseSectionName, matchOuterSize } from '../../src/jigs/structure/sections.ts';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
let seq = 0;
const curve = (layer, points, name = '') => ({
  id: `o${++seq}`,
  nativeId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  nativeType: 'Curve',
  layer64: b64(layer),
  name64: b64(name),
  line: points.flat(),
  vertices: [],
  indices: [],
  attributes64: [],
});

// A 6 m × 5 m bay, 4 m tall: four columns, girders on the long sides, a secondary beam at mid-span.
function frameCurves() {
  const cols = [
    [0, 0],
    [6, 0],
    [0, 5],
    [6, 5],
  ].map(([x, y]) =>
    curve('기둥', [
      [x, y, 0],
      [x, y, 4],
    ]),
  );
  const girders = [
    curve(
      '보',
      [
        [0, 0, 4],
        [6, 0, 4],
      ],
      'H-400x200x8x13',
    ),
    curve(
      '보',
      [
        [0, 5, 4],
        [6, 5, 4],
      ],
      'H-400x200x8x13',
    ),
    curve(
      '보',
      [
        [0, 0, 4],
        [0, 5, 4],
      ],
      'H-400x200x8x13',
    ),
    curve(
      '보',
      [
        [6, 0, 4],
        [6, 5, 4],
      ],
      'H-400x200x8x13',
    ),
  ];
  // Secondary beam from the mid-point of one girder to the other (T-junctions).
  const beam = curve(
    '작은보',
    [
      [3, 0, 4],
      [3, 5, 4],
    ],
    'H-300x150x6.5x9',
  );
  return { host: 'rhino', scene: [...cols, ...girders, beam], objects: [] };
}

test('role and section names are read from layers and names', () => {
  assert.equal(roleFromText('기둥'), 'column');
  assert.equal(roleFromText('2F_GIRDER'), 'girder');
  assert.equal(roleFromText('작은보'), 'beam');
  assert.deepEqual(parseSectionName('H-400x200x8x13')?.dims, {
    h: 400,
    b: 200,
    tw: 8,
    tf: 13,
    r: 16,
  });
  assert.equal(parseSectionName('BH-600*300*12*20')?.shape, 'BH');
  assert.equal(matchOuterSize(402, 199)?.h, 400);
  assert.equal(matchOuterSize(1000, 50), null);
});

test('centre-line curves become a frame with supports, split T-junctions and the joint rule', () => {
  const { model, issues } = buildDraft(
    [{ syncId: 'sync-1', host: 'rhino', mode: 'curves', result: frameCurves() }],
    { layerHints: { 기둥: { section: 'H-300x300x10x15' } } },
  );
  const parsed = structureModelSchema.parse(model);
  assert.equal(issues.filter((i) => i.level === 'error').length, 0, JSON.stringify(issues));
  const byRole = (r) => parsed.members.filter((m) => m.role === r);
  assert.equal(byRole('column').length, 4);
  // The two long girders are split where the secondary beam meets them.
  assert.equal(byRole('girder').length, 6);
  assert.equal(byRole('beam').length, 1);
  const beam = byRole('beam')[0];
  assert.deepEqual(
    beam.releases,
    { i: { ry: true, rz: true }, j: { ry: true, rz: true } },
    'beam on girders is pinned',
  );
  assert.ok(
    byRole('girder').every((m) => !m.releases),
    'girders framing into columns stay rigid',
  );
  const supports = parsed.nodes.filter((n) => n.support);
  assert.equal(supports.length, 4);
  assert.deepEqual(supports[0].support, { dx: true, dy: true, dz: true, rz: true });
  assert.ok(parsed.sections.some((s) => s.id === 'H300x300x10x15'));
  assert.equal(parsed.members.find((m) => m.role === 'column').section, 'H300x300x10x15');
  assert.ok(
    parsed.members.every((m) => m.source?.objectId),
    'each member points back to its Rhino object',
  );
});

const box = (a, b, depth, width) => {
  // Eight corners of a prism along a→b with a vertical depth (beams) or X/Y extents (columns).
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const vertical = Math.abs(d[2]) > 0.9 * Math.hypot(...d);
  const [u, w] = vertical
    ? [
        [depth / 2, 0, 0],
        [0, width / 2, 0],
      ]
    : [
        [0, 0, depth / 2],
        [
          (-d[1] / Math.hypot(d[0], d[1])) * (width / 2),
          (d[0] / Math.hypot(d[0], d[1])) * (width / 2),
          0,
        ],
      ];
  const vertices = [];
  for (const end of [a, b])
    for (const su of [-1, 1])
      for (const sw of [-1, 1])
        vertices.push(...[0, 1, 2].map((k) => end[k] + su * u[k] + sw * w[k]));
  return vertices;
};
const solid = (layer, vertices) => ({
  ...curve(layer, []),
  line: [],
  nativeType: 'Brep',
  vertices,
  indices: [0, 1, 2],
});

test('member solids give axes, matched H sizes and ends joined to the column axis', () => {
  const axis = solidAxis(box([0, 0, 0], [0, 0, 4], 0.3, 0.3));
  assert.ok(axis && Math.abs(axis.b[2] - 4) < 1e-9 && Math.abs(axis.depth - 0.3) < 1e-9);
  // Columns 300×300 at x = 0 and 6; a 400×200 beam between their faces (ends 0.15 m short of the axis).
  const scene = [
    solid('COLUMN', box([0, 0, 0], [0, 0, 4.2], 0.3, 0.3)),
    solid('COLUMN', box([6, 0, 0], [6, 0, 4.2], 0.3, 0.3)),
    solid('BEAM', box([0.15, 0, 4.0], [5.85, 0, 4.0], 0.4, 0.2)),
  ];
  const { model, issues } = buildDraft([
    { syncId: 's', host: 'rhino', mode: 'breps', result: { host: 'rhino', scene } },
  ]);
  const parsed = structureModelSchema.parse(model);
  const beam = parsed.members.find((m) => m.role !== 'column');
  const section = parsed.sections.find((s) => s.id === beam.section);
  assert.equal(section.name, 'H-400x200x8x13');
  assert.equal(
    section.provenance.assumed,
    true,
    'a size matched from the outer box is an assumption',
  );
  const nodes = new Map(parsed.nodes.map((n) => [n.id, n.xyz_m]));
  assert.ok(
    Math.abs(nodes.get(beam.i)[0] - 0) < 1e-6 && Math.abs(nodes.get(beam.j)[0] - 6) < 1e-6,
    'beam ends on the column axes',
  );
  assert.equal(beam.role, 'girder');
  assert.ok(issues.some((i) => i.code === 'END_SNAPPED'));
});

test('a CAD plan with beam and column layers becomes a one-storey frame at the given level', () => {
  const seg = (layer, pts) => ({
    id: `c${++seq}`,
    nativeId: `h${seq}`,
    layer64: b64(layer),
    segments: pts.flat(),
    nativeType: 'Line',
  });
  const square = (x, y) => {
    const s = 0.15;
    return seg('COL', [
      [x - s, y - s, 0],
      [x + s, y - s, 0],
      [x + s, y - s, 0],
      [x + s, y + s, 0],
      [x + s, y + s, 0],
      [x - s, y + s, 0],
      [x - s, y + s, 0],
      [x - s, y - s, 0],
    ]);
  };
  const scene = [
    seg('BEAM', [
      [0, 0, 0],
      [8, 0, 0],
    ]),
    seg('BEAM', [
      [8, 0, 0],
      [8, 6, 0],
    ]),
    seg('BEAM', [
      [8, 6, 0],
      [0, 6, 0],
    ]),
    seg('BEAM', [
      [0, 6, 0],
      [0, 0, 0],
    ]),
    square(0, 0),
    square(8, 0),
    square(8, 6),
    square(0, 6),
  ];
  const { model } = buildDraft([
    {
      syncId: 'cad',
      host: 'zwcad',
      mode: 'cad',
      result: { host: 'zwcad', scene },
      cad: { levels_m: [5], base_m: 0, beamLayers: ['BEAM'], columnLayers: ['COL'] },
    },
  ]);
  const parsed = structureModelSchema.parse(model);
  assert.equal(parsed.members.filter((m) => m.role === 'column').length, 4);
  assert.equal(parsed.members.filter((m) => m.role === 'girder').length, 4);
  assert.equal(parsed.nodes.filter((n) => n.support).length, 4);
  assert.ok(parsed.nodes.every((n) => n.xyz_m[2] === 0 || n.xyz_m[2] === 5));
});

test('area loads are carried one way and the ledger balances', () => {
  const { model } = buildDraft(
    [{ syncId: 's', host: 'rhino', mode: 'curves', result: frameCurves() }],
    {
      layerHints: { 기둥: { section: 'H-300x300x10x15' } },
    },
  );
  model.areaLoads = [
    {
      id: 'roof',
      pattern: 'D',
      polygon_m: [
        [0, 0, 4],
        [6, 0, 4],
        [6, 5, 4],
        [0, 5, 4],
      ],
      value_kPa: 2,
      spanDirection: 'X',
    },
  ];
  const { model: out, ledger } = distributeAreaLoads(structureModelSchema.parse(model));
  assert.equal(ledger.length, 1);
  assert.ok(Math.abs(ledger[0].input_kN - 60) < 1e-9);
  assert.ok(Math.abs(ledger[0].undelivered_kN) < 1e-9, JSON.stringify(ledger[0]));
  assert.equal(ledger[0].carriers.length, 3, 'two edge girders along Y and the middle beam');
  assert.ok(out.loads.every((l) => l.provenance?.assumed));
});

test('model checks catch a missing support, a mechanism and near nodes', () => {
  const { model } = buildDraft(
    [{ syncId: 's', host: 'rhino', mode: 'curves', result: frameCurves() }],
    {
      layerHints: { 기둥: { section: 'H-300x300x10x15' } },
    },
  );
  const noSupport = structuredClone(model);
  noSupport.nodes = noSupport.nodes.map(({ support, ...n }) => n);
  assert.ok(checkModel(noSupport).issues.some((i) => i.code === 'NO_SUPPORT'));
  // Pinned bases, and every beam end released: the frame can sway.
  const sway = structuredClone(model);
  sway.members = sway.members.map((m) =>
    m.role === 'column'
      ? m
      : { ...m, releases: { i: { ry: true, rz: true }, j: { ry: true, rz: true } } },
  );
  const issues = checkModel(sway).issues;
  assert.ok(
    issues.some((i) => i.code === 'MECHANISM'),
    JSON.stringify(issues),
  );
  const near = structuredClone(model);
  near.nodes.push({
    id: 'X',
    xyz_m: [near.nodes[0].xyz_m[0] + 0.012, near.nodes[0].xyz_m[1], near.nodes[0].xyz_m[2]],
  });
  assert.ok(checkModel(near).issues.some((i) => i.code === 'NEAR_NODES'));
});

test('a confirmed draft is analysed, failures get a cause and the record round-trips', () => {
  const { model } = buildDraft(
    [{ syncId: 's', host: 'rhino', mode: 'curves', result: frameCurves() }],
    {
      layerHints: { 기둥: { section: 'H-300x300x10x15' } },
    },
  );
  model.areaLoads = [
    {
      id: 'roof',
      pattern: 'L',
      polygon_m: [
        [0, 0, 4],
        [6, 0, 4],
        [6, 5, 4],
        [0, 5, 4],
      ],
      value_kPa: 60,
    },
  ];
  const out = analyzeConfirmed(model);
  assert.equal(out.result.status, 'ok', out.result.error);
  assert.ok(out.result.summary.failCount > 0, 'a very heavy roof load fails some members');
  const failed = out.result.checks.find((c) => c.status === 'fail');
  assert.ok(['member', 'input-suspect'].includes(failed.cause));
  const store = new StructureStore(null);
  store.save('p1', {
    confirmed: {
      confirmedAt: 'now',
      modelHash: out.result.modelHash,
      model: out.model,
      sources: [],
      ledger: out.ledger,
      issues: out.issues,
      result: out.result,
    },
  });
  assert.equal(store.get('p1').confirmed.modelHash, out.result.modelHash);
  assert.equal(documentKey({ host: 'rhino', sourceDocument: { name: 'a.3dm' } }), 'rhino:a.3dm');
  const blocked = structuredClone(model);
  blocked.nodes = blocked.nodes.map(({ support, ...n }) => n);
  assert.throws(() => analyzeConfirmed(blocked), /blocking check errors/);
});

test('screen edits set sections, supports, joints and loads without resending the model', () => {
  const { model } = buildDraft([
    { syncId: 's', host: 'rhino', mode: 'curves', result: frameCurves() },
  ]);
  const unassigned = model.members.filter((m) => m.section === 'UNASSIGNED').map((m) => m.id);
  assert.ok(unassigned.length > 0);
  const edited = applyEdits(model, {
    sections: [{ members: unassigned, name: 'H-350x175x7x11' }],
    supports: [{ nodes: model.nodes.filter((n) => n.support).map((n) => n.id), fixity: 'fixed' }],
    joints: [{ member: 'M5', end: 'i', value: 'pin' }],
    areaLoads: [
      {
        id: 'roof',
        pattern: 'L',
        polygon_m: [
          [0, 0, 4],
          [6, 0, 4],
          [6, 5, 4],
          [0, 5, 4],
        ],
        value_kPa: 1,
      },
    ],
  });
  const parsed = structureModelSchema.parse(edited);
  assert.ok(!parsed.sections.some((s) => s.id === 'UNASSIGNED'));
  assert.equal(parsed.sections.find((s) => s.id === 'H350x175x7x11').provenance.by, 'user');
  assert.ok(parsed.nodes.filter((n) => n.support).every((n) => n.support.ry));
  assert.deepEqual(parsed.members.find((m) => m.id === 'M5').releases.i, { ry: true, rz: true });
  assert.equal(analyzeConfirmed(edited).result.status, 'ok');
});

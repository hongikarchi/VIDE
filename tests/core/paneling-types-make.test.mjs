// PLAN-49 T-257: 패널링 3단계 [타입 만들기] without a host — the placements (each type's block put on
// its panels' flat plates), the data block of vide.bake.block-instances@1, the stage-3 adapter (type
// blocks, connection marks, cut outlines and numbers), chunking with only the used definitions per
// body, the template text (name ownership, unused-definition cleanup), the report frame and the CSV
// marks. A hidden Rhino 8 makes them in tests/integration/rhino-paneling-types.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  blockHeaderProblems,
  decodeDataBlock,
  encodeDataBlock,
  itemProblems,
  unsafeArgs,
} from '../../src/jigs/bake/data-block.ts';
import {
  MAX_BODY_CHARS,
  PLACEHOLDER,
  loadTemplate,
  renderChunks,
} from '../../src/jigs/bake/templates.ts';
import { layoutHashOf, panelRows, typingHashOf } from '../../src/jigs/bake/panels.ts';
import { validateManifest } from '../../src/jigs/runtime/manifest.ts';
import { parseReportTemplate, resolveReport } from '../../src/jigs/runtime/report-format.ts';
import { makeKey, SCHEDULE_COLUMNS } from '../../src/contracts/paneling.ts';
import {
  buildMembers,
  cutSheet,
  fitOutline,
  layoutPanels,
  measurePlate,
  optimizePanels,
  placePoint,
  planarize,
  resolveMemberSettings,
  resolveOptimizeSettings,
  typePlacements,
} from '../../src/jigs/official/paneling-kit/index.ts';
import { faceSampler } from '../../src/jigs/official/paneling-kit/index.ts';
import { exportMarks, exportName } from '../../src/ui/paneling/model.ts';
import { hypar, plane, previewSettings, sampleOf } from '../fixtures/paneling-surfaces.mjs';

const JIG = join(import.meta.dirname, '..', '..', 'src', 'jigs', 'official', 'jigs', 'paneling');
const manifest = JSON.parse(readFileSync(join(JIG, 'jig.json'), 'utf8'));
const decl = (id) => manifest.bake.find((b) => b.id === id);
const OBJECT = '6f1c2b1e-1111-4a6b-9c1d-000000000002';
const params = (values = {}, by = {}) =>
  Object.fromEntries(
    manifest.params.map((p) => [
      p.key,
      { value: values[p.key] ?? p.default, by: by[p.key] ?? 'user', at: '2026-10-08T00:00:00Z' },
    ]),
  );

/** Stages 1·2·3 on a face with the real kit: 10 mm joints, 50 mm plates. */
function stages(face, preview = {}, optimize = {}, member = {}) {
  const sample = sampleOf(face, { objectId: OBJECT });
  const ps = previewSettings(preview);
  const laid = layoutPanels(sample, ps);
  assert.ok(laid.ok, laid.message);
  const layout = laid.layout;
  const members = buildMembers(
    sample,
    layout,
    ps,
    resolveMemberSettings({
      thickness: 0.05,
      thicknessSide: 'outside',
      joint: 0.01,
      boundaryJoint: 'half',
      stock: null,
      ...member,
    }),
    { solids: false },
  ).members;
  const result = optimizePanels({
    sample,
    layout,
    members,
    direction: ps.direction.value,
    settings: resolveOptimizeSettings(optimize),
  });
  assert.ok(result.ok, JSON.stringify(result));
  return { sample, layout, members, typing: result.typing, direction: ps.direction.value };
}
const det = (r) =>
  r[0] * (r[4] * r[8] - r[5] * r[7]) -
  r[1] * (r[3] * r[8] - r[5] * r[6]) +
  r[2] * (r[3] * r[7] - r[4] * r[6]);

test('fitOutline: the same outline turned, moved and re-indexed fits exactly; a mirror does not', () => {
  const a = [
    [0, 0],
    [1.2, 0],
    [1.2, 0.6],
    [0.1, 0.7],
  ];
  const t = 0.7;
  const moved = a.map(([x, y]) => [
    Math.cos(t) * x - Math.sin(t) * y + 3,
    Math.sin(t) * x + Math.cos(t) * y - 2,
  ]);
  const shifted = [...moved.slice(2), ...moved.slice(0, 2)];
  const fit = fitOutline(a, shifted);
  assert.ok(fit.worst < 1e-9, `${fit.worst}`);
  assert.equal(fit.offset, 2);
  assert.ok(Math.abs(fit.angle - t) < 1e-9);
  const mirror = a.map(([x, y]) => [x, -y]).reverse();
  assert.ok(fitOutline(a, mirror).worst > 0.05);
  assert.equal(fitOutline(a, a.slice(0, 3)).worst, Infinity);
});

test('placements: every typed panel gets its type block on its own flat plate (within the type tolerance), proper rotations', () => {
  const s = stages(hypar({ hole: false }), { size: [1.2, 0.6] });
  const placed = typePlacements(s);
  assert.equal(placed.blocks.length, s.typing.types.length);
  assert.equal(placed.placements.length + placed.failures.length, s.typing.panels.length);
  // Failures are exactly the panels the typing failed (here thin cut edge rows: no plate in stage 2).
  assert.deepEqual(
    placed.failures.map((f) => f.id).sort(),
    s.typing.panels
      .filter((t) => t.failure || t.type === 'T-00')
      .map((t) => t.panelId)
      .sort(),
  );
  assert.ok(placed.placements.length > 800);
  const typeTol = 0.002;
  const samplers = new Map(s.sample.faces.map((f) => [f.faceIndex, faceSampler(f)]));
  const member = new Map(s.members.members.map((m) => [m.panelId, m]));
  const panel = new Map(s.layout.panels.map((p) => [p.id, p]));
  const block = new Map(placed.blocks.map((b) => [b.type, b]));
  let worst = 0;
  for (const p of placed.placements) {
    assert.ok(Math.abs(det(p.rotation) - 1) < 1e-9, 'a rotation, no mirror');
    const plate = measurePlate(samplers.get(panel.get(p.id).faceIndex), member.get(p.id).uv, 1);
    const flat = planarize(plate);
    // Column 3 is the front normal: the panel's plate normal.
    const n = [p.rotation[2], p.rotation[5], p.rotation[8]];
    const dot =
      n[0] * plate.plane.normal[0] + n[1] * plate.plane.normal[1] + n[2] * plate.plane.normal[2];
    assert.ok(dot > 1 - 1e-9);
    // Every placed block corner lies on one of the panel's plate corners.
    for (const [x, y] of block.get(p.type).outline) {
      const q = placePoint(p, [x, y, 0]);
      const d = Math.min(...flat.map((c) => Math.hypot(c[0] - q[0], c[1] - q[1], c[2] - q[2])));
      worst = Math.max(worst, d);
    }
    assert.ok(p.fit <= typeTol + 1e-9, `${p.id} fit ${p.fit}`);
  }
  assert.ok(worst <= typeTol + 1e-6, `largest corner distance ${worst}`);
  // The representative's block sits exactly on itself.
  for (const b of placed.blocks) {
    const rep = placed.placements.find((p) => p.id === b.representative);
    assert.ok(rep.fit < 1e-9, `${b.type} representative fit ${rep.fit}`);
  }
});

test('placements: panels beyond the tolerance and untyped panels are failures with an outline, never fitted', () => {
  const s = stages(hypar({ hole: false }), { size: [1.2, 0.6] }, { maxTypes: 3 });
  assert.ok(s.typing.overTypeTol.length > 0);
  const placed = typePlacements(s);
  const failed = new Map(placed.failures.map((f) => [f.id, f]));
  for (const id of s.typing.overTypeTol) {
    assert.equal(failed.get(id).code, 'over-type-tol');
    assert.ok(failed.get(id).outline.length >= 3);
  }
  assert.ok(!placed.placements.some((p) => s.typing.overTypeTol.includes(p.id)));
  // A failed stage-1 panel (T-00) is a failure too, with the stage-1 corners.
  const holed = stages(hypar(), { size: [1.2, 0.6] });
  const untyped = holed.typing.panels.filter((t) => t.type === 'T-00');
  const placedHoled = typePlacements(holed);
  for (const t of untyped) assert.ok(placedHoled.failures.some((f) => f.id === t.panelId));
});

test('adapter: [타입 만들기] → one definition per type, a placement per panel, keys by the layout fingerprint', () => {
  const s = stages(hypar({ hole: false }), { size: [1.2, 0.6] });
  const rows = panelRows({
    decl: decl('types'),
    stepId: 'optimize',
    output: s.typing,
    layout: s.layout,
    members: s.members,
    sample: s.sample,
    manifestParams: manifest.params,
    params: params({ thickness: 0.05, joint: 0.01 }),
    layerRoot: 'VIDE::패널링',
  });
  assert.deepEqual(rows.problems, []);
  const hash = typingHashOf(s.typing).slice(0, 6);
  assert.equal(rows.blocks.hash, hash);
  assert.deepEqual(
    rows.blocks.defs.map((d) => d.name),
    s.typing.types.map((t) => `vide-panel-${t.type}-${hash}`),
  );
  assert.ok(rows.blocks.defs.every((d) => d.thickness === 0.05));
  assert.equal(rows.blocks.keyPrefix, makeKey('type', layoutHashOf(s.layout), ''));
  assert.equal(rows.items.length, s.typing.panels.length);
  assert.ok(rows.items.every((i) => i.key === rows.blocks.keyPrefix + i.id));
  assert.deepEqual(unsafeArgs(rows.items), []);
  assert.deepEqual(itemProblems('vide.bake.block-instances@1', rows.items), []);
  assert.deepEqual(blockHeaderProblems(rows.blocks), []);
  assert.deepEqual(
    rows.blocks.attrs.map(([k]) => k),
    ['vide-assumed', 'vide-thickness', 'vide-joint'],
  );
  // `inside` pushes the plate behind the front.
  const inside = panelRows({
    decl: decl('types'),
    stepId: 'optimize',
    output: s.typing,
    layout: s.layout,
    members: s.members,
    sample: s.sample,
    manifestParams: manifest.params,
    params: params({ thickness: 0.05, thicknessSide: 'inside' }),
    layerRoot: 'VIDE::패널링',
  });
  assert.ok(inside.blocks.defs.every((d) => d.thickness === -0.05));
  // The block name changes with the typing: a renumbered make never reuses an older definition.
  const other = stages(hypar({ hole: false }), { size: [1.2, 0.6] }, { typeTol: 0.005 });
  assert.notEqual(typingHashOf(other.typing).slice(0, 6), hash);
  // Without stage 2 nothing is made.
  const none = panelRows({
    decl: decl('types'),
    stepId: 'optimize',
    output: s.typing,
    layout: s.layout,
    sample: s.sample,
    manifestParams: manifest.params,
    params: params(),
    layerRoot: 'VIDE::패널링',
  });
  assert.deepEqual(none.problems, ['2단계 부재 결과가 없습니다']);
});

test('block data block: definitions, rotations, origins and failure outlines round-trip; a body carries only the definitions it uses', () => {
  const blocks = {
    keyPrefix: 'type:abcdef01:',
    hash: 'a1b2c3',
    budgetMs: 60000,
    failLayerPath: 'VIDE::패널링::실패',
    attrs: [['vide-assumed', 'false']],
    defs: [
      {
        name: 'vide-panel-T-01-a1b2c3',
        type: 'T-01',
        thickness: 0.05,
        outline: [
          [0, 0],
          [1.2, 0],
          [1.2, 0.6],
          [0, 0.6],
        ],
      },
      {
        name: 'vide-panel-T-02-a1b2c3',
        type: 'T-02',
        thickness: 0.05,
        outline: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      },
    ],
  };
  const r = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  const items = [
    {
      key: 'type:abcdef01:P-1-1',
      attrs: [],
      id: 'P-1-1',
      def: 'vide-panel-T-01-a1b2c3',
      cls: 'double',
      status: 0,
      flatness: 0.0012,
      width: 1.19,
      height: 0.59,
      fail: '',
      rotation: r,
      origin: [100.5, 200.25, 5],
      outline: [],
    },
    {
      key: 'type:abcdef01:P-1-2',
      attrs: [],
      id: 'P-1-2',
      def: '',
      cls: 'flat',
      status: 1,
      flatness: 0,
      width: 0,
      height: 0,
      fail: 'over-type-tol',
      rotation: [],
      origin: [0, 0, 0],
      outline: [
        [100, 200, 5],
        [101, 200, 5],
        [101, 201, 5],
      ],
    },
  ];
  const header = {
    template: 'vide.bake.block-instances@1',
    jigId: 'vide/paneling',
    instanceId: 'inst-1',
    bakeId: 'types',
    runId: 'run-1',
    layerPath: 'VIDE::패널링::타입',
    deleteIds: ['6f1c2b1e-1111-4a6b-9c1d-000000000009'],
    blocks,
  };
  const decoded = decodeDataBlock(encodeDataBlock(header, items));
  // Only T-01 is used: T-02 is not in this body.
  assert.deepEqual(
    decoded.header.blocks.defs.map((d) => d.name),
    ['vide-panel-T-01-a1b2c3'],
  );
  assert.deepEqual(decoded.header.blocks.defs[0].outline, blocks.defs[0].outline);
  assert.equal(decoded.header.blocks.hash, 'a1b2c3');
  assert.deepEqual(decoded.header.deleteIds, header.deleteIds);
  const [placed, failed] = decoded.items;
  assert.equal(placed.def, 'vide-panel-T-01-a1b2c3');
  assert.deepEqual(placed.rotation, r);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(placed.origin[i] - items[0].origin[i]) < 1e-4);
  assert.equal(placed.cls, 'double');
  assert.equal(failed.def, '');
  assert.equal(failed.fail, 'over-type-tol');
  assert.equal(failed.outline.length, 3);
  // A mirror (det −1) or an unknown definition is refused before encoding.
  assert.match(
    itemProblems('vide.bake.block-instances@1', [
      { ...items[0], rotation: [1, 0, 0, 0, -1, 0, 0, 0, 1] },
    ]).join(),
    /회전이 아닙니다/,
  );
  assert.throws(
    () => encodeDataBlock(header, [{ ...items[0], def: 'vide-panel-T-09-a1b2c3' }]),
    /BAKE_BLOCK_DEF/,
  );
  assert.match(
    blockHeaderProblems({
      ...blocks,
      defs: [{ ...blocks.defs[0], name: 'vide-panel-T-01-ffffff' }],
    }).join(),
    /블록 이름/,
  );
});

test('about 5,000 panels: placements, bodies within the worker limit with each body naming its own definitions', (t) => {
  const s = stages(hypar(), { size: [0.34, 0.34] });
  assert.ok(s.layout.panels.length >= 5000, `${s.layout.panels.length}`);
  const started = performance.now();
  const rows = panelRows({
    decl: decl('types'),
    stepId: 'optimize',
    output: s.typing,
    layout: s.layout,
    members: s.members,
    sample: s.sample,
    manifestParams: manifest.params,
    params: params({ thickness: 0.05 }),
    layerRoot: 'VIDE::패널링',
  });
  const ms = Math.round(performance.now() - started);
  assert.deepEqual(rows.problems, []);
  const chunks = renderChunks(
    {
      template: 'vide.bake.block-instances@1',
      jigId: 'vide/paneling',
      instanceId: 'inst-1',
      bakeId: 'types',
      runId: 'run-1',
      layerPath: 'VIDE::패널링::타입',
      deleteIds: [],
      blocks: rows.blocks,
    },
    rows.items,
  );
  assert.ok(chunks.every((c) => c.code.length <= MAX_BODY_CHARS));
  assert.equal(new Set(chunks.flatMap((c) => c.keys)).size, rows.items.length);
  for (const chunk of chunks) {
    const block = Buffer.from(/FromBase64String\("([^"]+)"\)/.exec(chunk.code)[1], 'base64');
    const decoded = decodeDataBlock(block);
    const named = new Set(decoded.header.blocks.defs.map((d) => d.name));
    for (const item of decoded.items) if (item.def) assert.ok(named.has(item.def));
  }
  t.diagnostic(
    `${rows.items.length} panels, ${rows.blocks.defs.length} types, ${chunks.length} bodies, rows ${ms} ms`,
  );
});

test('connection marks and the cut sheet: node and joint types at their places, flat outlines on XY beside the surface', () => {
  const s = stages(plane(7.2, 3.6), { size: [1.2, 0.6] });
  const input = (id) => ({
    decl: decl(id),
    stepId: 'optimize',
    output: s.typing,
    layout: s.layout,
    members: s.members,
    sample: s.sample,
    manifestParams: manifest.params,
    params: params(),
    layerRoot: 'VIDE::패널링',
  });
  const marks = panelRows(input('connections'));
  assert.deepEqual(marks.problems, []);
  const nodes = marks.items.filter((i) => i.key.startsWith('node:'));
  const joints = marks.items.filter((i) => i.key.startsWith('joint:'));
  assert.equal(nodes.length, s.typing.nodeAt.length);
  assert.equal(
    joints.length,
    new Set(s.typing.jointAt.map((j) => [...j.keys].sort().join('|'))).size,
  );
  assert.ok(nodes.every((n) => /^N-\d{2}$/.test(n.text)));
  assert.ok(joints.every((j) => /^J-\d{2}$/.test(j.text)));
  assert.deepEqual(unsafeArgs(marks.items), []);
  assert.deepEqual(itemProblems('vide.bake.textdot@1', marks.items), []);

  const cuts = panelRows(input('cuts'));
  const numbers = panelRows(input('cut-numbers'));
  const flat = s.typing.panels.filter((t) => t.flat && t.type !== 'T-00');
  assert.equal(cuts.items.length, flat.length);
  assert.deepEqual(
    numbers.items.map((i) => i.key),
    cuts.items.map((i) => `${i.key}:no`),
  );
  const maxX = Math.max(...s.layout.panels.flatMap((p) => p.corners.map((c) => c[0])));
  const minZ = Math.min(...s.layout.panels.flatMap((p) => p.corners.map((c) => c[2])));
  const byId = new Map(flat.map((t) => [t.panelId, t]));
  for (const item of cuts.items) {
    const pts = item.curve.points;
    assert.deepEqual(pts[0], pts.at(-1), 'closed');
    assert.ok(pts.every((p) => p[0] > maxX && p[2] === minZ));
    const id = item.attrs.find(([k]) => k === 'vide-panel-id')[1];
    const outline = byId.get(id).flat;
    const perimeter = (ring) =>
      ring.reduce(
        (n, p, i) =>
          n +
          Math.hypot(ring[(i + 1) % ring.length][0] - p[0], ring[(i + 1) % ring.length][1] - p[1]),
        0,
      );
    assert.ok(Math.abs(perimeter(pts.slice(0, -1)) - perimeter(outline)) < 1e-6);
  }
  // No two cut outlines overlap: each sits in its own cell.
  const boxes = cuts.items.map((i) => {
    const xs = i.curve.points.map((p) => p[0]);
    const ys = i.curve.points.map((p) => p[1]);
    return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  });
  for (let a = 0; a < boxes.length; a++)
    for (let b = a + 1; b < boxes.length; b++)
      assert.ok(
        boxes[a][1] <= boxes[b][0] ||
          boxes[b][1] <= boxes[a][0] ||
          boxes[a][3] <= boxes[b][2] ||
          boxes[b][3] <= boxes[a][2],
      );
  assert.equal(cutSheet(s.layout, { ...s.typing, panels: [] }).length, 0);
});

test('template text: definitions by name and owner, a person’s name never touched, unused older ones removed, placements on type layers', () => {
  const text = loadTemplate('vide.bake.block-instances@1').text;
  assert.equal(text.split(PLACEHOLDER).length, 2);
  assert.match(text, /if \(Str\(\) != "vide\.bake\.block-instances@1"\) throw/);
  assert.match(text, /var owner = "VIDE " \+ jigId \+ " · " \+ instanceId \+ " · " \+ bakeId;/);
  assert.match(
    text,
    /\.StartsWith\(ownedByJig, StringComparison\.Ordinal\)\) defIndex\[i\] = existing\.Index;\s+else defFailed\[i\] = "BLOCK_NAME_TAKEN";/,
  );
  assert.match(text, /doc\.InstanceDefinitions\.Add\(name, owner, Point3d\.Origin/);
  assert.match(text, /doc\.Objects\.AddInstanceObject\(defIndex\[def\], xf, attributes\)/);
  assert.match(text, /LayerOf\(layerPath \+ "::" \+ defTypes\[def\]\)/);
  // Only this make's definitions of another fingerprint, and only with no placement left.
  assert.match(
    text,
    /d\.Description == owner && !d\.Name\.EndsWith\("-" \+ hash, StringComparison\.Ordinal\)/,
  );
  assert.match(
    text,
    /d\.GetReferences\(0\)\.Length == 0 && doc\.InstanceDefinitions\.Delete\(d\.Index, true, true\)/,
  );
  assert.match(text, /existing\.Attributes\.GetUserString\("vide-instance"\) != instanceId/);
  assert.match(text, /BAKE_TIMEOUT/);
  assert.doesNotMatch(
    text,
    /Purge|Compact\(|Rhino\.RhinoDoc\.ActiveDoc|SetUserString\(\s*"vide-key"[^;]*existing/,
  );
  for (const name of [
    'vide-panel-id',
    'vide-panel-type',
    'vide-panel-class',
    'vide-panel-size',
    'vide-flatness-mm',
    'vide-status',
  ])
    assert.ok(text.includes(`"${name}"`), name);
});

test('the jig validates with the stage-3 makes and its report frame resolves with the 가정·다시 계산 marks', () => {
  const { issues } = validateManifest(manifest, { official: true, source: 'builtin' });
  assert.deepEqual(
    issues.filter((i) => i.level === 'error'),
    [],
  );
  const raw = JSON.parse(readFileSync(join(JIG, 'reports', 'paneling.json'), 'utf8'));
  const parsed = parseReportTemplate(raw);
  assert.deepEqual(parsed.issues ?? [], []);
  const s = stages(plane(7.2, 3.6), { size: [1.2, 0.6] });
  const context = (counts, final = {}) => ({
    outputs: { preview: s.layout, members: s.members, optimize: s.typing },
    params: {},
    inputs: {
      settings: [],
      open: [],
      counts: { settings: 0, assumed: 0, questions: 0, open: 0, notFinal: 0, ...counts },
    },
    final: { preview: true, members: true, optimize: true, ...final },
  });
  const head = (ctx) => resolveReport(parsed.template, ctx).headline.text;
  assert.equal(
    head(context({})),
    `패널 ${s.layout.counts.total}개를 타입 ${s.typing.types.length}개로 묶었습니다.`,
  );
  assert.match(head(context({ assumed: 3 })), /가정 값 3개 포함\.$/);
  assert.match(
    head(context({ assumed: 2, notFinal: 1 }, { optimize: false })),
    /가정 값 2개 포함, 다시 계산 필요\.$/,
  );
  // CSV: the first line stays the column head, so the marks go in the file name.
  assert.deepEqual(exportMarks({ assumed: 2, stale: true }), [
    '가정 값 2개 포함',
    '다시 계산 필요',
  ]);
  const at = new Date(2026, 9, 8, 9, 5);
  assert.equal(exportName('types', at), '패널링-타입-20261008-0905.csv');
  assert.equal(
    exportName('panels', at, { assumed: 2, stale: true }),
    '패널링-패널-20261008-0905-가정 값 2개 포함-다시 계산 필요.csv',
  );
  assert.equal(Object.keys(SCHEDULE_COLUMNS).length, 4);
});

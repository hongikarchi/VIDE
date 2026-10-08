// vide/paneling-kit stage 3 (PLAN-49 T-256, SPEC-16.7): synthetic sampled faces → stage-1 layout →
// a stand-in stage-2 member set (no joint) → flatness, planarization, curvature classes, types,
// nodes, joints, cut outlines and the schedule. Hand-computed flatness / planarization gap / distance
// from the surface on a cylinder, rotation-free and mirror typing on built shapes, the largest type
// count, deterministic numbering, failures and the 5,000-panel time. Synthetic data only; no host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMembers,
  groupShapes,
  layoutPanels,
  membersStep,
  resolveMemberSettings,
  makeShape,
  optimizePanels,
  optimizeSettingsFromParams,
  optimizeStep,
  resolveOptimizeSettings,
  scheduleCsv,
  scheduleRows,
} from '../../src/jigs/official/paneling-kit/index.ts';
import { SCHEDULE_COLUMNS, panelTypingSchema } from '../../src/contracts/paneling.ts';
import {
  cylinderBand,
  hypar,
  plane,
  previewSettings,
  sampleFace,
  sampleOf,
} from '../fixtures/paneling-surfaces.mjs';
import { membersOf } from '../fixtures/paneling-members-stub.mjs';

const R = 8;
/** Open cylinder band with the angle as U (uniform), radius R, outward normal. */
const uniformCylinder = () =>
  sampleFace(
    (u, v) => ({
      p: [R * Math.cos(u), R * Math.sin(u), v],
      n: [Math.cos(u), Math.sin(u), 0],
      k: [0, -1 / R],
    }),
    { domainU: [0, 1.2], domainV: [0, 3] },
  );

function stage3(face, preview = {}, optimize = {}, o = {}) {
  const sample = sampleOf(face);
  const ps = previewSettings(preview);
  const laid = layoutPanels(sample, ps);
  assert.equal(laid.ok, true, JSON.stringify(laid));
  const layout = o.shuffle
    ? { ...laid.layout, panels: o.shuffle(laid.layout.panels) }
    : laid.layout;
  const members = membersOf(layout, o.members);
  if (o.shuffle) members.members = o.shuffle(members.members);
  const result = optimizePanels({
    sample,
    layout,
    members,
    direction: ps.direction.value,
    settings: resolveOptimizeSettings(optimize),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const parsed = panelTypingSchema.safeParse(result.typing);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 3)));
  return { ...result, layout, members };
}
const byId = (typing) => Object.fromEntries(typing.panels.map((p) => [p.panelId, p]));
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test('flat grid: one flat type, node N-01 4 panels at 90°×4, coplanar joints, cut outline at the origin', () => {
  const { typing, layout } = stage3(plane(7.2, 3.6));
  assert.equal(layout.panels.length, 36);
  assert.equal(typing.types.length, 1);
  assert.deepEqual(
    { ...typing.types[0], size: typing.types[0].size.map((x) => Math.round(x * 1e6) / 1e6) },
    {
      type: 'T-01',
      class: 'flat',
      count: 36,
      vertexCount: 4,
      representative: 'P-1-1',
      size: [1.2, 0.6],
      maxDeviation: typing.types[0].maxDeviation,
      mirrorOf: null,
    },
  );
  assert.ok(typing.types[0].maxDeviation < 1e-9);
  assert.deepEqual(typing.nodes[0], {
    type: 'N-01',
    valence: 4,
    angles: [90, 90, 90, 90],
    count: 25,
  });
  assert.deepEqual(
    typing.nodes.map((n) => [n.valence, n.angles, n.count]),
    [
      [4, [90, 90, 90, 90], 25],
      [2, [90, 90, 180], 20],
      [1, [90, 270], 4],
    ],
  );
  assert.equal(typing.nodeAt.length, 49);
  // Joints: every shared edge coplanar; the 0.6 and 1.2 m edges are two length groups.
  assert.ok(typing.joints.every((j) => j.dihedral[0] === -0.5 && j.dihedral[1] === 0.5));
  assert.deepEqual(
    typing.joints.map((j) => [j.type, j.count, Math.round(j.length * 1000)]),
    [
      ['J-01', 30, 600],
      ['J-02', 30, 1200],
    ],
  );
  assert.equal(typing.jointAt.length, 60);
  const p = byId(typing);
  assert.equal(p['P-1-1'].class, 'flat');
  assert.equal(p['P-1-1'].flatness, 0);
  assert.equal(p['P-1-1'].planarGap, 0);
  assert.equal(p['P-1-1'].offSurface, 0);
  assert.deepEqual(p['P-2-3'].flat, [
    [0, 0],
    [1.2, 0],
    [1.2, 0.6],
    [0, 0.6],
  ]);
  assert.equal(typing.maxTypesUnmet, null);
  assert.deepEqual(typing.overTypeTol, []);
});

test('triangle pattern on a plane: flatness 0, one type (halves a·b are a 180° turn apart)', () => {
  const { typing } = stage3(plane(4.8, 2.4), { pattern: 'triangle' });
  assert.ok(typing.panels.every((p) => p.flatness < 1e-12 && p.class === 'flat'));
  assert.equal(typing.types.length, 1, 'a and b halves are the same shape turned');
  assert.equal(typing.types[0].vertexCount, 3);
});

test('cylinder: flatness, planarization gap and distance from the surface match the hand values', () => {
  const { typing, layout } = stage3(uniformCylinder(), { size: [0.8, 0.6] });
  const p = byId(typing);
  let checked = 0;
  for (const panel of layout.panels) {
    if (panel.boundary || panel.row === 1 || panel.row === 5 || panel.col === 1) continue;
    if (panel.col >= 11) continue;
    // Half angle a of the panel; check points: 6 at ±a, 3 at 0 → plane at R(1 + 2cos a)/3.
    const a = (panel.uv[1][0] - panel.uv[0][0]) / 2;
    const delta = (R * (1 - Math.cos(a))) / 3;
    const t = p[panel.id];
    near(t.flatness, 2 * delta, 2e-6, `${panel.id} flatness`);
    near(t.planarGap, delta * 2 * Math.sin(a), 2e-6, `${panel.id} planarGap`);
    near(t.offSurface, delta * Math.cos(a), 2e-6, `${panel.id} offSurface`);
    // Cut outline: first vertex at the origin, pattern axis +X, front up; perimeter = plate's.
    const chord = 2 * R * Math.sin(a);
    near(t.flat[1][0], chord, 2e-6, 'first edge along +X');
    near(t.flat[1][1], 0, 1e-9, 'first edge along +X');
    assert.deepEqual(t.flat[0], [0, 0]);
    let perimeter = 0;
    for (let i = 0; i < t.flat.length; i++) {
      const [x0, y0] = t.flat[i],
        [x1, y1] = t.flat[(i + 1) % t.flat.length];
      perimeter += Math.hypot(x1 - x0, y1 - y0);
    }
    near(perimeter, 2 * (chord + 0.6), 4e-6, 'perimeter');
    assert.equal(t.class, 'single');
    checked++;
  }
  assert.ok(checked >= 20, `${checked}`);
  // Joints along the generators fold by 2a, convex toward the outward normal (+).
  const a = 0.4 / R;
  const fold = typing.joints.find((j) => j.dihedral[0] > 0);
  assert.ok(fold, JSON.stringify(typing.joints));
  const deg = (2 * a * 180) / Math.PI;
  assert.ok(fold.dihedral[0] <= deg && deg <= fold.dihedral[1], JSON.stringify(fold));
  assert.ok(
    typing.joints.some((j) => j.dihedral[0] === -0.5),
    'joints across rows are coplanar',
  );
});

test('뒤집기 reverses the front: the fold sign turns negative, flatness stays', () => {
  const up = stage3(uniformCylinder(), { size: [0.8, 0.6] });
  const down = stage3(uniformCylinder(), {
    size: [0.8, 0.6],
    direction: { axis: 'u', startCorner: 'min-min', flip: true },
  });
  assert.ok(down.typing.joints.some((j) => j.dihedral[1] < 0));
  assert.ok(!down.typing.joints.some((j) => j.dihedral[0] > 0));
  near(byId(down.typing)['P-2-2'].flatness, byId(up.typing)['P-2-2'].flatness, 1e-9, 'flatness');
});

test('cylinder band (non-uniform parameter): single curvature, full panels one type, the cut row another', () => {
  const { typing, layout } = stage3(cylinderBand(8, (2 * Math.PI) / 3, 6), {
    size: [1.2, 0.6],
    direction: { axis: 'v', startCorner: 'min-min', flip: false },
  });
  assert.ok(typing.panels.every((p) => p.class === 'single'));
  const p = byId(typing);
  const full = layout.panels.filter((x) => !x.boundary);
  const cut = layout.panels.filter((x) => x.boundary);
  assert.ok(full.length > 0 && cut.length > 0);
  assert.equal(new Set(full.map((x) => p[x.id].type)).size, 1, 'full panels share one type');
  const fullType = p[full[0].id].type;
  assert.equal(fullType, 'T-01');
  assert.ok(
    cut.every((x) => p[x.id].type !== fullType),
    'cut panels are a separate type',
  );
  assert.equal(typing.types.find((t) => t.type === 'T-01').class, 'single');
});

test('hyperbolic paraboloid: double curvature, fewer types as the tolerance grows', () => {
  const counts = [0.001, 0.005, 0.02].map((typeTol) => {
    const { typing } = stage3(hypar({ hole: false }), { size: [1.2, 0.6] }, { typeTol });
    assert.ok(typing.panels.every((p) => p.class === 'double'));
    return typing.types.length;
  });
  assert.ok(counts[0] > counts[1] && counts[1] > counts[2], JSON.stringify(counts));
});

test('largest type count: 3 holds, panels beyond the tolerance are listed; mixed vertex counts → maxTypesUnmet', () => {
  const capped = stage3(hypar({ hole: false }), { size: [1.2, 0.6] }, { maxTypes: 3 }).typing;
  assert.ok(capped.types.length <= 3, `${capped.types.length}`);
  assert.equal(capped.maxTypesUnmet, null);
  assert.ok(capped.overTypeTol.length > 0);
  const p = byId(capped);
  for (const id of capped.overTypeTol) {
    assert.equal(p[id].failure.code, 'over-type-tol');
    assert.ok(p[id].deviation > 0.002);
  }
  assert.equal(
    capped.types.reduce((n, t) => n + t.count, 0),
    capped.panels.length,
    'every panel stays in a type',
  );
  // With the trim hole the cut panels have 3…9 vertices: one type per vertex count at best.
  const mixed = stage3(hypar(), { size: [1.2, 0.6] }, { maxTypes: 1 }).typing;
  const counts = new Set(mixed.types.map((t) => t.vertexCount));
  assert.equal(mixed.maxTypesUnmet, counts.size);
  assert.equal(mixed.types.length, counts.size);
});

test('typing: a turned and moved panel is the same type, its mirror image is another with mirrorOf', () => {
  const quad = [
    [0, 0, 0],
    [1, 0, 0],
    [1.3, 0.8, 0],
    [0, 0.5, 0],
  ];
  const shapeOf = (vs, normal) => {
    const mids = vs.map((a, i) => {
      const b = vs[(i + 1) % vs.length];
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    });
    const c = [0, 1, 2].map((k) => vs.reduce((s, v) => s + v[k], 0) / vs.length);
    return makeShape({ vertices: vs, mids, centre: c, normal });
  };
  // Turn 70° about an oblique axis, move, and start the outline at another vertex.
  const axis = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
  const th = (70 * Math.PI) / 180;
  const rot = (p) => {
    const [x, y, z] = axis,
      c = Math.cos(th),
      s = Math.sin(th),
      d = (x * p[0] + y * p[1] + z * p[2]) * (1 - c);
    return [
      p[0] * c + (y * p[2] - z * p[1]) * s + x * d + 5,
      p[1] * c + (z * p[0] - x * p[2]) * s + y * d - 2,
      p[2] * c + (x * p[1] - y * p[0]) * s + z * d + 1,
    ];
  };
  const turned = quad.map(rot);
  const shifted = turned.slice(2).concat(turned.slice(0, 2));
  // Mirror x → −x, outline reversed to stay counter-clockwise from +Z.
  const mirror = quad.map(([x, y, z]) => [-x, y, z]).reverse();
  const shapes = [
    shapeOf(quad, [0, 0, 1]),
    shapeOf(
      shifted,
      rot([0, 0, 1]).map((v, k) => v - rot([0, 0, 0])[k]),
    ),
    shapeOf(mirror, [0, 0, 1]),
  ];
  const g = groupShapes(shapes, 0.002, null);
  assert.equal(g.typeOf[0], g.typeOf[1], 'turned copy joins the type');
  assert.ok(g.deviation[1] < 1e-9);
  assert.notEqual(g.typeOf[2], g.typeOf[0], 'mirror image is another type');
  assert.equal(g.types[g.typeOf[2]].mirrorOf, g.typeOf[0]);
  assert.equal(g.types[g.typeOf[0]].mirrorOf, g.typeOf[2]);
  // The flipped plate (front face down) is not the same type either.
  const upsideDown = shapeOf(quad.slice().reverse(), [0, 0, -1]);
  const g2 = groupShapes([shapes[0], upsideDown], 0.002, null);
  assert.equal(g2.types.length, 2);
});

test('deterministic: panels and members in another order give the same types and numbers', () => {
  const plain = stage3(hypar(), { size: [1.2, 0.6] }, { typeTol: 0.005 }).typing;
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const shuffle = (xs) => {
    const out = xs.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const mixed = stage3(hypar(), { size: [1.2, 0.6] }, { typeTol: 0.005 }, { shuffle }).typing;
  assert.deepEqual(mixed.types, plain.types);
  assert.deepEqual(mixed.panels, plain.panels);
  assert.deepEqual(mixed.nodes, plain.nodes);
  assert.deepEqual(mixed.joints, plain.joints);
  assert.deepEqual(mixed.jointAt, plain.jointAt);
});

test('planarize none: no flat plates for curved panels, surface check points, 펼침 없음 in the schedule', () => {
  const { typing, layout, members } = stage3(
    uniformCylinder(),
    { size: [0.8, 0.6] },
    { planarize: 'none' },
  );
  const p = byId(typing);
  assert.equal(p['P-2-2'].planarGap, null);
  assert.equal(p['P-2-2'].offSurface, null);
  assert.equal(p['P-2-2'].flat, null, 'flatness 6.7 mm > 3 mm: no cut outline');
  const loose = stage3(
    uniformCylinder(),
    { size: [0.8, 0.6] },
    { planarize: 'none', flatnessTol: 0.01 },
  );
  assert.ok(byId(loose.typing)['P-2-2'].flat, 'within the tolerance: flat outline');
  const rows = scheduleRows(layout, members, typing);
  const row = rows.panels.find((r) => r.id === 'P-2-2');
  assert.equal(row.reason, '펼침 없음 · 곡면');
  assert.equal(row.class, '단곡');
  near(row.flatness, 6.7, 0.051, 'flatness mm with one decimal');
});

test('pq is not ready: computed as best-fit with a note', () => {
  const r = stage3(plane(2.4, 1.2), {}, { planarize: 'pq' });
  assert.match(r.notes.join(' '), /준비 중/);
  assert.equal(r.typing.panels[0].planarGap, 0);
});

test('failures: a zero-area plate fails alone; a failed stage-2 member keeps its failure; maxTypes 0 is refused', () => {
  const { typing } = stage3(
    plane(4.8, 2.4),
    {},
    {},
    {
      members: {
        uvOf: (p) => (p.id === 'P-2-2' ? p.uv.map(() => p.uv[0]) : p.uv),
      },
    },
  );
  const p = byId(typing);
  assert.equal(p['P-2-2'].failure.code, 'degenerate');
  assert.equal(p['P-2-2'].type, 'T-00');
  assert.equal(p['P-1-1'].failure, null);
  assert.equal(typing.types.length, 1);
  assert.equal(typing.types[0].count, 15);

  const sample = sampleOf(plane(2.4, 1.2));
  const ps = previewSettings();
  const layout = layoutPanels(sample, ps).layout;
  const members = membersOf(layout);
  members.members[1].failure = {
    code: 'thickness-curvature',
    message: '두께 불가 · 곡률 반지름 70 mm',
  };
  const r = optimizePanels({
    sample,
    layout,
    members,
    direction: ps.direction.value,
    settings: resolveOptimizeSettings(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.typing.panels[1].failure.code, 'thickness-curvature');
  assert.equal(r.typing.types[0].count, 3);

  const refused = optimizePanels({
    sample,
    layout,
    members,
    direction: ps.direction.value,
    settings: resolveOptimizeSettings({ maxTypes: 0 }),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'BAD_SETTINGS');
  assert.match(refused.message, /최대 타입 수/);
  // The jig's flat value 0 means no limit.
  assert.equal(optimizeSettingsFromParams({ maxTypes: 0 }).maxTypes.value, null);
  assert.equal(optimizeSettingsFromParams({}).typeTol.source, 'assumed');
  assert.equal(optimizeSettingsFromParams({ typeTol: 0.004 }).typeTol.source, 'person');
});

test('the step reads step.preview and step.members; the schedule tables follow SCHEDULE_COLUMNS', () => {
  const sample = sampleOf(plane(2.4, 1.2));
  const ps = previewSettings();
  const layout = layoutPanels(sample, ps).layout;
  const members = membersOf(layout);
  const typing = optimizeStep(
    { surface: sample, steps: { preview: layout, members } },
    { typeTol: 0.002, maxTypes: 0 },
  );
  assert.equal(typing.schema, 'vide.paneling.typing@1');
  assert.equal(typing.types.length, 1);
  assert.throws(
    () => optimizeStep({ surface: sample, steps: { preview: layout } }, {}),
    /2단계 부재/,
  );

  const rows = scheduleRows(layout, members, typing);
  for (const table of Object.keys(SCHEDULE_COLUMNS))
    for (const row of rows[table])
      assert.deepEqual(
        Object.keys(row),
        SCHEDULE_COLUMNS[table].map(([key]) => key),
        table,
      );
  assert.deepEqual(rows.panels[0], {
    id: 'P-1-1',
    face: 0,
    row: 1,
    col: 1,
    boundary: '',
    type: 'T-01',
    class: '평면',
    width: 1200,
    height: 600,
    plateWidth: 1200,
    plateHeight: 600,
    thickness: 50,
    area: 0.72,
    opening: null,
    flatness: 0,
    planarGap: 0,
    offSurface: 0,
    jointGapMin: null,
    jointGapMax: null,
    sampleDeviation: null,
    status: '정상',
    reason: '',
  });
  assert.deepEqual(rows.nodes[0], { type: 'N-01', count: 4, valence: 1, angles: '90 / 270' });
  const csv = scheduleCsv('types', rows.types);
  assert.ok(
    csv.startsWith(
      '﻿타입,수,등급,꼭짓점 수,대표 패널,판 가로(mm),판 세로(mm),최대 편차(mm),거울상 짝\r\n',
    ),
  );
  assert.match(csv, /\r\nT-01,4,평면,4,P-1-1,1200,600,0,\r\n$/);
  // Before stage 3 the stage-3 columns are empty.
  const early = scheduleRows(layout, members, null);
  assert.equal(early.panels[0].type, null);
  assert.equal(early.panels[0].flatness, null);
  assert.deepEqual(early.types, []);
});

test('about 5,000 panels: typing time (release 2 s target)', (t) => {
  const sample = sampleOf(hypar());
  const ps = previewSettings({ size: [0.34, 0.34] });
  const layout = layoutPanels(sample, ps).layout;
  const members = membersOf(layout);
  const run = () =>
    optimizePanels({
      sample,
      layout,
      members,
      direction: ps.direction.value,
      settings: resolveOptimizeSettings(),
    });
  run(); // warm up
  const times = [];
  let result;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    result = run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  t.diagnostic(
    `${layout.panels.length} panels, ${result.typing.types.length} types, ${result.typing.nodes.length} node / ${result.typing.joints.length} joint types: median ${times[1].toFixed(0)} ms`,
  );
  assert.ok(layout.panels.length >= 5000);
  assert.ok(times[1] < 4000, `median ${times[1]} ms`);
});

// Integration (PLAN-49 W3): stage 3 on the real stage-2 `MemberSet` from T-254 instead of the
// stand-in — joint-reduced plates keep their vertex keys, so nodes and joints are still found.
test('real stage-2 members (joint 10 mm): typing covers every plate; the jig steps chain preview → members → optimize', () => {
  const sample = sampleOf(plane(7.2, 3.6));
  const ps = previewSettings();
  const layout = layoutPanels(sample, ps).layout;
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
    }),
  ).members;
  const result = optimizePanels({
    sample,
    layout,
    members,
    direction: ps.direction.value,
    settings: resolveOptimizeSettings(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const parsed = panelTypingSchema.safeParse(result.typing);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 3)));
  const { typing } = result;
  assert.equal(typing.panels.length, layout.panels.length);
  assert.equal(
    typing.panels.filter((p) => p.failure).length,
    0,
    'no plate fails on a plane with a 10 mm joint',
  );
  // joint 10 mm with a half joint on the edge: every plate is 1.19 × 0.59, one flat type
  assert.equal(typing.types.length, 1);
  assert.equal(typing.types[0].class, 'flat');
  assert.deepEqual(
    typing.types[0].size.map((x) => Math.round(x * 1e4) / 1e4),
    [1.19, 0.59],
  );
  assert.ok(typing.nodes.length >= 1, 'node types from the shared vertex keys');
  assert.ok(typing.joints.length >= 1, 'joint types from the shared edges');

  // The jig's own step functions: the stage outputs feed the next stage as inputs.steps.<id>.
  const params = {
    pattern: 'rect',
    width: 1.2,
    height: 0.6,
    thickness: 0.05,
    thicknessSide: 'outside',
    joint: 0.01,
    boundaryJoint: 'half',
    stockWidth: 0,
    stockHeight: 0,
  };
  const surface = sample;
  const preview = layoutPanels(sample, ps).layout;
  const set = membersStep({ surface, steps: { preview } }, params);
  const typed = optimizeStep({ surface, steps: { preview, members: set } }, params);
  assert.equal(panelTypingSchema.safeParse(typed).success, true);
  assert.equal(typed.panels.length, preview.panels.length);
});

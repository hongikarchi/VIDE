// vide/paneling-kit T-260 (PLAN-49, SPEC-16.13): the hexagon and Voronoi patterns, a person's tile
// placed rigidly in tangent frames, and attractor openings — on synthetic sampled faces, through
// the jig steps, the stage-2/3 chain, the make rows and the 가정 gate. Synthetic data only; no host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attractorDistance,
  layoutPanels,
  membersStep,
  openingRatio,
  optimizeStep,
  previewSettingsFromParams,
  previewStep,
  tileFromCurves,
} from '../../src/jigs/official/paneling-kit/index.ts';
import {
  OPENING_MAX,
  curveSetSchema,
  panelLayoutSchema,
  panelTypingSchema,
  previewSettingsSchema,
} from '../../src/contracts/paneling.ts';
import { panelRows } from '../../src/jigs/bake/panels.ts';
import { stageSources } from '../../src/jigs/runtime/paneling-confirmed.ts';
import { settingInUse, settingShown, toneOf } from '../../src/ui/paneling/model.ts';
import { officialJigRoot } from '../../src/jigs/runtime/loader.ts';
import { validateJig } from '../../src/jigs/runtime/pack.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closedCylinder,
  cylinderBand,
  hypar,
  plane,
  previewSettings,
  sampleOf,
} from '../fixtures/paneling-surfaces.mjs';

const lay = (face, over = {}, extras) => {
  const result = layoutPanels(sampleOf(face), previewSettings(over), extras);
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  const parsed = panelLayoutSchema.safeParse(result.layout);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 3)));
  return { layout: result.layout, notes: result.notes };
};
const voronoi = (face, value, over = {}) => {
  const settings = {
    ...previewSettings({ pattern: 'voronoi', size: [1, 1], ...over }),
    voronoi: { value, source: 'person' },
  };
  const result = layoutPanels(sampleOf(face), settings);
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.equal(panelLayoutSchema.safeParse(result.layout).success, true);
  return result.layout;
};
const keyUses = (layout) => {
  const uses = new Map();
  for (const p of layout.panels) for (const k of p.vertexKeys) uses.set(k, (uses.get(k) ?? 0) + 1);
  return uses;
};
const areaOf = (layout) => layout.panels.filter((p) => !p.failure).reduce((a, p) => a + p.area, 0);
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const curveSet = (items) => ({
  schema: 'vide.paneling.curves@1',
  source: {
    linkId: 'link-1',
    documentKey: 'link-1',
    readAt: '2026-10-08T00:00:00.000Z',
    toMeters: 1,
    absTol: 0.001,
  },
  items: items.map((item, i) => ({
    objectId: ID(i + 1),
    kind: 'polyline',
    closed: true,
    flatXY: true,
    ...item,
  })),
});
const square = (x, y, s, z = 0) => [
  [x, y, z],
  [x + s, y, z],
  [x + s, y + s, z],
  [x, y + s, z],
];
/** Two 0.4 m squares 0.1 m apart, drawn far from the origin (the drawing's place does not matter). */
const twoSquares = () =>
  curveSet([{ points: square(100, 50, 0.4, 3) }, { points: square(100.5, 50, 0.4, 3) }]);

test('hexagon: rows 3h/4 apart, even rows pushed w/2, neighbours share every vertex by key', () => {
  const { layout } = lay(plane(6, 3.6), { pattern: 'hexagon', size: [1.2, 0.8] });
  assert.ok(Math.abs(areaOf(layout) - 6 * 3.6) < 1e-9, 'the panels cover the face');
  const whole = layout.panels.filter((p) => !p.boundary);
  assert.ok(whole.length >= 10);
  for (const p of whole) {
    assert.equal(p.uv.length, 6);
    assert.ok(Math.abs(p.width - 1.2) < 1e-9 && Math.abs(p.height - 0.8) < 1e-9, p.id);
  }
  // An inner lattice vertex is shared by three hexagons; only the four face corners stand alone.
  const uses = [...keyUses(layout).values()];
  assert.equal(Math.max(...uses), 3);
  assert.equal(uses.filter((n) => n === 1).length, 4);
  const byId = Object.fromEntries(layout.panels.map((p) => [p.id, p]));
  const centre = (p) => [
    p.corners.reduce((a, c) => a + c[0], 0) / p.corners.length,
    p.corners.reduce((a, c) => a + c[1], 0) / p.corners.length,
  ];
  // Row 2 (raw row 1, pushed) sits 0.6 m above row 1 and half a width along.
  const a = centre(byId['P-2-2']),
    b = centre(byId['P-3-2']);
  assert.ok(Math.abs(b[1] - a[1] - 0.6) < 1e-9);
  assert.ok(Math.abs(Math.abs(b[0] - a[0]) - 0.6) < 1e-9);
});

test('hexagon on a closed direction across the axis: an even row count, the height fits the period', () => {
  const R = 4;
  const { layout, notes } = lay(closedCylinder(R), {
    pattern: 'hexagon',
    size: [1.2, 0.8],
    direction: { axis: 'v', startCorner: 'min-min', flip: false },
  });
  // The period is the sampled circumference (a polyline on the sample grid, a hair under 2πR).
  const rows = (2 * Math.PI * R) / (0.75 * layout.module[1]);
  assert.ok(Math.abs(rows - Math.round(rows)) < 0.01 && Math.round(rows) % 2 === 0, `${rows}`);
  assert.ok(notes.some((n) => n.includes('세로 닫힌 방향이라 크기를 둘레에 맞춤')));
  // No panel is cut at the seam: the cut panels are only at the two open ends.
  for (const p of layout.panels.filter((x) => x.boundary)) {
    const z = p.corners.map((c) => c[2]);
    assert.ok(Math.min(...z) < 0.8 + 1e-6 || Math.max(...z) > 6 - 0.8 - 1e-6, p.id);
  }
  assert.ok(
    [...keyUses(layout).values()].every((n) => n >= 2),
    'wrapped keys are shared',
  );
});

test('Voronoi: seeds are deterministic, cells tile the face and share their vertices by seed names', () => {
  const layout = voronoi(plane(6, 4), { jitter: 0.5, seed: 1 });
  assert.ok(Math.abs(areaOf(layout) - 24) < 1e-9);
  assert.equal(layout.counts.offTarget, 0, '보로노이는 목표와 다름을 세지 않음');
  const uses = keyUses(layout);
  assert.equal([...uses.values()].filter((n) => n === 1).length, 4, 'only the face corners alone');
  for (const [key, n] of uses)
    if (key.startsWith('0:v:')) assert.equal(n, key.split('/').length, key);
  const again = voronoi(plane(6, 4), { jitter: 0.5, seed: 1 });
  assert.deepEqual(again, layout);
  const other = voronoi(plane(6, 4), { jitter: 0.5, seed: 2 });
  assert.notDeepEqual(
    other.panels.map((p) => p.corners),
    layout.panels.map((p) => p.corners),
  );
  // No jitter: the cells are the grid's squares and a corner joins four cells under one key.
  const square = voronoi(plane(6, 4), { jitter: 0, seed: 1 });
  assert.equal(square.panels.length, 24);
  assert.ok(square.panels.every((p) => p.uv.length === 4 && Math.abs(p.area - 1) < 1e-9));
  assert.equal(Math.max(...keyUses(square).values()), 4);
});

test('Voronoi on a closed cylinder and a trimmed hypar: seams wrap, trims cut, nothing fails', () => {
  const R = 4;
  const cyl = voronoi(closedCylinder(R), { jitter: 0.7, seed: 3 });
  assert.equal(cyl.counts.failed, 0);
  assert.ok([...keyUses(cyl).values()].every((n) => n >= 2));
  assert.ok(Math.abs(areaOf(cyl) - 2 * Math.PI * R * 6) / (2 * Math.PI * R * 6) < 2e-3);
  const hy = voronoi(hypar(), { jitter: 0.7, seed: 3 });
  assert.equal(hy.counts.failed, 0);
  assert.ok(hy.counts.boundary > 20);
});

test('tile: closed curves drawn flat, placed per cell in the tangent frame; pieces crossing the edge are dropped', () => {
  const tile = tileFromCurves(twoSquares());
  assert.deepEqual(
    tile.size.map((v) => Math.round(v * 1e9) / 1e9),
    [0.9, 0.4],
  );
  const { layout } = lay(plane(4.3, 3), { pattern: 'tile', size: [1, 1] }, { tile });
  const byId = Object.fromEntries(layout.panels.map((p) => [p.id, p]));
  assert.ok(byId['P-1-1t1'] && byId['P-1-1t2']);
  assert.ok(
    Math.abs(byId['P-1-1t1'].corners[0][0] - 0.05) < 1e-9,
    'piece 1 left of the cell centre',
  );
  for (const p of layout.panels.filter((x) => !x.failure)) {
    assert.ok(Math.abs(p.width - 0.4) < 1e-9 && Math.abs(p.height - 0.4) < 1e-9);
    assert.equal(p.boundary, false);
  }
  // Column 5 (centre 4.5 m) has its left piece over the 4.3 m edge: dropped with its reason; the
  // right piece is wholly outside and left out.
  const dropped = layout.panels.filter((p) => p.failure?.code === 'dropped');
  assert.equal(dropped.length, 3);
  assert.ok(dropped.every((p) => p.id.endsWith('t1') && p.failure.message.includes('타일 조각')));
  assert.equal(layout.counts.dropped, 3);
  assert.equal(layout.counts.total, 24);
  // No vertex is shared: every piece stands alone (stage 2 treats every edge as a boundary edge).
  assert.ok([...keyUses(layout).values()].every((n) => n === 1));
});

test('tile on a cylinder keeps the drawn shape (rigid), corners on the surface', () => {
  const R = 8;
  const tile = tileFromCurves(twoSquares());
  const { layout } = lay(cylinderBand(R), { pattern: 'tile', size: [1, 1] }, { tile });
  const ok = layout.panels.filter((p) => !p.failure);
  assert.ok(ok.length > 20);
  for (const p of ok) {
    for (const c of p.corners) assert.ok(Math.abs(Math.hypot(c[0], c[1]) - R) < 1e-4);
    // Edges stay 0.4 m: pressed onto R 8 m along the normal they shorten by under 1 mm.
    for (let i = 0; i < p.corners.length; i++) {
      const a = p.corners[i],
        b = p.corners[(i + 1) % p.corners.length];
      const len = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      assert.ok(Math.abs(len - 0.4) < 1e-3, `${p.id} ${len}`);
    }
  }
});

test('tile reading rules and the missing tile', () => {
  assert.throws(
    () => tileFromCurves(curveSet([{ points: square(0, 0, 1), closed: false }])),
    /타일 곡선이 아님 · 닫힌 곡선/,
  );
  assert.throws(
    () => tileFromCurves(curveSet([{ points: square(0, 0, 1), flatXY: false }])),
    /평면 XY/,
  );
  assert.throws(
    () =>
      tileFromCurves(
        curveSet([
          {
            points: [
              [0, 0, 0],
              [3, 1, 0],
              [3, 0, 0],
              [0, 2, 0],
            ],
          },
        ]),
      ),
    /자기 교차/,
  );
  const missing = layoutPanels(sampleOf(plane(2, 2)), previewSettings({ pattern: 'tile' }));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NO_TILE');
  assert.match(missing.message, /타일이 없습니다/);
  assert.equal(curveSetSchema.safeParse(twoSquares()).success, true);
});

test('attractor openings: ratio by distance, steps, the 0.95 cap and the measured share', () => {
  const settings = { near: 0.8, far: 0.2, radius: 3, levels: 0 };
  assert.equal(openingRatio(settings, 0), 0.8);
  assert.equal(openingRatio(settings, 3), 0.2);
  assert.ok(Math.abs(openingRatio(settings, 1.5) - 0.5) < 1e-12);
  assert.equal(openingRatio(settings, Infinity), 0.2, 'no attractor: the far ratio');
  const stepped = { ...settings, levels: 4 };
  for (const d of [0, 0.4, 1.1, 1.9, 2.6, 5])
    assert.ok(
      [0.2, 0.4, 0.6, 0.8].some((v) => Math.abs(openingRatio(stepped, d) - v) < 1e-12),
      `${d}`,
    );
  assert.ok(openingRatio({ near: 0.95, far: 0.95, radius: 1, levels: 0 }, 0) <= OPENING_MAX);
  assert.equal(
    previewSettingsSchema.safeParse({
      ...previewSettings(),
      opening: { value: { near: 0.96, far: 0, radius: 1, levels: 0 }, source: 'person' },
    }).success,
    false,
    'above 0.95 is refused by the settings check',
  );
  assert.equal(
    attractorDistance(
      [1, 1, 0],
      [
        {
          points: [
            [0, 0, 0],
            [2, 0, 0],
          ],
          closed: false,
        },
      ],
    ),
    1,
  );

  const sample = sampleOf(plane(6, 3));
  const attractors = [{ points: [[0.5, 0.5, 0]], closed: false }];
  const result = layoutPanels(
    sample,
    { ...previewSettings({ size: [1, 1] }), opening: { value: settings, source: 'person' } },
    { attractors },
  );
  assert.equal(result.ok, true);
  assert.equal(panelLayoutSchema.safeParse(result.layout).success, true);
  const byId = Object.fromEntries(result.layout.panels.map((p) => [p.id, p]));
  assert.equal(byId['P-1-1'].opening.ratio, 0.8);
  assert.ok(Math.abs(byId['P-1-1'].opening.actual - 0.8) < 1e-9, 'a plane keeps the share exactly');
  assert.ok(Math.abs(byId['P-1-6'].opening.ratio - 0.2) < 1e-12, '5 m away: far');
  // The attractors decide the layout too (the make keys' layout hash).
  const moved = layoutPanels(
    sample,
    { ...previewSettings({ size: [1, 1] }), opening: { value: settings, source: 'person' } },
    { attractors: [{ points: [[3, 1, 0]], closed: false }] },
  );
  assert.notEqual(moved.layout.settingsHash, result.layout.settingsHash);
  // Without an opening the hash is the settings' alone, as before T-260.
  const plain = layoutPanels(sample, previewSettings({ size: [1, 1] }), { attractors });
  const before = layoutPanels(sample, previewSettings({ size: [1, 1] }));
  assert.equal(plain.layout.settingsHash, before.layout.settingsHash);
  assert.ok(plain.layout.panels.every((p) => !p.opening));
});

const STEP_PARAMS = {
  pattern: 'grid',
  width: 1,
  height: 1,
  measure: 'arc-length',
  projection: 'plan-xy',
  axis: 'u',
  startCorner: 'min-min',
  flip: false,
  boundaryRule: 'trim',
  mergeBelow: 0.3,
  thickness: 0.02,
  thicknessSide: 'outside',
  joint: 0.01,
  boundaryJoint: 'flush',
  stockWidth: 0,
  stockHeight: 0,
  flatnessTol: 0.003,
  planarize: 'best-fit',
  typeTol: 0.002,
  maxTypes: 0,
  flatRadius: 100,
  nodeAngleStep: 1,
};
const chain = (face, params, inputs = {}) => {
  const surface = sampleOf(face);
  const preview = previewStep({ surface, ...inputs }, params);
  const members = membersStep({ surface, steps: { preview } }, params);
  const optimize = optimizeStep({ surface, steps: { preview, members } }, params);
  assert.equal(panelTypingSchema.safeParse(optimize).success, true);
  return { preview, members, optimize };
};

test('steps: Voronoi, hexagon and tile run through members and typing', () => {
  const vor = chain(plane(5, 4), { ...STEP_PARAMS, pattern: 'voronoi', jitter: 0.6, seed: 7 });
  assert.ok(vor.members.members.filter((m) => !m.failure).length >= 15);
  assert.ok(vor.optimize.joints.length > 0, 'Voronoi cells share joints');
  const hex = chain(plane(6, 3.6), { ...STEP_PARAMS, pattern: 'hexagon', width: 1.2, height: 0.8 });
  // Whole hexagons away from the edge are one type, the most numerous (cut pieces add others).
  assert.equal(hex.optimize.types[0].vertexCount, 6);
  assert.ok(hex.optimize.types[0].count >= 10);
  assert.ok(hex.optimize.nodes.some((n) => n.valence === 3));
  const tile = chain(
    plane(4, 3),
    { ...STEP_PARAMS, pattern: 'tile' },
    { tile: { value: twoSquares() } },
  );
  assert.equal(tile.preview.panels.length, 24);
  // Rigid pieces share nothing: no joints between them, and the two pieces are one shape.
  assert.equal(tile.members.joints.length, 0);
  assert.equal(tile.optimize.jointAt.length, 0);
  assert.equal(tile.optimize.types.length, 1);
  // Flush boundary joints: each piece keeps its drawn size.
  assert.ok(tile.members.members.every((m) => Math.abs(m.flatSize[0] - 0.4) < 1e-9));
  assert.throws(
    () => previewStep({ surface: sampleOf(plane(2, 2)) }, { ...STEP_PARAMS, pattern: 'tile' }),
    /타일이 없습니다/,
  );
});

test('openings split the types by target ratio (levels), and become curves in the preview make', () => {
  const attractors = {
    value: curveSet([{ kind: 'point', closed: false, flatXY: true, points: [[0.5, 0.5, 0]] }]),
  };
  const params = {
    ...STEP_PARAMS,
    openNear: 0.6,
    openFar: 0.2,
    openRadius: 2.5,
    openLevels: 3,
  };
  // Without openings: corner, edge and inner plates (flush boundary joints) are three types.
  const without = chain(plane(6, 3), STEP_PARAMS);
  assert.equal(without.optimize.types.length, 3);
  const withOpenings = chain(plane(6, 3), params, { attractors });
  const ratioOf = new Map(withOpenings.preview.panels.map((p) => [p.id, p.opening?.ratio]));
  assert.deepEqual([...new Set(ratioOf.values())].map((r) => r.toFixed(3)).sort(), [
    '0.200',
    '0.400',
    '0.600',
  ]);
  // Same shape, another opening level: another type; every type holds one level only.
  assert.ok(withOpenings.optimize.types.length > without.optimize.types.length);
  const levels = new Map();
  for (const t of withOpenings.optimize.panels) {
    if (!levels.has(t.type)) levels.set(t.type, new Set());
    levels.get(t.type).add(ratioOf.get(t.panelId).toFixed(3));
  }
  assert.ok([...levels.values()].every((set) => set.size === 1));

  const decl = {
    id: 'openings',
    template: 'vide.bake.curves@1',
    host: 'rhino',
    items: 'step.preview',
    rows: 'paneling',
    layer: '개구',
    key: 'id',
    mode: 'replace-own',
  };
  const rows = panelRows({
    decl,
    stepId: 'preview',
    output: withOpenings.preview,
    layout: withOpenings.preview,
    sample: sampleOf(plane(6, 3)),
    manifestParams: [],
    params: {},
    layerRoot: '패널링',
  });
  assert.deepEqual(rows.problems, []);
  assert.equal(rows.items.length, 18);
  const first = rows.items[0];
  assert.match(first.key, /^opening:[a-f0-9]{8}:P-1-1$/);
  assert.equal(first.curve.points.length, 5, 'closed: the first point again');
  assert.deepEqual(first.curve.points[0], first.curve.points[4]);
  assert.ok(first.attrs.some(([k, v]) => k === 'vide-opening' && v === '60.0'));
  // No opening: nothing to make (the declaration runs empty and clears earlier outlines).
  const none = panelRows({
    decl,
    stepId: 'preview',
    output: without.preview,
    layout: without.preview,
    sample: sampleOf(plane(6, 3)),
    manifestParams: [],
    params: {},
    layerRoot: '패널링',
  });
  assert.equal(none.items.length, 0);
});

test('가정 gate: Voronoi seeds count only with Voronoi, opening settings only with a ratio above 0', () => {
  const decls = [
    { key: 'pattern', group: '1단계 미리보기' },
    { key: 'jitter', group: '1단계 미리보기' },
    { key: 'seed', group: '1단계 미리보기' },
    { key: 'openNear', group: '1단계 미리보기' },
    { key: 'openFar', group: '1단계 미리보기' },
    { key: 'openRadius', group: '1단계 미리보기' },
    { key: 'openLevels', group: '1단계 미리보기' },
  ];
  const p = (value, by = 'default') => ({ value, by });
  const base = {
    pattern: p('grid', 'user'),
    jitter: p(0.5),
    seed: p(1),
    openNear: p(0),
    openFar: p(0),
    openRadius: p(10),
    openLevels: p(5),
  };
  assert.deepEqual(stageSources(decls, base).assumed.preview, []);
  assert.deepEqual(
    stageSources(decls, { ...base, pattern: p('voronoi', 'user') }).assumed.preview,
    ['jitter', 'seed'],
  );
  assert.deepEqual(stageSources(decls, { ...base, openNear: p(0.5, 'user') }).assumed.preview, [
    'openFar',
    'openRadius',
    'openLevels',
  ]);
  // The screen agrees: the opening ratios stay on screen, the rest only with an opening.
  const values = { pattern: 'grid', openNear: 0, openFar: 0 };
  assert.equal(settingInUse({ key: 'openNear' }, values), false);
  assert.equal(settingShown({ key: 'openNear' }, values), true);
  assert.equal(settingShown({ key: 'openRadius' }, values), false);
  assert.equal(settingShown({ key: 'openRadius' }, { ...values, openFar: 0.3 }), true);
  assert.equal(settingShown({ key: 'jitter' }, values), false);
  assert.equal(settingShown({ key: 'jitter' }, { ...values, pattern: 'voronoi' }), true);
  // Flat params → settings: Voronoi seeds and the opening appear only when they are read.
  assert.equal(previewSettingsFromParams(STEP_PARAMS).voronoi, undefined);
  assert.equal(previewSettingsFromParams(STEP_PARAMS).opening, undefined);
  assert.deepEqual(
    previewSettingsFromParams({ ...STEP_PARAMS, pattern: 'voronoi', jitter: 0.3, seed: 4 }).voronoi
      .value,
    { jitter: 0.3, seed: 4 },
  );
  assert.deepEqual(previewSettingsFromParams({ ...STEP_PARAMS, openFar: 0.1 }).opening.value, {
    near: 0,
    far: 0.1,
    radius: 10,
    levels: 5,
  });
});

test('the 개구율 colour: bands of the target ratio, none without an opening', () => {
  const { layout } = lay(plane(2, 1), { size: [1, 1] });
  const results = { layout };
  assert.equal(toneOf(layout.panels[0], results, 'opening'), 'ov-existing');
  const withOpening = {
    ...layout.panels[0],
    opening: { ratio: 0.9, actual: 0.9, uv: [], corners: [] },
  };
  assert.equal(toneOf(withOpening, results, 'opening'), 'ov-cat-5');
});

test('the official jig declares the tile and attractor inputs, the new settings and the openings make', async () => {
  const dir = join(officialJigRoot(), 'paneling');
  const manifest = JSON.parse(readFileSync(join(dir, 'jig.json'), 'utf8'));
  const inputs = Object.fromEntries(manifest.inputs.map((i) => [i.key, i]));
  assert.equal(inputs.tile.kind, 'host-curves');
  assert.equal(inputs.tile.accept, 'tile');
  assert.equal(inputs.attractors.accept, 'attractor');
  const pattern = manifest.params.find((p) => p.key === 'pattern');
  assert.deepEqual(
    pattern.choices.map((c) => c.value),
    ['grid', 'staggered', 'diamond', 'triangle', 'hexagon', 'voronoi', 'tile'],
  );
  const preview = manifest.steps.find((s) => s.id === 'preview');
  for (const read of ['input.tile', 'input.attractors', 'param.jitter', 'param.openLevels'])
    assert.ok(preview.reads.includes(read), read);
  assert.equal(manifest.params.find((p) => p.key === 'openNear').range.max, 0.95);
  assert.ok(manifest.bake.some((b) => b.id === 'openings' && b.layer === '개구'));
  assert.deepEqual(
    (await validateJig(dir, { source: 'builtin' })).issues.filter((i) => i.level === 'error'),
    [],
  );
});

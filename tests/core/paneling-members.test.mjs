// vide/paneling-kit stage 2 (PLAN-49 T-254, SPEC-16.6·16.10): stage-1 layouts on synthetic sampled
// faces → members. Joint reduction measured on the surface (not a fixed 2D distance), flush and
// half boundary joints, the joint gap range and '고르지 않음', the curvature limit toward the
// thickness side only, closed outward solids and their volume, plate sizes (exact when flat,
// approximate when curved), stock either way round, joint centre lines, failures (joint bigger
// than the panel, not closed) and the jig step. Synthetic data only; no host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildMembers,
  layoutFingerprint,
  layoutPanels,
  memberSettingsFromParams,
  membersStep,
  overStockOf,
  previewStep,
  resolveMemberSettings,
} from '../../src/jigs/official/paneling-kit/index.ts';
import { makeKey, memberSetSchema } from '../../src/contracts/paneling.ts';
import { JigRegistry, officialJigRoot } from '../../src/jigs/runtime/loader.ts';
import { selftestJig } from '../../src/jigs/runtime/pack.ts';
import {
  cylinderBand,
  hypar,
  plane,
  previewSettings,
  sampleOf,
} from '../fixtures/paneling-surfaces.mjs';

const MM = 0.001;
/** Members with every stage-2 value given by a person. */
const memberSettings = (over = {}) =>
  resolveMemberSettings({
    thickness: 0.05,
    thicknessSide: 'outside',
    joint: 0.01,
    boundaryJoint: 'flush',
    stock: null,
    ...over,
  });
const run = (face, preview = {}, members = {}, options) => {
  const sample = sampleOf(face);
  const settings = previewSettings(preview);
  const laid = layoutPanels(sample, settings);
  assert.equal(laid.ok, true, JSON.stringify(laid));
  const out = buildMembers(sample, laid.layout, settings, memberSettings(members), options);
  const parsed = memberSetSchema.safeParse(out.members);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 3)));
  return { sample, layout: laid.layout, set: out.members, ms: out.ms };
};
const byId = (set) => Object.fromEntries(set.members.map((m) => [m.panelId, m]));
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

/** Every edge used once each way and a positive signed volume. */
function closedOutward(mesh) {
  const count = new Map();
  for (let i = 0; i < mesh.f.length; i += 3)
    for (const [a, b] of [
      [mesh.f[i], mesh.f[i + 1]],
      [mesh.f[i + 1], mesh.f[i + 2]],
      [mesh.f[i + 2], mesh.f[i]],
    ])
      count.set(`${a}>${b}`, (count.get(`${a}>${b}`) ?? 0) + 1);
  for (const [k, n] of count) {
    const [a, b] = k.split('>');
    if (n !== 1 || count.get(`${b}>${a}`) !== 1) return { closed: false, volume: 0 };
  }
  const p = (i) => [mesh.v[3 * i], mesh.v[3 * i + 1], mesh.v[3 * i + 2]];
  let six = 0;
  for (let i = 0; i < mesh.f.length; i += 3) {
    const [a, b, c] = [p(mesh.f[i]), p(mesh.f[i + 1]), p(mesh.f[i + 2])];
    six +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return { closed: true, volume: six / 6 };
}

test('plane 2 × 2 grid of 1.2 × 0.6, joint 10 mm: inner gaps 10 mm, plates 1.195 × 0.595 flush, 1.19 × 0.59 half', () => {
  const face = plane(2.4, 1.2, { paramScale: 1000 });
  const { set, layout } = run(face);
  assert.equal(set.members.length, 4);
  assert.deepEqual(
    set.members.map((m) => m.panelId),
    layout.panels.map((p) => p.id),
    'same order as the layout',
  );
  for (const m of set.members) {
    assert.equal(m.failure, null);
    near(m.flatSize[0], 1.195, 1e-9, 'plate width');
    near(m.flatSize[1], 0.595, 1e-9, 'plate height');
    assert.equal(m.flatSizeApprox, false, 'a flat plate has its real size');
    near(m.jointGap[0], 0.01, 1e-9, 'gap min');
    near(m.jointGap[1], 0.01, 1e-9, 'gap max');
    assert.equal(m.jointUneven, false);
    near(m.area, 1.195 * 0.595, 1e-9, 'area');
    near(m.volume, 1.195 * 0.595 * 0.05, 1e-9, 'volume = area × 50 mm');
    assert.equal(m.thickness, 0.05);
  }
  // The reduced outline stays in the face's own (mm) parameters, flush on the face boundary.
  const p11 = byId(set)['P-1-1'];
  assert.deepEqual(
    p11.uv.map((q) => q.map((x) => Math.round(x * 1e6) / 1e6)),
    [
      [0, 0],
      [1195, 0],
      [1195, 595],
      [0, 595],
    ],
  );
  // Joint centre lines: one per shared edge, on the lattice line between the plates.
  assert.equal(set.joints.length, 4);
  const vertical = set.joints.find((j) => j.keys.join() === '0:1:0,0:1:1');
  assert.ok(vertical);
  for (const q of vertical.line) near(q[0], 1.2, 1e-9, 'centre line x');
  assert.deepEqual(set.overStock, []);
  assert.equal(set.layoutHash, layoutFingerprint(layout));
  assert.match(makeKey('member', set.layoutHash, 'P-1-1'), /^member:[a-f0-9]{8}:P-1-1$/);

  const half = run(face, {}, { boundaryJoint: 'half' }).set;
  for (const m of half.members) {
    near(m.flatSize[0], 1.19, 1e-9, 'half: width');
    near(m.flatSize[1], 0.59, 1e-9, 'half: height');
  }
  // Joint 0: plates are the panels.
  const none = run(face, {}, { joint: 0 }).set;
  for (const m of none.members) {
    near(m.flatSize[0], 1.2, 1e-9, 'no joint: width');
    assert.deepEqual(m.jointGap, [0, 0]);
  }
});

test('closed, outward solids on both thickness sides; volume = area × thickness on a plane', () => {
  for (const thicknessSide of ['outside', 'inside']) {
    const { set } = run(plane(2.4, 1.2), {}, { thicknessSide, thickness: 0.03 });
    for (const m of set.members) {
      assert.ok(m.solid, `${m.panelId} has a solid`);
      const { closed, volume } = closedOutward(m.solid);
      assert.ok(closed, `${thicknessSide} ${m.panelId} closed`);
      assert.ok(volume > 0, `${thicknessSide} ${m.panelId} outward`);
      near(volume, m.volume, 1e-9, 'mesh volume');
      near(m.volume, m.area * 0.03, 1e-9, 'area × thickness');
      const zs = m.solid.v.filter((_, i) => i % 3 === 2);
      near(
        thicknessSide === 'outside' ? Math.max(...zs) : Math.min(...zs),
        thicknessSide === 'outside' ? 0.03 : -0.03,
        1e-9,
        `${thicknessSide}: offset along the reference normal`,
      );
    }
  }
  // [뒤집기] reverses the reference normal: 'outside' now goes to −z.
  const flipped = run(plane(2.4, 1.2), {
    direction: { axis: 'u', startCorner: 'min-min', flip: true },
  });
  const zs = flipped.set.members[0].solid.v.filter((_, i) => i % 3 === 2);
  near(Math.min(...zs), -0.05, 1e-9, 'flip: outside is −z');
  // Without solids (the work copy).
  const lean = run(plane(2.4, 1.2), {}, {}, { solids: false }).set;
  assert.ok(lean.members.every((m) => m.solid === null && m.volume > 0));
});

test('cylinder band R 8 m: the joint is 10 mm on the surface, which is not a fixed distance in 2D', () => {
  // θ = angle·(u + u²/2)/1.5: one unit of u is twice as long at u = 1 as at u = 0.
  const { set, layout } = run(cylinderBand(8), {}, { joint: 0.01 });
  const tolGap = Math.max(1 * MM, 0.1 * 0.01);
  let gaps = 0;
  for (const m of set.members) {
    assert.equal(m.failure, null, m.panelId);
    if (!m.jointGap) continue;
    gaps++;
    assert.ok(m.jointGap[0] <= m.jointGap[1]);
    assert.ok(Math.abs(m.jointGap[0] - 0.01) <= tolGap, `${m.panelId} min ${m.jointGap[0]}`);
    assert.ok(Math.abs(m.jointGap[1] - 0.01) <= tolGap, `${m.panelId} max ${m.jointGap[1]}`);
    assert.equal(m.jointUneven, false);
    assert.equal(m.flatSizeApprox, true, 'a curved plate is measured on its best-fit plane');
  }
  assert.ok(gaps >= 100, `${gaps}`);
  // The UV distance each side moved in: the first column's right edge vs the last full column's.
  const panels = Object.fromEntries(layout.panels.map((p) => [p.id, p]));
  const members = byId(set);
  const moved = (id, edge) => {
    const p = panels[id].uv,
      m = members[id].uv;
    return Math.abs(p[edge][0] - m[edge][0]);
  };
  const lastFull = layout.panels.filter((p) => p.row === 1 && !p.boundary).at(-1).id;
  const first = moved('P-1-1', 1); // right side, bottom corner
  const last = moved(lastFull, 0); // left side, bottom corner
  assert.ok(first / last > 1.5, `UV move ${first} vs ${last}: the surface scale decides it`);
});

test('curvature limit: thickness toward the curvature centre fails at thickness × k ≥ 0.7, the other side passes', () => {
  // R 8 m: 50 mm either way is far below the limit.
  for (const thicknessSide of ['outside', 'inside']) {
    const { set } = run(cylinderBand(8), {}, { thicknessSide });
    assert.ok(
      set.members.every((m) => m.failure === null),
      thicknessSide,
    );
  }
  // R 0.5 m (k = 2 /m), panels 0.2 × 0.2: 400 mm toward the centre → 0.8 ≥ 0.7 fails.
  const small = (thicknessSide, thickness) =>
    run(
      cylinderBand(0.5, (2 * Math.PI) / 3, 0.6),
      { size: [0.2, 0.2] },
      { thicknessSide, thickness },
    ).set;
  const inward = small('inside', 0.4);
  assert.ok(inward.members.length > 0);
  for (const m of inward.members) {
    assert.equal(m.failure?.code, 'thickness-curvature', m.panelId);
    assert.match(m.failure.message, /두께 불가 · 곡률 반지름 500 mm/);
    assert.equal(m.solid, null);
  }
  assert.ok(
    small('outside', 0.4).members.every((m) => m.failure === null),
    'convex side passes',
  );
  assert.ok(
    small('inside', 0.3).members.every((m) => m.failure === null),
    '0.6 < 0.7 passes',
  );
  // [뒤집기] swaps which side is the centre side.
  const flipped = run(
    cylinderBand(0.5, (2 * Math.PI) / 3, 0.6),
    { size: [0.2, 0.2], direction: { axis: 'u', startCorner: 'min-min', flip: true } },
    { thicknessSide: 'outside', thickness: 0.4 },
  ).set;
  assert.ok(flipped.members.every((m) => m.failure?.code === 'thickness-curvature'));
});

test('stock 1.2 × 1.5 m: a plate that fits turned 90° is not over; one that fits neither way is listed', () => {
  assert.equal(overStockOf(1.4, 1.2, [1.2, 1.5]), false);
  assert.equal(overStockOf(1.6, 1.0, [1.2, 1.5]), true);
  const fits = run(plane(2.8, 2.4), { size: [1.4, 1.2] }, { joint: 0, stock: [1.2, 1.5] }).set;
  assert.deepEqual(fits.overStock, []);
  const over = run(plane(3.2, 2.0), { size: [1.6, 1.0] }, { joint: 0, stock: [1.2, 1.5] }).set;
  assert.deepEqual(over.overStock, ['P-1-1', 'P-1-2', 'P-2-1', 'P-2-2']);
  assert.ok(
    over.members.every((m) => m.failure === null),
    'over stock is not a failure',
  );
});

test('failures: a joint bigger than the panel → degenerate, a sheet that does not close → not-closed, stage-1 failures carried', () => {
  const big = run(plane(2.4, 1.2), {}, { joint: 1.3 }).set;
  for (const m of big.members) {
    assert.equal(m.failure?.code, 'degenerate', m.panelId);
    assert.match(m.failure.message, /줄눈\(1300 mm\)이 패널보다 커서/);
    assert.equal(m.solid, null);
  }
  // Normals of length 0: the offset sheet sits on the front one, nothing closes; never patched.
  const flat = plane(2.4, 1.2);
  flat.normals = flat.normals.map(() => 0);
  const open = run(flat).set;
  for (const m of open.members) {
    assert.equal(m.failure?.code, 'not-closed', m.panelId);
    assert.equal(m.solid, null);
  }
  // 'drop' panels stay listed with their failure; their edges are boundary for the neighbours.
  const { set, layout } = run(plane(2.5, 1.2), { boundary: { rule: 'drop', mergeBelow: 0.3 } });
  assert.equal(set.members.length, layout.panels.length);
  const dropped = set.members.filter((m) => m.failure?.code === 'dropped');
  assert.equal(dropped.length, 2);
  const p12 = byId(set)['P-1-2'];
  near(p12.flatSize[0], 1.195, 1e-9, 'edge next to a dropped panel is flush');
});

test('jointUneven: a gap off target by more than max(1 mm, 10 %) is flagged, not failed', () => {
  // The check is on the measured gap: move P-1-2's left edge 5 mm away from P-1-1 in UV (the shared
  // vertex keys stay), so after the 10 mm joint the two plates sit 15 mm apart.
  const sample = sampleOf(plane(2.4, 1.2));
  const settings = previewSettings();
  const layout = structuredClone(layoutPanels(sample, settings).layout);
  const p12 = layout.panels.find((p) => p.id === 'P-1-2');
  p12.uv[0][0] += 0.005;
  p12.uv[3][0] += 0.005;
  const set = buildMembers(sample, layout, settings, memberSettings()).members;
  const a = byId(set)['P-1-1'],
    b = byId(set)['P-1-2'];
  near(a.jointGap[1], 0.015, 1e-6, 'measured gap');
  assert.equal(a.jointUneven, true);
  assert.equal(b.jointUneven, true);
  assert.equal(a.failure, null);
  assert.equal(b.failure, null);
});

test('settings from the jig params: given values keep their source, stock 0 × 0 is no limit, the rest assumed', () => {
  const s = memberSettingsFromParams({ thickness: 0.04, joint: 0, stockWidth: 0, stockHeight: 0 }, [
    'joint',
  ]);
  assert.deepEqual(s.thickness, { value: 0.04, source: 'person' });
  assert.deepEqual(s.joint, { value: 0, source: 'assumed' });
  assert.deepEqual(s.stock, { value: null, source: 'person' });
  assert.deepEqual(s.thicknessSide, { value: 'outside', source: 'assumed' });
  const t = memberSettingsFromParams({ stockWidth: 1.2, stockHeight: 2.4 });
  assert.deepEqual(t.stock, { value: [1.2, 2.4], source: 'person' });
  assert.equal(
    memberSettingsFromParams({ stockWidth: 1.2, stockHeight: 0 }).stock.source,
    'assumed',
  );
});

test('the members step reads step.preview; without it the reason is given', () => {
  const surface = sampleOf(plane(2.4, 1.2, { paramScale: 1000 }));
  const preview = previewStep({ surface }, {});
  const set = membersStep({ surface, steps: { preview } }, { joint: 0.02, boundaryJoint: 'half' });
  assert.equal(set.schema, 'vide.paneling.members@1');
  near(set.members[0].flatSize[0], 1.18, 1e-9, 'half joint 20 mm');
  assert.throws(() => membersStep({ surface, steps: {} }, {}), /1단계 미리보기 결과가 없습니다/);
});

test('same input twice → the same members; about 5,000 panels on the hypar in time', (t) => {
  const a = run(plane(2.4, 1.2)).set,
    b = run(plane(2.4, 1.2)).set;
  assert.deepEqual(a, b);
  const { set, ms, layout } = run(hypar(), { size: [0.34, 0.34] });
  t.diagnostic(`${layout.counts.total} panels → members in ${ms} ms`);
  assert.equal(set.members.length, layout.panels.length);
  const ok = set.members.filter((m) => !m.failure);
  assert.ok(ok.length >= 5000, `${ok.length}`);
  for (const m of ok.slice(0, 200)) assert.ok(closedOutward(m.solid).closed, m.panelId);
  // Gaps across the doubly curved surface stay at 10 mm.
  const off = ok.filter((m) => m.jointUneven);
  assert.equal(
    off.length,
    0,
    off
      .slice(0, 3)
      .map((m) => `${m.panelId} ${m.jointGap}`)
      .join('; '),
  );
  assert.ok(ms < 5000, `${ms} ms`);
});

test('the official jig runs the members step in its self-test', async () => {
  const dir = join(officialJigRoot(), 'paneling');
  const registry = new JigRegistry({ dataDir: tmpdir() });
  const entry = (await registry.list()).find((e) => e.id === 'vide/paneling');
  assert.ok(entry);
  const report = await selftestJig(dir, { source: 'builtin' });
  assert.ok(
    report.cases.every((c) => c.ok),
    JSON.stringify(report.cases.filter((c) => !c.ok)),
  );
});

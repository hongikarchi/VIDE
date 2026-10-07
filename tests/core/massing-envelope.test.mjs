import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MERGE_DEVIATION,
  buildableStep,
  envelopeStep,
  limitStep,
  planStep,
  regulationStep,
  siteStep,
  solidCutters,
} from '../../src/jigs/official/massing-kit/index.ts';
import {
  checkSolid,
  facesVolume,
  mergeCoplanar,
  prismSolid,
  regionPrismSolid,
  reversedMesh,
  solidSubtract,
  weldSolid,
} from '../../src/jigs/official/geometry-kit/index.ts';
import { extractItems } from '../../src/jigs/bake/plan.ts';
import { renderChunks } from '../../src/jigs/bake/templates.ts';
import {
  SITES,
  SLANTED,
  nearStraightLot,
  paramsOf,
  runMass,
  star,
} from '../fixtures/massing-sites.mjs';

// PLAN-45 T-210 (SPEC-12.9): 돌출 · 일조 사선 · 최대 외피 as closed polyhedra in the engine, the
// closed/orientation/volume check, the engine's coplanar merge for `vide.bake.brep-faces@1`, the
// 판단 필요 variants and the 정북 기준 switch, on the synthetic sites of SPIKE-2026-10-07-envelope.

const JIG = 'src/jigs/official/jigs/buildable-mass';
const close = (actual, expected, eps, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} ≠ ${expected} (±${eps})`);

function run(site, extra = {}) {
  const params = { ...paramsOf(site), ...extra };
  const own = site.inputs.site;
  const s = siteStep({ site: own }, params);
  const regulations = regulationStep({}, params);
  const plan = planStep({}, params);
  const limits = limitStep({ site: own, steps: { site: s, regulations } });
  return { site: s, limits, out: envelopeStep({ steps: { site: s, regulations, plan, limits } }) };
}
const volumes = (variant) => Object.fromEntries(variant.envelopes.map((e) => [e.kind, e.volume]));

test('envelope volumes against hand calculations (exact sites) and the true-circle grid (0.1 %)', () => {
  for (const site of SITES) {
    const { out } = run(site);
    assert.equal(out.variants.length, 1);
    const v = volumes(out.variants[0]);
    const e = site.expect;
    for (const kind of ['extrude', 'sun', 'max'])
      if (e[kind] !== undefined) close(v[kind], e[kind], 1e-6, `${site.id} ${kind}`);
    if (e.maxGrid !== undefined) {
      close(v.max, e.maxGrid, 1e-3 * e.maxGrid, `${site.id} max`);
      assert.ok(v.max <= e.maxGrid + 0.4, `${site.id}: round ends only remove more`);
    }
    for (const env of out.variants[0].envelopes) {
      assert.equal(env.check.ok, true, `${site.id} ${env.kind}: ${env.check.reasons}`);
      assert.ok(env.faces >= 6 && env.faces <= env.polygons);
    }
  }
});

test('sections and the 일조 cut: rect at the 5th floor mid-height (16.05 m) holds 19 × 20.975; the sun cut is 돌출 − 최대', () => {
  const { out } = run(SITES[0]);
  const v = out.variants[0];
  // floors 4.5 + 3.3 k: mid-heights 2.25, 6.15, 9.45, 12.75, 16.05, …
  const at = v.sections.find((s) => Math.abs(s.z - 16.05) < 1e-9);
  // d ≥ 16.05 / 2 from the datum y = 30 → y ≤ 21.975; x ∈ [0.5, 19.5], y ≥ 1.
  close(at.max, 19 * (21.975 - 1), 1e-6, 'max section');
  close(at.extrude, 19 * 27.5, 1e-6, 'extrude section');
  close(v.sunCutVolume, 15675 - 12445, 1e-6, 'sun cut');
});

test('due-north distance: slanted north boundary matches the hand calculation; the shortest distance cuts more', () => {
  const north = volumes(run(SLANTED).out.variants[0]);
  close(north.extrude, SLANTED.expect.extrude, 1e-6, 'extrude');
  close(north.sun, SLANTED.expect.sun, 1e-6, 'sun (north)');
  const euclid = volumes(run(SLANTED, { sunDistance: 'euclidean' }).out.variants[0]);
  assert.ok(euclid.sun < north.sun - 100, `${euclid.sun} < ${north.sun}`);
  // Undecided definition: computed with the shortest distance and counted as unconfirmed.
  const asked = run(SLANTED, { sunDistance: 'ask' });
  close(volumes(asked.out.variants[0]).sun, euclid.sun, 1e-9, 'ask = shortest distance');
  assert.ok(asked.out.unresolved.some((u) => /일조 거리의 정의 사람 입력 필요/.test(u.reason)));
  assert.equal(asked.out.unconfirmed, run(SLANTED).out.unconfirmed + 1);
});

test('정북 기준: 진북 with a convergence angle recomputes; 도북 ignores it', () => {
  const rect = SITES[0];
  const base = volumes(run(rect).out.variants[0]);
  const trueNorth = run(rect, { convergenceDeg: 30, northBasis: 'true' });
  const gridNorth = run(rect, { convergenceDeg: 30, northBasis: 'grid' });
  assert.deepEqual(volumes(gridNorth.out.variants[0]), base);
  const turned = volumes(trueNorth.out.variants[0]);
  assert.ok(turned.max < base.max - 1, `${turned.max} vs ${base.max}`);
  // North turned 30° east: the east parcel edge now faces north too.
  assert.deepEqual(trueNorth.limits.sun.datum.map((d) => d.target).sort(), ['s1', 's2']);
  close(trueNorth.site.north[0], 0.5, 1e-12);
});

test("'판단 필요' 일조 or 높이 gives both envelopes; a missing height uses the 검토 높이 and says so", () => {
  const rect = SITES[0];
  const sun = run(rect, { sunState: 'undecided' }).out;
  assert.deepEqual(
    sun.variants.map((v) => [v.id, v.sunApplied, volumes(v).max]),
    [
      ['base', true, 12445],
      ['without', false, 19 * 28.5 * 30],
    ],
  );
  assert.equal(sun.items.length, 3 + 2, 'base: 돌출·일조·최대, without: 돌출·최대');

  const height = run(rect, { heightMaxState: 'undecided' }).out;
  assert.deepEqual(
    height.variants.map((v) => [v.id, v.height, v.heightSource]),
    [
      ['base', 30, '최고 높이'],
      ['without', 60, '검토 높이(계산 상한, 법정 값 아님)'],
    ],
  );
  const none = run(rect, { heightMaxState: 'ask' }).out;
  assert.equal(none.variants[0].height, 60);
  assert.ok(
    none.unresolved.some((u) => u.rule === 'height-limit' && /사람 입력 필요/.test(u.reason)),
  );
  // The lowest applied height wins; with none, 층수 × 층고 (1층 + 기준층 × (n − 1)).
  const lowest = run(rect, { streetHeightState: 'apply', streetHeight: 24 }).out;
  assert.equal(lowest.variants[0].heightSource, '가로구역 최고 높이');
  const floors = run(rect, { heightMaxState: 'none', floorsMaxState: 'apply', floorsMax: 7 }).out;
  close(floors.variants[0].height, 4.5 + 6 * 3.3, 1e-9);
});

test('the check refuses inside-out and open solids; it never flips', () => {
  const { out } = run(SITES[1]);
  const box = weldSolid(
    solidSubtract(
      prismSolid(
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        0,
        5,
      ),
      [],
    ),
  );
  assert.equal(checkSolid(box).ok, true);
  const inside = checkSolid(reversedMesh(box));
  assert.equal(inside.ok, false);
  assert.equal(inside.boundaryEdges, 0, 'closed but inside out');
  assert.ok(inside.reasons.some((r) => /뒤집힘/.test(r)));
  const open = checkSolid({ v: box.v, f: box.f.slice(1) });
  assert.equal(open.ok, false);
  assert.ok(open.reasons.some((r) => /열린 변/.test(r)));
  // Merged faces keep every vertex; as wound they hold the checked volume.
  for (const item of out.items) {
    close(facesVolume(item.faces), item.volume, 1e-9 * item.volume, item.key);
    assert.ok(item.faces.every((f) => f[0].length >= 3));
  }
});

test('coplanar merge: an L-shaped box top is one face; a box with a courtyard keeps the hole', () => {
  const l = weldSolid(
    prismSolid(
      [
        [0, 0],
        [30, 0],
        [30, 15],
        [15, 15],
        [15, 30],
        [0, 30],
      ],
      0,
      10,
    ),
  );
  const faces = mergeCoplanar(l);
  assert.equal(faces.length, 8, 'top, bottom, six walls');
  const ring = solidSubtract(
    prismSolid(
      [
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
      ],
      0,
      10,
    ),
    prismSolid(
      [
        [5, 5],
        [15, 5],
        [15, 15],
        [5, 15],
      ],
      -1,
      11,
    ),
  );
  const merged = mergeCoplanar(weldSolid(ring));
  const tops = merged.filter((f) => f[0].every((p) => Math.abs(p[2] - 10) < 1e-9));
  assert.equal(tops.length, 1);
  assert.equal(tops[0].length, 2, 'outer ring and the courtyard hole');
  close(facesVolume(merged), 300 * 10, 1e-9);
});

test('stress sites (spike star-8, star-16) close and merge; the bake declaration reads the items', () => {
  for (const n of [8, 16]) {
    const { out } = run(star(n));
    for (const env of out.variants[0].envelopes)
      assert.equal(env.check.ok, true, `star-${n} ${env.kind}: ${env.check.reasons}`);
  }
  const manifest = JSON.parse(readFileSync(`${JIG}/jig.json`, 'utf8'));
  const decl = manifest.bake.find((b) => b.id === 'envelopes');
  const { out } = run(SITES[1]);
  const { items, problems } = extractItems(decl, out);
  assert.deepEqual(problems, []);
  assert.equal(items.length, 3);
  const attrs = Object.fromEntries(items[2].attrs);
  assert.equal(attrs['vide-envelope'], '최대 외피 (판단 필요 항목 적용)');
  assert.match(attrs['vide-rules'], /법정 최대치 추정/);
  const chunks = renderChunks(
    {
      template: decl.template,
      jigId: 'vide/buildable-mass',
      instanceId: 'test',
      bakeId: decl.id,
      runId: 'run',
      layerPath: 'VIDE::매스::외피',
      deleteIds: [],
    },
    items,
  );
  assert.deepEqual(
    chunks.flatMap((c) => c.keys),
    ['env:base:extrude', 'env:base:sun', 'env:base:max'],
  );
});

test('a floor section with a long straight cut edge (one point 7e-15 m off) closes as a prism (T-214)', () => {
  // The 위층 축소 cut of a real lot read back from Rhino left dozens of points on the cut line,
  // one a hair below it; ear clipping stopped with only straight-run points left. Synthetic ring.
  const top = [];
  for (let k = 0; k <= 30; k++) top.push([60 - 4 * k, k === 15 ? -7e-15 : 0]);
  const base = [
    ...top,
    [-60, -10],
    [-40, -30],
    [-20, -25],
    [0, -40],
    [20, -28],
    [40, -35],
    [60, -10],
  ];
  const ring = [...base.slice(20), ...base.slice(0, 20)];
  const area =
    Math.abs(
      ring.reduce((s, p, i) => {
        const q = ring[(i + 1) % ring.length];
        return s + p[0] * q[1] - q[0] * p[1];
      }, 0),
    ) / 2;
  const check = checkSolid(weldSolid(prismSolid(ring, 0, 3)));
  assert.ok(check.ok, check.reasons.join(', '));
  assert.ok(Math.abs(check.volume - area * 3) < 1e-6, `${check.volume} vs ${area * 3}`);
});

test('F-6: a lot of 36 short road segments bent by millimetres gives closed envelopes with any 건축선 후퇴 (T-214)', () => {
  // Before the fix the 돌출 외피 of these lots failed the check ('열린 변 3, 비다양체 변 30' for seed
  // 1 at 0.5 m, 16 of the 18 seed × setback cases) while the 2D 가능 영역 was computed.
  for (const seed of [1, 2, 5])
    for (const setback of [0.5, 1, 3]) {
      const site = nearStraightLot(seed, setback);
      const { site: s, limits, out } = run(site);
      assert.equal(s.segments.length, 36);
      assert.ok(s.segments.every((g) => g.kind === 'road'));
      const params = paramsOf(site);
      const area = buildableStep({
        steps: { site: s, regulations: regulationStep({}, params), limits },
      }).area;
      const v = out.variants[0];
      for (const env of v.envelopes)
        assert.equal(
          env.check.ok,
          true,
          `seed ${seed} ${setback} m ${env.kind}: ${env.check.reasons}`,
        );
      // The 돌출 외피 is the 2D 가능 영역 extruded to the height cap (40 m).
      close(volumes(v).extrude, area * 40, 1e-6 * area * 40, `seed ${seed} ${setback} m`);
      // Every floor section of the prism is the 2D area.
      for (const sec of v.sections) close(sec.extrude, area, 1e-6 * area, `section ${sec.z}`);
    }
});

test('F-6: the whole mass chain (floors, 대안, 주차) runs on the many-segment lot', async () => {
  const { steps } = await runMass(nearStraightLot(1, 0.5));
  assert.ok(steps.alternatives.rows.length >= 1);
  assert.ok(steps.parking.ground.free > 0);
});

test('F-6: near-straight runs are cut as one capsule grown by their deviation (≤ 1 mm, safe side)', () => {
  const site = nearStraightLot(1, 0.5);
  const params = paramsOf(site);
  const s = siteStep({ site: site.inputs.site }, params);
  const limits = limitStep({
    site: site.inputs.site,
    steps: { site: s, regulations: regulationStep({}, params) },
  });
  const merged = solidCutters(limits.cutters);
  assert.ok(merged.length < limits.cutters.length, 'some runs merged');
  const byTarget = new Map(limits.cutters.map((c) => [c.target, c]));
  const distance = (p, a, b) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
    );
    return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
  };
  for (const { cutter, targets } of merged) {
    if (targets.length < 2) continue;
    const grown = cutter.radius - 0.5;
    assert.ok(grown >= 0 && grown <= MERGE_DEVIATION, `grown ${grown}`);
    // Every piece lies within the growth of the chord, so the merged capsule covers it.
    for (const t of targets)
      for (const p of [byTarget.get(t).a, byTarget.get(t).b])
        assert.ok(distance(p, cutter.a, cutter.b) <= grown + 1e-12);
  }
});

test('a region with a hole and near-straight vertices is a closed prism with the exact volume (F-6)', () => {
  const outer = [];
  for (let k = 0; k <= 40; k++) outer.push([k, k % 2 ? 1e-9 : 0]);
  outer.push([40, 30], [0, 30]);
  const hole = [
    [10, 10],
    [10, 20],
    [20, 20],
    [20, 10],
  ];
  const check = checkSolid(weldSolid(regionPrismSolid(outer, [hole], 0, 5)));
  // Closed and manifold; a hole through the prism makes it a torus (Euler 0), which the
  // envelope check rightly refuses as one shell of Euler 2.
  assert.deepEqual([check.boundaryEdges, check.nonManifoldEdges, check.euler], [0, 0, 0]);
  close(check.volume, (40 * 30 - 100) * 5, 1e-6);
  const triangulated = checkSolid(weldSolid(regionPrismSolid(outer, [], 0, 5, true)));
  assert.ok(triangulated.ok, triangulated.reasons.join(', '));
  close(triangulated.volume, 40 * 30 * 5, 1e-6);
});

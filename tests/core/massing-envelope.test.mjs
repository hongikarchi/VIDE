import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  envelopeStep,
  limitStep,
  planStep,
  regulationStep,
  siteStep,
} from '../../src/jigs/official/massing-kit/index.ts';
import {
  checkSolid,
  facesVolume,
  mergeCoplanar,
  prismSolid,
  reversedMesh,
  solidSubtract,
  weldSolid,
} from '../../src/jigs/official/geometry-kit/index.ts';
import { extractItems } from '../../src/jigs/bake/plan.ts';
import { renderChunks } from '../../src/jigs/bake/templates.ts';
import { SITES, SLANTED, paramsOf, star } from '../fixtures/massing-sites.mjs';

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

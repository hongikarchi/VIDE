// 제한선과 2D 건축 가능 영역 (SPEC-12.8, PLAN-45 T-209). Each restriction is a plan region to remove
// from the site, as data (`Cutter`) so the step output can carry it and the envelope step can make
// the same solids again. Distances are measured to boundary *segments* (capsules), never to
// infinite lines: an infinite strip over-cuts at reflex corners and beside exempt runs
// (RESEARCH-04 J-04, SPIKE-2026-10-07-envelope 결과 1). Round ends are polygons circumscribing the
// circle (64 sides by default), so the approximation only removes more (safe side). A round end is
// left out only where the next segment of the same rule meets at a convex or straight corner with
// a distance at least as large — inside the site that next capsule already covers it.
//
// The 2D area is computed on a 1 m slab with the solid booleans of `vide/geometry-kit` (area =
// volume), as in the spike.

import { signedArea, type Polygon, type Vec2 } from '../geometry-kit/plan.ts';
import {
  checkSolid,
  loftSolid,
  mergeCoplanar,
  prismSolid,
  solidIntersect,
  solidSubtract,
  solidUnionAll,
  solidVolume,
  weldSolid,
  type Solid,
} from '../geometry-kit/solid.ts';
import type { RuleId } from './rules.ts';

/** Sides of a full circle for round ends (multiple of 4). SPIKE 결론 3: 64. */
export const ARC_SIDES = 64;

/** A capsule around a segment: every point within `radius` of it. */
export interface CapsuleCutter {
  rule: RuleId;
  kind: 'capsule';
  a: Vec2;
  b: Vec2;
  radius: number;
  /** False = the end at a (b) is flat (covered by the next capsule of the same rule). */
  roundA: boolean;
  roundB: boolean;
  /** Segment, corner or drawn-line id the cutter belongs to. */
  target: string;
}
/** A plan polygon (가각 triangle, the road side of a 건축한계선). */
export interface PolygonCutter {
  rule: RuleId;
  kind: 'polygon';
  ring: Vec2[];
  target: string;
}
export type Cutter = CapsuleCutter | PolygonCutter;

/** One 일조 datum segment (already moved outward when the datum is across a road). */
export interface SunDatum {
  a: Vec2;
  b: Vec2;
  target: string;
  source: string;
}

/** The 일조 rule as data (SPEC-12.8 1 지면, SPEC-12.9 2 사선). */
export interface SunRule {
  datum: SunDatum[];
  baseHeight: number;
  nearDistance: number;
  ratio: number;
  /** Distance to the datum: shortest (Euclidean) or measured due north. */
  measure: 'euclidean' | 'north';
  /** Unit north in plan (x = east, y = north of the document). */
  north: Vec2;
  /** The rule applies inside these zones only; null = the whole site. */
  zones: Vec2[][] | null;
  applies: '적용' | '판단 필요';
}

const ccw = (r: Polygon): Polygon => (signedArea(r) < 0 ? [...r].reverse() : r);

/**
 * Capsule ring of a segment. The vertex order depends only on the segment, the side count and the
 * end flags, so two capsules of one segment have corresponding, parallel edges (planar loft sides).
 */
export function capsuleRing(
  a: Vec2,
  b: Vec2,
  radius: number,
  sides = ARC_SIDES,
  roundA = true,
  roundB = true,
): Polygon {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  const base = Math.atan2(dy, dx);
  const R = radius / Math.cos(Math.PI / sides);
  const left: Vec2 = [-dy / L, dx / L];
  const ts: number[] = [];
  for (let k = 0; k < sides; k++) ts.push(((2 * k + 1) * Math.PI) / sides);
  // Start at the first vertex around a (cos t < 0), so the a block and the b block are contiguous.
  const first = ts.findIndex((t) => Math.cos(t) < 0);
  const order = [...ts.slice(first), ...ts.slice(0, first)];
  const aBlock = order.filter((t) => Math.cos(t) < 0),
    bBlock = order.filter((t) => Math.cos(t) > 0);
  const at = (p: Vec2, t: number): Vec2 => [
    p[0] + R * Math.cos(base + t),
    p[1] + R * Math.sin(base + t),
  ];
  const out: Polygon = [];
  if (roundA) for (const t of aBlock) out.push(at(a, t));
  else
    out.push(
      [a[0] + left[0] * radius, a[1] + left[1] * radius],
      [a[0] - left[0] * radius, a[1] - left[1] * radius],
    );
  if (roundB) for (const t of bBlock) out.push(at(b, t));
  else
    out.push(
      [b[0] - left[0] * radius, b[1] - left[1] * radius],
      [b[0] + left[0] * radius, b[1] + left[1] * radius],
    );
  return out;
}

/** Plan region of a cutter. */
export function cutterRing(c: Cutter, sides = ARC_SIDES): Polygon {
  return c.kind === 'capsule'
    ? capsuleRing(c.a, c.b, c.radius, sides, c.roundA, c.roundB)
    : ccw(c.ring);
}

export const cutterSolid = (c: Cutter, z0: number, z1: number, sides = ARC_SIDES): Solid =>
  prismSolid(cutterRing(c, sides), z0, z1);

/** Plan region within `r` of the datum measured due north: the segment swept south by r. */
export function northSweep(d: SunDatum, north: Vec2, r: number): Polygon {
  return [
    d.a,
    d.b,
    [d.b[0] - north[0] * r, d.b[1] - north[1] * r],
    [d.a[0] - north[0] * r, d.a[1] - north[1] * r],
  ];
}

/** True when the datum segment can be swept due north (not parallel to north). */
const sweepable = (d: SunDatum, north: Vec2) => {
  const dx = d.b[0] - d.a[0],
    dy = d.b[1] - d.a[1];
  return Math.abs(dx * north[1] - dy * north[0]) > 1e-9 * Math.hypot(dx, dy);
};

/** 일조 지면 벽: within the 기준 높이 이하 거리 of the datum, from below the ground to `z1`. */
export function sunWallSolid(s: SunRule, z0: number, z1: number, sides = ARC_SIDES): Solid {
  if (!(s.nearDistance > 0)) return [];
  const pieces = s.datum
    .filter((d) => s.measure === 'euclidean' || sweepable(d, s.north))
    .map((d) =>
      prismSolid(
        s.measure === 'euclidean'
          ? capsuleRing(d.a, d.b, s.nearDistance, sides)
          : ccw(northSweep(d, s.north, s.nearDistance)),
        z0,
        z1,
      ),
    );
  return zoned(s, solidUnionAll(pieces), z0, z1);
}

/**
 * 일조 사선: above the 기준 높이 the forbidden region grows as `ratio × z` from the datum. Each datum
 * segment gives one loft (capsule or north sweep at the 기준 높이 → the same at `z1`); several
 * segments are united, so a bent datum gives a valley (convex bend) or a cone joint (concave bend).
 */
export function sunSlopeSolid(s: SunRule, z1: number, sides = ARC_SIDES): Solid {
  const z0 = s.baseHeight;
  if (!(z1 > z0)) return [];
  const r0 = s.ratio * z0,
    r1 = s.ratio * z1;
  const pieces = s.datum
    .filter((d) => s.measure === 'euclidean' || sweepable(d, s.north))
    .map((d) =>
      s.measure === 'euclidean'
        ? loftSolid(capsuleRing(d.a, d.b, r0, sides), z0, capsuleRing(d.a, d.b, r1, sides), z1)
        : loftSolid(northSweep(d, s.north, r0), z0, northSweep(d, s.north, r1), z1),
    );
  return zoned(s, solidUnionAll(pieces), z0 - 1, z1 + 1);
}

function zoned(s: SunRule, solid: Solid, z0: number, z1: number) {
  if (!s.zones || !solid.length) return solid;
  const zone = solidUnionAll(s.zones.map((z) => prismSolid(z, z0 - 1, z1 + 1)));
  return solidIntersect(solid, zone);
}

// ── 2D 가능 영역 ─────────────────────────────────────────────────────────────────────────────────

export interface PlanRegion {
  outer: Vec2[];
  holes: Vec2[][];
}

/** Top faces (z = top) of a slab solid as plan regions. */
export function slabRegions(solid: Solid, top: number): PlanRegion[] {
  if (!solid.length) return [];
  const faces = mergeCoplanar(weldSolid(solid));
  const out: PlanRegion[] = [];
  for (const face of faces) {
    if (!face[0].every((p) => Math.abs(p[2] - top) < 1e-6)) continue;
    const n = signedArea(face[0].map((p): Vec2 => [p[0], p[1]]));
    if (!(n > 0)) continue;
    out.push({
      outer: face[0].map((p): Vec2 => [p[0], p[1]]),
      holes: face.slice(1).map((h) => h.map((p): Vec2 => [p[0], p[1]])),
    });
  }
  return out;
}

export interface Buildable {
  /** 가능 영역 면적 (㎡). */
  area: number;
  siteArea: number;
  regions: PlanRegion[];
  /** Area each rule removes on its own (SPEC-12.8 4), with the regions left by that rule alone. */
  reductions: { rule: RuleId; area: number; targets: string[]; regions: PlanRegion[] }[];
}

const RULE_ORDER: RuleId[] = [
  'road-setback',
  'chamfer',
  'limit-line',
  'open-space-road',
  'open-space-adjacent',
  'civil',
  'sun-ground',
  'other',
];

/**
 * 2D 가능 영역 = 대지 − every cutter (and the 일조 지면 벽 when given). Areas are slab volumes; the
 * site itself is the closed ring the caller validated.
 */
export function buildableArea(
  site: Polygon,
  cutters: readonly Cutter[],
  sun: SunRule | null,
  sides = ARC_SIDES,
): Buildable {
  const slab = prismSolid(site, 0, 1);
  const siteArea = Math.abs(signedArea(site));
  const byRule = new Map<RuleId, { solid: Solid; targets: string[] }>();
  const add = (rule: RuleId, solid: Solid, target: string) => {
    const entry = byRule.get(rule) ?? { solid: [], targets: [] };
    entry.solid = solidUnionAll([entry.solid, solid]);
    if (!entry.targets.includes(target)) entry.targets.push(target);
    byRule.set(rule, entry);
  };
  for (const c of cutters) add(c.rule, cutterSolid(c, -1, 2, sides), c.target);
  if (sun) {
    const wall = sunWallSolid(sun, -1, 2, sides);
    if (wall.length)
      for (const d of sun.datum) {
        const entry = byRule.get('sun-ground') ?? { solid: wall, targets: [] };
        entry.targets.push(d.target);
        byRule.set('sun-ground', entry);
      }
  }
  const all = solidUnionAll([...byRule.values()].map((e) => e.solid));
  const left = solidSubtract(slab, all);
  const reductions = RULE_ORDER.filter((r) => byRule.has(r)).map((rule) => {
    const rest = solidSubtract(slab, byRule.get(rule)!.solid);
    return {
      rule,
      area: siteArea - Math.max(0, solidVolume(rest)),
      targets: byRule.get(rule)!.targets,
      regions: slabRegions(rest, 1),
    };
  });
  const area = left.length ? Math.max(0, checkSolid(weldSolid(left)).volume) : 0;
  return { area, siteArea, regions: area > 0 ? slabRegions(left, 1) : [], reductions };
}

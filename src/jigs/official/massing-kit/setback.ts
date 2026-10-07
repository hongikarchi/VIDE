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

// ── 거의 한 직선인 구간 합치기 (T-214 F-6) ──────────────────────────────────────────────────────
// A real lot's boundary has runs of short segments bent by millimetres. Their capsules have nearly
// coplanar sides, and the solid booleans then leave open edges and spikes. Before the solids are
// made, consecutive pieces of one rule whose endpoints all lie within MERGE_DEVIATION of one chord
// become one capsule on the chord whose radius grows by that deviation: every point within r of a
// piece is within r + deviation of the chord (distance to a segment is convex), so the merge only
// removes more (safe side, as the 64-gon round ends). The cutters in the step output stay per
// segment; only the solids are made from the merged pieces.

/** Endpoints within this distance (m) of the chord merge consecutive pieces. */
export const MERGE_DEVIATION = 1e-3;
/** Consecutive pieces join when one ends this close (m) to where the next starts. */
const MERGE_GAP = 0.05;

function segmentDistance(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
}

/** Runs of consecutive pieces that lie within MERGE_DEVIATION of one chord, with that deviation. */
function nearStraightRuns<T>(
  items: readonly T[],
  ends: (t: T) => [Vec2, Vec2],
  same: (x: T, y: T) => boolean,
): { items: T[]; a: Vec2; b: Vec2; deviation: number }[] {
  const out: { items: T[]; a: Vec2; b: Vec2; deviation: number }[] = [];
  const deviation = (run: readonly T[]) => {
    const a = ends(run[0])[0],
      b = ends(run[run.length - 1])[1];
    if (!(Math.hypot(b[0] - a[0], b[1] - a[1]) > 0)) return Infinity;
    let d = 0;
    for (const t of run) for (const p of ends(t)) d = Math.max(d, segmentDistance(p, a, b));
    return d;
  };
  let run: T[] = [];
  const flush = () => {
    if (!run.length) return;
    const dev = run.length > 1 ? deviation(run) : 0;
    out.push({ items: run, a: ends(run[0])[0], b: ends(run[run.length - 1])[1], deviation: dev });
    run = [];
  };
  for (const item of items) {
    const last = run[run.length - 1];
    if (last !== undefined && same(last, item)) {
      const p = ends(last)[1],
        q = ends(item)[0];
      if (
        Math.hypot(p[0] - q[0], p[1] - q[1]) <= MERGE_GAP &&
        deviation([...run, item]) <= MERGE_DEVIATION
      ) {
        run.push(item);
        continue;
      }
    }
    flush();
    run = [item];
  }
  flush();
  return out;
}

/** Cutters for the solids: near-straight runs of capsules merged (see above), with their targets. */
export function solidCutters(cutters: readonly Cutter[]): { cutter: Cutter; targets: string[] }[] {
  const out: { cutter: Cutter; targets: string[] }[] = [];
  const runs = nearStraightRuns<Cutter>(
    cutters,
    (c) => (c.kind === 'capsule' ? [c.a, c.b] : [c.ring[0], c.ring[0]]),
    (x, y) =>
      x.kind === 'capsule' &&
      y.kind === 'capsule' &&
      x.rule === y.rule &&
      Math.abs(x.radius - y.radius) <= 1e-12,
  );
  for (const r of runs) {
    const first = r.items[0],
      last = r.items[r.items.length - 1];
    if (r.items.length === 1 || first.kind !== 'capsule' || last.kind !== 'capsule') {
      for (const c of r.items) out.push({ cutter: c, targets: [c.target] });
      continue;
    }
    const grown = r.deviation > 0;
    out.push({
      cutter: {
        ...first,
        a: r.a,
        b: r.b,
        radius: first.radius + r.deviation,
        // A grown capsule is wider than the neighbour that made its end flat: round it again.
        roundA: grown || first.roundA,
        roundB: grown || last.roundB,
      },
      targets: [...new Set(r.items.map((c) => c.target))],
    });
  }
  return out;
}

/** 일조 기준선 pieces for the solids: shortest-distance runs merged, with the radius growth. */
function sunPieces(s: SunRule): { a: Vec2; b: Vec2; pad: number }[] {
  const usable = s.datum.filter((d) => s.measure === 'euclidean' || sweepable(d, s.north));
  // Measured due north the sweep of a chord is not a superset of its pieces' sweeps: no merge.
  if (s.measure !== 'euclidean') return usable.map((d) => ({ a: d.a, b: d.b, pad: 0 }));
  return nearStraightRuns(
    usable,
    (d) => [d.a, d.b],
    () => true,
  ).map((r) => ({ a: r.a, b: r.b, pad: r.deviation }));
}

/** Plan region within `r` of the datum measured due north: the segment swept south by r. */
export function northSweep(d: Pick<SunDatum, 'a' | 'b'>, north: Vec2, r: number): Polygon {
  return [
    d.a,
    d.b,
    [d.b[0] - north[0] * r, d.b[1] - north[1] * r],
    [d.a[0] - north[0] * r, d.a[1] - north[1] * r],
  ];
}

/** True when the datum segment can be swept due north (not parallel to north). */
const sweepable = (d: Pick<SunDatum, 'a' | 'b'>, north: Vec2) => {
  const dx = d.b[0] - d.a[0],
    dy = d.b[1] - d.a[1];
  return Math.abs(dx * north[1] - dy * north[0]) > 1e-9 * Math.hypot(dx, dy);
};

/** 일조 지면 벽: within the 기준 높이 이하 거리 of the datum, from below the ground to `z1`. */
export function sunWallSolid(s: SunRule, z0: number, z1: number, sides = ARC_SIDES): Solid {
  if (!(s.nearDistance > 0)) return [];
  const pieces = sunPieces(s).map((d) =>
    prismSolid(
      s.measure === 'euclidean'
        ? capsuleRing(d.a, d.b, s.nearDistance + d.pad, sides)
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
  const pieces = sunPieces(s).map((d) =>
    s.measure === 'euclidean'
      ? loftSolid(
          capsuleRing(d.a, d.b, r0 + d.pad, sides),
          z0,
          capsuleRing(d.a, d.b, r1 + d.pad, sides),
          z1,
        )
      : loftSolid(northSweep(d, s.north, r0), z0, northSweep(d, s.north, r1), z1),
  );
  return zoned(s, solidUnionAll(pieces), z0 - 1, z1 + 1);
}

/**
 * The 일조 cut (지면 벽 from −1 to `top` and 사선) as separate solids before their union, for a
 * boolean retried in another order (T-214 F-6). Each piece is limited to the zones on its own;
 * the union of the pieces is `sunWallSolid ∪ sunSlopeSolid`.
 */
export function sunCutPieces(s: SunRule, top: number, sides = ARC_SIDES): Solid[] {
  const one = (solid: Solid, z0: number, z1: number) => zoned(s, solid, z0, z1);
  const out: Solid[] = [];
  const near = s.nearDistance > 0;
  const z0 = s.baseHeight,
    r0 = s.ratio * z0,
    r1 = s.ratio * top;
  for (const d of sunPieces(s)) {
    if (near)
      out.push(
        one(
          prismSolid(
            s.measure === 'euclidean'
              ? capsuleRing(d.a, d.b, s.nearDistance + d.pad, sides)
              : ccw(northSweep(d, s.north, s.nearDistance)),
            -1,
            top,
          ),
          -1,
          top,
        ),
      );
    if (top > z0)
      out.push(
        one(
          s.measure === 'euclidean'
            ? loftSolid(
                capsuleRing(d.a, d.b, r0 + d.pad, sides),
                z0,
                capsuleRing(d.a, d.b, r1 + d.pad, sides),
                top,
              )
            : loftSolid(northSweep(d, s.north, r0), z0, northSweep(d, s.north, r1), top),
          z0 - 1,
          top + 1,
        ),
      );
  }
  return out.filter((p) => p.length);
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
  const byRule = new Map<RuleId, { pieces: Solid[]; targets: string[] }>();
  const add = (rule: RuleId, solid: Solid, targets: readonly string[]) => {
    const entry = byRule.get(rule) ?? { pieces: [], targets: [] };
    if (solid.length) entry.pieces.push(solid);
    for (const target of targets) if (!entry.targets.includes(target)) entry.targets.push(target);
    byRule.set(rule, entry);
  };
  for (const { cutter, targets } of solidCutters(cutters))
    add(cutter.rule, cutterSolid(cutter, -1, 2, sides), targets);
  if (sun) {
    const wall = sunWallSolid(sun, -1, 2, sides);
    if (wall.length)
      add(
        'sun-ground',
        wall,
        sun.datum.map((d) => d.target),
      );
  }
  const left = cutSlab(
    slab,
    [...byRule.values()].flatMap((e) => e.pieces),
    1,
  );
  const reductions = RULE_ORDER.filter((r) => byRule.has(r)).map((rule) => {
    const rest = cutSlab(slab, byRule.get(rule)!.pieces, 1);
    return {
      rule,
      area: siteArea - Math.max(0, rest.volume),
      targets: byRule.get(rule)!.targets,
      regions: rest.regions,
    };
  });
  const area = Math.max(0, left.volume);
  return { area, siteArea, regions: area > 0 ? left.regions : [], reductions };
}

/**
 * Slab − ∪ cuts with its plan regions (top faces at `top`). The BSP result depends on the order
 * of the booleans; when one leaves open or non-manifold edges (or faces that do not close into
 * regions), the same cut is made again in another order (T-214 F-6: near-straight runs of a real
 * lot). Throws the first failure when no order gives a clean slab.
 */
export function cutSlab(
  slab: Solid,
  cuts: readonly Solid[],
  top: number,
): { solid: Solid; regions: PlanRegion[]; volume: number } {
  const orders: (() => Solid)[] = [
    () => solidSubtract(slab, solidUnionAll(cuts)),
    () => solidSubtract(slab, solidUnionAll([...cuts].reverse())),
    () => cuts.reduce<Solid>((acc, c) => solidSubtract(acc, c), slab),
  ];
  let first: Solid | null = null;
  for (const make of cuts.length ? orders : [() => slab]) {
    const solid = make();
    if (!solid.length) return { solid, regions: [], volume: 0 };
    first ??= solid;
    const check = checkSolid(weldSolid(solid));
    if (check.boundaryEdges || check.nonManifoldEdges || check.degenerate) continue;
    try {
      return { solid, regions: slabRegions(solid, top), volume: check.volume };
    } catch {
      // another order
    }
  }
  // No order closed: the first result as before (its regions throw when faces do not close).
  return {
    solid: first!,
    regions: slabRegions(first!, top),
    volume: checkSolid(weldSolid(first!)).volume,
  };
}

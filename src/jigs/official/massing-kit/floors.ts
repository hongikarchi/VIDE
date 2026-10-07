// 층 나누기 (SPEC-12.10 1, PLAN-45 T-211): the maximum envelope cut by the floor heights of the
// 계획 조건 into floor outlines, the basement outline (대지 경계 − 지하 이격) and the plan-region
// helpers the alternatives use (area, union area, trimming a floor from the north side). General
// geometry on `vide/geometry-kit` solids; no legal value lives here.
//
// Every envelope rule removes more as the height grows (extrusion walls are vertical, 일조 사선
// widens with z), so the envelope never widens upward and the section at a floor's top is the
// largest outline whose prism fits between the floor's bottom and top. The floor outline is that
// top section; `floorFits` checks it against the envelope in the tests.

import {
  pointInPolygon,
  signedArea,
  type Polygon,
  type Vec2,
  type Vec3,
} from '../geometry-kit/plan.ts';
import { boundaryDistance, segmentsCross } from '../geometry-kit/polygon.ts';
import {
  prismSolid,
  regionPrismSolid,
  solidIntersect,
  solidPolygon,
  solidSubtract,
  solidUnionAll,
  solidVolume,
  type Solid,
  type SolidMesh,
} from '../geometry-kit/solid.ts';
import {
  ARC_SIDES,
  buildableArea,
  cutSlab,
  slabRegions,
  type Cutter,
  type PlanRegion,
} from './setback.ts';

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Area of plan regions (outer − holes, ㎡). */
export const regionsArea = (regions: readonly PlanRegion[]) =>
  regions.reduce(
    (s, r) =>
      s +
      Math.abs(signedArea(r.outer)) -
      r.holes.reduce((h, ring) => h + Math.abs(signedArea(ring)), 0),
    0,
  );

/**
 * Closed solid of a plan region between z0 and z1: the prism with holes built directly (T-214
 * F-6), or — when its rings cannot be triangulated — the outer prism less the hole prisms.
 */
export function regionSolid(region: PlanRegion, z0: number, z1: number): Solid {
  try {
    return regionPrismSolid(region.outer, region.holes, z0, z1);
  } catch {
    const outer = prismSolid(region.outer, z0, z1);
    if (!region.holes.length) return outer;
    return solidSubtract(
      outer,
      solidUnionAll(region.holes.map((h) => prismSolid(h, z0 - 1, z1 + 1))),
    );
  }
}
const regionsSolid = (regions: readonly PlanRegion[], z0: number, z1: number) =>
  solidUnionAll(regions.map((r) => regionSolid(r, z0, z1)));

/** The same outline on several floors is one region (no boolean of coincident prisms, T-214 F-6). */
const distinct = (lists: readonly (readonly PlanRegion[])[]) => [
  ...new Map(lists.flat().map((r) => [JSON.stringify(r), r])).values(),
];

/** Area of the union of several region lists in plan (건축면적 = 수평 투영 면적). */
export function unionArea(lists: readonly (readonly PlanRegion[])[]) {
  const all = distinct(lists);
  if (!all.length) return 0;
  if (all.length === 1) return regionsArea(all);
  return Math.max(0, solidVolume(regionsSolid(all, 0, 1)));
}

/** Plan regions of the union of several region lists. */
export function unionRegions(lists: readonly (readonly PlanRegion[])[]): PlanRegion[] {
  const all = distinct(lists);
  if (!all.length) return [];
  if (all.length === 1) return [...all];
  // Retried in the other order when the faces do not close (T-214 F-6).
  try {
    return slabRegions(regionsSolid(all, 0, 1), 1);
  } catch (error) {
    try {
      return slabRegions(regionsSolid([...all].reverse(), 0, 1), 1);
    } catch {
      throw error;
    }
  }
}

/** Regions minus regions (plan), retried in another order when the faces do not close. */
export function subtractRegions(
  from: readonly PlanRegion[],
  cut: readonly PlanRegion[],
): PlanRegion[] {
  if (!from.length) return [];
  if (!cut.length) return [...from];
  try {
    return cutSlab(
      regionsSolid(from, 0, 1),
      cut.map((r) => regionSolid(r, -1, 2)),
      1,
    ).regions;
  } catch (error) {
    // One region less disjoint regions strictly inside it (the ground left around the floor
    // outlines, T-214 F-6): the cuts are its holes, no boolean needed.
    const [outer] = from;
    const inside = (ring: readonly Vec2[]) =>
      ring.every(
        (p) => pointInPolygon(p, outer.outer, 0) && boundaryDistance(p, outer.outer) > 1e-6,
      ) &&
      ring.every((p, i) => {
        const q = ring[(i + 1) % ring.length];
        return outer.outer.every(
          (a, j) => !segmentsCross(p, q, a, outer.outer[(j + 1) % outer.outer.length], 0),
        );
      });
    if (
      from.length === 1 &&
      !outer.holes.length &&
      cut.every((r) => !r.holes.length && inside(r.outer))
    )
      return [{ outer: outer.outer, holes: cut.map((r) => r.outer) }];
    throw error;
  }
}

/** Regions ∩ regions (plan). */
export function intersectRegions(a: readonly PlanRegion[], b: readonly PlanRegion[]): PlanRegion[] {
  if (!a.length || !b.length) return [];
  const both = solidIntersect(regionsSolid(a, 0, 1), regionsSolid(b, -1, 2));
  return both.length ? slabRegions(both, 1) : [];
}

/** Solid of a welded mesh (the envelope as the envelope step hands it on). */
export const meshSolid = (m: SolidMesh): Solid =>
  m.f.map((loop) => solidPolygon(loop.map((i) => m.v[i])));

export interface FloorDef {
  /** '1F', '2F', … ; 'B1', 'B2', … below ground. */
  floor: string;
  /** 1, 2, … above ground; −1, −2, … below. */
  index: number;
  z0: number;
  z1: number;
}

/**
 * Floor levels (SPEC-12.10 1): 1층 층고, then 기준층 층고, as long as the floor's top stays within
 * the height `H`; basements of `basementHeight` below 0.
 */
export function floorLevels(
  ground: number,
  typical: number,
  H: number,
  basements: number,
  basementHeight: number,
): FloorDef[] {
  const out: FloorDef[] = [];
  if (ground > 0 && typical > 0 && H > 0) {
    let z0 = 0,
      h = ground;
    for (let k = 1; k <= 400 && z0 + h <= H + 1e-9; k++) {
      out.push({ floor: `${k}F`, index: k, z0: r6(z0), z1: r6(z0 + h) });
      z0 += h;
      h = typical;
    }
  }
  if (basementHeight > 0)
    for (let k = 1; k <= Math.floor(basements); k++)
      out.push({
        floor: `B${k}`,
        index: -k,
        z0: r6(-k * basementHeight),
        z1: r6(-(k - 1) * basementHeight) + 0,
      });
  return out;
}

/** Outline of a floor of the envelope: the section at the floor's top (see the file note). */
export function floorRegions(envelope: Solid, site: Polygon, z0: number, z1: number): PlanRegion[] {
  const xs = site.map((p) => p[0]),
    ys = site.map((p) => p[1]);
  const pad = 1;
  const box: Polygon = [
    [Math.min(...xs) - pad, Math.min(...ys) - pad],
    [Math.max(...xs) + pad, Math.min(...ys) - pad],
    [Math.max(...xs) + pad, Math.max(...ys) + pad],
    [Math.min(...xs) - pad, Math.max(...ys) + pad],
  ];
  // A vertical prism (no 일조 사선: 최대 = 돌출 외피) has the same outline at every height: its top
  // face, without a boolean (T-214 F-6).
  const zs = new Set(envelope.flatMap((p) => p.v.map((v) => v[2])));
  if (zs.size === 2) {
    const top = Math.max(...zs);
    if (z1 <= top + 1e-9) return slabRegions(envelope, top);
  }
  const slab = solidIntersect(envelope, prismSolid(box, z0, z1));
  return slab.length ? slabRegions(slab, z1) : [];
}

/** True when the prism of `regions` between z0 and z1 lies inside the envelope (± tol m³). */
export function floorFits(
  envelope: Solid,
  regions: readonly PlanRegion[],
  z0: number,
  z1: number,
  tol = 1e-6,
) {
  if (!regions.length) return true;
  const outside = solidSubtract(regionsSolid(regions, z0, z1), envelope);
  return !outside.length || solidVolume(outside) <= tol;
}

/** Basement outline (SPEC-12.10 1): the site minus a band of `setback` along every boundary edge. */
export function basementRegions(site: Polygon, setback: number, sides = ARC_SIDES): PlanRegion[] {
  if (!(setback > 0)) return [{ outer: site, holes: [] }];
  const n = site.length;
  const cutters: Cutter[] = site.map((a, i) => ({
    rule: 'other',
    kind: 'capsule',
    a,
    b: site[(i + 1) % n],
    radius: setback,
    roundA: true,
    roundB: true,
    target: `edge-${i}`,
  }));
  return buildableArea(site, cutters, null, sides).regions;
}

// ── Trimming a floor (위층 축소) ───────────────────────────────────────────────────────────────

/** Sutherland–Hodgman clip of one ring by {p · u ≤ c}; area only (rings may touch themselves). */
function clippedArea(ring: readonly Vec2[], u: Vec2, c: number) {
  const out: Vec2[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i],
      q = ring[(i + 1) % n];
    const dp = p[0] * u[0] + p[1] * u[1] - c,
      dq = q[0] * u[0] + q[1] * u[1] - c;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out.length >= 3 ? Math.abs(signedArea(out)) : 0;
}
const keptArea = (regions: readonly PlanRegion[], u: Vec2, c: number) =>
  regions.reduce(
    (s, r) =>
      s + clippedArea(r.outer, u, c) - r.holes.reduce((h, ring) => h + clippedArea(ring, u, c), 0),
    0,
  );

/**
 * The part of `regions` south of a line across `north` whose area is `target` (㎡): the floor is
 * cut back from the north side (위층 축소). The line is found by bisection on the area; the regions
 * themselves are cut with the solid booleans, so they stay proper rings.
 */
export function trimRegions(
  regions: readonly PlanRegion[],
  target: number,
  north: Vec2,
): { regions: PlanRegion[]; area: number; cutAt: number } {
  const total = regionsArea(regions);
  if (!(target > 1e-9)) return { regions: [], area: 0, cutAt: -Infinity };
  if (target >= total - 1e-9) return { regions: [...regions], area: total, cutAt: Infinity };
  const proj = regions.flatMap((r) => r.outer.map((p) => p[0] * north[0] + p[1] * north[1]));
  let lo = Math.min(...proj),
    hi = Math.max(...proj);
  for (let k = 0; k < 200 && hi - lo > 1e-10; k++) {
    const mid = (lo + hi) / 2;
    if (keptArea(regions, north, mid) < target) lo = mid;
    else hi = mid;
  }
  const c = (lo + hi) / 2;
  // Half-plane {p · north ≤ c} as a big rectangle around the regions.
  const pts = regions.flatMap((r) => r.outer);
  const xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  const E =
    2 * Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + 10;
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2,
    cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const along: Vec2 = [-north[1], north[0]];
  const s0 = cx * north[0] + cy * north[1];
  const base: Vec2 = [cx + north[0] * (c - s0), cy + north[1] * (c - s0)];
  const half: Polygon = [
    [base[0] - along[0] * E, base[1] - along[1] * E],
    [base[0] - along[0] * E - north[0] * E, base[1] - along[1] * E - north[1] * E],
    [base[0] + along[0] * E - north[0] * E, base[1] + along[1] * E - north[1] * E],
    [base[0] + along[0] * E, base[1] + along[1] * E],
  ];
  const kept = intersectRegions(regions, [{ outer: half, holes: [] }]);
  return { regions: kept, area: regionsArea(kept), cutAt: c };
}

/** 3D points of a region ring at a level (for bake items). */
export const ringAt = (ring: readonly Vec2[], z: number): Vec3[] =>
  ring.map((p) => [p[0], p[1], z]);

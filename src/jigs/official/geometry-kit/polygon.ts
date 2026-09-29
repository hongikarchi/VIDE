// Plan polygon operations shared by the layout functions (PLAN-23 T-050): strict segment
// crossing, line ↔ polygon crossings (half-open rule, so a vertex counts once), ray hits, convex
// clipping (Cyrus–Beck), line ↔ circle, Minkowski sum of convex shapes and the inward inset of a
// ring (테두리보 들임선). All lengths are metres; tolerances are absolute metres.

import {
  GeometryError,
  assertPoints,
  convexHull,
  counterClockwise,
  pointInPolygon,
  requirePolygon,
  segmentDistance,
  signedArea,
  type PlanPoint,
  type Polygon,
  type Vec2,
} from './plan.ts';

/**
 * True when the open segments a–b and c–d share one interior point at least `tol` metres from all
 * four ends. Touching at an end and collinear overlap are not crossings (a girder that ends on the
 * slab edge, or runs along it, does not "cross" it).
 */
export function segmentsCross(
  a: PlanPoint,
  b: PlanPoint,
  c: PlanPoint,
  d: PlanPoint,
  tol = 1e-6,
): boolean {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    vx = d[0] - c[0],
    vy = d[1] - c[1];
  const denominator = ux * vy - uy * vx;
  const lu = Math.hypot(ux, uy),
    lv = Math.hypot(vx, vy);
  if (!(lu > 0) || !(lv > 0) || Math.abs(denominator) <= 1e-12 * lu * lv) return false;
  const wx = c[0] - a[0],
    wy = c[1] - a[1];
  const s = (wx * vy - wy * vx) / denominator; // along a–b
  const t = (wx * uy - wy * ux) / denominator; // along c–d
  return s * lu > tol && (1 - s) * lu > tol && t * lv > tol && (1 - t) * lv > tol;
}

/** Plan distance from `p` to the closest edge of `polygon`. */
export function boundaryDistance(p: PlanPoint, polygon: readonly PlanPoint[]) {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const d = segmentDistance(p, polygon[j], polygon[i]);
    if (d < best) best = d;
  }
  return best;
}

/** A region of the plan: one outer ring less the holes inside it. */
export interface Region {
  outer: readonly PlanPoint[];
  holes?: readonly (readonly PlanPoint[])[];
}

/**
 * Inside the outer ring and not strictly inside a hole. A point on the outer ring or on a hole
 * ring (within `tol`) counts as inside the region.
 */
export function pointInRegion(point: PlanPoint, region: Region, tol = 1e-9) {
  if (!pointInPolygon(point, region.outer, tol)) return false;
  for (const hole of region.holes ?? [])
    if (pointInPolygon(point, hole, 0) && boundaryDistance(point, hole) > tol) return false;
  return true;
}

/**
 * Parameters t (metres when `direction` is a unit vector) where the line origin + t·direction
 * crosses the polygon boundary, ascending. Half-open rule: a vertex on the line is counted once,
 * an edge lying on the line not at all; consecutive pairs bound the parts inside the polygon.
 */
export function lineCrossings(
  origin: PlanPoint,
  direction: PlanPoint,
  polygon: readonly PlanPoint[],
): number[] {
  const dx = direction[0],
    dy = direction[1];
  const length2 = dx * dx + dy * dy;
  if (!(length2 > 0)) throw new GeometryError('no-nan', 'line direction is zero');
  const side = (p: PlanPoint) => (p[0] - origin[0]) * dy - (p[1] - origin[1]) * dx;
  const out: number[] = [];
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const p = polygon[j],
      q = polygon[i];
    const sp = side(p),
      sq = side(q);
    if (sp > 0 === sq > 0) continue;
    const s = sp / (sp - sq);
    const x = p[0] + s * (q[0] - p[0]) - origin[0],
      y = p[1] + s * (q[1] - p[1]) - origin[1];
    out.push((x * dx + y * dy) / length2);
  }
  return out.sort((a, b) => a - b);
}

/** Distances (unit `direction`) at which the ray from `origin` hits the polygon, ascending, > tol. */
export function rayHits(
  origin: PlanPoint,
  direction: PlanPoint,
  polygon: readonly PlanPoint[],
  tol = 1e-9,
): number[] {
  const length = Math.hypot(direction[0], direction[1]);
  if (!(length > 0)) throw new GeometryError('no-nan', 'ray direction is zero');
  return lineCrossings(origin, [direction[0] / length, direction[1] / length], polygon).filter(
    (t) => t > tol,
  );
}

/**
 * Cyrus–Beck: the parameter interval of the line origin + t·direction inside a convex polygon
 * (either winding), or null when the line misses it.
 */
export function clipLineConvex(
  origin: PlanPoint,
  direction: PlanPoint,
  convex: readonly PlanPoint[],
): [number, number] | null {
  const ring = signedArea(convex) < 0 ? [...convex].reverse() : convex;
  let tIn = -Infinity,
    tOut = Infinity;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const p = ring[j],
      q = ring[i];
    // Outward normal of a counter-clockwise edge.
    const nx = q[1] - p[1],
      ny = -(q[0] - p[0]);
    const num = (p[0] - origin[0]) * nx + (p[1] - origin[1]) * ny;
    const den = direction[0] * nx + direction[1] * ny;
    if (Math.abs(den) <= 1e-15 * Math.hypot(nx, ny)) {
      if (num < 0) return null;
      continue;
    }
    const t = num / den;
    if (den > 0) tOut = Math.min(tOut, t);
    else tIn = Math.max(tIn, t);
  }
  return tIn <= tOut ? [tIn, tOut] : null;
}

/** Parameter interval of the line origin + t·direction (unit) inside a circle, or null. */
export function lineCircle(
  origin: PlanPoint,
  direction: PlanPoint,
  center: PlanPoint,
  radius: number,
): [number, number] | null {
  const wx = origin[0] - center[0],
    wy = origin[1] - center[1];
  const b = wx * direction[0] + wy * direction[1];
  const c = wx * wx + wy * wy - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  return [-b - s, -b + s];
}

/** Minkowski sum of two convex polygons (hull of the pairwise sums), counter-clockwise. */
export function minkowskiSum(a: readonly PlanPoint[], b: readonly PlanPoint[]): Polygon {
  const ra = requirePolygon(a, 'polygon A', true);
  const rb = requirePolygon(b, 'polygon B', true);
  const sums: Vec2[] = [];
  for (const p of ra) for (const q of rb) sums.push([p[0] + q[0], p[1] + q[1]]);
  return convexHull(sums);
}

/** The polygon mirrored through the origin (−p for every vertex). */
export function negate(polygon: readonly PlanPoint[]): Polygon {
  return polygon.map((p): Vec2 => [-p[0], -p[1]]);
}

/**
 * Ring moved inward by `distance` (outward when negative) with mitred corners: every edge is
 * shifted along its inward normal and consecutive edge lines are intersected again. Straight runs
 * of collinear vertices keep their shifted vertex. The result is counter-clockwise. An inset that
 * collapses or crosses itself (too large for a narrow part of the ring) throws `polygon-valid`.
 */
export function insetPolygon(polygon: readonly PlanPoint[], distance: number): Polygon {
  if (!Number.isFinite(distance)) throw new GeometryError('no-nan', `inset ${String(distance)}`);
  const ring = counterClockwise(polygon);
  const n = ring.length;
  const lines: { a: Vec2; d: Vec2 }[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i],
      q = ring[(i + 1) % n];
    const dx = q[0] - p[0],
      dy = q[1] - p[1];
    const length = Math.hypot(dx, dy);
    // Inward normal of a counter-clockwise edge is its left normal.
    const nx = -dy / length,
      ny = dx / length;
    lines.push({ a: [p[0] + nx * distance, p[1] + ny * distance], d: [dx / length, dy / length] });
  }
  const out: Polygon = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i + n - 1) % n],
      next = lines[i];
    const denominator = prev.d[0] * next.d[1] - prev.d[1] * next.d[0];
    if (Math.abs(denominator) <= 1e-12) {
      out.push([next.a[0], next.a[1]]);
      continue;
    }
    const wx = next.a[0] - prev.a[0],
      wy = next.a[1] - prev.a[1];
    const s = (wx * next.d[1] - wy * next.d[0]) / denominator;
    out.push([prev.a[0] + s * prev.d[0], prev.a[1] + s * prev.d[1]]);
  }
  const result = requirePolygon(out, 'inset ring');
  const before = signedArea(ring),
    after = signedArea(result);
  if (after <= 0 || (distance > 0 && after >= before) || (distance < 0 && after <= before))
    throw new GeometryError('polygon-valid', `inset ${distance} m collapses the ring`);
  // A mitred corner that folded over leaves a vertex outside the original ring.
  if (distance > 0)
    for (const p of result)
      if (!pointInPolygon(p, ring, 1e-9))
        throw new GeometryError('polygon-valid', `inset ${distance} m folds the ring`);
  return result;
}

/** Index of the longest edge of a ring (edge i runs from vertex i to i + 1). */
export function longestEdge(polygon: readonly PlanPoint[]) {
  let best = -1,
    length = -Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i],
      q = polygon[(i + 1) % polygon.length];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l > length) {
      length = l;
      best = i;
    }
  }
  return best;
}

/** Validated plain copy of a list of rings (each at least a triangle, no self-crossing). */
export function requireRings(rings: readonly (readonly PlanPoint[])[], what: string): Polygon[] {
  if (!Array.isArray(rings)) throw new GeometryError('polygon-valid', `${what} is not a list`);
  return rings.map((ring, i) => requirePolygon(ring, `${what}[${i}]`));
}

/** Validated plan points (finite x, y), copied as Vec2. */
export function planPoints(points: readonly PlanPoint[], what: string): Vec2[] {
  assertPoints(points, what);
  return points.map((p): Vec2 => [p[0], p[1]]);
}

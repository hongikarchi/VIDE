// Interference between convex plan footprints (SPEC-06.11 2: real footprint overlap and minimum
// distance, never an axis-aligned ban band). Separating axes decide overlap; a gap is measured as
// the true minimum distance, so two footprints apart in one direction pass even when their
// projections on the grid axes overlap.

import {
  requirePolygon,
  ring,
  signedArea,
  type PlanPoint,
  type Polygon,
  type Vec2,
} from './plan.ts';

export interface Separation {
  /** < 0: penetration depth along `axis`; > 0: minimum plan distance; 0: touching. */
  distance: number;
  /**
   * Unit direction from A towards B: for an overlap the axis of least penetration (move B this
   * way by −distance to clear it), for a gap the direction between the closest points.
   */
  axis: Vec2;
}

type Local = { a: Polygon; b: Polygon; origin: Vec2 };

// Both shapes about A's first vertex: footprints sit far from the origin in site coordinates.
function local(a: readonly PlanPoint[], b: readonly PlanPoint[]): Local {
  const ra = requirePolygon(a, 'polygon A', true);
  const rb = requirePolygon(b, 'polygon B', true);
  const origin: Vec2 = [ra[0][0], ra[0][1]];
  const shift = (p: Vec2): Vec2 => [p[0] - origin[0], p[1] - origin[1]];
  return { a: ra.map(shift), b: rb.map(shift), origin };
}

function project(polygon: Polygon, nx: number, ny: number): [number, number] {
  let min = Infinity,
    max = -Infinity;
  for (const p of polygon) {
    const d = p[0] * nx + p[1] * ny;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

function centroid(polygon: Polygon): Vec2 {
  let x = 0,
    y = 0;
  for (const p of polygon) {
    x += p[0];
    y += p[1];
  }
  return [x / polygon.length, y / polygon.length];
}

function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  let t = length2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + t * dx, a[1] + t * dy];
}

/** Separating-axis result for two convex polygons (either winding). */
export function separation(a: readonly PlanPoint[], b: readonly PlanPoint[]): Separation {
  const shapes = local(a, b);
  const ca = centroid(shapes.a),
    cb = centroid(shapes.b);
  let least = Infinity;
  let axis: Vec2 = [1, 0];
  let apart = false;
  for (const polygon of [shapes.a, shapes.b]) {
    for (let i = 0; i < polygon.length && !apart; i++) {
      const p = polygon[i],
        q = polygon[(i + 1) % polygon.length];
      const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (!(length > 0)) continue;
      const nx = -(q[1] - p[1]) / length,
        ny = (q[0] - p[0]) / length;
      const [minA, maxA] = project(shapes.a, nx, ny);
      const [minB, maxB] = project(shapes.b, nx, ny);
      // B clears A by moving +n by `forward` or −n by `backward`. When one projection holds the
      // other (a cap inside a footing) the way out is longer than the shared interval, so the
      // interval alone would understate the depth.
      const forward = maxA - minB,
        backward = maxB - minA;
      const depth = Math.min(forward, backward);
      if (depth < 0) apart = true;
      else if (depth < least) {
        const sign =
          forward < backward
            ? 1
            : backward < forward
              ? -1
              : (cb[0] - ca[0]) * nx + (cb[1] - ca[1]) * ny < 0
                ? -1
                : 1;
        least = depth;
        axis = [sign * nx, sign * ny];
      }
    }
  }
  if (!apart) return { distance: least === 0 ? 0 : -least, axis };
  // Apart on some axis: the true gap is the closest vertex–edge pair (exact for convex shapes).
  let best = Infinity;
  let from: Vec2 = [0, 0],
    to: Vec2 = [0, 0];
  const scan = (points: Polygon, edges: Polygon, pointsAreA: boolean) => {
    for (const p of points)
      for (let i = 0; i < edges.length; i++) {
        const c = closestOnSegment(p, edges[i], edges[(i + 1) % edges.length]);
        const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
        if (d < best) {
          best = d;
          from = pointsAreA ? p : c;
          to = pointsAreA ? c : p;
        }
      }
  };
  scan(shapes.a, shapes.b, true);
  scan(shapes.b, shapes.a, false);
  const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return { distance: best, axis: d > 0 ? [(to[0] - from[0]) / d, (to[1] - from[1]) / d] : axis };
}

/** Signed plan distance between convex polygons: negative = penetration depth. */
export function signedDistance(a: readonly PlanPoint[], b: readonly PlanPoint[]) {
  return separation(a, b).distance;
}

// Sutherland–Hodgman in the shared local frame; both inputs are convex.
function clipLocal(shapes: Local): Polygon {
  const edges = signedArea(shapes.b) > 0 ? shapes.b : [...shapes.b].reverse();
  let output: Polygon = signedArea(shapes.a) > 0 ? shapes.a : [...shapes.a].reverse();
  for (let i = 0; i < edges.length && output.length; i++) {
    const e0 = edges[i],
      e1 = edges[(i + 1) % edges.length];
    const side = (p: Vec2) => (e1[0] - e0[0]) * (p[1] - e0[1]) - (e1[1] - e0[1]) * (p[0] - e0[0]);
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j],
        q = input[(j + 1) % input.length];
      const sp = side(p),
        sq = side(q);
      if (sp >= 0) output.push(p);
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq);
        output.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
  }
  // A vertex on a clip edge is pushed twice, and shapes that only touch leave a zero-area sliver.
  const cleaned = ring(output);
  const area = Math.abs(signedArea(cleaned));
  return cleaned.length < 3 ||
    area <= 1e-9 * Math.min(Math.abs(signedArea(shapes.a)), Math.abs(signedArea(shapes.b)))
    ? []
    : cleaned;
}

/** Intersection of two convex polygons, counter-clockwise; [] when they only touch or are apart. */
export function clipConvex(subject: readonly PlanPoint[], clip: readonly PlanPoint[]): Polygon {
  const shapes = local(subject, clip);
  return clipLocal(shapes).map((p): Vec2 => [p[0] + shapes.origin[0], p[1] + shapes.origin[1]]);
}

/** Overlap area of two convex polygons (m²), for the interference report. */
export function overlapArea(a: readonly PlanPoint[], b: readonly PlanPoint[]) {
  return Math.abs(signedArea(clipLocal(local(a, b))));
}

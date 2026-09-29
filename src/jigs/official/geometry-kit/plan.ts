// geometry-kit plan basics (official library `vide/geometry-kit`, ARCH-03 §2.3, PLAN-23 T-042).
// Pure plan (XY) geometry in metres. No node: imports: the engine, the step runner bundle and the
// browser all load this. Invalid input throws GeometryError carrying the after-run gate it fails
// ('no-nan' | 'polygon-valid' | 'planar-curve', SPEC-07 계산 뒤 점검); validatePolygon returns the
// same as a value.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Any point whose first two numbers are plan x, y (a Vec3 is read in plan). */
export type PlanPoint = readonly number[];
/** A plan ring without the closing repeat of its first point. */
export type Polygon = Vec2[];

export type GeometryErrorCode = 'no-nan' | 'polygon-valid' | 'planar-curve';
export class GeometryError extends Error {
  code: GeometryErrorCode;
  constructor(code: GeometryErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'GeometryError';
    this.code = code;
  }
}
export type Check = { ok: true } | { ok: false; code: GeometryErrorCode; message: string };

/** Minimum-area enclosing rectangle. `v` is `u` turned +90°, so `corners` run counter-clockwise. */
export interface Rect {
  center: Vec2;
  /** Unit axis of the long side, folded to (−90°, 90°]; for a square to (−45°, 45°]. */
  u: Vec2;
  v: Vec2;
  halfU: number;
  halfV: number;
  /** Angle of `u` from +x in degrees (a square rotated −21° reads −21). */
  angleDeg: number;
  corners: Polygon;
}

// Relative tolerances: sizes are metres, coordinates can be hundreds of kilometres from the origin,
// so every comparison is made against the shape's own extent, never an absolute number.
const AREA_EPS = 1e-9;
const SQUARE_EPS = 1e-7;

export function assertFinite(values: ArrayLike<number>, what: string) {
  for (let i = 0; i < values.length; i++)
    if (!Number.isFinite(values[i]))
      throw new GeometryError('no-nan', `${what}[${i}] is ${String(values[i])}`);
}

export function assertPoints(points: readonly PlanPoint[], what: string) {
  if (!Array.isArray(points)) throw new GeometryError('polygon-valid', `${what} is not a list`);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      throw new GeometryError('no-nan', `${what}[${i}] is not a finite point`);
  }
}

/** (a − o) × (b − o): > 0 when o → a → b turns left. */
export function cross(o: PlanPoint, a: PlanPoint, b: PlanPoint) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Largest side of the axis-aligned box around the points (the shape's own scale). */
export function extent(points: readonly PlanPoint[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  return Math.max(maxX - minX, maxY - minY);
}

/** Plan copy of a ring: closing repeat and consecutive duplicate points dropped. */
export function ring(polygon: readonly PlanPoint[]): Polygon {
  const out: Polygon = [];
  for (const p of polygon) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push([p[0], p[1]]);
  }
  while (
    out.length > 1 &&
    out[0][0] === out[out.length - 1][0] &&
    out[0][1] === out[out.length - 1][1]
  )
    out.pop();
  return out;
}

/** Signed shoelace area, counter-clockwise positive (computed about the first vertex). */
export function signedArea(polygon: readonly PlanPoint[]) {
  if (polygon.length < 3) return 0;
  const [ox, oy] = polygon[0];
  let twice = 0;
  for (let i = 1; i < polygon.length - 1; i++) {
    const a = polygon[i],
      b = polygon[i + 1];
    twice += (a[0] - ox) * (b[1] - oy) - (b[0] - ox) * (a[1] - oy);
  }
  return twice / 2;
}

export function polygonArea(polygon: readonly PlanPoint[]) {
  return Math.abs(signedArea(polygon));
}

/** Winding of a valid polygon; a zero-area ring throws `polygon-valid`. */
export function orientation(polygon: readonly PlanPoint[]): 'ccw' | 'cw' {
  const checked = requirePolygon(polygon, 'polygon');
  return signedArea(checked) > 0 ? 'ccw' : 'cw';
}

/** Validated copy wound counter-clockwise. */
export function counterClockwise(polygon: readonly PlanPoint[]): Polygon {
  const checked = requirePolygon(polygon, 'polygon');
  return signedArea(checked) > 0 ? checked : checked.reverse();
}

function segmentsCross(a: PlanPoint, b: PlanPoint, c: PlanPoint, d: PlanPoint, eps: number) {
  const d1 = cross(a, b, c),
    d2 = cross(a, b, d),
    d3 = cross(c, d, a),
    d4 = cross(c, d, b);
  if (
    ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
    ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
  )
    return true;
  // Touching or collinear overlap between non-adjacent edges also makes the ring non-simple.
  const on = (p: PlanPoint, q: PlanPoint, r: PlanPoint, turn: number) =>
    Math.abs(turn) <= eps &&
    Math.min(p[0], q[0]) - 1e-12 <= r[0] &&
    r[0] <= Math.max(p[0], q[0]) + 1e-12 &&
    Math.min(p[1], q[1]) - 1e-12 <= r[1] &&
    r[1] <= Math.max(p[1], q[1]) + 1e-12;
  return on(a, b, c, d1) || on(a, b, d, d2) || on(c, d, a, d3) || on(c, d, b, d4);
}

/**
 * Gate check for a plan ring: finite, at least three distinct points, non-zero area and no
 * self-intersection. With `convex`, the ring must also turn one way exactly once.
 */
export function validatePolygon(
  polygon: readonly PlanPoint[],
  options: { convex?: boolean } = {},
): Check {
  try {
    requirePolygon(polygon, 'polygon', options.convex);
    return { ok: true };
  } catch (error) {
    if (error instanceof GeometryError)
      return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}

/** Throwing form of validatePolygon; returns the cleaned ring (see `ring`). */
export function requirePolygon(polygon: readonly PlanPoint[], what: string, convex = false) {
  assertPoints(polygon, what);
  const points = ring(polygon);
  if (points.length < 3)
    throw new GeometryError('polygon-valid', `${what} has ${points.length} distinct points`);
  const size = extent(points);
  const area = signedArea(points);
  if (!(size > 0) || Math.abs(area) <= AREA_EPS * size * size)
    throw new GeometryError('polygon-valid', `${what} has no area`);
  const eps = AREA_EPS * size * size;
  const n = points.length;
  if (convex) {
    const sign = Math.sign(area);
    let turning = 0;
    for (let i = 0; i < n; i++) {
      const a = points[i],
        b = points[(i + 1) % n],
        c = points[(i + 2) % n];
      const turn = cross(a, b, c);
      if (turn * sign < -eps) throw new GeometryError('polygon-valid', `${what} is not convex`);
      const ux = b[0] - a[0],
        uy = b[1] - a[1],
        vx = c[0] - b[0],
        vy = c[1] - b[1];
      turning += Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    }
    // A star wound twice turns one way at every vertex but through 4π.
    if (Math.abs(Math.abs(turning) - 2 * Math.PI) > 1e-6)
      throw new GeometryError('polygon-valid', `${what} winds more than once`);
  } else {
    for (let i = 0; i < n; i++)
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue; // first and last edges share a vertex
        if (segmentsCross(points[i], points[i + 1], points[j], points[(j + 1) % n], eps))
          throw new GeometryError('polygon-valid', `${what} crosses itself (edges ${i}, ${j})`);
      }
  }
  return points;
}

/**
 * Convex hull in plan (Andrew's monotone chain), counter-clockwise from the lowest-x point.
 * Collinear and duplicate points are dropped; fewer than three points come back as they are.
 */
export function convexHull(points: readonly PlanPoint[]): Polygon {
  assertPoints(points, 'points');
  const sorted = points.map((p): Vec2 => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique: Polygon = [];
  for (const p of sorted) {
    const last = unique[unique.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) unique.push(p);
  }
  if (unique.length < 3) return unique;
  const lower: Polygon = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Polygon = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Plan distance from `p` to segment a–b. */
export function segmentDistance(p: PlanPoint, a: PlanPoint, b: PlanPoint) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  let t = length2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Even-odd containment; a point within `tolerance` of the boundary counts as inside. */
export function pointInPolygon(point: PlanPoint, polygon: readonly PlanPoint[], tolerance = 1e-9) {
  assertPoints([point], 'point');
  assertPoints(polygon, 'polygon');
  const n = polygon.length;
  if (n < 3) throw new GeometryError('polygon-valid', `polygon has ${n} points`);
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[j],
      b = polygon[i];
    if (segmentDistance(point, a, b) <= tolerance) return true;
    if (b[1] > y !== a[1] > y && x < ((a[0] - b[0]) * (y - b[1])) / (a[1] - b[1]) + b[0])
      inside = !inside;
  }
  return inside;
}

/**
 * Minimum-area enclosing rectangle (rotating calipers over the hull edges). Keeps the shape's own
 * rotation; see Rect for the canonical axis. Fewer than three non-collinear points throw
 * `polygon-valid`.
 */
export function minAreaRect(points: readonly PlanPoint[]): Rect {
  const hull = convexHull(points);
  if (hull.length < 3) throw new GeometryError('polygon-valid', 'points do not enclose an area');
  const size = extent(hull);
  if (polygonArea(hull) <= AREA_EPS * size * size)
    throw new GeometryError('polygon-valid', 'points do not enclose an area');
  const [ox, oy] = hull[0];
  let best:
    | { area: number; ux: number; uy: number; a: [number, number]; b: [number, number] }
    | undefined;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i],
      q = hull[(i + 1) % hull.length];
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!(length > 0)) continue;
    const ux = (q[0] - p[0]) / length,
      uy = (q[1] - p[1]) / length;
    let minA = Infinity,
      maxA = -Infinity,
      minB = Infinity,
      maxB = -Infinity;
    for (const h of hull) {
      const x = h[0] - ox,
        y = h[1] - oy;
      const a = x * ux + y * uy,
        b = -x * uy + y * ux;
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    const area = (maxA - minA) * (maxB - minB);
    // Ties keep the first edge in hull order, so the result does not depend on rounding noise.
    if (!best || area < best.area * (1 - 1e-12))
      best = { area, ux, uy, a: [minA, maxA], b: [minB, maxB] };
  }
  const { ux, uy, a, b } = best!;
  const midA = (a[0] + a[1]) / 2,
    midB = (b[0] + b[1]) / 2;
  const center: Vec2 = [ox + midA * ux - midB * uy, oy + midA * uy + midB * ux];
  let u: Vec2 = [ux, uy];
  let halfU = (a[1] - a[0]) / 2,
    halfV = (b[1] - b[0]) / 2;
  const square = Math.abs(halfU - halfV) <= SQUARE_EPS * Math.max(halfU, halfV);
  if (!square && halfV > halfU) {
    u = [-uy, ux];
    [halfU, halfV] = [halfV, halfU];
  }
  // Fold the axis: a rectangle is the same after a half turn, a square after a quarter turn.
  const limit = square ? 45 : 90;
  let angle = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
  for (let guard = 0; guard < 4 && (angle > limit || angle <= -limit); guard++) {
    if (angle > limit) {
      u = square ? [u[1], -u[0]] : [-u[0], -u[1]];
      angle -= 2 * limit;
    } else {
      u = square ? [-u[1], u[0]] : [-u[0], -u[1]];
      angle += 2 * limit;
    }
    if (square) [halfU, halfV] = [halfV, halfU];
  }
  const v: Vec2 = [-u[1], u[0]];
  const corner = (su: number, sv: number): Vec2 => [
    center[0] + su * halfU * u[0] + sv * halfV * v[0],
    center[1] + su * halfU * u[1] + sv * halfV * v[1],
  ];
  return {
    center,
    u,
    v,
    halfU,
    halfV,
    angleDeg: (Math.atan2(u[1], u[0]) * 180) / Math.PI,
    corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
  };
}

/** Plan (XY) length of an open polyline. */
export function planLength(polyline: readonly PlanPoint[]) {
  assertPoints(polyline, 'polyline');
  let length = 0;
  for (let i = 1; i < polyline.length; i++)
    length += Math.hypot(polyline[i][0] - polyline[i - 1][0], polyline[i][1] - polyline[i - 1][1]);
  return length;
}

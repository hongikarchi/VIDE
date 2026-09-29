// Allowed windows for a footprint along a line (RESEARCH-10 §14.4 ② 2, PLAN-23 T-050): where on a
// grid line can a pile cap sit so that it keeps `clearance` from every existing footing? The
// interference is the real footprints' distance (SPEC-06.11 2), so a cap next to a footing in one
// direction passes even when the two overlap along the other axis (grid-4m-bay). Each obstacle
// blocks one interval: the line's part inside the Minkowski sum of obstacle and cap, widened by
// the clearance; the windows are what is left between `from` and `to`.

import { GeometryError, assertPoints, requirePolygon, type PlanPoint, type Vec2 } from './plan.ts';
import { clipLineConvex, lineCircle, minkowskiSum, negate } from './polygon.ts';

export interface WindowLine {
  origin: PlanPoint;
  /** Direction of the line; `from`/`to` are metres along it from `origin`. */
  direction: PlanPoint;
  from: number;
  to: number;
}

export interface WindowOptions {
  /** Minimum plan distance the footprint must keep from an obstacle (m, default 0). */
  clearance?: number;
}

export interface Windows {
  /** Parameter intervals (m along the line, ascending) where the footprint keeps clear. */
  windows: [number, number][];
  /** Every obstacle's blocked interval clipped to the line's range, with the obstacle index. */
  blocked: { interval: [number, number]; obstacle: number }[];
}

/** Bounding radius of a ring about the origin. */
function radiusAbout(ring: readonly PlanPoint[], origin: PlanPoint) {
  let r = 0;
  for (const p of ring) r = Math.max(r, Math.hypot(p[0] - origin[0], p[1] - origin[1]));
  return r;
}

/**
 * Interval of the line inside the convex polygon widened by `clearance` (a rounded offset:
 * the polygon itself, a strip along every edge and a disc at every vertex).
 */
function blockedInterval(
  origin: Vec2,
  direction: Vec2,
  convex: readonly Vec2[],
  clearance: number,
): [number, number] | null {
  let lo = Infinity,
    hi = -Infinity;
  const take = (piece: [number, number] | null) => {
    if (!piece) return;
    if (piece[0] < lo) lo = piece[0];
    if (piece[1] > hi) hi = piece[1];
  };
  take(clipLineConvex(origin, direction, convex));
  if (clearance > 0) {
    const n = convex.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const p = convex[j],
        q = convex[i];
      const dx = q[0] - p[0],
        dy = q[1] - p[1];
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const nx = (-dy / length) * clearance,
          ny = (dx / length) * clearance;
        take(
          clipLineConvex(origin, direction, [
            [p[0] + nx, p[1] + ny],
            [q[0] + nx, q[1] + ny],
            [q[0] - nx, q[1] - ny],
            [p[0] - nx, p[1] - ny],
          ]),
        );
      }
      take(lineCircle(origin, direction, q, clearance));
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * Windows along `line` where `shape` (a convex footprint drawn about its own placement point,
 * e.g. a cap square about (0, 0)) stays at least `clearance` from every convex `obstacle`.
 */
export function allowedWindows(
  line: WindowLine,
  shape: readonly PlanPoint[],
  obstacles: readonly (readonly PlanPoint[])[],
  options: WindowOptions = {},
): Windows {
  assertPoints([line.origin, line.direction], 'line');
  if (!Number.isFinite(line.from) || !Number.isFinite(line.to) || line.from > line.to)
    throw new GeometryError('no-nan', `line range ${String(line.from)}..${String(line.to)}`);
  const clearance = options.clearance ?? 0;
  if (!Number.isFinite(clearance) || clearance < 0)
    throw new GeometryError('no-nan', `clearance ${String(clearance)}`);
  const length = Math.hypot(line.direction[0], line.direction[1]);
  if (!(length > 0)) throw new GeometryError('no-nan', 'line direction is zero');
  const direction: Vec2 = [line.direction[0] / length, line.direction[1] / length];
  const mirrored = negate(requirePolygon(shape, 'shape', true));
  const shapeRadius = radiusAbout(mirrored, [0, 0]);
  if (!Array.isArray(obstacles))
    throw new GeometryError('polygon-valid', 'obstacles is not a list');

  // Local frame about the line origin; obstacles far from the line are skipped by radius.
  const origin: Vec2 = [0, 0];
  const ox = line.origin[0],
    oy = line.origin[1];
  const blocked: Windows['blocked'] = [];
  obstacles.forEach((obstacle, index) => {
    const local = requirePolygon(obstacle, `obstacles[${index}]`, true).map(
      (p): Vec2 => [p[0] - ox, p[1] - oy],
    );
    const center: Vec2 = [0, 0];
    for (const p of local) {
      center[0] += p[0] / local.length;
      center[1] += p[1] / local.length;
    }
    const reach = radiusAbout(local, center) + shapeRadius + clearance;
    const along = center[0] * direction[0] + center[1] * direction[1];
    const across = Math.abs(center[0] * direction[1] - center[1] * direction[0]);
    if (across > reach || along + reach < line.from || along - reach > line.to) return;
    const interval = blockedInterval(origin, direction, minkowskiSum(local, mirrored), clearance);
    if (!interval) return;
    const lo = Math.max(interval[0], line.from),
      hi = Math.min(interval[1], line.to);
    if (lo < hi) blocked.push({ interval: [lo, hi], obstacle: index });
  });
  blocked.sort((p, q) => p.interval[0] - q.interval[0] || p.interval[1] - q.interval[1]);

  const windows: [number, number][] = [];
  let cursor = line.from;
  for (const { interval } of blocked) {
    if (interval[0] > cursor + 1e-9) windows.push([cursor, interval[0]]);
    if (interval[1] > cursor) cursor = interval[1];
  }
  if (line.to > cursor + 1e-9) windows.push([cursor, line.to]);
  return { windows, blocked };
}

/** Whether a parameter lies in one of the windows. */
export function inWindows(windows: readonly (readonly [number, number])[], t: number) {
  return windows.some(([lo, hi]) => t >= lo - 1e-9 && t <= hi + 1e-9);
}

// Spans from a drawn member curve (SPEC-06.14 경간 표): the curve is cut at every support whose
// plan distance to it is within the tolerance. Pieces between two supports are spans, pieces past
// the first or last support are overhangs (cantilevers). The curve's own length is not a span.

import { GeometryError, assertPoints, type PlanPoint, type Vec3 } from './plan.ts';

export interface SplitOptions {
  /**
   * Supports closer than this along the curve are one station, and a station this close to an
   * end sits on the end (m, default 0.001).
   */
  merge?: number;
}

export interface Station {
  /** Indices into the support list that landed here, ascending. */
  supports: number[];
  /** Distance from the curve start along the curve (3D) and in plan. */
  at: number;
  planAt: number;
  /** Plan distance from the (first) support to the curve. */
  offset: number;
  point: Vec3;
}

export interface CurvePiece {
  kind: 'span' | 'overhang';
  /** Station index at each end; null is the free end of an overhang. */
  from: number | null;
  to: number | null;
  /** Along-curve (3D) and plan length. */
  length: number;
  planLength: number;
  points: Vec3[];
}

export interface SplitResult {
  /** Supports on the curve, in order along it. Empty = the curve rests on nothing within tol. */
  stations: Station[];
  /** Pieces between consecutive stations, in order. */
  spans: CurvePiece[];
  /** Start overhang (if any) first, then end overhang. None when there is no station. */
  overhangs: CurvePiece[];
  length: number;
  planLength: number;
}

type Position = { segment: number; t: number; point: Vec3 };

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
}

/**
 * Cut `polyline` (points in order; z optional) at `supports` within plan distance `tol`.
 * Deterministic: the result does not depend on the order of `supports` beyond the indices it
 * reports.
 */
export function splitAtSupports(
  polyline: readonly PlanPoint[],
  supports: readonly PlanPoint[],
  tol: number,
  options: SplitOptions = {},
): SplitResult {
  assertPoints(polyline, 'polyline');
  assertPoints(supports, 'supports');
  const merge = options.merge ?? 0.001;
  if (!Number.isFinite(tol) || tol < 0) throw new GeometryError('no-nan', `tolerance ${tol}`);
  if (!Number.isFinite(merge) || merge < 0) throw new GeometryError('no-nan', `merge ${merge}`);
  const points: Vec3[] = polyline.map((p) => {
    const z = p.length > 2 ? p[2] : 0;
    if (!Number.isFinite(z)) throw new GeometryError('no-nan', 'polyline z is not finite');
    return [p[0], p[1], z];
  });
  if (points.length < 2)
    throw new GeometryError('polygon-valid', 'polyline has fewer than 2 points');

  const n = points.length - 1;
  const cumulative = new Float64Array(n + 1);
  const cumulativePlan = new Float64Array(n + 1);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i <= n; i++) {
    const p = points[i];
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    if (i === 0) continue;
    const q = points[i - 1];
    const plan = Math.hypot(p[0] - q[0], p[1] - q[1]);
    cumulativePlan[i] = cumulativePlan[i - 1] + plan;
    cumulative[i] = cumulative[i - 1] + Math.hypot(plan, p[2] - q[2]);
  }
  const length = cumulative[n],
    planTotal = cumulativePlan[n];
  const along = (segment: number, t: number) =>
    cumulative[segment] + t * (cumulative[segment + 1] - cumulative[segment]);
  const alongPlan = (segment: number, t: number) =>
    cumulativePlan[segment] + t * (cumulativePlan[segment + 1] - cumulativePlan[segment]);

  // Nearest point on the curve in plan for every support within reach (first segment wins ties).
  const found: (Station & Position)[] = [];
  for (let k = 0; k < supports.length; k++) {
    const s = supports[k];
    if (s[0] < minX - tol || s[0] > maxX + tol || s[1] < minY - tol || s[1] > maxY + tol) continue;
    let best = Infinity,
      segment = 0,
      t = 0;
    for (let i = 0; i < n; i++) {
      const a = points[i],
        b = points[i + 1];
      const dx = b[0] - a[0],
        dy = b[1] - a[1];
      const length2 = dx * dx + dy * dy;
      let u = length2 > 0 ? ((s[0] - a[0]) * dx + (s[1] - a[1]) * dy) / length2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const d = Math.hypot(s[0] - (a[0] + u * dx), s[1] - (a[1] + u * dy));
      if (d < best) {
        best = d;
        segment = i;
        t = u;
      }
    }
    if (best > tol) continue;
    let at = along(segment, t);
    let point = lerp(points[segment], points[segment + 1], t);
    // Near an end: the support is the end (no sliver overhang, no sliver span).
    if (at <= merge) {
      segment = 0;
      t = 0;
      at = 0;
      point = [...points[0]];
    } else if (length - at <= merge) {
      segment = n - 1;
      t = 1;
      at = length;
      point = [...points[n]];
    }
    found.push({
      supports: [k],
      at,
      planAt: alongPlan(segment, t),
      offset: best,
      point,
      segment,
      t,
    });
  }
  found.sort((a, b) => a.at - b.at || a.offset - b.offset || a.supports[0] - b.supports[0]);

  // Supports that meet at one place are one station; the first along the curve fixes its position.
  const stations: (Station & Position)[] = [];
  for (const candidate of found) {
    const group = stations[stations.length - 1];
    if (group && candidate.at - group.at <= merge) {
      group.supports.push(candidate.supports[0]);
      continue;
    }
    stations.push(candidate);
  }
  for (const station of stations) station.supports.sort((a, b) => a - b);

  const piece = (
    kind: CurvePiece['kind'],
    start: Position,
    end: Position,
    from: number | null,
    to: number | null,
  ): CurvePiece => {
    const out: Vec3[] = [start.point];
    const push = (p: Vec3) => {
      const last = out[out.length - 1];
      if (last[0] !== p[0] || last[1] !== p[1] || last[2] !== p[2]) out.push([p[0], p[1], p[2]]);
    };
    for (let i = start.segment + 1; i <= end.segment; i++) push(points[i]);
    push(end.point);
    let pieceLength = 0,
      piecePlan = 0;
    for (let i = 1; i < out.length; i++) {
      const plan = Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
      piecePlan += plan;
      pieceLength += Math.hypot(plan, out[i][2] - out[i - 1][2]);
    }
    return { kind, from, to, length: pieceLength, planLength: piecePlan, points: out };
  };

  const spans: CurvePiece[] = [];
  const overhangs: CurvePiece[] = [];
  if (stations.length) {
    const first = stations[0],
      last = stations[stations.length - 1];
    const start: Position = { segment: 0, t: 0, point: points[0] };
    const end: Position = { segment: n - 1, t: 1, point: points[n] };
    if (first.at > 0) overhangs.push(piece('overhang', start, first, null, 0));
    for (let i = 1; i < stations.length; i++)
      spans.push(piece('span', stations[i - 1], stations[i], i - 1, i));
    if (last.at < length) overhangs.push(piece('overhang', last, end, stations.length - 1, null));
  }
  return {
    stations: stations.map(({ supports, at, planAt, offset, point }) => ({
      supports,
      at,
      planAt,
      offset,
      point,
    })),
    spans,
    overhangs,
    length,
    planLength: planTotal,
  };
}

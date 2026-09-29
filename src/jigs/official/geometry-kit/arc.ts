// Arcs and curve segmentation (SPEC-06.11 5, PLAN-23 T-050): a girder in a curved zone becomes a
// single-curvature arc in a vertical plane with a rise at mid-chord; a drawn curve (129 Sync
// points) is fitted with the arc through its ends and its farthest point; arcs and polylines are
// segmented for analysis (max length, max chord sagitta). Points are xyz in metres (z defaults to
// 0). Collinear or non-planar input throws `planar-curve`.

import { GeometryError, type PlanPoint, type Vec3 } from './plan.ts';

export interface Arc {
  center: Vec3;
  radius: number;
  /** Unit normal of the arc's plane (right-hand rule: the arc turns counter-clockwise about it). */
  normal: Vec3;
  /** Unit frame in the plane: `e1` towards the start, `e2 = normal × e1`. */
  e1: Vec3;
  e2: Vec3;
  start: Vec3;
  /** The point the arc was made through (the apex for a vertical arc). */
  through: Vec3;
  end: Vec3;
  /** Swept angle in radians (0, 2π). */
  sweep: number;
  length: number;
  chord: number;
  /** Sagitta of the whole arc: the distance from the chord's midpoint to the arc. */
  rise: number;
  /** True when the arc lies in a vertical plane (normal horizontal). */
  vertical: boolean;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossProduct = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

export function xyz(point: PlanPoint, what: string): Vec3 {
  const z = point.length > 2 ? point[2] : 0;
  if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || !Number.isFinite(z))
    throw new GeometryError('no-nan', `${what} is not a finite point`);
  return [point[0], point[1], z];
}

/** The circle arc from `a` through `b` to `c`. */
export function arcThrough(a: PlanPoint, b: PlanPoint, c: PlanPoint): Arc {
  const start = xyz(a, 'a'),
    through = xyz(b, 'b'),
    end = xyz(c, 'c');
  const u = sub(through, start),
    v = sub(end, start);
  const n = crossProduct(u, v);
  const area2 = norm(n);
  const size = Math.max(norm(u), norm(v));
  if (!(size > 0) || area2 <= 1e-12 * size * size)
    throw new GeometryError('planar-curve', 'three points on a line do not make an arc');
  // Circumcentre with `start` as origin: ((|u|² v − |v|² u) × n) / (2 |n|²).
  const uu = dot(u, u),
    vv = dot(v, v);
  const w = crossProduct(sub(scale(v, uu), scale(u, vv)), n);
  const offset = scale(w, 1 / (2 * area2 * area2));
  const center: Vec3 = [start[0] + offset[0], start[1] + offset[1], start[2] + offset[2]];
  const radius = norm(offset);
  const normal = scale(n, 1 / area2);
  const e1 = scale(sub(start, center), 1 / radius);
  const e2 = crossProduct(normal, e1);
  const angle = (p: Vec3) => {
    const d = sub(p, center);
    const t = Math.atan2(dot(d, e2), dot(d, e1));
    return t <= 0 ? t + 2 * Math.PI : t;
  };
  const sweep = angle(end);
  const chord = norm(v);
  return {
    center,
    radius,
    normal,
    e1,
    e2,
    start,
    through,
    end,
    sweep,
    length: radius * sweep,
    chord,
    rise: radius * (1 - Math.cos(sweep / 2)),
    vertical: Math.abs(normal[2]) <= 1e-9,
  };
}

/** Point on the arc at fraction `t` (0 = start, 1 = end). */
export function arcPoint(arc: Arc, t: number): Vec3 {
  const angle = arc.sweep * t;
  const c = Math.cos(angle) * arc.radius,
    s = Math.sin(angle) * arc.radius;
  return [
    arc.center[0] + arc.e1[0] * c + arc.e2[0] * s,
    arc.center[1] + arc.e1[1] * c + arc.e2[1] * s,
    arc.center[2] + arc.e1[2] * c + arc.e2[2] * s,
  ];
}

/**
 * Arc in the vertical plane through `a` and `b` with `rise` above the chord's midpoint (a hog;
 * negative for a sag). Ends coincident in plan, or a zero rise, throw `planar-curve`.
 */
export function verticalArc(a: PlanPoint, b: PlanPoint, rise: number): Arc {
  if (!Number.isFinite(rise)) throw new GeometryError('no-nan', `rise ${String(rise)}`);
  const start = xyz(a, 'a'),
    end = xyz(b, 'b');
  if (Math.hypot(end[0] - start[0], end[1] - start[1]) <= 1e-9)
    throw new GeometryError('planar-curve', 'arc ends coincide in plan');
  if (rise === 0) throw new GeometryError('planar-curve', 'a zero rise is a straight line');
  const apex: Vec3 = [
    (start[0] + end[0]) / 2,
    (start[1] + end[1]) / 2,
    (start[2] + end[2]) / 2 + rise,
  ];
  return arcThrough(start, apex, end);
}

export interface ArcFit {
  arc: Arc;
  /** Largest distance of any input point from the arc's circle (m). */
  deviation: number;
  /** Largest distance of any input point from the arc's plane (m). */
  planeDeviation: number;
}

/**
 * Arc through a polyline's ends and its point farthest from the chord, with the deviation of the
 * other points. Fewer than three points, or points on one line, throw `planar-curve`.
 */
export function fitArc(points: readonly PlanPoint[]): ArcFit {
  if (!Array.isArray(points) || points.length < 3)
    throw new GeometryError('planar-curve', 'an arc needs at least three points');
  const pts = points.map((p, i) => xyz(p, `points[${i}]`));
  const start = pts[0],
    end = pts[pts.length - 1];
  const chord = sub(end, start);
  const chordLength = norm(chord);
  let farthest = -1,
    farthestDistance = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = sub(pts[i], start);
    const distance = chordLength > 0 ? norm(crossProduct(d, chord)) / chordLength : norm(d);
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthest = i;
    }
  }
  if (farthest < 0 || farthestDistance <= 1e-9 * Math.max(chordLength, 1))
    throw new GeometryError('planar-curve', 'points lie on one line');
  const arc = arcThrough(start, pts[farthest], end);
  let deviation = 0,
    planeDeviation = 0;
  for (const p of pts) {
    const d = sub(p, arc.center);
    const off = dot(d, arc.normal);
    const radial = Math.hypot(dot(d, arc.e1), dot(d, arc.e2)) - arc.radius;
    planeDeviation = Math.max(planeDeviation, Math.abs(off));
    deviation = Math.max(deviation, Math.hypot(off, radial));
  }
  return { arc, deviation, planeDeviation };
}

export interface SegmentOptions {
  /** Longest piece (m, default 1.0). */
  maxLength?: number;
  /** Largest distance between a piece's chord and the arc (m, default 0.005). */
  maxSagitta?: number;
}

function positive(value: number | undefined, fallback: number, what: string) {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || v <= 0) throw new GeometryError('no-nan', `${what} ${String(value)}`);
  return v;
}

/** Polyline along the arc whose pieces respect both limits; ends are the arc's own ends. */
export function segmentArc(arc: Arc, options: SegmentOptions = {}): Vec3[] {
  const maxLength = positive(options.maxLength, 1.0, 'maxLength');
  const maxSagitta = positive(options.maxSagitta, 0.005, 'maxSagitta');
  const byLength = Math.ceil(arc.length / maxLength - 1e-9);
  const step = maxSagitta >= arc.radius ? Math.PI : 2 * Math.acos(1 - maxSagitta / arc.radius);
  const bySagitta = Math.ceil(arc.sweep / step - 1e-9);
  const n = Math.max(1, byLength, bySagitta);
  const out: Vec3[] = [[...arc.start]];
  for (let i = 1; i < n; i++) out.push(arcPoint(arc, i / n));
  out.push([...arc.end]);
  return out;
}

/** Polyline with every piece no longer than `maxLength`; the original vertices are kept. */
export function segmentPolyline(points: readonly PlanPoint[], maxLength: number): Vec3[] {
  const limit = positive(maxLength, 1.0, 'maxLength');
  if (!Array.isArray(points) || points.length < 2)
    throw new GeometryError('polygon-valid', 'polyline has fewer than 2 points');
  const pts = points.map((p, i) => xyz(p, `points[${i}]`));
  const out: Vec3[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1],
      b = pts[i];
    const length = norm(sub(b, a));
    const n = Math.max(1, Math.ceil(length / limit - 1e-9));
    for (let k = 1; k < n; k++)
      out.push([
        a[0] + ((b[0] - a[0]) * k) / n,
        a[1] + ((b[1] - a[1]) * k) / n,
        a[2] + ((b[2] - a[2]) * k) / n,
      ]);
    out.push(b);
  }
  return out;
}

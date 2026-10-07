import type { Geometry, Point, SourceObject, SourceSnapshot } from './drawing-backflow.ts';
import { isPacked, unpackPositions } from '../contracts/geometry-transfer.ts';

/**
 * 역반영의 원천 스냅숏 (SPEC-14.2, PLAN-47 T-233): the source (Rhino) objects of a stored Sync result in
 * metres. A Rhino Sync keeps every curve as points (`line`: the polyline vertices when the curve is
 * a polyline, else 128 equal divisions) and every block instance as its transform, so the curve
 * type is rebuilt here:
 *  - 2 points → line; points on one circle at 128 divisions → arc (129 points, open) or circle
 *    (128 points, closed); any other point list → polyline (closed when it ends where it starts);
 *  - 128/129 points not on a circle (a free-form curve) → no geometry (not written, SOURCE_TYPE);
 *  - an instance → insert (position, rotation about Z, scale); its block name is not in the Sync,
 *    so it stays '' and only position and rotation are compared and written.
 * Surfaces, meshes, text and annotations carry no geometry.
 */

const DIVISIONS = 128;
/**
 * Points of a Sync are rounded to 1 µm and stored as float32 offsets from the curve's first point
 * (ARCH-01 §5), so a fitted circle may be off by a few µm.
 */
const FIT = 2e-5;

const b64 = (value: unknown) => {
  if (typeof value !== 'string' || !value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
};
const round = (value: number) => Math.round(value * 1e9) / 1e9;

/** Least-squares circle through points in one XY plane: centre and radius, or null. */
export function fitCircle(points: readonly Point[]): { center: Point; radius: number } | null {
  if (points.length < 3) return null;
  const z = points[0][2];
  if (points.some((p) => Math.abs(p[2] - z) > 1e-6)) return null;
  // Kåsa fit about the mean (well conditioned for real coordinates).
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n,
    my = points.reduce((s, p) => s + p[1], 0) / n;
  let suu = 0,
    svv = 0,
    suv = 0,
    suuu = 0,
    svvv = 0,
    suvv = 0,
    svuu = 0;
  for (const p of points) {
    const u = p[0] - mx,
      v = p[1] - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-24) return null;
  const ka = (suuu + suvv) / 2,
    kb = (svvv + svuu) / 2;
  const uc = (ka * svv - kb * suv) / det,
    vc = (kb * suu - ka * suv) / det;
  let a = mx + uc,
    b = my + vc,
    radius = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  if (!(radius > 1e-9)) return null;
  // A few geometric (Gauss–Newton) steps remove the algebraic fit's bias on short arcs.
  for (let step = 0; step < 8; step++) {
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0],
      g = [0, 0, 0];
    for (const p of points) {
      const dx = p[0] - a,
        dy = p[1] - b,
        r = Math.hypot(dx, dy) || 1e-12;
      const j = [-dx / r, -dy / r, -1],
        f = r - radius;
      for (let row = 0; row < 3; row++) {
        g[row] += j[row] * f;
        for (let col = 0; col < 3; col++) m[row * 3 + col] += j[row] * j[col];
      }
    }
    const d = solve3(m, g);
    if (!d) break;
    a -= d[0];
    b -= d[1];
    radius -= d[2];
    if (Math.hypot(d[0], d[1], d[2]) < 1e-12) break;
  }
  const center: Point = [a, b, z];
  if (!(radius > 1e-9)) return null;
  for (const p of points)
    if (Math.abs(Math.hypot(p[0] - center[0], p[1] - center[1]) - radius) > FIT) return null;
  return { center: [round(center[0]), round(center[1]), z], radius: round(radius) };
}

/** x of m·x = v for a 3×3 m (row-major), or null when m is singular. */
function solve3(m: number[], v: number[]): number[] | null {
  const det = (k: number[]) =>
    k[0] * (k[4] * k[8] - k[5] * k[7]) -
    k[1] * (k[3] * k[8] - k[5] * k[6]) +
    k[2] * (k[3] * k[7] - k[4] * k[6]);
  const whole = det(m);
  if (Math.abs(whole) < 1e-30) return null;
  return [0, 1, 2].map((col) => {
    const k = [...m];
    for (let row = 0; row < 3; row++) k[row * 3 + col] = v[row];
    return det(k) / whole;
  });
}

const angle = (p: Point, c: Point) => {
  const value = Math.atan2(p[1] - c[1], p[0] - c[0]);
  return value < 0 ? value + Math.PI * 2 : value;
};
const same = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9;

/** A curve's stored points as the geometry a backflow writes (see the module note), or null. */
export function curveGeometry(points: readonly Point[]): Geometry | null {
  if (points.length < 2) return null;
  if (points.length === 2) return { kind: 'line', points: [points[0], points[1]] };
  const closed = same(points[0], points[points.length - 1]);
  if (points.length === DIVISIONS + 1 || points.length === DIVISIONS) {
    const circle = fitCircle(closed ? points.slice(0, -1) : points);
    if (!circle) return null;
    const first = points[0],
      last = points[points.length - 1];
    const step = Math.hypot(points[1][0] - first[0], points[1][1] - first[1]);
    const gap = Math.hypot(last[0] - first[0], last[1] - first[1]);
    // A closed curve divided 128 times does not repeat its start: the last gap is one step.
    if (
      closed ||
      (points.length === DIVISIONS && Math.abs(gap - step) < Math.max(FIT, step * 1e-3))
    )
      return { kind: 'circle', center: circle.center, radius: circle.radius };
    if (points.length !== DIVISIONS + 1) return null;
    const c = circle.center;
    const turn =
      (first[0] - c[0]) * (points[1][1] - c[1]) - (first[1] - c[1]) * (points[1][0] - c[0]);
    const [start, end] =
      turn >= 0 ? [angle(first, c), angle(last, c)] : [angle(last, c), angle(first, c)];
    return { kind: 'arc', center: c, radius: circle.radius, start, end };
  }
  if (closed) return { kind: 'polyline', points: points.slice(0, -1), closed: true };
  return { kind: 'polyline', points: [...points], closed: false };
}

/** An instance transform (row-major 4×4, translation in metres) as an insert. */
export function insertGeometry(transform: readonly number[]): Geometry | null {
  if (transform.length !== 16 || transform.some((v) => !Number.isFinite(v))) return null;
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = transform;
  return {
    kind: 'insert',
    block: '',
    position: [tx, ty, tz],
    rotation: ((Math.atan2(d, a) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2),
    scale: [Math.hypot(a, d, g), Math.hypot(b, e, h), Math.hypot(c, f, i)],
  };
}

const listOf = (value: unknown): Iterable<Record<string, unknown>> =>
  value && typeof value === 'object' && Symbol.iterator in value
    ? (value as Iterable<Record<string, unknown>>)
    : [];

/** The source snapshot of a stored Rhino Sync result (`scene` rows; may be a lazy stored list). */
export function sourceFromSync(
  result: Record<string, unknown>,
  linkId: string,
  revision: string,
): SourceSnapshot {
  const objects: SourceObject[] = [];
  for (const row of listOf(result.scene)) {
    const id = String(row.nativeId ?? row.id ?? '');
    if (!id) continue;
    const type = String(row.nativeType ?? 'Object');
    const block = row.block as { transform?: unknown } | undefined;
    let geometry: Geometry | null = null;
    if (block && (Array.isArray(block.transform) || ArrayBuffer.isView(block.transform)))
      geometry = insertGeometry([...(block.transform as ArrayLike<number> & Iterable<number>)]);
    else if (type === 'Curve' && (Array.isArray(row.line) || isPacked(row.line))) {
      const flat = isPacked(row.line) ? unpackPositions(row.line) : (row.line as number[]);
      const points: Point[] = [];
      for (let k = 0; k + 2 < flat.length; k += 3) points.push([flat[k], flat[k + 1], flat[k + 2]]);
      geometry = curveGeometry(points);
    }
    objects.push({ id, layer: b64(row.layer64), type, geometry });
  }
  return { linkId, revision, objects };
}

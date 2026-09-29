// Small 3D vector helpers for the structure-analysis library (m units, global +Z up).

export type Vec3 = [number, number, number];

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a: Vec3) => Math.sqrt(dot(a, a));
export const dist = (a: Vec3, b: Vec3) => len(sub(a, b));
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, mul(sub(b, a), t));
export const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 0 ? mul(a, 1 / l) : [0, 0, 0];
};
export const isFiniteVec = (p: unknown): p is Vec3 =>
  Array.isArray(p) && p.length === 3 && p.every((v) => typeof v === 'number' && Number.isFinite(v));

/** Parameter of the closest point of p on the infinite line ab and the distance to that line. */
export function projectOnLine(p: Vec3, a: Vec3, b: Vec3): { t: number; distance: number } {
  const d = sub(b, a);
  const dd = dot(d, d);
  if (dd <= 0) return { t: 0, distance: dist(p, a) };
  const t = dot(sub(p, a), d) / dd;
  return { t, distance: dist(p, add(a, mul(d, t))) };
}

/** Component of v perpendicular to the unit direction t. */
export function perpendicular(v: Vec3, t: Vec3): Vec3 {
  return sub(v, mul(t, dot(v, t)));
}

/** Cumulative along-curve length at every vertex (first entry 0). */
export function cumulativeLength(points: readonly Vec3[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + dist(points[i - 1], points[i]));
  return out;
}

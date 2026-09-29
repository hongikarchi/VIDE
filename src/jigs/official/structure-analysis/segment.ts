// Curve segmentation (SPEC-06.1): only curved rails are cut into analysis pieces, by a maximum
// chord length and a maximum curve-to-chord sag. Straight rails are never split here; the model
// builder splits them at joints only. Vertices always come from the input points (plus the
// projected split points), so the result is deterministic for the same input.

import { type Vec3, dist, lerp, projectOnLine } from './geometry.ts';

export interface SegmentOptions {
  /** Longest chord a piece may have (m). */
  maxLen_m: number;
  /** Largest distance between the curve points and the chord of a piece (m). */
  maxSag_m: number;
  /** Points that must become vertices (joints of other members); projected onto the curve. */
  splitAt?: readonly Vec3[];
  /** A split point farther than this from the curve is ignored (m, default 0.005). */
  tol_m?: number;
}

/** Drop repeated consecutive points. */
export function cleanPolyline(points: readonly Vec3[], tol = 1e-9): Vec3[] {
  const out: Vec3[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > tol) out.push([p[0], p[1], p[2]]);
  }
  return out;
}

/** Largest distance from the points strictly between `from` and `to` to the chord from→to. */
export function chordSag(points: readonly Vec3[], from: number, to: number): number {
  let sag = 0;
  const a = points[from],
    b = points[to];
  for (let k = from + 1; k < to; k++) {
    const { t, distance } = projectOnLine(points[k], a, b);
    const d = t < 0 ? dist(points[k], a) : t > 1 ? dist(points[k], b) : distance;
    if (d > sag) sag = d;
  }
  return sag;
}

/** A rail is curved when some interior point leaves the chord between its ends by more than tol. */
export function isCurved(points: readonly Vec3[], tol_m: number): boolean {
  const clean = cleanPolyline(points);
  return clean.length > 2 && chordSag(clean, 0, clean.length - 1) > tol_m;
}

/**
 * Vertices of the analysis pieces of a curved rail. The first and last point, every projected
 * `splitAt` point and the greedy farthest points that keep chord ≤ maxLen and sag ≤ maxSag.
 */
export function segmentCurve(points: readonly Vec3[], options: SegmentOptions): Vec3[] {
  const tol = options.tol_m ?? 0.005;
  if (!(options.maxLen_m > 0) || !(options.maxSag_m > 0))
    throw Object.assign(new Error('segmentCurve needs positive maxLen_m and maxSag_m'), {
      code: 'INVALID_INPUT',
    });
  const base = cleanPolyline(points);
  if (base.length < 2)
    throw Object.assign(new Error('a rail needs two distinct points'), { code: 'INVALID_INPUT' });

  // Insert the split points (nearest projection within tol) as mandatory vertices.
  type Vertex = { p: Vec3; mandatory: boolean };
  const inserts: { segment: number; t: number; p: Vec3 }[] = [];
  const mandatoryIndex = new Set<number>([0, base.length - 1]);
  for (const s of options.splitAt ?? []) {
    let best = { segment: -1, t: 0, distance: Infinity };
    for (let k = 0; k + 1 < base.length; k++) {
      const { t, distance } = projectOnLine(s, base[k], base[k + 1]);
      const tc = Math.min(1, Math.max(0, t));
      const d = t === tc ? distance : dist(s, lerp(base[k], base[k + 1], tc));
      if (d < best.distance) best = { segment: k, t: tc, distance: d };
    }
    if (best.segment < 0 || best.distance > tol) continue;
    const p = lerp(base[best.segment], base[best.segment + 1], best.t);
    if (dist(p, base[best.segment]) <= tol) mandatoryIndex.add(best.segment);
    else if (dist(p, base[best.segment + 1]) <= tol) mandatoryIndex.add(best.segment + 1);
    else if (!inserts.some((x) => dist(x.p, p) <= tol))
      inserts.push({ segment: best.segment, t: best.t, p });
  }
  inserts.sort((u, v) => u.segment - v.segment || u.t - v.t);
  const vertices: Vertex[] = [];
  let next = 0;
  for (let k = 0; k < base.length; k++) {
    vertices.push({ p: base[k], mandatory: mandatoryIndex.has(k) });
    while (next < inserts.length && inserts[next].segment === k) {
      vertices.push({ p: inserts[next].p, mandatory: true });
      next++;
    }
  }
  const pts = vertices.map((v) => v.p);
  const n = pts.length;

  // Greedy: from each vertex take the farthest later vertex that keeps chord and sag in bounds,
  // never passing a mandatory vertex.
  const out: Vec3[] = [pts[0]];
  let a = 0;
  while (a < n - 1) {
    let stop = a + 1;
    while (stop < n - 1 && !vertices[stop].mandatory) stop++;
    let b = a + 1;
    for (let c = a + 2; c <= stop; c++) {
      if (dist(pts[a], pts[c]) > options.maxLen_m || chordSag(pts, a, c) > options.maxSag_m) break;
      b = c;
    }
    out.push(pts[b]);
    a = b;
  }
  return out;
}

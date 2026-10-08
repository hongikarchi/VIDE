// 어트랙터 개구 (SPEC-16.13 4, PLAN-49 T-260): an opening per panel whose ratio follows the distance
// to the nearest attractor point or polyline. d = 3D distance from the panel centre (the surface
// point at a point inside its outline in parameters: the area centroid, or for a concave outline
// the inside point farthest from its edges); r = far + (near − far)·max(0, 1 − d/R), snapped to one
// of `levels` equal values between far and near when levels ≥ 2; never above OPENING_MAX. The
// opening is the outline shrunk by √r about that point — less when it would leave under
// OPENING_RIM to the panel's edge on the surface — carried to the surface; its measured share of
// the panel area is kept next to the target. Failed and dropped panels get none.

import {
  OPENING_MAX,
  type CurveSet,
  type Panel,
  type PreviewSettings,
} from '../../../contracts/paneling.ts';
import { fingerprint } from './hash.ts';
import type { FaceSampler } from './sample.ts';
import { cross3, dot3, sub3, type Vec2, type Vec3 } from './vec.ts';

export interface Attractor {
  /** One point, or a polyline (closed: the last point joins the first). */
  points: Vec3[];
  closed: boolean;
}

export type OpeningSettings = NonNullable<PreviewSettings['opening']>['value'];

/** Attractors from the read points and curves (none when nothing was picked). */
export function attractorsFromCurves(set: CurveSet | null | undefined): Attractor[] {
  if (!set) return [];
  return set.items.map((item) => ({
    points: item.points.map((p) => [p[0], p[1], p[2]] as Vec3),
    closed: item.kind === 'polyline' && item.closed,
  }));
}

/** Fingerprint of the attractors (part of the layout's settings hash). */
export function attractorsHash(attractors: readonly Attractor[]): string {
  const round = (v: number) => Math.round(v * 1e7) / 1e7;
  return fingerprint(attractors.map((a) => [a.closed, a.points.map((p) => p.map(round))]));
}

function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub3(b, a);
  const l2 = dot3(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot3(sub3(p, a), ab) / l2)) : 0;
  const q: Vec3 = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Distance from p to the nearest attractor; Infinity without attractors. */
export function attractorDistance(p: Vec3, attractors: readonly Attractor[]): number {
  let best = Infinity;
  for (const a of attractors) {
    const pts = a.points;
    if (pts.length === 1) {
      best = Math.min(best, Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1], p[2] - pts[0][2]));
      continue;
    }
    const n = a.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++)
      best = Math.min(best, segmentDistance(p, pts[i], pts[(i + 1) % pts.length]));
  }
  return best;
}

/** The target ratio at distance d (SPEC-16.13 4 값). */
export function openingRatio(settings: OpeningSettings, d: number): number {
  const { near, far, radius, levels } = settings;
  const f = Number.isFinite(d) ? Math.max(0, 1 - d / radius) : 0;
  let r = far + (near - far) * f;
  if (levels >= 2 && near !== far) {
    const step = (near - far) / (levels - 1);
    r = far + Math.round((r - far) / step) * step;
  }
  return Math.min(OPENING_MAX, Math.max(0, r));
}

/** Area on the surface of an outline in parameters (fan over corners and edge middles, like the
 *  layout's panel area). */
export function surfaceArea(sampler: FaceSampler, uv: readonly Vec2[]): number {
  const n = uv.length;
  const cu = uv.reduce((a, p) => a + p[0], 0) / n;
  const cv = uv.reduce((a, p) => a + p[1], 0) / n;
  const centre = sampler.point(cu, cv);
  const corners = uv.map((p) => sampler.point(p[0], p[1]));
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = uv[i],
      b = uv[(i + 1) % n];
    const mid = sampler.point((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    const ring = [corners[i], mid, corners[(i + 1) % n]];
    for (let k = 0; k < 2; k++) {
      const c = cross3(sub3(ring[k], centre), sub3(ring[k + 1], centre));
      area += Math.hypot(c[0], c[1], c[2]) / 2;
    }
  }
  return area;
}

/** The rim an opening keeps to its panel's outline on the surface (SPEC-16.13 4 모양). */
export const OPENING_RIM = 0.015;

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c),
    d2 = o(a, b, d),
    d3 = o(c, d, a),
    d4 = o(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Point in a UV polygon (even-odd). */
export function insideUV(p: readonly number[], ring: readonly (readonly number[])[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** The outline's edges on the surface as a polyline (four pieces per edge), for rim distances. */
export function boundaryOnSurface(sampler: FaceSampler, uv: readonly Vec2[]): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < uv.length; i++) {
    const a = uv[i],
      b = uv[(i + 1) % uv.length];
    for (let k = 0; k < 4; k++)
      out.push(sampler.point(a[0] + ((b[0] - a[0]) * k) / 4, a[1] + ((b[1] - a[1]) * k) / 4));
  }
  return out;
}

/** The smallest surface distance from the opening's corners and edge middles to the outline's
 *  boundary polyline; −1 when a corner is outside the outline or an edge crosses it. */
export function openingRim(
  sampler: FaceSampler,
  opening: readonly Vec2[],
  outline: readonly Vec2[],
  boundary: readonly Vec3[] = boundaryOnSurface(sampler, outline as Vec2[]),
): number {
  const n = opening.length,
    m = outline.length;
  for (let i = 0; i < n; i++) {
    if (!insideUV(opening[i], outline)) return -1;
    for (let j = 0; j < m; j++)
      if (segmentsCross(opening[i], opening[(i + 1) % n], outline[j], outline[(j + 1) % m]))
        return -1;
  }
  let rim = Infinity;
  for (let i = 0; i < n; i++) {
    const a = opening[i],
      b = opening[(i + 1) % n];
    for (const p of [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Vec2]) {
      const x = sampler.point(p[0], p[1]);
      for (let k = 0; k < boundary.length; k++)
        rim = Math.min(rim, segmentDistance(x, boundary[k], boundary[(k + 1) % boundary.length]));
    }
  }
  return rim;
}

/** A point inside the outline to shrink it about: the area centroid, or for a concave outline whose
 *  centroid falls outside, the inside grid point farthest from the edges. */
function insidePoint(uv: readonly Vec2[]): Vec2 {
  let a = 0,
    cx = 0,
    cy = 0;
  for (let i = 0; i < uv.length; i++) {
    const p = uv[i],
      q = uv[(i + 1) % uv.length];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c;
    cx += (p[0] + q[0]) * c;
    cy += (p[1] + q[1]) * c;
  }
  const mean: Vec2 = [
    uv.reduce((s, p) => s + p[0], 0) / uv.length,
    uv.reduce((s, p) => s + p[1], 0) / uv.length,
  ];
  const centroid: Vec2 = Math.abs(a) > 0 ? [cx / (3 * a), cy / (3 * a)] : mean;
  if (insideUV(centroid, uv)) return centroid;
  const u0 = Math.min(...uv.map((p) => p[0])),
    u1 = Math.max(...uv.map((p) => p[0])),
    v0 = Math.min(...uv.map((p) => p[1])),
    v1 = Math.max(...uv.map((p) => p[1]));
  const edgeDist = (p: Vec2) => {
    let d = Infinity;
    for (let i = 0; i < uv.length; i++) {
      const s0 = uv[i],
        s1 = uv[(i + 1) % uv.length];
      const ex = s1[0] - s0[0],
        ey = s1[1] - s0[1];
      const l2 = ex * ex + ey * ey;
      const t =
        l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - s0[0]) * ex + (p[1] - s0[1]) * ey) / l2)) : 0;
      d = Math.min(d, Math.hypot(p[0] - s0[0] - t * ex, p[1] - s0[1] - t * ey));
    }
    return d;
  };
  let best = mean,
    bestD = -1;
  for (let j = 1; j < 16; j++)
    for (let i = 1; i < 16; i++) {
      const p: Vec2 = [u0 + ((u1 - u0) * i) / 16, v0 + ((v1 - v0) * j) / 16];
      if (!insideUV(p, uv)) continue;
      const d = edgeDist(p);
      if (d > bestD) {
        best = p;
        bestD = d;
      }
    }
  return best;
}

/** Set `opening` on every panel that gets one (in place). The outline shrinks by √r about a point
 *  inside the panel; when that leaves less than OPENING_RIM to the panel's edge on the surface (or
 *  pokes out of a concave panel) it shrinks further until the rim holds, and the measured ratio
 *  says so. A panel without room for any opening gets none. */
export function addOpenings(
  panels: Panel[],
  samplers: ReadonlyMap<number, FaceSampler>,
  settings: OpeningSettings,
  attractors: readonly Attractor[],
): void {
  if (!(settings.near > 0 || settings.far > 0)) return;
  for (const panel of panels) {
    if (panel.failure || !(panel.area > 0)) continue;
    const sampler = samplers.get(panel.faceIndex);
    if (!sampler) continue;
    const outline = panel.uv as Vec2[];
    const [cu, cv] = insidePoint(outline);
    const ratio = openingRatio(settings, attractorDistance(sampler.point(cu, cv), attractors));
    if (!(ratio > 0)) continue;
    const boundary = boundaryOnSurface(sampler, outline);
    const shrink = (k: number) =>
      outline.map(([u, v]) => [cu + k * (u - cu), cv + k * (v - cv)] as Vec2);
    const fits = (k: number) => openingRim(sampler, shrink(k), outline, boundary) >= OPENING_RIM;
    let k = Math.sqrt(ratio);
    if (!fits(k)) {
      let lo = 0,
        hi = k;
      for (let it = 0; it < 24; it++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      k = lo;
    }
    if (!(k > 1e-3)) continue;
    const uv = shrink(k);
    const corners = uv.map((p) => sampler.point(p[0], p[1]));
    const actual = surfaceArea(sampler, uv) / panel.area;
    panel.opening = {
      ratio,
      actual: Number.isFinite(actual) ? actual : 0,
      uv,
      corners: corners.map((c) => [c[0], c[1], c[2]] as Vec3),
    };
  }
}

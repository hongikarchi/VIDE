// 어트랙터 개구 (SPEC-16.13 4, PLAN-49 T-260): an opening per panel whose ratio follows the distance
// to the nearest attractor point or polyline. d = 3D distance from the panel centre (the surface
// point at the mean of its outline parameters); r = far + (near − far)·max(0, 1 − d/R), snapped to
// one of `levels` equal values between far and near when levels ≥ 2; never above OPENING_MAX. The
// opening is the outline shrunk by √r about that parameter mean and carried to the surface; its
// measured share of the panel area is kept next to the target. Failed and dropped panels get none.

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

/** Set `opening` on every panel that gets one (in place). */
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
    const n = panel.uv.length;
    const cu = panel.uv.reduce((a, p) => a + p[0], 0) / n;
    const cv = panel.uv.reduce((a, p) => a + p[1], 0) / n;
    const ratio = openingRatio(settings, attractorDistance(sampler.point(cu, cv), attractors));
    if (!(ratio > 0)) continue;
    const k = Math.sqrt(ratio);
    const uv = panel.uv.map(([u, v]) => [cu + k * (u - cu), cv + k * (v - cv)] as Vec2);
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

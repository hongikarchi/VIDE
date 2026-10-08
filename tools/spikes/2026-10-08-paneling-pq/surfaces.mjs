// SPIKE T-259 (PLAN-49): synthetic 90 × 60 m faces for the PQ measurement, sampled like the read
// template (192 × 128, k = j·nu + i, + curvature = centre on the normal side) through the test fixture's
// `sampleFace`. Normals and principal curvatures come from finite differences of the analytic
// position, so any position function can be used. No project data.
import { sampleFace, rectLoop, circleLoop } from '../../../tests/fixtures/paneling-surfaces.mjs';

const H = 1e-4;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

/** Position, unit normal and signed principal curvatures [k1 ≥ k2] of `f(u, v) → [x, y, z]`. */
export function differential(f, u, v) {
  const p = f(u, v);
  const pu = scale(sub(f(u + H, v), f(u - H, v)), 1 / (2 * H));
  const pv = scale(sub(f(u, v + H), f(u, v - H)), 1 / (2 * H));
  const puu = scale(sub(sub(f(u + H, v), scale(p, 2)), scale(f(u - H, v), -1)), 1 / (H * H));
  const pvv = scale(sub(sub(f(u, v + H), scale(p, 2)), scale(f(u, v - H), -1)), 1 / (H * H));
  const puv = scale(
    sub(sub(f(u + H, v + H), f(u + H, v - H)), sub(f(u - H, v + H), f(u - H, v - H))),
    1 / (4 * H * H),
  );
  const c = cross(pu, pv);
  const n = scale(c, 1 / Math.hypot(...c));
  const E = dot(pu, pu),
    F = dot(pu, pv),
    G = dot(pv, pv);
  const L = dot(puu, n),
    M = dot(puv, n),
    N = dot(pvv, n);
  const det = E * G - F * F;
  const K = (L * N - M * M) / det;
  const Hm = (E * N - 2 * F * M + G * L) / (2 * det);
  const d = Math.sqrt(Math.max(0, Hm * Hm - K));
  return { p, n, k: [Hm + d, Hm - d] };
}

// 90 × 60 m faces paneled at 1 m (about 5,400 panels): curvature radii of a few tens of metres, so a
// 1 m panel is a few mm out of plane — the range where planarization matters.
const W = 90,
  D = 60;
const face = (f, o = {}) =>
  sampleFace((u, v) => differential(f, u, v), {
    nu: 192,
    nv: 128,
    domainU: [0, W],
    domainV: [0, D],
    trimLoops: o.hole ? [rectLoop(0, W, 0, D), circleLoop(46, 29, 7.5)] : [],
    ...o,
  });

const saddle = (x, y) => (x - 45) ** 2 / 120 - (y - 30) ** 2 / 80 + 5;

/**
 * Four faces, the iso-curves going from a conjugate net (planar quads exist on the surface) to an
 * asymptotic one (the worst case for planar quads):
 * - `aligned`: the saddle z = (x−45)²/120 − (y−30)²/80 + 5 with a 7.5 m hole; a translation surface,
 *   so its parameter lines are conjugate (the T-250 saddle three times larger).
 * - `rotated`: the same saddle, its parameters turned 30° against the curvature directions.
 * - `wave`: z = 3 sin(x/8) cos(y/10) (iso-curves neither conjugate nor asymptotic).
 * - `twisted`: z = (x−45)(y−30)/60 (iso-curves are asymptotic lines).
 */
export const FACES = {
  aligned: () => face((u, v) => [u, v, saddle(u, v)], { hole: true }),
  rotated: () => {
    const c = Math.cos(Math.PI / 6),
      s = Math.sin(Math.PI / 6);
    return face((u, v) => {
      const x = 45 + c * (u - 45) - s * (v - 30);
      const y = 30 + s * (u - 45) + c * (v - 30);
      return [x, y, saddle(x, y)];
    });
  },
  wave: () => face((u, v) => [u, v, 3 * Math.sin(u / 8) * Math.cos(v / 10)]),
  twisted: () => face((u, v) => [u, v, ((u - 45) * (v - 30)) / 60]),
};

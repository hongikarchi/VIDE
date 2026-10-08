// 곡률 등급 (SPEC-16.7 3, PLAN-49 T-256): from the signed principal curvatures at a panel's check
// points, kmax = the largest |k1|, |k2| and kmin = the largest of each point's smaller |k|. With
// k0 = 1 ÷ '평면으로 볼 곡률 반지름': kmax ≤ k0 → flat, else kmin ≤ k0 → single, else double.
// The class describes a panel (schedule, colour); it never splits a type (SPEC-16.7 4).

import type { FaceSampler } from './sample.ts';
import type { Vec2 } from './vec.ts';

export type CurvatureClass = 'flat' | 'single' | 'double';
export const CLASS_ORDER: Record<CurvatureClass, number> = { flat: 0, single: 1, double: 2 };
export const CLASS_LABELS: Record<CurvatureClass, string> = {
  flat: '평면',
  single: '단곡',
  double: '복곡',
};

export function curvatureClass(
  sampler: FaceSampler,
  checkUV: readonly Vec2[],
  flatRadius: number,
): { class: CurvatureClass; kmax: number; kmin: number } {
  let kmax = 0,
    kmin = 0;
  for (const [u, v] of checkUV) {
    const [k1, k2] = sampler.curvature(u, v);
    const a = Math.abs(k1),
      b = Math.abs(k2);
    kmax = Math.max(kmax, a, b);
    kmin = Math.max(kmin, Math.min(a, b));
  }
  const k0 = 1 / flatRadius;
  return { class: kmax <= k0 ? 'flat' : kmin <= k0 ? 'single' : 'double', kmax, kmin };
}

/** The higher of two classes (a type's class is the highest among its panels). */
export const higherClass = (a: CurvatureClass, b: CurvatureClass): CurvatureClass =>
  CLASS_ORDER[b] > CLASS_ORDER[a] ? b : a;

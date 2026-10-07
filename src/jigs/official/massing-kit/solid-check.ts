// 외피 점검과 만들기 면 목록 (SPEC-12.9 4·6, PLAN-45 T-210 `solid-check.ts`). The engine check is
// `checkSolid` of `vide/geometry-kit` (closed, manifold, one shell, Euler 2, positive volume — an
// inside-out solid fails on the volume sign, RESEARCH-04 J-04). Before baking, the engine merges
// coplanar polygons into faces with holes itself (Rhino's MergeCoplanarFaces changed volumes by
// 4.7–9.9 % in the spike and is never called) and checks that the merged faces, as wound, still
// enclose the checked volume; `vide.bake.brep-faces@1` repeats the check in Rhino.

import type { Vec3 } from '../geometry-kit/plan.ts';
import {
  checkSolid,
  facesVolume,
  mergeCoplanar,
  type SolidCheck,
  type SolidMesh,
} from '../geometry-kit/solid.ts';

export type EnvelopeCheck = SolidCheck;

export const envelopeCheck = (mesh: SolidMesh): EnvelopeCheck => checkSolid(mesh);

export interface BakeFaces {
  /** Faces → rings (outer counter-clockwise seen from outside, then holes) → points (m). */
  faces: Vec3[][][];
  /** Engine volume (m³), sent in f64 with the faces. */
  volume: number;
}

/** Merged faces of a checked mesh; throws `점검 실패` when the merge changes the volume. */
export function bakeFaces(mesh: SolidMesh, check: SolidCheck): BakeFaces {
  const faces = mergeCoplanar(mesh);
  const wound = facesVolume(faces);
  if (!(Math.abs(wound - check.volume) <= 1e-9 * Math.max(1, Math.abs(check.volume))))
    throw new Error(`점검 실패: 면 병합 뒤 부피 ${wound} ≠ ${check.volume}`);
  return { faces, volume: check.volume };
}

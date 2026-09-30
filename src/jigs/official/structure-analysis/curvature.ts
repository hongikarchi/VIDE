// Geometry of design members for marks and the schedule (SPEC-06.12): the node chain, its length,
// the chord between the ends, the rise above the chord and the radius of the single-curvature arc
// through the chord ends and the apex. A member is curved when its rise exceeds the tolerance.

import type { StructureModelInput } from '../../../contracts/structure-model.ts';
import { nodeChain } from './deflection.ts';
import type { MemberMap } from './frame-plan.ts';
import { type Vec3, cumulativeLength, dist, lerp, projectOnLine } from './geometry.ts';

export interface MemberGeometry {
  id: string;
  points: Vec3[];
  /** Length along the chain (m). */
  length_m: number;
  /** Straight distance between the chain ends (m). */
  chord_m: number;
  /** Largest offset of a chain node from the chord (m). */
  rise_m: number;
  /** c²/(8s) + s/2 for a curved member, null when straight. */
  radius_m: number | null;
  curved: boolean;
  /** Chord midpoint: the position key for numbering. */
  mid: Vec3;
}

/** Rise tolerance: twice the merge tolerance, at least 10 mm (Sync rounding never makes a curve). */
export const curveTolerance = (mergeTolerance_m: number) => Math.max(0.01, 2 * mergeTolerance_m);

export function memberGeometry(
  model: Pick<StructureModelInput, 'nodes' | 'members'> & {
    meta?: { mergeTolerance_m?: number };
  },
  map: Pick<MemberMap, 'physical'>,
  tol_m = curveTolerance(model.meta?.mergeTolerance_m ?? 0.005),
): Record<string, MemberGeometry> {
  const nodes = new Map(model.nodes.map((n) => [n.id, n.xyz_m as Vec3]));
  const members = new Map(model.members.map((m) => [m.id, m]));
  const out: Record<string, MemberGeometry> = {};
  for (const [id, segments] of Object.entries(map.physical)) {
    const chain = nodeChain(segments, members);
    if (!chain || chain.some((n) => !nodes.has(n))) continue;
    const points = chain.map((n) => nodes.get(n)!);
    const a = points[0],
      b = points[points.length - 1];
    const along = cumulativeLength(points);
    const chord = dist(a, b);
    let rise = 0;
    for (const p of points.slice(1, -1)) rise = Math.max(rise, projectOnLine(p, a, b).distance);
    const curved = chord > 0 && rise > tol_m;
    out[id] = {
      id,
      points,
      length_m: along[along.length - 1],
      chord_m: chord,
      rise_m: rise,
      radius_m: curved ? (chord * chord) / (8 * rise) + rise / 2 : null,
      curved,
      mid: lerp(a, b, 0.5),
    };
  }
  return out;
}

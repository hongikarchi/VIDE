// Reference deflection of design members (SPEC-06.6, ADR-019 follow-up, RESEARCH-10 결정 A8):
// the chord between the two support nodes of the physical member plus the core's per-segment
// deflection. Shown beside the verdicts as '참고 처짐'; never merged into the four-state verdict.
// The estimate never falls below any segment's own deflection: for a segment with end offsets
// r_a, r_b from the chord and internal deflection d, it takes max(r_a, r_b, (r_a + r_b)/2 + d).

import type { StructureModel, StructureResult } from '../../../contracts/structure-model.ts';
import type { MemberMap } from './frame-plan.ts';
import { type Vec3, cumulativeLength, len, lerp, perpendicular, sub, unit } from './geometry.ts';

export interface DeflectionRow {
  id: string;
  role: string;
  kind: 'span' | 'cantilever';
  /** Service combination that governs. */
  combo: string;
  length_m: number;
  deflection_mm: number;
  /** Largest per-segment deflection the core reported for the same combination. */
  segmentMax_mm: number;
  limit_mm: number;
  ratio: number;
  exceeds: boolean;
}

export interface DeflectionOptions {
  /** L/n by role; defaults to the model's checkSettings.deflectionLimits. */
  limits?: Record<string, number>;
  /** Cantilever tip limit divisor (L/n, default 180 — assumed). */
  cantilever_n?: number;
}

/** Ordered node chain of a design member's segments (tolerant to reversed segments). */
export function nodeChain(
  segments: string[],
  members: Map<string, { i: string; j: string }>,
): string[] | undefined {
  const first = members.get(segments[0]);
  if (!first) return undefined;
  if (segments.length === 1) return [first.i, first.j];
  const second = members.get(segments[1]);
  if (!second) return undefined;
  const startsAt = first.j === second.i || first.j === second.j ? first.i : first.j;
  const chain = [startsAt];
  for (const id of segments) {
    const m = members.get(id);
    if (!m) return undefined;
    const last = chain[chain.length - 1];
    if (m.i === last) chain.push(m.j);
    else if (m.j === last) chain.push(m.i);
    else return undefined;
  }
  return chain;
}

export function referenceDeflection(
  model: StructureModel,
  result: StructureResult,
  map: MemberMap,
  options: DeflectionOptions = {},
): DeflectionRow[] {
  if (result.status !== 'ok') return [];
  const service = model.combinations
    .filter((c) => c.limitState === 'service')
    .map((c) => c.id)
    .filter((id) => result.combos.includes(id));
  if (!service.length) return [];
  const limits = options.limits ?? model.checkSettings.deflectionLimits;
  const cantileverN = options.cantilever_n ?? limits.cantilever ?? 180;
  const nodes = new Map(model.nodes.map((n) => [n.id, n.xyz_m as Vec3]));
  const members = new Map(model.members.map((m) => [m.id, m]));
  const rows: DeflectionRow[] = [];
  for (const [id, segments] of Object.entries(map.physical)) {
    const role = map.roles[id] ?? 'other';
    if (role === 'column' || role === 'brace') continue;
    const chain = nodeChain(segments, members);
    if (!chain || chain.some((n) => !nodes.has(n) || !result.nodes[n])) continue;
    const points = chain.map((n) => nodes.get(n)!);
    const along = cumulativeLength(points);
    const length = along[along.length - 1];
    if (!(length > 0)) continue;
    const free = map.cantilever[id];
    const kind = free ? 'cantilever' : 'span';
    const axis = unit(sub(points[points.length - 1], points[0]));
    const n = limits[role] ?? limits.other ?? 240;
    const limit_mm = (length / (free ? cantileverN : n)) * 1e3;
    let best: DeflectionRow | undefined;
    for (const combo of service) {
      const u = chain.map((node) => result.nodes[node].disp[combo].slice(0, 3) as Vec3);
      // Offset of every chain node from the chord (span) or from the root (cantilever), mm.
      const offsets = u.map((uk, k) => {
        const reference = free
          ? free === 'j'
            ? u[0]
            : u[u.length - 1]
          : lerp(u[0], u[u.length - 1], along[k] / length);
        return len(perpendicular(sub(uk, reference), axis)) * 1e3;
      });
      let deflection = 0,
        segmentMax = 0;
      segments.forEach((seg, k) => {
        const d = result.members[seg]?.deflection_mm?.[combo] ?? 0;
        segmentMax = Math.max(segmentMax, d);
        const [ra, rb] = [offsets[k], offsets[k + 1]];
        deflection = Math.max(deflection, ra, rb, (ra + rb) / 2 + d);
      });
      const row: DeflectionRow = {
        id,
        role,
        kind,
        combo,
        length_m: length,
        deflection_mm: deflection,
        segmentMax_mm: segmentMax,
        limit_mm,
        ratio: limit_mm > 0 ? deflection / limit_mm : 0,
        exceeds: deflection > limit_mm,
      };
      if (!best || row.deflection_mm > best.deflection_mm) best = row;
    }
    if (best) rows.push(best);
  }
  return rows;
}

// 3D 가능 외피 (SPEC-12.9, PLAN-45 T-210): 돌출 · 일조 사선 · 최대 외피 as closed polyhedra in
// the engine (SPIKE-2026-10-07-envelope 결론 1). 돌출 = 대지 기둥(높이 상한) − 2D 절삭,
// 일조 사선 외피 = 대지 기둥 − (일조 벽 ∪ 사선), 최대 = 돌출 − (일조 벽 ∪ 사선). Every envelope passes
// the closed-solid check before it is offered for baking; a failure stops the step ('점검 실패')
// and nothing is flipped to make it pass (SPEC-12.9 4).

import type { Polygon } from '../geometry-kit/plan.ts';
import {
  prismSolid,
  sectionArea,
  solidSubtract,
  solidUnionAll,
  weldSolid,
  type Solid,
  type SolidMesh,
} from '../geometry-kit/solid.ts';
import {
  ARC_SIDES,
  cutterSolid,
  sunSlopeSolid,
  sunWallSolid,
  type Cutter,
  type SunRule,
} from './setback.ts';
import { bakeFaces, envelopeCheck, type BakeFaces, type EnvelopeCheck } from './solid-check.ts';

export type EnvelopeKind = 'extrude' | 'sun' | 'max';
export const ENVELOPE_TITLES: Record<EnvelopeKind, string> = {
  extrude: '돌출 외피',
  sun: '일조 사선 외피',
  max: '최대 외피',
};

export interface EnvelopeInput {
  site: Polygon;
  cutters: readonly Cutter[];
  sun: SunRule | null;
  /** 높이 상한 (m). */
  height: number;
  /** Section heights (m). */
  sectionAt: readonly number[];
  sides?: number;
}

export interface Envelope {
  kind: EnvelopeKind;
  mesh: SolidMesh;
  check: EnvelopeCheck;
  faces: BakeFaces;
}

export interface EnvelopeSet {
  height: number;
  envelopes: Envelope[];
  sections: { z: number; extrude: number; max: number }[];
  /** 일조 사선이 줄인 부피 (돌출 − 최대, m³). */
  sunCutVolume: number;
}

/** Throws `점검 실패: …` when an envelope does not pass the check (SPEC-12.9 4). */
export function envelopes(input: EnvelopeInput): EnvelopeSet {
  const sides = input.sides ?? ARC_SIDES;
  const H = input.height;
  if (!(H > 0)) throw new Error('점검 실패: 높이 상한이 0 이하입니다');
  const box = prismSolid(input.site, 0, H);
  const top = H + 1;
  const walls = input.sun ? sunWallSolid(input.sun, -1, top, sides) : [];
  const slopes = input.sun ? sunSlopeSolid(input.sun, top, sides) : [];
  const cut2d = solidUnionAll([...input.cutters.map((c) => cutterSolid(c, -1, top, sides)), walls]);
  const sunAll = solidUnionAll([walls, slopes]);
  const extrude: Solid = solidSubtract(box, cut2d);
  const solids: [EnvelopeKind, Solid][] = [['extrude', extrude]];
  if (input.sun) {
    solids.push(['sun', solidSubtract(box, sunAll)]);
    solids.push(['max', solidSubtract(extrude, sunAll)]);
  } else solids.push(['max', extrude]);
  const out: Envelope[] = [];
  for (const [kind, solid] of solids) {
    const mesh = weldSolid(solid);
    const check = envelopeCheck(mesh);
    if (!check.ok)
      throw new Error(`점검 실패: ${ENVELOPE_TITLES[kind]} — ${check.reasons.join(', ')}`);
    out.push({ kind, mesh, check, faces: bakeFaces(mesh, check) });
  }
  const ext = out.find((e) => e.kind === 'extrude')!,
    max = out.find((e) => e.kind === 'max')!;
  return {
    height: H,
    envelopes: out,
    sections: input.sectionAt
      .filter((z) => z > 0 && z < H)
      .map((z) => ({ z, extrude: sectionArea(ext.mesh, z), max: sectionArea(max.mesh, z) })),
    sunCutVolume: ext.check.volume - max.check.volume,
  };
}

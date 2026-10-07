// 3D 가능 외피 (SPEC-12.9, PLAN-45 T-210): 돌출 · 일조 사선 · 최대 외피 as closed polyhedra in
// the engine (SPIKE-2026-10-07-envelope 결론 1). 돌출 = the 2D 가능 영역 as a prism to the height cap
// (T-214 F-6), 일조 사선 외피 = 대지 기둥 − (일조 벽 ∪ 사선), 최대 = 돌출 − (일조 벽 ∪ 사선). Every envelope passes
// the closed-solid check before it is offered for baking; a failure stops the step ('점검 실패')
// and nothing is flipped to make it pass (SPEC-12.9 4).

import type { Polygon } from '../geometry-kit/plan.ts';
import {
  prismSolid,
  regionPrismSolid,
  sectionArea,
  solidIntersect,
  solidSubtract,
  solidUnionAll,
  weldSolid,
  type Solid,
  type SolidMesh,
} from '../geometry-kit/solid.ts';
import {
  ARC_SIDES,
  cutterSolid,
  cutSlab,
  solidCutters,
  sunCutPieces,
  sunSlopeSolid,
  sunWallSolid,
  type Cutter,
  type PlanRegion,
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
  // 돌출 외피 = the 2D 가능 영역 (대지 − 2D 절삭, the same cut as `buildableArea`) extruded to H,
  // built as a prism with holes. The cut is done once on a 1 m slab; subtracting the cutters from
  // the full-height box instead left open and non-manifold edges on a real lot of 38 short road
  // segments (T-214 F-6) while the slab was fine.
  const slabWalls = input.sun ? sunWallSolid(input.sun, -1, 2, sides) : [];
  let memo: PlanRegion[] | null = null;
  const regions = (): PlanRegion[] => (memo ??= cutRegions());
  const cutRegions = (): PlanRegion[] => {
    const cuts = [
      ...solidCutters(input.cutters).map(({ cutter }) => cutterSolid(cutter, -1, 2, sides)),
      ...(slabWalls.length ? [slabWalls] : []),
    ];
    const left = cuts.length
      ? cutSlab(prismSolid(input.site, 0, 1), cuts, 1).regions
      : [{ outer: input.site, holes: [] }];
    if (!left.length) throw new Error('건축 가능 영역 없음');
    return left;
  };
  const walls = input.sun ? sunWallSolid(input.sun, -1, top, sides) : [];
  const slopes = input.sun ? sunSlopeSolid(input.sun, top, sides) : [];
  const sunAll = solidUnionAll([walls, slopes]);
  const out: Envelope[] = [];
  /**
   * The first construction whose mesh passes the check (pushed to `out`, with the solid it came
   * from); else `점검 실패` with the first failure's reasons.
   */
  const checked = (kind: EnvelopeKind, ...tries: (() => Solid)[]): Solid => {
    let first: string | null = null;
    for (const make of tries) {
      try {
        const solid = make();
        const mesh = weldSolid(solid);
        const check = envelopeCheck(mesh);
        if (check.ok) {
          out.push({ kind, mesh, check, faces: bakeFaces(mesh, check) });
          return solid;
        }
        first ??= check.reasons.join(', ');
      } catch (error) {
        first ??= error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`점검 실패: ${ENVELOPE_TITLES[kind]} — ${first}`);
  };
  // The former construction (대지 기둥 − 2D 절삭 at full height), kept as a further try.
  let former: Solid | null = null;
  const formerExtrude = () =>
    (former ??= solidSubtract(
      box,
      solidUnionAll([
        ...solidCutters(input.cutters).map(({ cutter }) => cutterSolid(cutter, -1, top, sides)),
        walls,
      ]),
    ));
  const extrude = checked(
    'extrude',
    () => regions().flatMap((r) => regionPrismSolid(r.outer, r.holes, 0, H)),
    () => regions().flatMap((r) => regionPrismSolid(r.outer, r.holes, 0, H, true)),
    formerExtrude,
  );
  if (input.sun) {
    // The same cut in other orders when a boolean does not close (near-straight datum runs).
    const pieces = sunCutPieces(input.sun, top, sides);
    const reversed = () => solidUnionAll([...pieces].reverse());
    const oneByOne = (from: Solid) => pieces.reduce((acc, p) => solidSubtract(acc, p), from);
    const sunSolid = checked(
      'sun',
      () => solidSubtract(box, sunAll),
      () => solidSubtract(box, reversed()),
      () => oneByOne(box),
    );
    // 최대 = 돌출 − 일조 (the same set as 돌출 ∩ 일조 사선 외피).
    checked(
      'max',
      () => solidSubtract(extrude, sunAll),
      () => solidIntersect(extrude, sunSolid),
      () => solidSubtract(extrude, reversed()),
      () => oneByOne(extrude),
      () => solidSubtract(formerExtrude(), sunAll),
    );
  } else out.push({ ...out[0], kind: 'max' });
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

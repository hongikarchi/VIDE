// 검사하는 건물 형상 (SPEC-15.7 1, SPEC-15.6 3): `mass` and `rooftop` solids; when the model has no
// mass-role object at all, the floor outlines as prisms from each floor to the next (the top floor
// takes the massing plan's 기준층 층고, '가정'). A solid that fails the closed check is never used in
// a boolean and is reported as 형상 연산 실패.

import type { ClassifiedObject, ComplianceRoleName } from '../../../contracts/compliance.ts';
import { regionSolid } from '../massing-kit/floors.ts';
import type { Ctx } from './context.ts';
import { boxOf, polysVolume, type PreparedSolid } from './geometry.ts';
import { LEVEL_TOL } from './geometry.ts';
import { levelsOf } from './ground.ts';

export interface BuildingPart {
  objectId: string;
  role: ComplianceRoleName;
  solid: PreparedSolid;
}

export interface Building {
  parts: BuildingPart[];
  /** Objects whose solid failed the closed check. */
  failed: string[];
  /** Made from floor outlines (SPEC-15.7 1). */
  fromFloors: boolean;
  notes: string[];
}

/** Prisms of floor outlines: each floor up to the next level, the top one by `topHeight`. */
function floorPrisms(
  floors: readonly ClassifiedObject[],
  topHeight: number | null,
): { parts: BuildingPart[]; notes: string[] } {
  const regions = floors.filter((o) => o.shape.kind === 'region');
  const levels = levelsOf(regions.map((o) => (o.shape.kind === 'region' ? o.shape.z : 0)));
  const parts: BuildingPart[] = [];
  const notes: string[] = [];
  for (const o of regions) {
    if (o.shape.kind !== 'region') continue;
    const z = o.shape.z;
    const next = levels.find((l) => l > z + LEVEL_TOL);
    const top = next ?? (topHeight !== null ? z + topHeight : null);
    if (top === null) {
      notes.push('맨 위층 층고 없음 — 맨 위층 윤곽은 형상에 넣지 않음');
      continue;
    }
    if (next === undefined) notes.push('맨 위층 높이는 매스 작업본의 기준층 층고(가정)');
    try {
      const solid = regionSolid(o.shape.region, z, top);
      parts.push({
        objectId: o.objectId,
        role: 'floor',
        solid: { solid, ok: true, reasons: [], volume: polysVolume(solid), box: boxOf(solid) },
      });
    } catch {
      notes.push(`층 윤곽 ${o.objectId}로 형상을 만들 수 없음`);
    }
  }
  return { parts, notes };
}

function collect(ctx: Ctx, objs: readonly ClassifiedObject[]) {
  const parts: BuildingPart[] = [];
  const failed: string[] = [];
  for (const o of objs) {
    const s = ctx.solids.get(o.objectId);
    if (!s) continue;
    if (!s.ok) failed.push(o.objectId);
    else parts.push({ objectId: o.objectId, role: o.role, solid: s });
  }
  return { parts, failed };
}

/** The building the shape rows test: mass + rooftop, or floor prisms without any mass role. */
export function shapeBuilding(ctx: Ctx): Building {
  if (ctx.hasRole('mass')) {
    const { parts, failed } = collect(ctx, [...ctx.objs('mass'), ...ctx.objs('rooftop')]);
    return { parts, failed, fromFloors: false, notes: [] };
  }
  const floors = ctx.objs('floor');
  const solids = collect(
    ctx,
    floors.filter((o) => o.shape.kind === 'solid'),
  );
  const prisms = floorPrisms(floors, ctx.limits?.plan.floorHeightTypical ?? null);
  const roof = collect(ctx, ctx.objs('rooftop'));
  const parts = [...solids.parts, ...prisms.parts, ...roof.parts];
  return {
    parts,
    failed: [...solids.failed, ...roof.failed],
    fromFloors: solids.parts.length + prisms.parts.length > 0,
    notes:
      solids.parts.length + prisms.parts.length > 0
        ? ['층 윤곽으로 만든 형상', ...prisms.notes]
        : [],
  };
}

/**
 * The building the height row measures (SPEC-15.6 3): `mass` and `floor` solids; without any, the
 * floor outline prisms. `rooftop` parts are separate (the 옥탑 axis).
 */
export function heightBuilding(ctx: Ctx): Building & { rooftops: BuildingPart[] } {
  const main = collect(ctx, [
    ...ctx.objs('mass'),
    ...ctx.objs('floor').filter((o) => o.shape.kind === 'solid'),
  ]);
  const roof = collect(ctx, ctx.objs('rooftop'));
  if (main.parts.length || main.failed.length)
    return {
      ...main,
      failed: [...main.failed, ...roof.failed],
      fromFloors: false,
      notes: [],
      rooftops: roof.parts,
    };
  const prisms = floorPrisms(ctx.objs('floor'), ctx.limits?.plan.floorHeightTypical ?? null);
  return {
    parts: prisms.parts,
    failed: roof.failed,
    fromFloors: prisms.parts.length > 0,
    notes: prisms.parts.length ? ['가정 층고로 만든 높이', ...prisms.notes] : [],
    rooftops: roof.parts,
  };
}

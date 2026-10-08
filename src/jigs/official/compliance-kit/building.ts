// 검사하는 건물 형상 (SPEC-15.7 1, SPEC-15.6 3): `mass` and `rooftop` solids, plus the above-ground
// floor outlines no mass covers, each as a prism from its floor to the next (the top floor takes the
// massing plan's 기준층 층고, '가정') less the masses; when the model has no mass-role object at all,
// every above-ground floor outline as such a prism. A mass that covers only the basement or the
// podium therefore never hides the floors drawn above it. A solid that fails the closed check is
// never used in a boolean and is reported as 형상 연산 실패.

import type { ClassifiedObject, ComplianceRoleName } from '../../../contracts/compliance.ts';
import { regionSolid } from '../massing-kit/floors.ts';
import type { Ctx } from './context.ts';
import { booleanPiece, boxOf, polysVolume, type PreparedSolid } from './geometry.ts';
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

/** True when a floor outline lies below every 기준 지반 case (a basement floor: not tested). */
function belowGround(ctx: Ctx, o: ClassifiedObject, top: number) {
  if (o.floor) return o.floor.startsWith('B');
  if (!ctx.grounds.length) return false;
  const lowest = Math.min(...ctx.grounds.map((g) => g.local));
  return top <= lowest + LEVEL_TOL;
}

/**
 * Prisms of the above-ground floor outlines: each floor up to the next level, the top one by
 * `topHeight`. With `masses`, each prism less the masses, kept only where something is left (an
 * outline the masses do not cover); `added` counts those.
 */
function floorPrisms(
  ctx: Ctx,
  floors: readonly ClassifiedObject[],
  topHeight: number | null,
  masses: readonly BuildingPart[] = [],
): { parts: BuildingPart[]; notes: string[]; added: number } {
  const regions = floors.filter((o) => o.shape.kind === 'region');
  const levels = levelsOf(regions.map((o) => (o.shape.kind === 'region' ? o.shape.z : 0)));
  const parts: BuildingPart[] = [];
  const notes: string[] = [];
  let added = 0;
  for (const o of regions) {
    if (o.shape.kind !== 'region') continue;
    const z = o.shape.z;
    const next = levels.find((l) => l > z + LEVEL_TOL);
    let top = next ?? (topHeight !== null ? z + topHeight : null);
    // The top floor's height is an assumption (기준층 층고): where a mass stands on that floor's
    // outline, the floor ends where the mass does — the assumption never adds height to a mass.
    if (next === undefined && top !== null && masses.length) {
      const xs = o.shape.region.outer.map((p) => p[0]),
        ys = o.shape.region.outer.map((p) => p[1]);
      const on = masses.filter(
        (m) =>
          m.solid.box.min[2] <= z + LEVEL_TOL &&
          m.solid.box.max[2] > z + LEVEL_TOL &&
          m.solid.box.min[0] < Math.max(...xs) &&
          Math.min(...xs) < m.solid.box.max[0] &&
          m.solid.box.min[1] < Math.max(...ys) &&
          Math.min(...ys) < m.solid.box.max[1],
      );
      if (on.length) top = Math.min(top, Math.max(...on.map((m) => m.solid.box.max[2])));
    }
    if (top !== null && belowGround(ctx, o, top)) continue;
    if (top === null) {
      notes.push('맨 위층 층고 없음 — 맨 위층 윤곽은 형상에 넣지 않음');
      continue;
    }
    let solid;
    try {
      solid = regionSolid(o.shape.region, z, top);
    } catch {
      notes.push(`층 윤곽 ${o.objectId}로 형상을 만들 수 없음`);
      continue;
    }
    let volume = polysVolume(solid);
    if (masses.length) {
      const box = boxOf(solid);
      const near = masses.filter(
        (m) =>
          m.solid.box.min[0] <= box.max[0] &&
          box.min[0] <= m.solid.box.max[0] &&
          m.solid.box.min[1] <= box.max[1] &&
          box.min[1] <= m.solid.box.max[1] &&
          m.solid.box.min[2] <= box.max[2] &&
          box.min[2] <= m.solid.box.max[2],
      );
      let left: typeof solid | null = solid;
      for (const m of near) {
        if (!left) break;
        const piece = booleanPiece(left, m.solid.solid, 'subtract', volume);
        if (piece === 'failed') {
          notes.push('층 윤곽 프리즘에서 매스를 뺄 수 없음 — 초과 부피가 겹쳐 셀 수 있음');
          break;
        }
        left = piece ? piece.solid : null;
        volume = piece ? piece.volume : 0;
      }
      if (!left) continue; // the masses cover this floor
      solid = left;
      added++;
    }
    if (next === undefined) notes.push('맨 위층 높이는 매스 작업본의 기준층 층고(가정)');
    parts.push({
      objectId: o.objectId,
      role: 'floor',
      solid: { solid, ok: true, reasons: [], volume, box: boxOf(solid) },
    });
  }
  if (added) notes.unshift(`매스가 덮지 않은 지상 층 윤곽 ${added}개를 층 윤곽 프리즘으로 더함`);
  return { parts, notes, added };
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

/**
 * The building the shape rows test: mass + rooftop and the above-ground floor outlines the masses
 * leave uncovered, or floor prisms without any mass role.
 */
export function shapeBuilding(ctx: Ctx): Building {
  const topHeight = ctx.limits?.plan.floorHeightTypical ?? null;
  if (ctx.hasRole('mass')) {
    const { parts, failed } = collect(ctx, [...ctx.objs('mass'), ...ctx.objs('rooftop')]);
    if (!parts.length || failed.length) return { parts, failed, fromFloors: false, notes: [] };
    const extra = floorPrisms(ctx, ctx.objs('floor'), topHeight, parts);
    return {
      parts: [...parts, ...extra.parts],
      failed,
      fromFloors: false,
      notes: extra.added ? ['층 윤곽으로 만든 형상', ...extra.notes] : [],
    };
  }
  const floors = ctx.objs('floor');
  const solids = collect(
    ctx,
    floors.filter((o) => o.shape.kind === 'solid'),
  );
  const prisms = floorPrisms(ctx, floors, topHeight, solids.parts);
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
 * The building the height row measures (SPEC-15.6 3): `mass` and `floor` solids with the
 * above-ground floor outlines they leave uncovered; without any, the floor outline prisms.
 * `rooftop` parts are separate (the 옥탑 axis).
 */
export function heightBuilding(ctx: Ctx): Building & { rooftops: BuildingPart[] } {
  const topHeight = ctx.limits?.plan.floorHeightTypical ?? null;
  const main = collect(ctx, [
    ...ctx.objs('mass'),
    ...ctx.objs('floor').filter((o) => o.shape.kind === 'solid'),
  ]);
  const roof = collect(ctx, ctx.objs('rooftop'));
  if (main.parts.length || main.failed.length) {
    const extra = main.failed.length
      ? { parts: [], notes: [], added: 0 }
      : floorPrisms(ctx, ctx.objs('floor'), topHeight, main.parts);
    return {
      parts: [...main.parts, ...extra.parts],
      failed: [...main.failed, ...roof.failed],
      fromFloors: false,
      notes: extra.added ? ['가정 층고로 만든 높이', ...extra.notes] : [],
      rooftops: roof.parts,
    };
  }
  const prisms = floorPrisms(ctx, ctx.objs('floor'), topHeight);
  return {
    parts: prisms.parts,
    failed: roof.failed,
    fromFloors: prisms.parts.length > 0,
    notes: prisms.parts.length ? ['가정 층고로 만든 높이', ...prisms.notes] : [],
    rooftops: roof.parts,
  };
}

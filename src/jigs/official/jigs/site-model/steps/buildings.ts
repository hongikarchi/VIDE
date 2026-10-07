// ⑦ 건물 매스 (SPEC-12.5): each outline raised by its height into a closed mass. The height is the
// recorded one — 건물 정보 (VWorld), else 건축물대장 표제부 — and otherwise floors × '추정 층고'
// (default 3.3 m), whose source stays '추정' in the table and on the Rhino object. Wall-less
// buildings (무벽건물), outlines without floors or height and degenerate outlines are not made into
// masses but listed with the reason. With terrain on, a mass stands on the lowest ground under its
// outline.

import { areaOfAreas, inRing, moveArea, round, type XY } from './common.ts';
import type { CollectOutput } from './collect.ts';
import type { FrameOutput } from './frame.ts';
import { heightAt, type TerrainOutput } from './terrain.ts';

export interface Mass {
  key: string;
  name: string;
  polygon: XY[];
  /** Outer ring then holes, at the ground height (bake `rings`). */
  rings: [number, number, number][][];
  ground: number;
  height: number;
  floors: number | null;
  floorsText: string;
  heightText: string;
  heightSource: '건물 정보' | '대장' | '추정';
  use: string | null;
  onSite: boolean;
  footprint_m2: number;
  source: string;
  fetchedAt: string | null;
}
export interface BuildingsOutput {
  buildings: Mass[];
  unmade: { key: string; name: string; reason: string }[];
  count: number;
  estimated: number;
  maxHeight_m: number;
  storyHeight: number;
}

export function buildings(
  inputs: { steps: { collect: CollectOutput; frame: FrameOutput; terrain: TerrainOutput } },
  params: { storyHeight?: number },
): BuildingsOutput {
  const { collect, frame, terrain } = inputs.steps;
  const story = Number(params.storyHeight ?? 3.3);
  const masses: Mass[] = [];
  const unmade: BuildingsOutput['unmade'] = [];
  for (const b of collect.buildings) {
    const name = b.name ?? `이름 없는 건물 (${b.id})`;
    const areas = b.areas.map((a) => moveArea(a, frame.offset));
    const footprint = areaOfAreas(areas);
    if (b.wallless) {
      unmade.push({ key: b.key, name, reason: '무벽건물 — 매스·면적에서 뺌' });
      continue;
    }
    if (!areas.length || footprint < 0.5) {
      unmade.push({ key: b.key, name, reason: '퇴화한 윤곽' });
      continue;
    }
    let height: number;
    let source: Mass['heightSource'];
    if (b.height !== null && b.height > 0 && b.heightFrom) {
      height = b.height;
      source = b.heightFrom;
    } else if (b.floors !== null && b.floors > 0) {
      height = round(b.floors * story, 3);
      source = '추정';
    } else {
      unmade.push({ key: b.key, name, reason: '층수·높이 자료 없음' });
      continue;
    }
    // The largest polygon of the outline (a building is one mass).
    const area = [...areas].sort((x, y) => areaOfAreas([y]) - areaOfAreas([x]))[0];
    const ground = terrain.included
      ? Math.min(
          ...area.outer
            .map(([x, y]) => heightAt(terrain.triangles, x, y))
            .filter((z): z is number => z !== null),
          Infinity,
        )
      : 0;
    const z = Number.isFinite(ground) ? round(ground, 3) : 0;
    const centre = area.outer.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
    const c: XY = [centre[0] / area.outer.length, centre[1] / area.outer.length];
    masses.push({
      key: b.key,
      name,
      polygon: area.outer,
      rings: [area.outer, ...area.holes].map((r) => r.map(([x, y]) => [x, y, z])),
      ground: z,
      height,
      floors: b.floors,
      floorsText: b.floors !== null ? String(b.floors) : '',
      heightText: height.toFixed(2),
      heightSource: source,
      use: b.use,
      onSite: frame.site.rings.some((ring) => inRing(c, ring)),
      footprint_m2: round(areaOfAreas([area]), 2),
      source: b.source,
      fetchedAt: b.fetchedAt,
    });
  }
  return {
    buildings: masses,
    unmade,
    count: masses.length,
    estimated: masses.filter((m) => m.heightSource === '추정').length,
    maxHeight_m: masses.length ? Math.max(...masses.map((m) => m.height)) : 0,
    storyHeight: story,
  };
}

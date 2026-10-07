// 건물 정보 `LT_C_BLDGINFO` by box (2026-10-08 실호출): its own outline with `height`, 지상/지하
// 층수 (`grnd_flr`, `ugrnd_flr`), 용도 `usability`, 건폐율·용적률. It has no PNU, so it is joined to
// the `LT_C_SPBD` outlines by position. Height priority 1; 0 means "not recorded".

import { positive, textOf, type SiteDataContext } from '../http.ts';
import {
  interiorPoint,
  pointInPolygons,
  polygonsOf,
  type Bounds,
  type Polygons,
} from '../geometry.ts';
import type { Recorder } from '../snapshot.ts';
import type { Building } from './vworld-buildings.ts';
import { convertFeatures, readBox, readChecks, type Feature } from './vworld-data.ts';

export const BUILDING_INFO_LAYER = 'LT_C_BLDGINFO';

export interface BuildingInfo {
  id: string;
  height: number | null;
  floorsAbove: number | null;
  floorsBelow: number | null;
  use: string | null;
  name: string | null;
  dongName: string | null;
  polygons: Polygons;
}

export function buildingInfoOf(feature: Feature): BuildingInfo | null {
  const polygons = polygonsOf(feature.geometry);
  if (!polygons) return null;
  return {
    id: feature.id,
    height: positive(feature.properties.height),
    floorsAbove: positive(feature.properties.grnd_flr),
    floorsBelow: positive(feature.properties.ugrnd_flr),
    use: textOf(feature.properties.usability),
    name: textOf(feature.properties.bld_nm),
    dongName: textOf(feature.properties.dong_nm),
    polygons,
  };
}

export async function buildingInfoInBox(context: SiteDataContext, recorder: Recorder, box: Bounds) {
  const read = await readBox(context, 'vworld-building-info', recorder, BUILDING_INFO_LAYER, box, {
    geometry: true,
  });
  const { items, malformed } = convertFeatures(read.features, buildingInfoOf);
  const checks = readChecks(read, '건물 정보');
  if (malformed) checks.push(`건물 정보: 형식이 다른 ${malformed}건은 쓰지 않음`);
  return { info: items, checks };
}

/**
 * Height priority 1: a building-info outline whose inner point lies in the building's outline
 * and that records a height. Several matches (one building drawn in parts) → the tallest.
 */
export function joinBuildingInfo(buildings: Building[], info: BuildingInfo[]) {
  const points = info
    .filter((entry) => entry.height !== null)
    .map((entry) => ({ entry, point: interiorPoint(entry.polygons) }));
  for (const building of buildings) {
    const matches = points.filter(({ point }) => pointInPolygons(point, building.polygons));
    if (!matches.length) continue;
    const best = matches.reduce((a, b) => ((b.entry.height ?? 0) > (a.entry.height ?? 0) ? b : a));
    building.height = best.entry.height;
    building.heightSource = 'vworld-building-info';
    building.floorsBelow ??= best.entry.floorsBelow;
    building.mainUse ??= best.entry.use;
  }
}

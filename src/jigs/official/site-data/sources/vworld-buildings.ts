// Surrounding buildings by box (SPIKE §4, 2026-10-08):
// - `LT_C_SPBD` (도로명주소 건물): outline, 지상 층수 `gro_flo_co`, names, `bd_mgt_sn` (생성 당시
//   PNU 19자리 + 연번). No height.
// Heights come from `vworld-building-info` (priority 1) or `building-register` (priority 2).

import { numberOf, textOf, type SiteDataContext } from '../http.ts';
import { polygonsOf, type Bounds, type Polygons } from '../geometry.ts';
import { isPnu } from '../pnu.ts';
import type { Recorder } from '../snapshot.ts';
import { convertFeatures, readBox, readChecks, type Feature } from './vworld-data.ts';

export const BUILDINGS_LAYER = 'LT_C_SPBD';

export type HeightSource = 'vworld-building-info' | 'building-register';

export interface Building {
  /** 건물관리번호 (bd_mgt_sn) or the feature id. */
  id: string;
  /** The PNU in the 건물관리번호 (as of the building's registration; may be stale). */
  pnu: string | null;
  name: string | null;
  dongName: string | null;
  floorsAbove: number | null;
  floorsBelow: number | null;
  /** Recorded height (m); null → the jig estimates from floors and marks it '추정'. */
  height: number | null;
  heightSource: HeightSource | null;
  mainUse: string | null;
  polygons: Polygons;
}

export function buildingOf(feature: Feature): Building | null {
  const polygons = polygonsOf(feature.geometry);
  if (!polygons) return null;
  const managed = textOf(feature.properties.bd_mgt_sn);
  const pnu = managed?.slice(0, 19) ?? null;
  return {
    id: managed ?? feature.id,
    pnu: pnu && isPnu(pnu) ? pnu : null,
    name: textOf(feature.properties.buld_nm),
    dongName: textOf(feature.properties.buld_nm_dc),
    floorsAbove: numberOf(feature.properties.gro_flo_co),
    floorsBelow: null,
    height: null,
    heightSource: null,
    mainUse: null,
    polygons,
  };
}

export async function buildingsInBox(context: SiteDataContext, recorder: Recorder, box: Bounds) {
  const read = await readBox(context, 'vworld-buildings', recorder, BUILDINGS_LAYER, box, {
    geometry: true,
    keyOf: (feature) => textOf(feature.properties.bd_mgt_sn) ?? feature.id,
  });
  const { items, malformed } = convertFeatures(read.features, buildingOf);
  const checks = readChecks(read, '주변 건물');
  if (malformed) checks.push(`주변 건물: 형식이 다른 ${malformed}건은 쓰지 않음`);
  return { buildings: items, checks };
}

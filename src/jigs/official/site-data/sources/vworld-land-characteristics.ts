// 토지특성 (`ned/data/getLandCharacteristics`, PNU): 공부 면적 `lndpclAr`, 지목, 용도지역 1·2,
// 공시지가 기준연도. This year's rows may not exist yet, so last year is read when this year is
// empty (S-04 fetch_site.js). Several rows of one year are revisions of the same parcel.

import { numberOf, positive, textOf, type SiteDataContext } from '../http.ts';
import type { Recorder } from '../snapshot.ts';
import { readNed } from './vworld-ned.ts';

export const LAND_CHARACTERISTICS = 'https://api.vworld.kr/ned/data/getLandCharacteristics';
const SOURCE = 'vworld-land-characteristics' as const;

export interface LandCharacteristics {
  pnu: string;
  /** 공부 면적 m². */
  officialArea: number | null;
  landCategory: string | null;
  zoning: string[];
  roadSide: string | null;
  terrainHeight: string | null;
  terrainShape: string | null;
  year: number | null;
}

export function landCharacteristicsOf(
  row: Record<string, unknown>,
  pnu: string,
): LandCharacteristics {
  return {
    pnu,
    officialArea: positive(row.lndpclAr),
    landCategory: textOf(row.lndcgrCodeNm),
    zoning: [row.prposArea1Nm, row.prposArea2Nm]
      .map(textOf)
      .filter((name): name is string => !!name && name !== '지정되지않음'),
    roadSide: textOf(row.roadSideCodeNm),
    terrainHeight: textOf(row.tpgrphHgCodeNm),
    terrainShape: textOf(row.tpgrphFrmCodeNm),
    year: numberOf(row.stdrYear),
  };
}

/** The newest row for `pnu` this year or last year; null when neither year has one. */
export async function landCharacteristics(
  context: SiteDataContext,
  recorder: Recorder,
  pnu: string,
  year: number,
) {
  for (const stdrYear of [year, year - 1]) {
    const { rows } = await readNed(
      context,
      SOURCE,
      recorder,
      LAND_CHARACTERISTICS,
      'landCharacteristicss',
      {
        pnu,
        stdrYear: String(stdrYear),
      },
    );
    const own = rows
      .filter((row) => textOf(row.pnu) === pnu)
      .sort((a, b) => String(b.lastUpdtDt ?? '').localeCompare(String(a.lastUpdtDt ?? '')));
    if (own.length) return landCharacteristicsOf(own[0], pnu);
  }
  return null;
}

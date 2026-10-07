// 연속지적 `LP_PA_CBND_BUBUN` (SPIKE §2): target parcels by PNU (`attrFilter=pnu:=:…`) and the
// surrounding parcels by box (tiled, paged). Properties: pnu, jibun ("31대" — the last Hangul is
// 지목), addr, bonbun, bubun, gosi_year/month, jiga. There is no area field.

import { SiteDataError, textOf, type SiteDataContext } from '../http.ts';
import { areaOf, polygonsOf, type Bounds, type Polygons } from '../geometry.ts';
import { isPnu } from '../pnu.ts';
import type { Recorder } from '../snapshot.ts';
import { readBox, readLayer, readChecks, type Feature, type PageRead } from './vworld-data.ts';

export const CADASTRAL_LAYER = 'LP_PA_CBND_BUBUN';
const SOURCE = 'vworld-cadastral' as const;

export interface Parcel {
  pnu: string;
  address: string | null;
  /** 지목 (대, 도, 공, …) from the end of `jibun`. */
  landCategory: string | null;
  lot: string | null;
  polygons: Polygons;
  /** Plane area of the polygons (계산 면적, not 공부 면적). */
  computedArea: number;
  featureId: string;
}

/** A feature as a parcel, or null when its PNU or geometry does not hold. */
export function parcelOf(feature: Feature): Parcel | null {
  const pnu = textOf(feature.properties.pnu);
  const polygons = polygonsOf(feature.geometry);
  if (!pnu || !isPnu(pnu) || !polygons) return null;
  const jibun = textOf(feature.properties.jibun);
  return {
    pnu,
    address: textOf(feature.properties.addr),
    landCategory: jibun ? (/([가-힣]+)$/.exec(jibun)?.[1] ?? null) : null,
    lot: jibun ? jibun.replace(/[가-힣]+$/, '').trim() || null : null,
    polygons,
    computedArea: areaOf(polygons),
    featureId: feature.id,
  };
}

function parcelsOf(read: PageRead) {
  const parcels: Parcel[] = [];
  let malformed = 0;
  for (const feature of read.features) {
    const parcel = parcelOf(feature);
    if (parcel) parcels.push(parcel);
    else malformed++;
  }
  return { parcels, malformed };
}

/** The parcel of one PNU (null when the cadastre has none). */
export async function parcelByPnu(context: SiteDataContext, recorder: Recorder, pnu: string) {
  if (!isPnu(pnu)) throw new SiteDataError('BAD_RESPONSE', SOURCE, 'pnu');
  const read = await readLayer(
    context,
    SOURCE,
    recorder,
    CADASTRAL_LAYER,
    { attr: `pnu:=:${pnu}` },
    {
      geometry: true,
      size: 10,
      maxPages: 1,
    },
  );
  const { parcels, malformed } = parcelsOf(read);
  if (malformed && !parcels.length) throw new SiteDataError('BAD_RESPONSE', SOURCE, 'geometry');
  return parcels.find((parcel) => parcel.pnu === pnu) ?? null;
}

/** Every parcel touching `box`, each once (by PNU), with '확인 필요' lines. */
export async function parcelsInBox(context: SiteDataContext, recorder: Recorder, box: Bounds) {
  const read = await readBox(context, SOURCE, recorder, CADASTRAL_LAYER, box, {
    geometry: true,
    keyOf: (feature) => textOf(feature.properties.pnu) ?? feature.id,
  });
  const { parcels, malformed } = parcelsOf(read);
  const checks = readChecks(read, '주변 필지');
  if (malformed) checks.push(`주변 필지: 형식이 다른 ${malformed}건은 쓰지 않음`);
  return { parcels, checks };
}

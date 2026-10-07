// 용도지역·지구·구역 (SPIKE §3): two sources merged per parcel.
// - `ned/data/getLandUseAttr` (PNU): the complete list with 저촉 여부 (1 포함 · 2 저촉 · 3 접함), no
//   고시 번호.
// - 2D layers by a point inside the parcel: `LT_C_UQ*`·`UD801` give `uname` and 고시 연도·번호
//   (`dyear`, `dnum`); `LT_C_UPISUQ161` gives the 지구단위계획구역 (name, area, 결정·고시 일련번호).
// A point sees one place only; the share of a parcel split by two zones is a later calculation.

import { positive, textOf, type SiteDataContext } from '../http.ts';
import { interiorPoint, type Polygons, type Position } from '../geometry.ts';
import type { Recorder } from '../snapshot.ts';
import { readLayer } from './vworld-data.ts';
import { readNed } from './vworld-ned.ts';

export const LAND_USE_ATTR = 'https://api.vworld.kr/ned/data/getLandUseAttr';
const SOURCE = 'vworld-land-use' as const;

/** Zoning layers read at the parcel's inner point, with what they hold. */
export const ZONING_LAYERS: [layer: string, kind: string][] = [
  ['LT_C_UQ111', '용도지역(도시)'],
  ['LT_C_UQ112', '용도지역(관리)'],
  ['LT_C_UQ113', '용도지역(농림)'],
  ['LT_C_UQ114', '용도지역(자연환경보전)'],
  ['LT_C_UQ121', '경관지구'],
  ['LT_C_UQ123', '고도지구'],
  ['LT_C_UQ124', '방화지구'],
  ['LT_C_UQ125', '방재지구'],
  ['LT_C_UQ126', '보호지구'],
  ['LT_C_UQ128', '취락지구'],
  ['LT_C_UQ129', '개발진흥지구'],
  ['LT_C_UQ130', '특정용도제한지구'],
  ['LT_C_UQ141', '지구단위계획구역 등'],
  ['LT_C_UQ162', '도시자연공원구역'],
  ['LT_C_UD801', '개발제한구역'],
];
export const DISTRICT_PLAN_LAYER = 'LT_C_UPISUQ161';

export type Conflict = '포함' | '저촉' | '접함';
const CONFLICT: Record<string, Conflict> = { '1': '포함', '2': '저촉', '3': '접함' };

export interface Notice {
  year: string;
  number: string;
  layer: string;
}

export interface LandUseEntry {
  name: string;
  code: string | null;
  conflict: Conflict | null;
  /** 고시 연도·번호 from the layers (several when the area was decided more than once). */
  notices: Notice[];
  /** Layer kinds that also hold this name. */
  kinds: string[];
  from: ('attr' | 'layer')[];
  registeredAt: string | null;
}

export interface DistrictPlan {
  name: string;
  area: number | null;
  decisionId: string | null;
  noticeId: string | null;
}

export interface LandUse {
  pnu: string;
  /** The point the layers were read at (EPSG:5186). */
  point: Position;
  entries: LandUseEntry[];
  districtPlans: DistrictPlan[];
}

const normal = (name: string) => name.replace(/\s+/g, '');

export function conflictOf(row: Record<string, unknown>): Conflict | null {
  const named = textOf(row.cnflcAtNm);
  if (named === '포함' || named === '저촉' || named === '접함') return named;
  return CONFLICT[textOf(row.cnflcAt) ?? ''] ?? null;
}

/** The merged list of one parcel. */
export function mergeLandUse(
  attrs: Record<string, unknown>[],
  layered: { layer: string; kind: string; properties: Record<string, unknown> }[],
) {
  const entries = new Map<string, LandUseEntry>();
  for (const row of attrs) {
    const name = textOf(row.prposAreaDstrcCodeNm);
    if (!name) continue;
    const key = normal(name);
    if (entries.has(key)) continue;
    entries.set(key, {
      name,
      code: textOf(row.prposAreaDstrcCode),
      conflict: conflictOf(row),
      notices: [],
      kinds: [],
      from: ['attr'],
      registeredAt: textOf(row.registDt),
    });
  }
  for (const { layer, kind, properties } of layered) {
    const name = textOf(properties.uname);
    if (!name) continue;
    const key = normal(name);
    const entry =
      entries.get(key) ??
      ({
        name,
        code: null,
        conflict: null,
        notices: [],
        kinds: [],
        from: [],
        registeredAt: null,
      } satisfies LandUseEntry);
    entries.set(key, entry);
    if (!entry.from.includes('layer')) entry.from.push('layer');
    if (!entry.kinds.includes(kind)) entry.kinds.push(kind);
    const year = textOf(properties.dyear);
    const number = textOf(properties.dnum);
    if (
      year &&
      number &&
      year !== '0000' &&
      !entry.notices.some((notice) => notice.year === year && notice.number === number)
    )
      entry.notices.push({ year, number, layer });
  }
  return [...entries.values()];
}

export const districtPlanOf = (properties: Record<string, unknown>): DistrictPlan | null => {
  const name = textOf(properties.dgm_nm);
  return name
    ? {
        name,
        area: positive(properties.dgm_ar),
        decisionId: textOf(properties.wtnnc_sn),
        noticeId: textOf(properties.ntfc_sn),
      }
    : null;
};

/** Attributes by PNU plus every zoning layer at a point inside the parcel. */
export async function landUse(
  context: SiteDataContext,
  recorder: Recorder,
  pnu: string,
  polygons: Polygons,
): Promise<{ landUse: LandUse; total: number }> {
  const { rows, total } = await readNed(context, SOURCE, recorder, LAND_USE_ATTR, 'landUses', {
    pnu,
  });
  const point = interiorPoint(polygons);
  const layered: { layer: string; kind: string; properties: Record<string, unknown> }[] = [];
  for (const [layer, kind] of ZONING_LAYERS) {
    const read = await readLayer(
      context,
      SOURCE,
      recorder,
      layer,
      { point },
      {
        geometry: false,
        size: 100,
        maxPages: 1,
      },
    );
    for (const feature of read.features)
      layered.push({ layer, kind, properties: feature.properties });
  }
  const plans = await readLayer(
    context,
    SOURCE,
    recorder,
    DISTRICT_PLAN_LAYER,
    { point },
    {
      geometry: false,
      size: 100,
      maxPages: 1,
    },
  );
  const districtPlans = plans.features
    .map((feature) => districtPlanOf(feature.properties))
    .filter((plan): plan is DistrictPlan => !!plan);
  return {
    landUse: {
      pnu,
      point,
      entries: mergeLandUse(
        rows.filter((row) => textOf(row.pnu) === pnu || row.pnu === undefined),
        layered,
      ),
      districtPlans,
    },
    total,
  };
}

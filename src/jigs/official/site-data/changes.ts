// [다시 가져오기] (SPEC-12.4 '조회 사본을 고정한다'): what changed between the copy in use and a new
// one of the same target parcels — boundaries, 지목, 공부 면적, zoning, counts of parcels and
// buildings, building heights and each source's state. The person takes the new copy or keeps the
// old one; neither is overwritten.

import type { SiteCollection } from './collect.ts';

const shape = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));

const NAMES: Record<string, string> = {
  target: '대상 필지',
  landCharacteristics: '토지특성',
  landUse: '토지이용계획',
  parcels: '주변 필지',
  buildings: '주변 건물',
  buildingInfo: '건물 정보',
  register: '건축물대장',
};

export function collectionChanges(before: SiteCollection, after: SiteCollection): string[] {
  const out: string[] = [];
  for (const parcel of after.target.items) {
    const old = before.target.items.find((p) => p.pnu === parcel.pnu);
    if (!old) out.push(`대상 필지 ${parcel.pnu} 경계가 새로 생김`);
    else {
      if (shape(old.polygons) !== shape(parcel.polygons))
        out.push(`대상 필지 ${parcel.pnu} 경계가 바뀜`);
      if (old.landCategory !== parcel.landCategory)
        out.push(`지목 ${old.landCategory ?? '없음'} → ${parcel.landCategory ?? '없음'}`);
    }
  }
  for (const row of after.landCharacteristics.items) {
    const old = before.landCharacteristics.items.find((r) => r.pnu === row.pnu);
    if (old && old.officialArea !== row.officialArea)
      out.push(`공부 면적 ${old.officialArea ?? '없음'} → ${row.officialArea ?? '없음'} m²`);
  }
  const zones = (c: SiteCollection) =>
    [...new Set(c.landUse.items.flatMap((u) => u.entries.map((e) => e.name)))].sort().join(', ');
  if (zones(before) !== zones(after))
    out.push(`용도지역·지구 ${zones(before) || '없음'} → ${zones(after) || '없음'}`);
  if (before.parcels.items.length !== after.parcels.items.length)
    out.push(`주변 필지 ${before.parcels.items.length} → ${after.parcels.items.length}개`);
  if (before.buildings.items.length !== after.buildings.items.length)
    out.push(`주변 건물 ${before.buildings.items.length} → ${after.buildings.items.length}동`);
  const heights = after.buildings.items.filter((b) => {
    const old = before.buildings.items.find((o) => o.id === b.id);
    return old && old.height !== b.height;
  }).length;
  if (heights) out.push(`높이가 바뀐 건물 ${heights}동`);
  for (const key of Object.keys(NAMES) as (keyof typeof NAMES & keyof SiteCollection)[]) {
    const a = (before[key] as { status: string }).status;
    const b = (after[key] as { status: string }).status;
    if (a !== b) out.push(`${NAMES[key]} 상태 ${a} → ${b}`);
  }
  return out;
}

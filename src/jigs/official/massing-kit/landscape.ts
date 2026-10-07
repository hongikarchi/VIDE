// 조경·공지 면적 (SPEC-12.12 2, PLAN-45 T-212): 법정 면적 = 조경 면적 비율 × 대지면적 (the item's
// meaning as SPEC-12.12 2 states it; the ratio and whether it applies are 규제 조건 values), 계획
// 면적 = the areas a person drew. No ratio is held here; without the item the 법정 면적 is empty and
// '사람 입력 필요'.

import { signedArea, type Vec2 } from '../geometry-kit/plan.ts';
import { intersectRegions, regionsArea, unionArea } from './floors.ts';
import { itemOf, numberOf, type RegulationItem } from './rules.ts';
import type { PlanRegion } from './setback.ts';

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function landscapeAreas(
  items: readonly RegulationItem[],
  siteArea: number,
  site: Vec2[],
  drawn: { id: string; ring: Vec2[] }[],
) {
  const item = itemOf(items, 'landscapeRatio');
  const ratio = item.applies === '미적용' ? null : numberOf(item);
  const regions: PlanRegion[] = drawn.length
    ? intersectRegions(
        drawn.map((d) => ({
          outer: signedArea(d.ring) < 0 ? [...d.ring].reverse() : d.ring,
          holes: [],
        })),
        [{ outer: site, holes: [] }],
      )
    : [];
  const planned = drawn.length ? r6(unionArea([regions])) : 0;
  const legal = item.applies === '미적용' ? 0 : ratio === null ? null : r6(ratio * siteArea);
  return {
    ratio,
    legal,
    legalStatus:
      item.applies === '미적용'
        ? '미적용'
        : ratio === null
          ? `${item.title} ${item.applies === '판단 필요' ? '판단 필요' : '사람 입력 필요'}`
          : item.applies === '판단 필요'
            ? '계산(적용 여부 판단 필요)'
            : '계산',
    planned,
    regions,
    verdict:
      legal === null
        ? '미검토'
        : planned >= legal - 1e-6
          ? '충족'
          : drawn.length
            ? '부족'
            : '계획 영역 없음',
    regionsArea: r6(regionsArea(regions)),
  };
}

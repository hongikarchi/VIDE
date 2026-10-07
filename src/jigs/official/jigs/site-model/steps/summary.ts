// ⑧ 대지 요약 (SPEC-12.5): the site in one table with each value's basis (SPEC-12.14) and when it
// was read — addresses and PNUs, site area (공부 · 계산 · 차이, side by side, never merged), 지목,
// zoning, the roads it touches, true vs grid north, relief, surrounding buildings — and the one
// site-information point the bake leaves in Rhino (summary, CRS, base point, true north) for the
// conversation AI and the legal review to read. AI never edits these values.

import { BASIS, DISCLAIMER, round } from './common.ts';
import type { BuildingsOutput } from './buildings.ts';
import type { CollectOutput } from './collect.ts';
import type { FrameOutput } from './frame.ts';
import type { RoadsOutput } from './roads.ts';
import type { TerrainOutput } from './terrain.ts';

export interface SummaryRow {
  key: string;
  item: string;
  value: string;
  basis: string;
  source: string;
  at: string;
}
export interface SummaryOutput {
  disclaimer: string;
  pnus: string[];
  addresses: string[];
  officialArea_m2: number | null;
  computedArea_m2: number;
  areaGap_pct: number | null;
  landCategories: string;
  zones: string;
  roads: string;
  convergenceDeg: number;
  north: string;
  relief_m: number | null;
  buildings: number;
  maxHeight_m: number;
  estimated: number;
  checks: number;
  fetchedAt: string | null;
  rows: SummaryRow[];
  siteInfo: {
    key: string;
    text: string;
    point: [number, number, number];
    summary: string;
    crs: string;
    originSurvey: string;
    trueNorth: string;
  }[];
}

export function summary(inputs: {
  steps: {
    collect: CollectOutput;
    frame: FrameOutput;
    roads: RoadsOutput;
    buildings: BuildingsOutput;
    terrain: TerrainOutput;
  };
}): SummaryOutput {
  const { collect, frame, roads, buildings, terrain } = inputs.steps;
  const at = collect.fetchedAt ?? '';
  const targets = frame.targets;
  const pnus = targets.map((t) => t.pnu);
  const addresses = targets.map((t) => t.address ?? t.lot);
  const officials = targets.map((t) => t.officialArea);
  const official =
    officials.length && officials.every((a) => a !== null)
      ? round(
          officials.reduce((s, a) => s + (a ?? 0), 0),
          2,
        )
      : null;
  const computed = frame.site.area;
  const gap = official ? round(((computed - official) / official) * 100, 2) : null;
  const zones = collect.landUse
    .flatMap((u) => u.entries)
    .filter((e) => e.conflict !== '접함')
    .map(
      (e) =>
        `${e.name}${e.conflict && e.conflict !== '포함' ? `(${e.conflict})` : ''}${e.notices ? ` [고시 ${e.notices}]` : ''}`,
    );
  const zoneText = zones.length ? [...new Set(zones)].join(', ') : '용도지역 미확인';
  const north =
    frame.northBasis === 'true'
      ? `진북 기준 (도북과 ${Math.abs(frame.convergenceDeg).toFixed(3)}° 차이)`
      : `도북 기준 (진북과 ${Math.abs(frame.convergenceDeg).toFixed(3)}° 차이)`;
  const sourceOf = (key: string) =>
    collect.sources.find((s) => s.key === key)?.text ?? '가져오기 전';
  const rows: SummaryRow[] = [
    {
      key: 'address',
      item: '주소',
      value: addresses.join(', '),
      basis: BASIS.source,
      source: sourceOf('target'),
      at,
    },
    {
      key: 'pnu',
      item: 'PNU',
      value: pnus.join(', '),
      basis: BASIS.user,
      source: '대상 필지 확정',
      at: '',
    },
    {
      key: 'area-official',
      item: '대지면적(공부)',
      value: official !== null ? `${official.toFixed(2)} m²` : '공부 면적 없음',
      basis: BASIS.source,
      source: sourceOf('landCharacteristics'),
      at,
    },
    {
      key: 'area-computed',
      item: '대지면적(계산)',
      value: `${computed.toFixed(2)} m²${gap !== null ? ` (공부와 ${gap > 0 ? '+' : ''}${gap.toFixed(2)}%)` : ''}`,
      basis: BASIS.computed,
      source: '필지 경계 면적',
      at: '',
    },
    {
      key: 'jimok',
      item: '지목',
      value: targets.map((t) => `${t.lot} ${t.landCategory ?? '미확인'}`).join(', '),
      basis: BASIS.source,
      source: sourceOf('target'),
      at,
    },
    {
      key: 'zones',
      item: '용도지역·지구·구역',
      value: zoneText,
      basis: BASIS.source,
      source: sourceOf('landUse'),
      at,
    },
    {
      key: 'roads',
      item: '접한 도로',
      value: roads.text,
      basis: BASIS.computed,
      source: '지적 도로 필지와 대지 경계',
      at: '',
    },
    {
      key: 'north',
      item: '정북',
      value: north,
      basis: BASIS.computed,
      source: `${frame.crsLabel} 격자 수렴각`,
      at: '',
    },
    {
      key: 'origin',
      item: '기준점',
      value: `${frame.originText} (${frame.mode === 'site' ? '문서 원점' : '측량 좌표 그대로'})`,
      basis: BASIS.computed,
      source: frame.crs,
      at: '',
    },
    {
      key: 'relief',
      item: '대지 고저차',
      value: terrain.relief_m !== null ? `${terrain.relief_m.toFixed(2)} m` : terrain.note,
      basis: BASIS.computed,
      source: terrain.included ? '등고선·표고점 삼각망' : '—',
      at: '',
    },
    {
      key: 'buildings',
      item: '주변 건물',
      value: `${buildings.count}동, 최고 ${buildings.maxHeight_m.toFixed(1)} m${buildings.estimated ? ` (추정 높이 ${buildings.estimated}동)` : ''}${buildings.unmade.length ? ` · 만들지 않음 ${buildings.unmade.length}` : ''}`,
      basis: BASIS.source,
      source: sourceOf('buildings'),
      at,
    },
  ];
  // The site-information point (SPEC-12.6): a short JSON summary within the attribute limit.
  const brief = {
    pnu: pnus,
    area: { official, computed, gapPct: gap },
    jimok: targets.map((t) => t.landCategory),
    zones: [...new Set(zones)].slice(0, 8),
    roads: roads.roads.slice(0, 4).map((r) => ({
      dir: r.direction,
      min: r.widthMin_m,
      avg: r.widthAvg_m,
      contact: r.contact_m,
    })),
    convergenceDeg: frame.convergenceDeg,
    north: frame.northBasis,
    relief: terrain.relief_m,
    buildings: buildings.count,
    maxHeight: buildings.maxHeight_m,
    fetchedAt: collect.fetchedAt,
  };
  let text = JSON.stringify(brief);
  if (text.length > 1900)
    text = JSON.stringify({ ...brief, zones: brief.zones.slice(0, 2), roads: [] });
  return {
    disclaimer: DISCLAIMER,
    pnus,
    addresses,
    officialArea_m2: official,
    computedArea_m2: computed,
    areaGap_pct: gap,
    landCategories: targets.map((t) => t.landCategory ?? '미확인').join(', '),
    zones: zoneText,
    roads: roads.text,
    convergenceDeg: frame.convergenceDeg,
    north,
    relief_m: terrain.relief_m,
    buildings: buildings.count,
    maxHeight_m: buildings.maxHeight_m,
    estimated: buildings.estimated,
    checks:
      collect.checks.length + roads.checks.length + terrain.checks.length + frame.checks.length,
    fetchedAt: collect.fetchedAt,
    rows,
    siteInfo: targets.length
      ? [
          {
            key: 'site-info',
            text: '대지정보',
            point: [frame.origin[0] - frame.offset[0], frame.origin[1] - frame.offset[1], 0],
            summary: text,
            crs: frame.crsLabel,
            originSurvey: frame.originText,
            trueNorth: `${frame.trueNorth[0]}, ${frame.trueNorth[1]} (수렴각 ${frame.convergenceDeg}°)`,
          },
        ]
      : [],
  };
}

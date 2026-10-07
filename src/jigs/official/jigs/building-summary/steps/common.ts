// Shared shapes of the 건축개요 steps (SPEC-12.13·12.14, PLAN-45 T-213): what the two `jig-output`
// inputs hold, the 출처 labels every cell carries, and the number text the tables write. No legal
// value lives here — every number comes from the 고른 대안 (vide/buildable-mass) or the 대지 요약
// (vide/site-model) as they were handed over.

import type { ChosenHandoff } from '../../../massing-kit/handoff.ts';

export const DISCLAIMER = '탐색용 규모검토 — 인허가 도서·면적 산정·법규 검토를 대체하지 않음';

/**
 * 출처 (SPEC-12.14, short labels of the office table): 계산 = 도구로 계산함, 공부 = 원본에서 읽음
 * (공공 자료), 사람 입력 = 사용자가 확정함, 법규 결과 = the SPEC-13 result as it came; '사람 입력 필요'
 * marks a cell nobody has filled yet (SPEC-12.16).
 */
export const ORIGIN = {
  computed: '계산',
  record: '공부',
  person: '사람 입력',
  legal: '법규 결과',
  missing: '사람 입력 필요',
} as const;
export type OriginLabel = (typeof ORIGIN)[keyof typeof ORIGIN];

/** The site summary of vide/site-model (its `summary` output). */
export interface SiteSummary {
  pnus: string[];
  addresses: string[];
  officialArea_m2: number | null;
  computedArea_m2: number;
  areaGap_pct: number | null;
  zones: string;
  roads: string;
  fetchedAt: string | null;
  rows: { key: string; item: string; value: string; basis: string; source: string; at: string }[];
}
export interface JigOutputSource {
  instanceId: string;
  title: string;
  jig: string;
  version: string;
  step: string;
  status: string;
  at: string | null;
  hash: string | null;
  reason?: string;
}
/** A `jig-output` input as a step receives it (ARCH-03 §8.5). */
export interface JigOutputInput<T> {
  source: JigOutputSource | null;
  value: T | null;
  reason?: string;
}
export type MassInput = JigOutputInput<ChosenHandoff>;
export type SiteInput = JigOutputInput<SiteSummary>;

/** 1평 = 400/121 ㎡ (계량 단위 환산; shown beside ㎡ like the office table, never used in a rule). */
export const PY_PER_M2 = 121 / 400;
export const round = (value: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};
export const pyOf = (m2: number) => round(m2 * PY_PER_M2, 2);

/** Number text with thousands separators and fixed decimals. */
export function fmt(value: number, decimals: number): string {
  const [whole, frac] = value.toFixed(decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

export type Unit = '㎡' | '%' | 'm' | '층' | '대' | '';
/** How a cell's number is written: areas and lengths with 2 decimals, ratios as percent. */
export function cellText(value: number, unit: Unit): string {
  if (unit === '%') return `${fmt(value * 100, 2)} %`;
  if (unit === '층' || unit === '대') return `${fmt(value, 0)} ${unit}`;
  return unit ? `${fmt(value, 2)} ${unit}` : fmt(value, 2);
}

/** One row of the 건축개요 (the S-03 office layout: 항목 · 세부 · 값 · 평 · 비고, with 출처 kept). */
export interface OverviewRow {
  key: string;
  item: string;
  sub: string;
  /** The number of the cell in its stored unit (ratios as ratios), or null for a text cell. */
  value: number | null;
  unit: Unit;
  text: string;
  /** 평 beside an area (㎡) cell. */
  py: number | null;
  origin: OriginLabel | '미적용';
  /** 확정 상태 of a legal value (확정 · 가정 · 판단 필요 · 사람 입력 필요), else ''. */
  status: string;
  /** 근거 조항 and link of a legal value; the rule or source of a computed one. */
  basis: string;
  /** Which earlier result the value came from (작업본 · 대안 · 자료). */
  source: string;
}

/** One row of the 층별 면적표. */
export interface FloorRow {
  key: string;
  floor: string;
  use: string;
  area: number;
  exclusion: number;
  farArea: number;
  py: number;
  note: string;
  /** 'floor' rows are summed; 'total' rows carry the alternative's totals. */
  kind: 'floor' | 'total';
}

/** Every number a value holds (leaves, and the length of every list). */
export function numbersOf(value: unknown, out: number[] = [], depth = 0): number[] {
  if (depth > 14) return out;
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  else if (Array.isArray(value)) {
    out.push(value.length);
    for (const item of value) numbersOf(item, out, depth + 1);
  } else if (value && typeof value === 'object')
    for (const item of Object.values(value)) numbersOf(item, out, depth + 1);
  return out;
}

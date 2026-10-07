// 주차 (SPEC-12.12 1·3·5, PLAN-45 T-212): 법정 대수, 주차 진입 가능 구역, 주차 방식 대안. Every
// legal number is a 규제 조건 item with its source: the 용도별 산정 기준 (one form only — 'n ㎡당 1대',
// value n per use), the 끝수 처리 and its unit, the area the rule counts, the 모퉁이 제외 거리. An
// item nobody has entered leaves the count empty with '사람 입력 필요'; a rule at '판단 필요' leaves
// that use '미검토' (SPEC-12.12 1). The 대당 필요 면적 of each parking type is a plan setting, not a
// legal value. No layout of stalls or aisles is made.

import { segmentDistance, type Vec2 } from '../geometry-kit/plan.ts';
import type { BoundarySegment, Corner } from './boundary-segments.ts';
import { itemOf, numberOf, type RegulationItem } from './rules.ts';
import type { UseTotal } from './use-mix.ts';

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface ParkingUseRow {
  use: string;
  area: number;
  rule: number | null;
  ruleText: string;
  raw: number | null;
  count: number | null;
  status: '계산' | '미검토' | '사람 입력 필요' | '미적용';
}

export interface LegalParking {
  rows: ParkingUseRow[];
  /** Sum of area ÷ rule over the uses that have one. */
  raw: number;
  /** 법정 대수; null when a use is 미검토·사람 입력 필요 or the 끝수 처리 is not entered. */
  count: number | null;
  status: string;
  basis: string;
}

const ROUND: Record<string, (x: number) => number> = {
  // A tiny tolerance keeps 2.9999999 from 2 and 0.4999999 from 0.5 after float sums.
  'half-up': (x) => Math.floor(x + 0.5 + 1e-9),
  ceil: (x) => Math.ceil(x - 1e-9),
  floor: (x) => Math.floor(x + 1e-9),
};

/** 법정 주차 대수 from the uses' areas (SPEC-12.12 1). */
export function legalParking(
  byUse: readonly UseTotal[],
  items: readonly RegulationItem[],
): LegalParking {
  const basisItem = itemOf(items, 'parkingAreaBasis');
  const rounding = itemOf(items, 'parkingRounding');
  const scope = itemOf(items, 'parkingRoundScope');
  const basis =
    basisItem.applies === '적용' || basisItem.applies === '판단 필요' ? basisItem.value : null;
  const round =
    (rounding.applies === '적용' || rounding.applies === '판단 필요') &&
    typeof rounding.value === 'string'
      ? ROUND[rounding.value]
      : undefined;
  const each = scope.value === 'each';
  const scopeKnown = scope.value === 'each' || scope.value === 'sum';
  const rows: ParkingUseRow[] = byUse.map((u) => {
    const area = basis === 'far' ? u.farArea : u.total;
    // The use's own rule, else a rule entered for every use.
    const ruleItem = itemOf(items, 'parkingRule', u.use);
    if (ruleItem.applies === null || ruleItem.status === '사람 입력 필요')
      return {
        use: u.use,
        area: r6(area),
        rule: null,
        ruleText: '사람 입력 필요',
        raw: null,
        count: null,
        status: '사람 입력 필요',
      };
    if (ruleItem.applies === '미적용')
      return {
        use: u.use,
        area: r6(area),
        rule: null,
        ruleText: '미적용',
        raw: 0,
        count: 0,
        status: '미적용',
      };
    if (ruleItem.applies === '판단 필요')
      return {
        use: u.use,
        area: r6(area),
        rule: numberOf(ruleItem),
        ruleText: '판단 필요',
        raw: null,
        count: null,
        status: '미검토',
      };
    const n = numberOf(ruleItem)!;
    const raw = basis === null ? null : area / n;
    return {
      use: u.use,
      area: r6(area),
      rule: n,
      ruleText: `${r6(n)} ㎡당 1대`,
      raw: raw === null ? null : r6(raw),
      count: raw !== null && round && each ? round(raw) : null,
      status: basis === null ? '사람 입력 필요' : '계산',
    };
  });
  const raw = rows.reduce((s, r) => s + (r.raw ?? 0), 0);
  const missing: string[] = [];
  if (basis === null) missing.push(`${basisItem.title} 사람 입력 필요`);
  if (!round) missing.push(`${rounding.title} 사람 입력 필요`);
  if (!scopeKnown) missing.push(`${scope.title} 사람 입력 필요`);
  const open = rows
    .filter((r) => r.status === '미검토' || r.status === '사람 입력 필요')
    .map((r) => r.use);
  if (open.length) missing.push(`기준이 정해지지 않은 용도: ${open.join(', ')}`);
  let count: number | null = null;
  if (!missing.length && round)
    count = each ? rows.reduce((s, r) => s + (r.count ?? 0), 0) : round(raw);
  return {
    rows,
    raw: r6(raw),
    count,
    status: missing.length ? missing.join('; ') : '계산',
    basis: basis === null ? '사람 입력 필요' : String(basis),
  };
}

// ── 주차 진입 가능 구역 (2D) ────────────────────────────────────────────────────────────────────

export interface EntryPiece {
  segment: string;
  from: number;
  to: number;
  length: number;
  a: Vec2;
  b: Vec2;
}

/**
 * Road segments minus what a person drew as excluded (a line lying along the segment within `tol`
 * removes the stretch it covers) and minus the 모퉁이 제외 거리 at corners where two road segments
 * meet (convex corners, the item value from each side). Without that item value the corners are
 * not cut and the reason is returned as 미반영.
 */
export function entryZone(
  segments: readonly BoundarySegment[],
  corners: readonly Corner[],
  drawn: { id: string; points: Vec2[] }[],
  items: readonly RegulationItem[],
  tol: number,
) {
  const item = itemOf(items, 'parkingEntryCornerDistance');
  const corner = item.applies === '적용' ? numberOf(item) : null;
  const unresolved: string[] = [];
  if (item.applies !== '미적용' && corner === null)
    unresolved.push(
      `${item.title} ${item.applies === '판단 필요' ? '판단 필요' : '사람 입력 필요'} — 모퉁이를 빼지 않고 보임`,
    );
  const order = new Map(segments.map((s, i) => [s.id, i]));
  const roadCorner = (id: string, end: 'a' | 'b') =>
    corners.some((c) => {
      if (!(c.angleDeg < 180 - 1e-6)) return false;
      if (end === 'b' && c.before !== id) return false;
      if (end === 'a' && c.after !== id) return false;
      const other = segments[order.get(end === 'b' ? c.after : c.before)!];
      return other?.kind === 'road';
    });
  const pieces: EntryPiece[] = [];
  for (const s of segments) {
    if (s.kind !== 'road') continue;
    const L = s.length;
    const u: Vec2 = [(s.b[0] - s.a[0]) / L, (s.b[1] - s.a[1]) / L];
    const cuts: [number, number][] = [];
    if (corner !== null) {
      if (roadCorner(s.id, 'a')) cuts.push([0, corner]);
      if (roadCorner(s.id, 'b')) cuts.push([L - corner, L]);
    }
    for (const d of drawn) {
      if (d.points.length < 2) continue;
      if (!d.points.every((p) => segmentDistance(p, s.a, s.b) <= tol)) continue;
      const ts = d.points.map((p) => (p[0] - s.a[0]) * u[0] + (p[1] - s.a[1]) * u[1]);
      cuts.push([Math.min(...ts), Math.max(...ts)]);
    }
    cuts.sort((x, y) => x[0] - y[0]);
    let at = 0;
    const keep = (from: number, to: number) => {
      if (to - from > 1e-6)
        pieces.push({
          segment: s.id,
          from: r6(from),
          to: r6(to),
          length: r6(to - from),
          a: [s.a[0] + u[0] * from, s.a[1] + u[1] * from],
          b: [s.a[0] + u[0] * to, s.a[1] + u[1] * to],
        });
    };
    for (const [c0, c1] of cuts) {
      const from = Math.max(0, c0),
        to = Math.min(L, c1);
      if (from > at) keep(at, from);
      at = Math.max(at, to);
    }
    if (at < L) keep(at, L);
  }
  return { pieces, length: r6(pieces.reduce((s, p) => s + p.length, 0)), unresolved };
}

// ── 주차 방식 대안 ─────────────────────────────────────────────────────────────────────────────

export type ParkingType = 'ground' | 'underground' | 'mechanical';
export const PARKING_TYPE_TITLES: Record<ParkingType, string> = {
  ground: '지상 자주식',
  underground: '지하 자주식',
  mechanical: '기계식',
};

export interface ParkingTypeRow {
  type: ParkingType;
  title: string;
  count: number | null;
  areaPerCar: number | null;
  required: number | null;
  /** Ground: 지상 여유 면적; underground: one basement floor's area. */
  available: number;
  /** Underground: basement floors needed (추정). */
  floors: number | null;
  verdict: '충족' | '부족' | '사람 입력 필요';
  note: string;
}

/** SPEC-12.12 5: required area = 대당 필요 면적 × 대수, and what holds it. */
export function parkingTypes(
  count: number | null,
  perCar: Record<ParkingType, number>,
  groundFree: number,
  basementArea: number,
  basementPlanned: number,
): ParkingTypeRow[] {
  return (['ground', 'underground', 'mechanical'] as ParkingType[]).map((type) => {
    const a = perCar[type] > 0 ? perCar[type] : null;
    const base = { type, title: PARKING_TYPE_TITLES[type], count, areaPerCar: a };
    if (count === null || a === null)
      return {
        ...base,
        required: null,
        available: r6(type === 'underground' ? basementArea : groundFree),
        floors: null,
        verdict: '사람 입력 필요' as const,
        note:
          count === null
            ? '대수 없음(법정 대수 미확정, 계획 대수 없음)'
            : '대당 필요 면적 사람 입력 필요',
      };
    const required = r6(count * a);
    if (type === 'underground') {
      const floors = basementArea > 0 ? Math.ceil(required / basementArea - 1e-9) : null;
      return {
        ...base,
        required,
        available: r6(basementArea),
        floors,
        verdict:
          floors === null
            ? ('부족' as const)
            : floors <= basementPlanned
              ? ('충족' as const)
              : ('부족' as const),
        note:
          floors === null
            ? '지하 바닥 영역 없음'
            : `지하 ${floors}개 층 필요(계획 ${basementPlanned}개 층)`,
      };
    }
    return {
      ...base,
      required,
      available: r6(groundFree),
      floors: null,
      verdict: required <= groundFree + 1e-6 ? ('충족' as const) : ('부족' as const),
      note:
        type === 'mechanical'
          ? '기계식 설비 면적으로 본 추정 — 기종·배치는 하지 않음'
          : '지상 여유 면적 = 대지 − 건축면적 − 공개공지 − 그린 조경',
    };
  });
}

// The `vide/buildable-mass` jig steps as library functions (`kind: library`, called with
// `(inputs, params, overrides)`; ARCH-03 §2.3). Steps 대지 입력 · 규제 조건 · 계획 조건 · 제한선 ·
// 가능 영역 (T-209) and 외피 (T-210). Every value a rule uses is a 규제 조건 item (rules.ts) with its
// source; '판단 필요' items of 일조·높이 give two variants (적용 · 미적용), other undecided or missing
// items are calculated without and listed as 미반영 조건 (SPEC-12.7 5, SPEC-12.16).

import { requirePolygon, signedArea, type Polygon, type Vec2 } from '../geometry-kit/plan.ts';
import {
  boundarySegments,
  edgesOf,
  roadWidthAt,
  siteRing,
  type BoundarySegment,
  type Corner,
} from './boundary-segments.ts';
import { ENVELOPE_TITLES, envelopes, type EnvelopeSet } from './envelope.ts';
import { regulationsFromLegal, type LegalAdapterResult } from './legal-adapter.ts';
import {
  CHOICE_LABELS,
  isUnconfirmed,
  itemOf,
  mergeRegulations,
  numberOf,
  regulationsFromOverrides,
  regulationsFromParams,
  ruleOf,
  withOverrides,
  type StepOverride,
  type RegulationId,
  type RegulationItem,
  type RuleId,
} from './rules.ts';
import {
  ARC_SIDES,
  buildableArea,
  type CapsuleCutter,
  type Cutter,
  type PlanRegion,
  type SunDatum,
  type SunRule,
} from './setback.ts';

/** Shown with every result (SPEC-12.1). */
export const STUDY_NOTE = '탐색용 규모검토 — 인허가 도서·면적 산정·법규 검토를 대체하지 않음';
export const ENVELOPE_NOTE = '법정 최대치 추정 — 계획 매스가 아님';

// ── Input rows ──────────────────────────────────────────────────────────────────────────────────

interface Row {
  id?: string;
  line?: number[];
}
interface Line {
  id: string;
  points: Vec2[];
  closed: boolean;
}
const rowsOf = (role: unknown): Row[] =>
  role && typeof role === 'object' && Array.isArray((role as { rows?: unknown }).rows)
    ? ((role as { rows: Row[] }).rows ?? [])
    : [];

/** Read rows (flat xyz `line`) as plan polylines; a repeated first point means closed. */
export function linesOf(role: unknown, tol = 1e-6): Line[] {
  const out: Line[] = [];
  rowsOf(role).forEach((row, index) => {
    const flat = Array.isArray(row.line) ? row.line : [];
    const points: Vec2[] = [];
    for (let k = 0; k + 2 < flat.length; k += 3) {
      const p: Vec2 = [Number(flat[k]), Number(flat[k + 1])];
      const last = points[points.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > tol) points.push(p);
    }
    if (points.length < 2) return;
    const f = points[0],
      l = points[points.length - 1];
    const closed = points.length > 2 && Math.hypot(f[0] - l[0], f[1] - l[1]) <= tol;
    if (closed) points.pop();
    out.push({ id: String(row.id ?? `#${index}`), points, closed });
  });
  return out;
}

/** Two closed lines with the same corners (any start, either direction) within `tol`. */
function sameRing(a: Line, b: Line, tol: number) {
  if (!a.closed || !b.closed || a.points.length !== b.points.length) return false;
  const near = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;
  return a.points.every((p) => b.points.some((q) => near(p, q)));
}

const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

// ── 대지 입력 ────────────────────────────────────────────────────────────────────────────────────

export interface SiteOutput {
  ring: Vec2[];
  area_m2: number;
  segments: BoundarySegment[];
  corners: Corner[];
  /** Closed road polygons (for the road width across a segment). */
  roadRings: Vec2[][];
  /** Unit north in plan, and its angle clockwise from the document +Y (deg). */
  north: Vec2;
  northDeg: number;
  northBasis: 'true' | 'grid';
  tolerance: number;
  note: string;
}

/**
 * 대지 입력 (SPEC-12.7 1): the site boundary (one closed curve), road and neighbouring parcel
 * boundaries → contact segments. A boundary that is not closed or crosses itself stops here with
 * where (SPEC-12.8 5).
 */
export function siteStep(inputs: Record<string, unknown>, params: Record<string, unknown>) {
  const site = (inputs.site ?? {}) as Record<string, unknown>;
  const tol = num(params.segmentTolerance, 0.05);
  const boundaries = linesOf(site.boundary, 1e-6);
  if (boundaries.length !== 1)
    throw new Error(`대지 경계: 닫힌 곡선 하나가 필요합니다 (지금 ${boundaries.length}개)`);
  const b = boundaries[0];
  if (!b.closed) {
    const f = b.points[0],
      l = b.points[b.points.length - 1];
    throw new Error(
      `대지 경계가 닫히지 않았습니다: 끝점 (${r6(f[0])}, ${r6(f[1])})과 (${r6(l[0])}, ${r6(l[1])}) 사이 ${r6(Math.hypot(f[0] - l[0], f[1] - l[1]))} m`,
    );
  }
  let ring: Polygon;
  try {
    ring = siteRing(b.points);
  } catch (error) {
    const m = /edges (\d+), (\d+)/.exec(String((error as Error).message));
    if (m) {
      const p = b.points[Number(m[1])],
        q = b.points[Number(m[2])];
      throw new Error(
        `대지 경계가 스스로 교차합니다: 변 ${m[1]}((${r6(p[0])}, ${r6(p[1])})에서)과 변 ${m[2]}((${r6(q[0])}, ${r6(q[1])})에서)`,
      );
    }
    throw new Error(`대지 경계가 올바른 다각형이 아닙니다: ${(error as Error).message}`);
  }
  const roads = linesOf(site.roads);
  // A road lot listed among the neighbouring lots as well (the site model's 주변 필지 holds every
  // lot around, roads included) is the same lot on both layers: it counts as the road only.
  const neighbours = linesOf(site.neighbors).filter(
    (n) => !roads.some((r) => sameRing(n, r, Math.max(tol, 1e-6))),
  );
  const { segments, corners } = boundarySegments(ring, edgesOf(roads), edgesOf(neighbours), tol);
  const northBasis = params.northBasis === 'grid' ? 'grid' : 'true';
  const northDeg =
    num(params.gridNorthDeg, 0) + (northBasis === 'true' ? num(params.convergenceDeg, 0) : 0);
  const t = (northDeg * Math.PI) / 180;
  const roadRings = roads.filter((l) => l.closed && l.points.length >= 3).map((l) => l.points);
  return {
    ring,
    area_m2: Math.abs(signedArea(ring)),
    segments,
    corners,
    roadRings,
    north: [Math.sin(t), Math.cos(t)],
    northDeg,
    northBasis,
    tolerance: tol,
    note: STUDY_NOTE,
  } satisfies SiteOutput;
}

// ── 규제 조건 ────────────────────────────────────────────────────────────────────────────────────

export interface RegulationsOutput {
  items: RegulationItem[];
  /** The SPEC-13 result: wired or not, why no items, keys that fill nothing, what the engine left out. */
  legal: {
    available: boolean;
    reason: string;
    unmapped: NonNullable<LegalAdapterResult['unmapped']>;
    left: NonNullable<LegalAdapterResult['left']>;
  };
  differences: ReturnType<typeof mergeRegulations>['differences'];
  /** Items still '사람 입력 필요' (SPEC-12.16 사람 투입 칸). */
  needsInput: { id: RegulationId; title: string }[];
  /** '판단 필요'·'가정' items (SPEC-12.7 7). */
  unconfirmed: { id: RegulationId; title: string; status: string }[];
  /** Table entries (수정 사항) that were not taken, and why. */
  problems?: string[];
}

/**
 * 규제 조건 (SPEC-12.7 2): the person's settings and table entries (수정 사항 of kind
 * `regulation`, T-211·T-212), then the legal jig's `legal.constraints` (`input.legal`, T-220)
 * for the items the person left empty.
 */
export function regulationStep(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  overrides: StepOverride[] = [],
) {
  const table = regulationsFromOverrides(overrides);
  const person = withOverrides(regulationsFromParams(params), table.items);
  const legal = regulationsFromLegal(inputs.legal);
  const { items, differences } = mergeRegulations(person, legal.items);
  return {
    items,
    legal: {
      available: legal.available,
      reason: legal.reason,
      unmapped: legal.unmapped ?? [],
      left: legal.left ?? [],
    },
    differences,
    problems: table.problems,
    needsInput: items
      .filter((i) => i.status === '사람 입력 필요')
      .map((i) => ({ id: i.id, title: i.title })),
    unconfirmed: items
      .filter(isUnconfirmed)
      .map((i) => ({ id: i.id, title: i.title, status: i.status })),
  } satisfies RegulationsOutput;
}

// ── 계획 조건 ────────────────────────────────────────────────────────────────────────────────────

export interface PlanOutput {
  mainUse: string | null;
  floorHeightGround: number;
  floorHeightTypical: number;
  basementFloors: number;
  /** 지하 층고 (m) and 지하 이격 (m, SPEC-12.10 1). */
  basementFloorHeight: number;
  basementSetback: number;
  targetFar: number | null;
  studyHeight: number;
  northBasis: 'true' | 'grid';
  /** Plan values taken from their defaults (가정, SPEC-12.7 4). */
  assumptions: string[];
  questions: string[];
}

/** 계획 조건 (SPEC-12.7 3·4): settings; 주용도 still 미정 is asked (question card). */
export function planStep(_inputs: Record<string, unknown>, params: Record<string, unknown>) {
  const mainUse =
    typeof params.mainUse === 'string' && params.mainUse !== 'unset' ? params.mainUse : null;
  const targetFar = num(params.targetFar, 0);
  return {
    mainUse,
    floorHeightGround: num(params.floorHeightGround, 0),
    floorHeightTypical: num(params.floorHeightTypical, 0),
    basementFloors: num(params.basementFloors, 0),
    basementFloorHeight: num(params.basementFloorHeight, 0),
    basementSetback: Math.max(0, num(params.basementSetback, 0)),
    targetFar: targetFar > 0 ? targetFar : null,
    studyHeight: num(params.studyHeight, 0),
    northBasis: params.northBasis === 'grid' ? 'grid' : 'true',
    assumptions: ['층고(1층·기준층)', '지하 층고', '검토 높이(높이 상한이 없을 때의 계산 상한)'],
    questions: mainUse ? [] : ['주용도가 무엇인가요?'],
  } satisfies PlanOutput;
}

// ── 제한선 ──────────────────────────────────────────────────────────────────────────────────────

export interface Unresolved {
  rule: RuleId;
  title: string;
  reason: string;
  target?: string;
}

export interface LimitsOutput {
  cutters: Cutter[];
  sun: SunRule | null;
  /** Calculated without, listed (SPEC-12.7 5 미반영 조건). */
  unresolved: Unresolved[];
  /** Per boundary segment: kind and the rules on it. */
  segmentRules: {
    segment: string;
    kind: string;
    status: string;
    note: string;
    length: number;
    rules: { rule: RuleId; title: string; distance: number }[];
  }[];
  sides: number;
}

const unit = (a: Vec2, b: Vec2): Vec2 => {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
};

/** Side of the road for a 건축한계선: the half the road segments lie in (else away from the site). */
function limitLineCutter(line: Line, site: SiteOutput): { ring: Vec2[] } | { error: string } {
  const P = line.points;
  const xs = site.ring.map((p) => p[0]),
    ys = site.ring.map((p) => p[1]);
  const E =
    2 * Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + 10;
  const u0 = unit(P[1], P[0]),
    un = unit(P[P.length - 2], P[P.length - 1]);
  const start: Vec2 = [P[0][0] + u0[0] * E, P[0][1] + u0[1] * E];
  const end: Vec2 = [P[P.length - 1][0] + un[0] * E, P[P.length - 1][1] + un[1] * E];
  const c = unit(start, end);
  const perp: Vec2 = [-c[1], c[0]];
  const sideOf = (p: Vec2) => (p[0] - start[0]) * perp[0] + (p[1] - start[1]) * perp[1];
  let score = 0;
  for (const s of site.segments)
    if (s.kind === 'road')
      score += Math.sign(sideOf([(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2])) * s.length;
  if (score === 0) {
    const cx = site.ring.reduce((t, p) => t + p[0], 0) / site.ring.length,
      cy = site.ring.reduce((t, p) => t + p[1], 0) / site.ring.length;
    score = -Math.sign(sideOf([cx, cy])) || 1;
  }
  const s = Math.sign(score);
  const ring: Vec2[] = [
    start,
    ...P,
    end,
    [end[0] + perp[0] * s * E, end[1] + perp[1] * s * E],
    [start[0] + perp[0] * s * E, start[1] + perp[1] * s * E],
  ];
  try {
    return { ring: requirePolygon(ring, '건축한계선') };
  } catch {
    return { error: '건축한계선 모양을 영역으로 만들 수 없습니다(스스로 교차)' };
  }
}

/**
 * 제한선 (SPEC-12.8 1·2): the cutters of every applied rule on the segments it belongs to, the
 * 일조 rule (datum segments facing north), and what was left out and why.
 */
export function limitStep(inputs: Record<string, unknown>) {
  const steps = (inputs.steps ?? {}) as Record<string, unknown>;
  const site = steps.site as SiteOutput;
  const regs = steps.regulations as RegulationsOutput;
  if (!site || !regs) throw new Error('대지 입력·규제 조건 단계의 결과가 없습니다');
  const items = regs.items;
  const own = (inputs.site ?? {}) as Record<string, unknown>;
  const cutters: Cutter[] = [];
  const unresolved: Unresolved[] = [];
  const miss = (rule: RuleId, reason: string, target?: string) =>
    unresolved.push({ rule, title: ruleOf(rule).title, reason, ...(target ? { target } : {}) });
  const reasonOf = (item: RegulationItem) =>
    item.applies === '판단 필요'
      ? '판단 필요 — 사람이 정할 때까지 그 제한 없이 계산'
      : `${item.title} 사람 입력 필요`;

  // Distance rules on contact segments.
  const distanceRule = (
    rule: RuleId,
    id: RegulationId,
    kind: 'road' | 'adjacent',
    extra?: (seg: BoundarySegment) => number,
  ) => {
    const segs = site.segments.filter((s) => s.kind === kind);
    for (const seg of segs) {
      const item = itemOf(items, id, seg.id);
      if (item.applies === '미적용') continue;
      const value = item.applies === '적용' ? numberOf(item) : null;
      if (value === null) {
        miss(rule, reasonOf(item), seg.id);
        continue;
      }
      const radius = value + (extra?.(seg) ?? 0);
      if (radius > 0)
        cutters.push({
          rule,
          kind: 'capsule',
          a: seg.a,
          b: seg.b,
          radius,
          roundA: true,
          roundB: true,
          target: seg.id,
        });
    }
  };
  const roadSetbackOf = (seg: BoundarySegment) => {
    const item = itemOf(items, 'roadSetback', seg.id);
    return item.applies === '적용' ? (numberOf(item) ?? 0) : 0;
  };
  distanceRule('road-setback', 'roadSetback', 'road');
  distanceRule('open-space-road', 'openSpaceRoad', 'road', roadSetbackOf);
  distanceRule('open-space-adjacent', 'openSpaceAdjacent', 'adjacent');
  distanceRule('civil', 'civilSetback', 'adjacent');
  for (const seg of site.segments.filter((s) => s.kind === 'unknown'))
    miss('civil', `구간 확인 필요(${seg.note}) — 도로·인접 대지 규칙을 걸지 않음`, seg.id);

  // Round ends covered by the next capsule of the same rule (convex or straight corner, ≥ radius).
  const order = new Map(site.segments.map((s, i) => [s.id, i]));
  const n = site.segments.length;
  const capsules = cutters.filter((c): c is CapsuleCutter => c.kind === 'capsule');
  for (const c of capsules) {
    const i = order.get(c.target);
    if (i === undefined) continue;
    const next = site.segments[(i + 1) % n],
      prev = site.segments[(i - 1 + n) % n];
    const cornerAfter = site.corners[i],
      cornerBefore = site.corners[(i - 1 + n) % n];
    const covers = (segId: string, corner: Corner) =>
      corner.angleDeg <= 180 + 1e-9 &&
      capsules.some(
        (o) => o !== c && o.rule === c.rule && o.target === segId && o.radius >= c.radius - 1e-12,
      );
    if (covers(next.id, cornerAfter)) c.roundB = false;
    if (covers(prev.id, cornerBefore)) c.roundA = false;
  }

  // 가각: convex corners between two road segments.
  for (const corner of site.corners) {
    const before = site.segments[order.get(corner.before)!],
      after = site.segments[order.get(corner.after)!];
    if (before.kind !== 'road' || after.kind !== 'road' || !(corner.angleDeg < 180 - 1e-6))
      continue;
    const item = itemOf(items, 'chamferLength', corner.id);
    if (item.applies === '미적용') continue;
    const L = item.applies === '적용' ? numberOf(item) : null;
    if (L === null) {
      miss('chamfer', reasonOf(item), corner.id);
      continue;
    }
    const la = Math.min(L, before.length),
      lb = Math.min(L, after.length);
    const u = unit(corner.at, before.a),
      v = unit(corner.at, after.b);
    cutters.push({
      rule: 'chamfer',
      kind: 'polygon',
      ring: [
        corner.at,
        [corner.at[0] + v[0] * lb, corner.at[1] + v[1] * lb],
        [corner.at[0] + u[0] * la, corner.at[1] + u[1] * la],
      ],
      target: corner.id,
    });
  }

  // 건축한계선 (drawn) and 기타 이격 (drawn lines + distance).
  for (const line of linesOf(own.limitLines)) {
    const made = limitLineCutter(line, site);
    if ('error' in made) miss('limit-line', made.error, line.id);
    else cutters.push({ rule: 'limit-line', kind: 'polygon', ring: made.ring, target: line.id });
  }
  const others = linesOf(own.otherLines);
  if (others.length) {
    const item = itemOf(items, 'otherSetback');
    const d = item.applies === '적용' ? numberOf(item) : null;
    if (item.applies !== '미적용') {
      if (d === null) for (const l of others) miss('other', reasonOf(item), l.id);
      else
        for (const l of others) {
          const pts = l.closed ? [...l.points, l.points[0]] : l.points;
          for (let k = 0; k + 1 < pts.length; k++)
            if (d > 0)
              cutters.push({
                rule: 'other',
                kind: 'capsule',
                a: pts[k],
                b: pts[k + 1],
                radius: d,
                roundA: true,
                roundB: true,
                target: `${l.id}:${k}`,
              });
        }
    }
  }

  const sun = sunRule(site, items, own, miss);
  const segmentRules = site.segments.map((s) => ({
    segment: s.id,
    kind: s.kind === 'road' ? '도로' : s.kind === 'adjacent' ? '인접 대지' : '확인 필요',
    status: s.status,
    note: s.note,
    length: r6(s.length),
    rules: [
      ...cutters
        .filter((c): c is CapsuleCutter => c.kind === 'capsule' && c.target === s.id)
        .map((c) => ({ rule: c.rule, title: ruleOf(c.rule).title, distance: r6(c.radius) })),
      ...(sun?.datum.some((d) => d.target === s.id)
        ? [
            {
              rule: 'sun-ground' as RuleId,
              title: ruleOf('sun-ground').title,
              distance: r6(sun.nearDistance),
            },
          ]
        : []),
    ],
  }));
  return { cutters, sun, unresolved, segmentRules, sides: ARC_SIDES } satisfies LimitsOutput;
}

/** 일조 (SPEC-12.8 1, 12.9 2): datum segments facing north and the values; null when not applied. */
function sunRule(
  site: SiteOutput,
  items: readonly RegulationItem[],
  own: Record<string, unknown>,
  miss: (rule: RuleId, reason: string, target?: string) => void,
): SunRule | null {
  const sun = itemOf(items, 'sun');
  if (sun.applies === '미적용') return null;
  if (sun.applies === null) {
    miss('sun-ground', '정북 일조 적용 여부 사람 입력 필요 — 그 제한 없이 계산');
    return null;
  }
  const base = numberOf(itemOf(items, 'sunBaseHeight')),
    near = numberOf(itemOf(items, 'sunNearDistance')),
    ratio = numberOf(itemOf(items, 'sunRatio'));
  if (base === null || near === null || ratio === null) {
    const missing = (['sunBaseHeight', 'sunNearDistance', 'sunRatio'] as const)
      .filter((id) => numberOf(itemOf(items, id)) === null)
      .map((id) => itemOf(items, id).title);
    miss('sun-slope', `일조 값 사람 입력 필요: ${missing.join(', ')} — 그 제한 없이 계산`);
    return null;
  }
  const distance = itemOf(items, 'sunDistance');
  const measure = distance.value === 'north' ? 'north' : 'euclidean';
  const datum: SunDatum[] = [];
  const drawn = linesOf(own.sunDatum);
  if (drawn.length)
    for (const l of drawn) {
      const pts = l.closed ? [...l.points, l.points[0]] : l.points;
      for (let k = 0; k + 1 < pts.length; k++)
        datum.push({
          a: pts[k],
          b: pts[k + 1],
          target: `${l.id}:${k}`,
          source: '사람이 그린 기준선',
        });
    }
  else {
    const datumRoad = itemOf(items, 'sunDatumRoad');
    for (const seg of site.segments) {
      const facing = seg.normal[0] * site.north[0] + seg.normal[1] * site.north[1];
      if (!(facing > 1e-9)) continue;
      if (seg.kind === 'adjacent')
        datum.push({ a: seg.a, b: seg.b, target: seg.id, source: '인접 대지 경계(도구로 계산함)' });
      else if (seg.kind === 'road') {
        if (datumRoad.value === 'boundary')
          datum.push({ a: seg.a, b: seg.b, target: seg.id, source: '대지 경계(도로 쪽)' });
        else if (datumRoad.value === 'across-road') {
          const w = roadWidthAt(seg, site.roadRings, site.tolerance);
          if (w === null)
            miss(
              'sun-ground',
              '정북 도로의 너비를 도로 영역에서 찾지 못함 — 기준선을 그려 주세요',
              seg.id,
            );
          else
            datum.push({
              a: [seg.a[0] + seg.normal[0] * w, seg.a[1] + seg.normal[1] * w],
              b: [seg.b[0] + seg.normal[0] * w, seg.b[1] + seg.normal[1] * w],
              target: seg.id,
              source: `도로 건너편 경계(도로 너비 ${r6(w)} m, 도구로 계산함)`,
            });
        } else
          miss(
            'sun-ground',
            '정북 도로의 기준선 위치 사람 입력 필요 — 그 구간의 일조 없이 계산',
            seg.id,
          );
      } else miss('sun-ground', '정북 쪽 구간 확인 필요 — 그 구간의 일조 없이 계산', seg.id);
    }
  }
  if (distance.value !== 'euclidean' && distance.value !== 'north')
    miss(
      'sun-slope',
      `일조 거리의 정의 사람 입력 필요 — ${CHOICE_LABELS.euclidean}(더 많이 깎는 쪽)로 계산하고 미확정으로 둠`,
    );
  if (!datum.length) return null;
  const zones = linesOf(own.sunZone)
    .filter((l) => l.closed && l.points.length >= 3)
    .map((l) => l.points);
  return {
    datum,
    baseHeight: base,
    nearDistance: near,
    ratio,
    measure,
    north: site.north,
    zones: zones.length ? zones : null,
    applies: sun.applies === '판단 필요' ? '판단 필요' : '적용',
  };
}

// ── 가능 영역 ───────────────────────────────────────────────────────────────────────────────────

/** A variant of the result: '판단 필요' 일조·높이 applied (`base`) or not (`without`). */
export type VariantId = 'base' | 'without';
const VARIANT_TITLES: Record<VariantId, string> = {
  base: '판단 필요 항목 적용',
  without: '판단 필요 항목 미적용',
};

const curveItems = (prefix: string, regions: PlanRegion[], attrs: Record<string, string>) =>
  regions.flatMap((r, k) =>
    [r.outer, ...r.holes].map((ring, h) => ({
      key: `${prefix}:${k}${h ? `.${h}` : ''}`,
      curve: [...ring, ring[0]].map((p) => [p[0], p[1], 0]),
      ...attrs,
    })),
  );

/** 2D 건축 가능 영역 (SPEC-12.8 3~5). */
export function buildableStep(inputs: Record<string, unknown>) {
  const steps = (inputs.steps ?? {}) as Record<string, unknown>;
  const site = steps.site as SiteOutput;
  const regs = steps.regulations as RegulationsOutput;
  const limits = steps.limits as LimitsOutput;
  if (!site || !regs || !limits) throw new Error('앞 단계의 결과가 없습니다');
  const result = buildableArea(site.ring, limits.cutters, limits.sun, limits.sides);
  const variants: { id: VariantId; title: string; area: number }[] = [
    { id: 'base', title: VARIANT_TITLES.base, area: r6(result.area) },
  ];
  if (limits.sun?.applies === '판단 필요')
    variants.push({
      id: 'without',
      title: VARIANT_TITLES.without,
      area: r6(buildableArea(site.ring, limits.cutters, null, limits.sides).area),
    });
  const coverage = itemOf(regs.items, 'coverage');
  const coverageValue =
    coverage.applies === '적용' || coverage.applies === '판단 필요' ? numberOf(coverage) : null;
  // Ratios are stored as fractions (0.6 = 60 %), as jig settings of type `ratio` are.
  const capArea = coverageValue === null ? null : site.area_m2 * coverageValue;
  const empty = !(result.area > 1e-9);
  const worst = [...result.reductions].sort((a, b) => b.area - a.area)[0];
  const reductions = result.reductions.map((r) => ({
    rule: r.rule,
    title: ruleOf(r.rule).title,
    area: r6(r.area),
    targets: r.targets,
    basis: ruleOf(r.rule).reads.map((id) => {
      const item = itemOf(regs.items, id);
      return {
        id,
        title: item.title,
        value: item.value,
        status: item.status,
        origin: item.origin,
        source: item.source,
        basis: item.basis,
      };
    }),
  }));
  return {
    area: r6(result.area),
    siteArea: r6(result.siteArea),
    regions: result.regions,
    variants,
    reductions,
    coverage: {
      ratio: coverageValue,
      capArea: capArea === null ? null : r6(capArea),
      message:
        capArea === null
          ? '건폐율 상한 없음(사람 입력 필요 또는 미적용)'
          : result.area > capArea
            ? `건축면적은 상한 ${r6(capArea)} ㎡까지`
            : `가능 영역이 건폐율 상한 면적(${r6(capArea)} ㎡)보다 작음`,
    },
    empty,
    message: empty
      ? `가능 영역 없음 — 가장 많이 줄인 제한선: ${worst ? `${ruleOf(worst.rule).title} (${r6(worst.area)} ㎡)` : '없음'}`
      : '',
    unresolved: limits.unresolved,
    unconfirmed: regs.unconfirmed.length,
    lines: [
      ...result.reductions.flatMap((r) =>
        curveItems(`line:${r.rule}`, r.regions, { rule: ruleOf(r.rule).title }),
      ),
      ...curveItems('area', result.regions, { rule: '건축 가능 영역' }),
    ],
    note: STUDY_NOTE,
  };
}

// ── 외피 ────────────────────────────────────────────────────────────────────────────────────────

/** 높이 상한 (SPEC-12.9 1): the lowest applied height item, else 층수 × 층고, else 검토 높이. */
function heightCap(items: readonly RegulationItem[], plan: PlanOutput, withUndecided: boolean) {
  const heights = (['heightMax', 'streetHeight', 'altitudeHeight'] as const)
    .map((id) => itemOf(items, id))
    .filter((i) => i.applies === '적용' || (withUndecided && i.applies === '판단 필요'))
    .map((i) => ({ item: i, value: numberOf(i) }))
    .filter((x): x is { item: RegulationItem; value: number } => x.value !== null);
  if (heights.length) {
    const low = heights.reduce((a, b) => (b.value < a.value ? b : a));
    return { height: low.value, source: low.item.title, assumed: false };
  }
  const floors = itemOf(items, 'floorsMax');
  const n =
    floors.applies === '적용' || (withUndecided && floors.applies === '판단 필요')
      ? numberOf(floors)
      : null;
  if (n !== null && plan.floorHeightGround > 0 && plan.floorHeightTypical > 0)
    return {
      height: plan.floorHeightGround + (Math.floor(n) - 1) * plan.floorHeightTypical,
      source: `${floors.title} ${n}층 × 층고`,
      assumed: false,
    };
  return { height: plan.studyHeight, source: '검토 높이(계산 상한, 법정 값 아님)', assumed: true };
}

/** Floor mid-heights for the sections (층고: 1층·기준층). */
function sectionHeights(plan: PlanOutput, H: number) {
  const out: number[] = [];
  const g = plan.floorHeightGround,
    t = plan.floorHeightTypical;
  if (!(g > 0) || !(t > 0)) return [H / 2];
  for (let z = g / 2, k = 0; z < H && k < 400; k++, z = g + (k - 1) * t + t / 2) out.push(z);
  return out;
}

/** 3D 가능 외피 (SPEC-12.9): variants, envelopes, checks, sections and the bake items. */
export function envelopeStep(inputs: Record<string, unknown>) {
  const steps = (inputs.steps ?? {}) as Record<string, unknown>;
  const site = steps.site as SiteOutput;
  const regs = steps.regulations as RegulationsOutput;
  const plan = steps.plan as PlanOutput;
  const limits = steps.limits as LimitsOutput;
  if (!site || !regs || !plan || !limits) throw new Error('앞 단계의 결과가 없습니다');
  const undecidedHeight = (
    ['heightMax', 'streetHeight', 'altitudeHeight', 'floorsMax'] as const
  ).some((id) => itemOf(regs.items, id).applies === '판단 필요');
  const undecidedSun = limits.sun?.applies === '판단 필요';
  const ids: VariantId[] = undecidedHeight || undecidedSun ? ['base', 'without'] : ['base'];
  const unresolved = [...limits.unresolved];
  const unconfirmed =
    regs.unconfirmed.length +
    (limits.unresolved.some((u) => u.rule === 'sun-slope' && /거리의 정의/.test(u.reason)) ? 1 : 0);
  const items: Record<string, unknown>[] = [];
  const variants = ids.map((id) => {
    const cap = heightCap(regs.items, plan, id === 'base');
    if (cap.assumed && id === 'base')
      unresolved.push({
        rule: 'height-limit',
        title: ruleOf('height-limit').title,
        reason: `높이 상한 사람 입력 필요 — ${cap.source} ${cap.height} m로 계산`,
      });
    if (!(cap.height > 0)) throw new Error('점검 실패: 높이 상한(또는 검토 높이)이 없습니다');
    const sun = limits.sun && (id === 'base' || limits.sun.applies === '적용') ? limits.sun : null;
    const set: EnvelopeSet = envelopes({
      site: site.ring,
      cutters: limits.cutters,
      sun,
      height: cap.height,
      sectionAt: sectionHeights(plan, cap.height),
      sides: limits.sides,
    });
    const rules = [
      ...new Set([
        ...limits.cutters.map((c) => ruleOf(c.rule).title),
        ...(sun ? ['정북 일조(지면)', '일조 사선'] : []),
        '높이 제한',
      ]),
    ].join(', ');
    for (const e of set.envelopes)
      items.push({
        key: `env:${id}:${e.kind}`,
        kind: `${ENVELOPE_TITLES[e.kind]} (${VARIANT_TITLES[id]})`,
        faces: e.faces.faces,
        volume: e.faces.volume,
        volumeText: e.faces.volume.toFixed(3),
        rules: `${rules}; 높이 상한 ${r6(cap.height)} m(${cap.source}); ${ENVELOPE_NOTE}`,
        unconfirmed: String(unconfirmed),
      });
    return {
      id,
      title: VARIANT_TITLES[id],
      height: r6(cap.height),
      heightSource: cap.source,
      sunApplied: !!sun,
      envelopes: set.envelopes.map((e) => ({
        kind: e.kind,
        title: ENVELOPE_TITLES[e.kind],
        volume: r6(e.check.volume),
        faces: e.faces.faces.length,
        polygons: e.check.polygons,
        check: {
          ok: e.check.ok,
          reasons: e.check.reasons,
          warnings: e.check.warnings,
          shortestEdge: e.check.shortestEdge,
        },
      })),
      sections: set.sections.map((s) => ({
        z: r6(s.z),
        extrude: r6(s.extrude),
        max: r6(s.max),
        sunCut: r6(s.extrude - s.max),
      })),
      sunCutVolume: r6(set.sunCutVolume),
      /** The checked maximum envelope as a welded mesh: the floors step cuts it (T-211). */
      maxMesh: set.envelopes.find((e) => e.kind === 'max')!.mesh,
    };
  });
  return { variants, items, unresolved, unconfirmed, note: ENVELOPE_NOTE, study: STUDY_NOTE };
}

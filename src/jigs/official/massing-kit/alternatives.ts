// 대안 (SPEC-12.10 2~4·7, PLAN-45 T-211): the closed list of alternatives — 최대 · 기준 용적률 ·
// 인센티브 반영 · 공개공지 반영 · 사람 수정 — made from the floor outlines of the maximum envelope,
// at most 8 per work copy, and their table. The only arithmetic is: areas of the outlines, the
// person's 제외 면적, 용적률 = 산정 면적 ÷ 대지면적, and the target 용적률 the 규제 조건 items give
// (기준, 기준 + 완화량, capped by 상한 when one is entered). Two ways take area away when a target is
// below what the envelope holds: 'shrink-top' (위층부터: whole floors while the excess covers them,
// then the next floor cut back from the north side) and 'drop-floors' (위층부터 층을 통째로).
// Limits are verdicts ('초과'); they never stop the flow (SPEC-07.2).

import type { Vec2 } from '../geometry-kit/plan.ts';
import type { Solid } from '../geometry-kit/solid.ts';
import { floorFits, regionsArea, subtractRegions, trimRegions, unionArea } from './floors.ts';
import { requirePolygon } from '../geometry-kit/plan.ts';
import { itemOf, itemsOf, numberOf, type RegulationItem, type StepOverride } from './rules.ts';
import type { PlanRegion } from './setback.ts';

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** 한 작업본의 대안 상한 (SPEC-12.10 2). */
export const ALTERNATIVE_MAX = 8;
export type AlternativeKind = 'max' | 'base' | 'incentive' | 'open-space' | 'human';
export type TrimMethod = 'shrink-top' | 'drop-floors';
export const TRIM_TITLES: Record<TrimMethod, string> = {
  'shrink-top': '위층 축소(정북 쪽부터)',
  'drop-floors': '층수 줄이기',
};

export interface FloorShape {
  floor: string;
  index: number;
  z0: number;
  z1: number;
  regions: PlanRegion[];
  area: number;
}

export interface AltFloor extends FloorShape {
  /** 제외 면적 (사람 입력, SPEC-12.10 4) and its 근거. */
  exclusion: number;
  exclusionBasis: string;
  /** 용적률 산정 면적 = 바닥면적 − 제외 면적 (≥ 0). Basements: 0. */
  farArea: number;
  /** How this floor differs from the envelope floor: '축소', '사람 수정', '공개공지 뺌'. */
  change: string;
  /** Human-edited outline outside the envelope. */
  outside?: boolean;
}

export interface Alternative {
  id: string;
  kind: AlternativeKind;
  title: string;
  flags: string[];
  /** 목표 용적률 and where it comes from (null = none, the envelope only). */
  farTarget: number | null;
  farTargetSource: string;
  floors: AltFloor[];
  basement: AltFloor[];
  notes: string[];
  /** 공개공지 candidate row the alternative keeps open (open-space). */
  openSpace?: { no: number; id: string; area: number };
}

export interface AlternativeRow {
  id: string;
  title: string;
  flags: string;
  buildingArea: number;
  coverage: number;
  coverageCap: number | null;
  coverageVerdict: '적합' | '초과' | '상한 없음';
  coverageMargin: number | null;
  gfaAbove: number;
  gfaBelow: number;
  gfaTotal: number;
  exclusion: number;
  farArea: number;
  far: number;
  farTarget: number | null;
  farTargetSource: string;
  farCeiling: number | null;
  farCeilingSource: string;
  farVerdict: '적합' | '초과' | '상한 없음';
  farMargin: number | null;
  floorsAbove: number;
  floorsBelow: number;
  height: number;
  unconfirmed: number;
}

/** Exclusions per floor from the 수정 사항 `{kind: 'floor-exclusion', identity: {floor}}`. */
export function exclusionsOf(overrides: readonly StepOverride[]) {
  const out = new Map<string, { area: number; basis: string }>();
  const problems: string[] = [];
  for (const o of overrides) {
    if (o?.target?.kind !== 'floor-exclusion' || o.op !== 'set') continue;
    const floor = String(o.target.identity.floor ?? '');
    const area = Number(o.fields.area);
    if (!floor || !Number.isFinite(area) || area < 0) {
      problems.push(`제외 면적 ${floor || '(층 없음)'}: 0 이상의 면적이 필요합니다`);
      continue;
    }
    if (o.by === 'ai') {
      problems.push(`제외 면적 ${floor}: AI가 제안한 값은 사람이 받아야 들어갑니다`);
      continue;
    }
    const basis = typeof o.fields.basis === 'string' ? o.fields.basis : '';
    out.set(floor, { area, basis });
  }
  return { exclusions: out, problems };
}

function withExclusions(
  floors: readonly FloorShape[],
  exclusions: Map<string, { area: number; basis: string }>,
  below: boolean,
): AltFloor[] {
  return floors.map((f) => {
    const ex = exclusions.get(f.floor);
    const exclusion = ex ? Math.min(ex.area, f.area) : 0;
    return {
      ...f,
      exclusion: r6(exclusion),
      exclusionBasis: ex ? ex.basis || '근거 없음' : '',
      farArea: below ? 0 : r6(Math.max(0, f.area - exclusion)),
      change: '',
    };
  });
}

const farAreaOf = (floors: readonly AltFloor[]) => floors.reduce((s, f) => s + f.farArea, 0);

/**
 * Take area away from the top until the 용적률 산정 면적 is at most `cap` (㎡). Returns new floors
 * (regions trimmed with the solid booleans) and a note.
 */
export function trimToCap(
  floors: readonly AltFloor[],
  cap: number,
  method: TrimMethod,
  north: Vec2,
): { floors: AltFloor[]; note: string } {
  const total = farAreaOf(floors);
  let excess = total - cap;
  if (!(excess > 1e-6))
    return {
      floors: [...floors],
      note: `외피가 먼저 막음 — 목표 대비 여유 ${r6(cap - total)} ㎡`,
    };
  const out = [...floors];
  for (let i = out.length - 1; i >= 0 && excess > 1e-6; i--) {
    const f = out[i];
    if (method === 'drop-floors' || f.farArea <= excess + 1e-6) {
      excess -= f.farArea;
      out.splice(i, 1);
      continue;
    }
    const target = f.area - excess;
    const trimmed = trimRegions(f.regions, target, north);
    const area = r6(trimmed.area);
    out[i] = {
      ...f,
      regions: trimmed.regions,
      area,
      exclusion: Math.min(f.exclusion, area),
      farArea: r6(Math.max(0, area - Math.min(f.exclusion, area))),
      change: '축소',
    };
    excess = 0;
  }
  const kept = farAreaOf(out);
  return {
    floors: out,
    note: `${TRIM_TITLES[method]} — 산정 면적 ${r6(total)} → ${r6(kept)} ㎡ (목표 ${r6(cap)} ㎡)`,
  };
}

/** Target 용적률 items (SPEC-12.10 2) read from the 규제 조건. */
export function farTargets(items: readonly RegulationItem[]) {
  const base = itemOf(items, 'farBase');
  const max = itemOf(items, 'farMax');
  const baseValue = numberOf(base);
  const maxValue = numberOf(max);
  const incentives = itemsOf(items, 'incentiveFar').filter(
    (i) => (i.applies === '적용' || i.applies === '판단 필요') && typeof i.value === 'number',
  );
  const capped = (value: number) => (maxValue !== null && value > maxValue ? maxValue : value);
  return { base, max, baseValue, maxValue, incentives, capped };
}

/** The loosest entered 용적률 ceiling (상한 → 허용 → 기준) for the verdict. */
function farCeiling(items: readonly RegulationItem[]) {
  for (const id of ['farMax', 'farAllowed', 'farBase'] as const) {
    const item = itemOf(items, id);
    const v = numberOf(item);
    if (v !== null) return { value: v, source: item.title };
  }
  return { value: null, source: '용적률 사람 입력 필요' };
}

export interface AlternativeInput {
  floors: FloorShape[];
  basement: FloorShape[];
  siteArea: number;
  north: Vec2;
  items: readonly RegulationItem[];
  method: TrimMethod;
  /** The 공개공지 candidate the open-space alternative keeps open (null = none). */
  openSpace: { no: number; id: string; regions: PlanRegion[]; area: number } | null;
  openSpaceState: 'required' | 'none' | 'needs-input';
  humanBase: Exclude<AlternativeKind, 'human'>;
  overrides: readonly StepOverride[];
  /** The maximum envelope (for the human outlines' verdict). */
  envelope: Solid | null;
}

/** Human outlines from `{kind: 'mass-floor', identity: {alternative, floor}}` 수정 사항. */
function humanEdits(overrides: readonly StepOverride[]) {
  const byAlt = new Map<string, { floor: string; op: string; regions: PlanRegion[] | null }[]>();
  const problems: string[] = [];
  for (const o of overrides) {
    if (o?.target?.kind !== 'mass-floor') continue;
    const alt = String(o.target.identity.alternative ?? '');
    const floor = String(o.target.identity.floor ?? '');
    if (!/^human-[1-9]$/.test(alt) || !floor) {
      problems.push(`사람 수정: 대안(human-1…)과 층이 필요합니다 (${alt}/${floor})`);
      continue;
    }
    if (o.by === 'ai') {
      problems.push(`사람 수정 ${alt} ${floor}: AI가 제안한 수정은 사람이 받아야 들어갑니다`);
      continue;
    }
    const list = byAlt.get(alt) ?? byAlt.set(alt, []).get(alt)!;
    if (o.op === 'remove') list.push({ floor, op: 'remove', regions: null });
    else if (o.op === 'set') {
      try {
        const outline = (o.fields.outline as unknown[]).map(
          (p) => [Number((p as number[])[0]), Number((p as number[])[1])] as Vec2,
        );
        const holes = Array.isArray(o.fields.holes)
          ? (o.fields.holes as unknown[][]).map((h) =>
              requirePolygon(
                h.map((p) => [Number((p as number[])[0]), Number((p as number[])[1])] as Vec2),
                '구멍',
              ),
            )
          : [];
        const outer = requirePolygon(outline, '윤곽');
        const ccw = (r: Vec2[], sign: number) => {
          const a = r.reduce(
            (s, p, i) => s + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1],
            0,
          );
          return Math.sign(a) === sign ? r : [...r].reverse();
        };
        list.push({
          floor,
          op: 'set',
          regions: [{ outer: ccw(outer, 1), holes: holes.map((h) => ccw(h, -1)) }],
        });
      } catch (error) {
        problems.push(
          `사람 수정 ${alt} ${floor}: 윤곽이 올바른 다각형이 아닙니다 (${(error as Error).message})`,
        );
      }
    }
  }
  return { byAlt, problems };
}

/**
 * The alternatives (SPEC-12.10 2): 최대 always; 기준 용적률 when the item has a value; 인센티브 반영
 * when an incentive applies; 공개공지 반영 when the site needs one and a candidate is picked; 사람
 * 수정 for each `human-k` the 수정 사항 name. Alternatives that cannot be made are listed with the
 * reason in `skipped`.
 */
export function makeAlternatives(input: AlternativeInput) {
  const { exclusions, problems } = exclusionsOf(input.overrides);
  const above = withExclusions(input.floors, exclusions, false);
  const basement = withExclusions(input.basement, exclusions, true);
  const t = farTargets(input.items);
  const site = input.siteArea;
  const alternatives: Alternative[] = [];
  const skipped: { id: string; title: string; reason: string }[] = [];

  alternatives.push({
    id: 'max',
    kind: 'max',
    title: '최대(참고용)',
    flags: [],
    farTarget: null,
    farTargetSource: '없음 — 외피의 층별 윤곽 그대로',
    floors: above,
    basement,
    notes: ['층별 가능 윤곽을 그대로 씀(참고용)'],
  });

  if (t.baseValue === null)
    skipped.push({ id: 'base', title: '기준 용적률', reason: `${t.base.title} 사람 입력 필요` });
  else {
    const cut = trimToCap(above, t.baseValue * site, input.method, input.north);
    alternatives.push({
      id: 'base',
      kind: 'base',
      title: '기준 용적률',
      flags: t.base.applies === '판단 필요' ? ['조건 미확정'] : [],
      farTarget: t.baseValue,
      farTargetSource: t.base.title,
      floors: cut.floors,
      basement,
      notes: [cut.note],
    });
  }

  if (t.baseValue === null) {
    if (t.incentives.length)
      skipped.push({
        id: 'incentive',
        title: '인센티브 반영',
        reason: `${t.base.title} 사람 입력 필요`,
      });
    else
      skipped.push({
        id: 'incentive',
        title: '인센티브 반영',
        reason: '적용할 인센티브 없음(사람 입력 필요)',
      });
  } else if (!t.incentives.length)
    skipped.push({
      id: 'incentive',
      title: '인센티브 반영',
      reason: '적용할 인센티브 없음(사람 입력 필요)',
    });
  else {
    const sum = t.incentives.reduce((s, i) => s + (i.value as number), 0);
    const target = t.capped(t.baseValue + sum);
    const undecided = t.incentives.some((i) => i.applies === '판단 필요');
    const cut = trimToCap(above, target * site, input.method, input.north);
    const names = t.incentives.map((i) => `${i.target ?? i.title} +${r6(i.value as number)}`);
    const heights = itemsOf(input.items, 'incentiveHeight').filter((i) => numberOf(i) !== null);
    alternatives.push({
      id: 'incentive',
      kind: 'incentive',
      title: undecided ? '인센티브 반영 (조건 미확정)' : '인센티브 반영',
      flags: undecided ? ['조건 미확정'] : [],
      farTarget: r6(target),
      farTargetSource: `${t.base.title} + ${names.join(', ')}${t.maxValue !== null && t.baseValue + sum > t.maxValue ? ` → ${t.max.title}까지` : ''}`,
      floors: cut.floors,
      basement,
      notes: [
        cut.note,
        ...heights.map(
          (h) =>
            `높이 완화 ${r6(numberOf(h)!)} m는 외피에 넣지 않았습니다 — 높이 상한 설정에 더해 외피를 다시 계산하세요`,
        ),
      ],
    });
  }

  if (input.openSpaceState === 'none')
    skipped.push({
      id: 'open-space',
      title: '공개공지 반영',
      reason: '공개공지 대상 아님(미적용)',
    });
  else if (input.openSpaceState === 'needs-input')
    skipped.push({
      id: 'open-space',
      title: '공개공지 반영',
      reason: '공개공지 대상 여부·비율 사람 입력 필요',
    });
  else if (!input.openSpace)
    skipped.push({
      id: 'open-space',
      title: '공개공지 반영',
      reason: '공개공지 후보 없음 — 영역을 그려 주세요',
    });
  else {
    const os = input.openSpace;
    const opened = above
      .map((f) => {
        const regions = subtractRegions(f.regions, os.regions);
        const area = r6(regionsArea(regions));
        const exclusion = Math.min(f.exclusion, area);
        return {
          ...f,
          regions,
          area,
          exclusion,
          farArea: r6(Math.max(0, area - exclusion)),
          change: area < f.area - 1e-6 ? '공개공지 뺌' : '',
        };
      })
      .filter((f) => f.area > 1e-6);
    const osItem = itemOf(input.items, 'openSpaceIncentiveFar');
    const osValue = numberOf(osItem);
    const notes: string[] = [`공개공지 후보 ${os.no} (${r6(os.area)} ㎡) 위에는 매스를 두지 않음`];
    let target: number | null = null,
      source = '없음 — 외피에서 공개공지만 뺌';
    if (t.baseValue !== null) {
      target = t.capped(t.baseValue + (osValue ?? 0));
      source =
        osValue === null
          ? `${t.base.title} (공개공지 완화량 사람 입력 필요)`
          : `${t.base.title} + ${osItem.title} ${r6(osValue)}`;
    } else notes.push(`${t.base.title} 사람 입력 필요 — 덜어 내지 않음`);
    let floors = opened;
    if (target !== null) {
      const cut = trimToCap(opened, target * site, input.method, input.north);
      floors = cut.floors;
      notes.push(cut.note);
    }
    const undecided =
      osItem.applies === '판단 필요' ||
      itemOf(input.items, 'publicOpenSpace').applies === '판단 필요';
    alternatives.push({
      id: 'open-space',
      kind: 'open-space',
      title: undecided ? '공개공지 반영 (조건 미확정)' : '공개공지 반영',
      flags: undecided ? ['조건 미확정'] : [],
      farTarget: target === null ? null : r6(target),
      farTargetSource: source,
      floors,
      basement,
      notes,
      openSpace: { no: os.no, id: os.id, area: os.area },
    });
  }

  const human = humanEdits(input.overrides);
  problems.push(...human.problems);
  for (const [id, edits] of [...human.byAlt.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const from =
      alternatives.find((a) => a.kind === input.humanBase) ??
      alternatives.find((a) => a.kind === 'max')!;
    const byFloor = new Map(from.floors.map((f) => [f.floor, f]));
    const notes = [`${from.title}에서 시작`];
    let outside = false;
    for (const e of edits) {
      const f = byFloor.get(e.floor);
      if (!f) {
        problems.push(`${id}: ${from.title}에 ${e.floor}가 없습니다`);
        continue;
      }
      if (e.op === 'remove') {
        byFloor.delete(e.floor);
        notes.push(`${e.floor} 뺌`);
        continue;
      }
      const regions = e.regions!;
      const area = r6(regionsArea(regions));
      const out = input.envelope ? !floorFits(input.envelope, regions, f.z0, f.z1) : false;
      outside ||= out;
      const exclusion = Math.min(f.exclusion, area);
      byFloor.set(e.floor, {
        ...f,
        regions,
        area,
        exclusion,
        farArea: r6(Math.max(0, area - exclusion)),
        change: '사람 수정',
        ...(out ? { outside: true } : {}),
      });
    }
    alternatives.push({
      id,
      kind: 'human',
      title: `사람 수정 ${id.slice(6)}`,
      flags: outside ? ['외피 밖'] : [],
      farTarget: from.farTarget,
      farTargetSource: from.farTargetSource,
      floors: from.floors.filter((f) => byFloor.has(f.floor)).map((f) => byFloor.get(f.floor)!),
      basement,
      notes,
    });
  }

  if (alternatives.length > ALTERNATIVE_MAX) {
    for (const a of alternatives.splice(ALTERNATIVE_MAX))
      skipped.push({ id: a.id, title: a.title, reason: `대안은 ${ALTERNATIVE_MAX}개까지` });
  }
  return { alternatives, skipped, problems };
}

/** One table row (SPEC-12.10 3). */
export function alternativeRow(
  alt: Alternative,
  siteArea: number,
  items: readonly RegulationItem[],
  unconfirmed: number,
): AlternativeRow {
  const coverageItem = itemOf(items, 'coverage');
  const coverageCap = numberOf(coverageItem);
  const buildingArea = r6(unionArea(alt.floors.map((f) => f.regions)));
  const gfaAbove = r6(alt.floors.reduce((s, f) => s + f.area, 0));
  const gfaBelow = r6(alt.basement.reduce((s, f) => s + f.area, 0));
  const exclusion = r6(alt.floors.reduce((s, f) => s + f.exclusion, 0));
  const farArea = r6(alt.floors.reduce((s, f) => s + f.farArea, 0));
  const far = siteArea > 0 ? farArea / siteArea : 0;
  const ceiling = farCeiling(items);
  const capArea = coverageCap === null ? null : coverageCap * siteArea;
  return {
    id: alt.id,
    title: alt.title,
    flags: alt.flags.join(', '),
    buildingArea,
    coverage: r6(siteArea > 0 ? buildingArea / siteArea : 0),
    coverageCap,
    coverageVerdict:
      capArea === null ? '상한 없음' : buildingArea > capArea + 1e-6 ? '초과' : '적합',
    coverageMargin: capArea === null ? null : r6(capArea - buildingArea),
    gfaAbove,
    gfaBelow,
    gfaTotal: r6(gfaAbove + gfaBelow),
    exclusion,
    farArea,
    far: r6(far),
    farTarget: alt.farTarget,
    farTargetSource: alt.farTargetSource,
    farCeiling: ceiling.value,
    farCeilingSource: ceiling.source,
    farVerdict: ceiling.value === null ? '상한 없음' : far > ceiling.value + 1e-9 ? '초과' : '적합',
    farMargin: ceiling.value === null ? null : r6(ceiling.value * siteArea - farArea),
    floorsAbove: alt.floors.length,
    floorsBelow: alt.basement.length,
    height: r6(alt.floors.reduce((h, f) => Math.max(h, f.z1), 0)),
    unconfirmed: unconfirmed + (alt.flags.includes('조건 미확정') ? 1 : 0),
  };
}

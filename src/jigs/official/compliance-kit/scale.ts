// 규모 (SPEC-15.6, PLAN-48 T-238): 건폐율, 용적률 (the massing-kit `farTargets` ladder), 높이 (one
// row per item, `incentiveHeight` never a reason for 적합) and 층수. Every limit is a 규제 조건 item
// read by SPEC-15.5 6; the only numbers here are the plan values measured from the model.

import type {
  ComplianceCheckId,
  ComplianceRoleName,
  ComplianceState,
  NumberSource,
} from '../../../contracts/compliance.ts';
import { unionArea } from '../massing-kit/floors.ts';
import type { PlanRegion } from '../massing-kit/setback.ts';
import { heightBuilding } from './building.ts';
import type { Ctx } from './context.ts';
import { LEVEL_TOL, projectionRegions, sliceAbove } from './geometry.ts';
import type { FloorTable } from './ground.ts';
import { numOf, readAll, readLimit, titleOf, type LimitRead } from './limits-read.ts';
import {
  AXIS_REASONS,
  casesOf,
  combine,
  draft,
  product,
  setState,
  useItems,
  worstOf,
  type Outcome,
  type RowDraft,
} from './verdict.ts';

export interface NotApplicableEntry {
  check: ComplianceCheckId;
  id: string;
  title: string;
  basis: string;
}
export type CheckOut = { row: RowDraft } | { na: NotApplicableEntry };

export const naOf = (check: ComplianceCheckId, read: LimitRead): { na: NotApplicableEntry } => ({
  na: {
    check,
    id: read.id.slice(0, 60),
    title: (read.target ? `${read.title}(${read.target})` : read.title).slice(0, 120),
    basis: (read.item?.basis?.clause?.trim() || '근거 없음').slice(0, 400),
  },
});

type AxisValue = { key: string; label: string };
interface Axis {
  name: string;
  values: AxisValue[];
}
type Picks = Record<string, AxisValue>;
interface Judged {
  state: ComplianceState;
  reason?: string;
  /** The limit this reading compared against (for the 경우 list). */
  limit?: number | null;
}

interface PartOut {
  read: LimitRead;
  state: ComplianceState;
  reasons: string[];
  outcomes: Outcome[];
}

/**
 * An upper-limit row: planned ≤ limit is 적합, by every reading of `axes` (경우), for every item of
 * the check (구간). A '판단 필요' 적용 여부 adds the reading without the limit; a '판단 필요' value
 * never decides 적합 or 위반 (SPEC-15.5 6).
 */
function upperRow(
  r: RowDraft,
  reads: readonly LimitRead[],
  axes: Axis[],
  plannedOf: (picks: Picks) => number,
  judge: (planned: number, limit: number) => Judged,
  unit: string,
  axisReasons: Record<string, string> = AXIS_REASONS,
) {
  const parts: PartOut[] = reads.map((read) => {
    if (read.kind === 'none')
      return { read, state: '사람 입력 필요', reasons: [read.reason], outcomes: [] };
    const L = numOf(read);
    if (L === null)
      return {
        read,
        state: '사람 입력 필요',
        reasons: [`${read.title}: 숫자 값이 아님`],
        outcomes: [],
      };
    const limitAxis: Axis = {
      name: 'limit',
      values:
        read.kind === 'undecided-applies'
          ? [
              { key: 'in', label: `${read.title} 적용` },
              { key: 'out', label: `${read.title} 미적용` },
            ]
          : [],
    };
    const outcomes: Outcome[] = product<AxisValue>([...axes, limitAxis]).map((c) => {
      const planned = plannedOf(c.picks);
      const limit = c.keys.limit === 'out' ? null : L;
      const j: Judged = limit === null ? { state: '적합' } : judge(planned, limit);
      return {
        label: c.labels.join(' · ') || '계산',
        keys: c.keys,
        state: j.state,
        planned,
        limit: j.limit !== undefined ? j.limit : limit,
        reason: j.reason,
      };
    });
    let { state, reasons } = combine(outcomes, { ...axisReasons, limit: read.reason });
    if (read.kind === 'undecided-value' && (state === '적합' || state === '위반')) {
      state = '판단 필요';
      reasons = [read.reason];
    }
    return { read, state, reasons, outcomes };
  });
  const all = parts.flatMap((p) => p.outcomes);
  const planned = all.length ? Math.max(...all.map((o) => o.planned ?? -Infinity)) : null;
  if (planned !== null && Number.isFinite(planned)) r.planned = { value: planned, unit };
  const valued = parts
    .map((p) => ({ p, v: numOf(p.read) }))
    .filter((x): x is { p: PartOut; v: number } => x.v !== null && x.p.read.kind !== 'none')
    .sort((a, b) => a.v - b.v);
  if (valued.length) r.limit = { value: valued[0].v, unit, read: valued[0].p.read };
  if (parts.length === 1) {
    const [p] = parts;
    setState(r, p.state, ...p.reasons);
    r.cases = casesOf(p.outcomes);
    return;
  }
  r.parts = parts.map((p) => {
    const ps = p.outcomes.map((o) => o.planned ?? -Infinity);
    return {
      label: (p.read.target ?? p.read.title).slice(0, 120),
      target: p.read.target?.slice(0, 80) ?? null,
      state: p.state,
      planned: ps.length && Number.isFinite(Math.max(...ps)) ? Math.max(...ps) : null,
      limit: numOf(p.read),
      reason: (p.reasons.join('; ') || (p.state === '적합' ? '' : p.state)).slice(0, 300),
    };
  });
  const state = worstOf(parts.map((p) => p.state));
  setState(
    r,
    state,
    ...parts
      .filter((p) => p.state !== '적합')
      .flatMap((p) => p.reasons.map((x) => `${p.read.target ?? p.read.title}: ${x}`)),
  );
}

const groundAxis = (ctx: Ctx): Axis => ({
  name: 'ground',
  values: ctx.grounds.length > 1 ? ctx.grounds.map((g) => ({ key: g.key, label: g.label })) : [],
});
const siteAxis = (ctx: Ctx): Axis => ({
  name: 'site',
  values:
    ctx.siteAreas.length > 1 ? ctx.siteAreas.map((s) => ({ key: s.key, label: s.label })) : [],
});
const siteArea = (ctx: Ctx, picks: Picks) =>
  ctx.siteAreas.find((s) => s.key === picks.site?.key)?.value ?? ctx.siteAreas[0].value;
const groundOf = (ctx: Ctx, picks: Picks) =>
  ctx.grounds.find((g) => g.key === picks.ground?.key) ?? ctx.grounds[0];

function siteNumbers(ctx: Ctx): NumberSource[] {
  return ctx.siteAreas.map((s) => ({
    label: s.label.slice(0, 120),
    value: s.value,
    unit: '㎡',
    kind: '대지' as const,
    ref: s.key,
  }));
}

const regionsOf = (ctx: Ctx, role: ComplianceRoleName): PlanRegion[] =>
  ctx.objs(role).flatMap((o) => (o.shape.kind === 'region' ? [o.shape.region] : []));

// ── 건폐율 ──────────────────────────────────────────────────────────────────────────────────────

export function coverage(ctx: Ctx): CheckOut {
  const r = draft('coverage', '건폐율', ['building-area', 'mass', 'rooftop', 'floor']);
  if (!ctx.limits) return { row: setState(r, '사람 입력 필요', ctx.limitsMissing) };
  const lim = readLimit(ctx.regs, 'coverage');
  if (lim.kind === 'na') return naOf('coverage', lim);
  useItems(r, [lim], '비율');
  if (!ctx.unitsKnown) return { row: setState(r, '검사 불가', '문서 단위 모름') };
  r.numbers.push(...siteNumbers(ctx));
  const outlines = regionsOf(ctx, 'building-area');
  const masses = [...ctx.objs('mass'), ...ctx.objs('rooftop')]
    .map((o) => ({ o, s: ctx.solids.get(o.objectId) }))
    .filter((x) => x.s?.ok);
  const floors = ctx.objs('floor');
  const projectionAt = (g: (typeof ctx.grounds)[number]) => {
    const lists: PlanRegion[][] = masses.map((x) => projectionRegions(sliceAbove(x.s!, g.local)));
    for (const o of floors) {
      if (o.shape.kind === 'region') {
        const above = o.floor ? !o.floor.startsWith('B') : o.shape.z >= g.local - LEVEL_TOL;
        if (above) lists.push([o.shape.region]);
      } else if (o.shape.kind === 'solid') {
        const s = ctx.solids.get(o.objectId);
        if (s?.ok) lists.push(projectionRegions(sliceAbove(s, g.local)));
      }
    }
    return unionArea(lists.filter((l) => l.length));
  };
  let area: Axis;
  const areaOf = new Map<string, number>();
  let projection = false;
  if (outlines.length) {
    const a = unionArea([outlines]);
    areaOf.set('outline', a);
    area = { name: 'area', values: [{ key: 'outline', label: '' }] };
    r.objectIds.push(...ctx.objs('building-area').map((o) => o.objectId));
    r.numbers.push({
      label: '건축면적(윤곽)',
      value: a,
      unit: '㎡',
      kind: '모델',
      ref: 'model:building-area',
      note: '사람이 그린 건축면적 윤곽의 합집합',
    });
    if (masses.length)
      for (const g of ctx.grounds) {
        const extra =
          unionArea([
            outlines,
            ...masses.map((x) => projectionRegions(sliceAbove(x.s!, g.local))),
          ]) - a;
        if (extra > 1e-6)
          r.numbers.push({
            label: `수평투영이 윤곽 밖으로 나간 면적(${g.label})`,
            value: extra,
            unit: '㎡',
            kind: '모델',
            ref: 'model:mass',
            note: '판정에는 윤곽을 씀',
          });
      }
  } else {
    if (!masses.length && !floors.length)
      return { row: setState(r, '검사 불가', '건물 매스·층 윤곽 없음') };
    if (!ctx.grounds.length) return { row: setState(r, '사람 입력 필요', '기준 지반 높이') };
    projection = true;
    r.numbers.push(...ctx.groundNumbers);
    r.objectIds.push(...masses.map((x) => x.o.objectId), ...floors.map((o) => o.objectId));
    for (const g of ctx.grounds) {
      const a = projectionAt(g);
      areaOf.set(g.key, a);
      r.numbers.push({
        label: `건축면적(수평투영, ${g.label})`,
        value: a,
        unit: '㎡',
        kind: '모델',
        ref: 'model:mass',
        note: '수평투영 · 산정 예외 미반영',
      });
    }
    area = groundAxis(ctx);
    if (!area.values.length)
      area = { name: 'ground', values: [{ key: ctx.grounds[0].key, label: '' }] };
  }
  if (lim.kind === 'none') {
    const a = [...areaOf.values()][0];
    r.planned = { value: a / ctx.siteAreas[0].value, unit: '비율' };
    return { row: setState(r, '사람 입력 필요', lim.reason) };
  }
  upperRow(
    r,
    [lim],
    [area, siteAxis(ctx)],
    (p) => (areaOf.get(p[area.name]?.key ?? '') ?? [...areaOf.values()][0]) / siteArea(ctx, p),
    (planned, limit) => ({ state: planned <= limit ? '적합' : '위반' }),
    '비율',
  );
  if (projection && r.state !== '적합' && r.state !== '사람 입력 필요' && r.state !== '검사 불가') {
    r.state = '판단 필요';
    r.reasons.push('건축면적이 수평투영(산정 예외 미반영) — 건축면적 윤곽을 그리면 다시 체크');
  }
  return { row: r };
}

// ── 높이 ────────────────────────────────────────────────────────────────────────────────────────

export const HEIGHT_ITEMS = ['heightMax', 'streetHeight', 'altitudeHeight'] as const;

export function height(ctx: Ctx, id: (typeof HEIGHT_ITEMS)[number]): CheckOut {
  const r = draft(`height:${id}`, `높이 — ${titleOf(id)}`, ['mass', 'floor', 'rooftop']);
  if (!ctx.limits) return { row: setState(r, '사람 입력 필요', ctx.limitsMissing) };
  const reads = readAll(ctx.regs, id);
  const active = reads.filter((x) => x.kind !== 'na');
  if (!active.length) return naOf(`height:${id}`, reads[0]);
  useItems(r, active, 'm');
  if (!ctx.unitsKnown) return { row: setState(r, '검사 불가', '문서 단위 모름') };
  const b = heightBuilding(ctx);
  if (b.failed.length) {
    r.objectIds.push(...b.failed);
    return {
      row: setState(r, '검사 불가', `형상 연산 실패(닫힌 솔리드 점검 실패 ${b.failed.length}개)`),
    };
  }
  if (!b.parts.length && !b.rooftops.length)
    return { row: setState(r, '검사 불가', '건물 매스·층 윤곽 없음') };
  if (!ctx.grounds.length) return { row: setState(r, '사람 입력 필요', '기준 지반 높이') };
  r.numbers.push(...ctx.groundNumbers);
  r.unconfirmed.push(...b.notes.filter((n) => n !== '층 윤곽으로 만든 형상'));
  r.objectIds.push(...b.parts.map((p) => p.objectId), ...b.rooftops.map((p) => p.objectId));
  const relief = readAll(ctx.regs, 'incentiveHeight').filter((x) => numOf(x) !== null);
  const reliefSum = relief.reduce((s, x) => s + numOf(x)!, 0);
  if (relief.length) useItems(r, relief, 'm');
  const top = (parts: typeof b.parts) =>
    parts.length ? Math.max(...parts.map((p) => p.solid.box.max[2])) : -Infinity;
  const mainTop = top(b.parts),
    roofTop = top(b.rooftops);
  for (const g of ctx.grounds)
    r.numbers.push({
      label: `건물 최고점 − 기준 지반(${g.label})`,
      value: (b.parts.length ? mainTop : roofTop) - g.local,
      unit: 'm',
      kind: '모델',
      ref: 'model:mass',
      ...(b.fromFloors ? { note: '가정 층고로 만든 높이' } : {}),
    });
  const roof: Axis = {
    name: 'roof',
    values:
      b.rooftops.length && b.parts.length
        ? [
            { key: 'out', label: '옥탑 등 제외' },
            { key: 'in', label: '옥탑 등 포함' },
          ]
        : [],
  };
  upperRow(
    r,
    active,
    [groundAxis(ctx), roof],
    (p) => {
      const g = groundOf(ctx, p);
      const t = !b.parts.length || p.roof?.key === 'in' ? Math.max(mainTop, roofTop) : mainTop;
      return t - g.local;
    },
    (planned, limit) => {
      if (planned <= limit) return { state: '적합' };
      if (reliefSum > 0 && planned <= limit + reliefSum)
        return { state: '판단 필요', reason: '높이 완화 적용 미확정', limit };
      return { state: '위반', limit };
    },
    'm',
    { ...AXIS_REASONS, roof: '옥탑 등의 높이 산입 여부' },
  );
  return { row: r };
}

// ── 층수 ────────────────────────────────────────────────────────────────────────────────────────

export function floorsRow(ctx: Ctx): CheckOut {
  const r = draft('floors', '지상 층수', ['floor', 'rooftop']);
  if (!ctx.limits) return { row: setState(r, '사람 입력 필요', ctx.limitsMissing) };
  const reads = readAll(ctx.regs, 'floorsMax');
  const active = reads.filter((x) => x.kind !== 'na');
  if (!active.length) return naOf('floors', reads[0]);
  useItems(r, active, '층');
  const floors = ctx.objs('floor');
  if (!floors.length) return { row: setState(r, '검사 불가', '층 윤곽 없음') };
  if (!ctx.unitsKnown && floors.some((o) => !o.floor))
    return { row: setState(r, '검사 불가', '문서 단위 모름(이름 없는 층 윤곽)') };
  const ft = ctx.floorTables();
  if (ft.needsGround) return { row: setState(r, '사람 입력 필요', '기준 지반 높이') };
  r.objectIds.push(...floors.map((o) => o.objectId));
  const stats = ft.tables.map((t) => {
    const above = t.floors.filter((f) => f.above);
    return {
      t,
      max: above.length ? Math.max(...above.map((f) => f.index)) : 0,
      count: above.length,
    };
  });
  const gaps = stats.some((s) => s.max !== s.count);
  if (gaps) r.unconfirmed.push('층 번호가 이어지지 않음');
  if (ft.tables.some((t) => t.floors.some((f) => f.byHeight)))
    r.unconfirmed.push('이름 없는 층 윤곽은 높이 순서로 층 이름을 붙임(도구로 계산함)');
  const rooftops = ctx.objs('rooftop');
  r.objectIds.push(...rooftops.map((o) => o.objectId));
  for (const s of stats)
    r.numbers.push({
      label: `지상 층수${s.t.ground ? `(${s.t.ground.label})` : ''}`,
      value: s.max,
      unit: '층',
      kind: '모델',
      ref: 'model:floor',
      note: `가장 큰 지상 번호 ${s.max} · 지상 층 이름 ${s.count}개`,
    });
  const tableAxis: Axis = {
    name: 'ground',
    values:
      ft.tables.length > 1
        ? ft.tables.map((t) => ({ key: t.ground!.key, label: t.ground!.label }))
        : [],
  };
  const statOf = (p: Picks) => stats.find((s) => s.t.ground?.key === p.ground?.key) ?? stats[0];
  upperRow(
    r,
    active,
    [
      tableAxis,
      {
        name: 'floors',
        values: gaps
          ? [
              { key: 'max', label: '가장 큰 번호' },
              { key: 'count', label: '지상 층 이름 수' },
            ]
          : [],
      },
      {
        name: 'roof',
        values: rooftops.length
          ? [
              { key: 'out', label: '옥탑 등 제외' },
              { key: 'in', label: '옥탑 등을 한 층으로 셈' },
            ]
          : [],
      },
    ],
    (p) => {
      const s = statOf(p);
      return (p.floors?.key === 'count' ? s.count : s.max) + (p.roof?.key === 'in' ? 1 : 0);
    },
    (planned, limit) => ({ state: planned <= limit ? '적합' : '위반' }),
    '층',
    { ...AXIS_REASONS, roof: '옥탑 등의 층수 산입 여부' },
  );
  return { row: r };
}

// ── 연면적·용적률 ───────────────────────────────────────────────────────────────────────────────

export interface FloorAreas {
  table: FloorTable;
  above: number;
  below: number;
  /** 지상 연면적 − 지상 층의 산정 제외 면적. */
  farArea: number;
  exclusionOver: string[];
  /** Exclusion per floor label (only floors in the model). */
  exclusionOf: Map<string, number>;
}

/** Floor areas of a table with the person's 산정 제외 면적 (SPEC-15.6 5). */
export function floorAreas(ctx: Ctx, table: FloorTable): FloorAreas {
  const exclusionOf = new Map<string, number>();
  for (const o of ctx.overrides)
    if (o.kind === 'floor-exclusion')
      exclusionOf.set(o.floor, (exclusionOf.get(o.floor) ?? 0) + o.area_m2);
  const over: string[] = [];
  let above = 0,
    below = 0,
    excl = 0;
  for (const f of table.floors) {
    if (f.above) above += f.area;
    else below += f.area;
    const e = exclusionOf.get(f.label) ?? 0;
    if (e > f.area + 1e-9) over.push(f.label);
    if (f.above) excl += Math.min(e, f.area);
  }
  return { table, above, below, farArea: above - excl, exclusionOver: over, exclusionOf };
}

export function far(ctx: Ctx): CheckOut {
  const r = draft('far', '용적률', ['floor']);
  if (!ctx.limits) return { row: setState(r, '사람 입력 필요', ctx.limitsMissing) };
  const base = readLimit(ctx.regs, 'farBase');
  const allowed = readLimit(ctx.regs, 'farAllowed');
  const max = readLimit(ctx.regs, 'farMax');
  const incentives = [
    ...readAll(ctx.regs, 'incentiveFar'),
    ...readAll(ctx.regs, 'openSpaceIncentiveFar'),
  ];
  if ([base, allowed, max].every((x) => x.kind === 'na')) return naOf('far', base);
  useItems(r, [base, allowed, max, ...incentives.filter((x) => x.item)], '비율');
  if (!ctx.unitsKnown) return { row: setState(r, '검사 불가', '문서 단위 모름') };
  const floors = ctx.objs('floor');
  if (!floors.length) return { row: setState(r, '검사 불가', '층 윤곽 없음') };
  const ft = ctx.floorTables();
  if (ft.needsGround) return { row: setState(r, '사람 입력 필요', '기준 지반 높이') };
  r.objectIds.push(...floors.map((o) => o.objectId));
  r.numbers.push(...siteNumbers(ctx));
  const areas = ft.tables.map((t) => floorAreas(ctx, t));
  const labels = new Set(ft.tables.flatMap((t) => t.floors.map((f) => f.label)));
  for (const o of ctx.overrides) {
    if (o.kind !== 'floor-exclusion') continue;
    r.numbers.push({
      label: `산정 제외 면적 ${o.floor}`,
      value: o.area_m2,
      unit: '㎡',
      kind: '사람 입력',
      ref: `override:${o.id}`.slice(0, 200),
      note: o.basis.slice(0, 300),
    });
    if (!labels.has(o.floor)) r.unconfirmed.push(`모델에 없는 층의 제외 면적: ${o.floor}`);
  }
  for (const a of areas) {
    const suffix = a.table.ground ? `(${a.table.ground.label})` : '';
    for (const f of a.table.floors) {
      if (f.levels.length > 1)
        r.unconfirmed.push(`한 층에 높이가 다른 바닥 ${f.levels.length}개(${f.label})`);
    }
    r.numbers.push(
      {
        label: `지상 연면적${suffix}`,
        value: a.above,
        unit: '㎡',
        kind: '모델',
        ref: 'model:floor',
      },
      {
        label: `지하 연면적${suffix}`,
        value: a.below,
        unit: '㎡',
        kind: '모델',
        ref: 'model:floor',
      },
      {
        label: `용적률 산정 연면적${suffix}`,
        value: a.farArea,
        unit: '㎡',
        kind: '계산',
        ref: 'model:floor',
        note: '지상 연면적 − 산정 제외 면적',
      },
    );
  }
  if (areas.some((a) => a.exclusionOver.length))
    return {
      row: setState(
        r,
        '사람 입력 필요',
        `제외 면적이 바닥면적보다 큼(${[...new Set(areas.flatMap((a) => a.exclusionOver))].join(', ')})`,
      ),
    };
  // The ladder (SPEC-15.6 5, massing-kit `farTargets` in meaning).
  const v = (x: LimitRead) => (x.kind === 'none' || x.kind === 'na' ? null : numOf(x));
  const baseV = v(base),
    allowedV = v(allowed),
    maxV = v(max);
  const reliefItems = incentives.filter(
    (x) => x.kind !== 'none' && x.kind !== 'na' && numOf(x) !== null,
  );
  const reliefRaw = baseV === null ? null : baseV + reliefItems.reduce((s, x) => s + numOf(x)!, 0);
  const relief = reliefRaw === null ? null : maxV !== null && reliefRaw > maxV ? maxV : reliefRaw;
  const reliefConfirmed =
    reliefItems.every((x) => x.kind === 'value' && x.status === '확정') &&
    (maxV === null || (max.kind === 'value' && max.status === '확정'));
  const loosestRead =
    maxV !== null ? max : allowedV !== null ? allowed : baseV !== null ? base : null;
  const loosest = loosestRead ? v(loosestRead) : null;
  const ladder: NumberSource[] = [];
  if (relief !== null && reliefItems.length)
    ladder.push({
      label: '완화 한도(기준 + 완화량, 상한으로 자름)',
      value: relief,
      unit: '비율',
      kind: '계산',
      ref: 'regulation:incentiveFar',
      note: reliefConfirmed ? '완화 항목 확정' : '완화 조건 미확정',
    });
  r.numbers.push(...ladder);
  if (baseV === null && loosest === null)
    return { row: setState(r, '사람 입력 필요', base.reason || '기준 용적률') };
  const undecided = (x: LimitRead | null) =>
    !!x && (x.kind === 'undecided-value' || x.kind === 'undecided-applies');
  const tableAxis: Axis = {
    name: 'ground',
    values:
      areas.length > 1
        ? areas.map((a) => ({ key: a.table.ground!.key, label: a.table.ground!.label }))
        : [],
  };
  const outcomes: Outcome[] = product<AxisValue>([tableAxis, siteAxis(ctx)]).map((c) => {
    const a = areas.find((x) => x.table.ground?.key === c.keys.ground) ?? areas[0];
    const p = a.farArea / siteArea(ctx, c.picks);
    const out = (
      state: ComplianceState,
      limit: number | null,
      read: LimitRead | null,
      reason?: string,
    ): Outcome => {
      let s = state;
      let why = reason;
      if ((s === '적합' || s === '위반') && undecided(read)) {
        s = '판단 필요';
        why = read!.reason;
      }
      return {
        label: c.labels.join(' · ') || '계산',
        keys: c.keys,
        state: s,
        planned: p,
        limit,
        reason: why,
      };
    };
    if (baseV === null) {
      if (loosest !== null && p > loosest) return out('위반', loosest, loosestRead);
      return out('사람 입력 필요', loosest, base, `${base.title} 사람 입력 필요`);
    }
    if (p <= baseV) return out('적합', baseV, base);
    if (relief !== null && reliefItems.length && p <= relief)
      return reliefConfirmed
        ? out('적합', relief, reliefItems[0])
        : out('판단 필요', relief, base, '완화 조건 미확정');
    if (loosest !== null && p <= loosest)
      return out('판단 필요', loosest, base, '기준을 넘지만 넘는 근거가 되는 완화 항목 없음');
    return out('위반', loosest ?? baseV, loosestRead ?? base);
  });
  const { state, reasons } = combine(outcomes);
  setState(r, state, ...reasons);
  r.cases = casesOf(outcomes);
  const worst = outcomes.reduce((a, b) => ((b.planned ?? 0) > (a.planned ?? 0) ? b : a));
  r.planned = { value: worst.planned!, unit: '비율' };
  let limitRead: LimitRead | null;
  let limitValue: number | null;
  if (state === '적합') {
    limitValue = worst.limit;
    limitRead =
      worst.limit === baseV ? base : maxV !== null && worst.limit === maxV ? max : reliefItems[0];
  } else if (state === '위반') {
    limitValue = loosest;
    limitRead = loosestRead;
  } else {
    limitValue = baseV ?? loosest;
    limitRead = baseV !== null ? base : loosestRead;
  }
  if (limitRead && limitValue !== null)
    r.limit = { value: limitValue, unit: '비율', read: limitRead };
  if (!ctx.settings.exclusionsComplete && (r.state === '위반' || r.state === '판단 필요')) {
    if (r.state === '위반') r.state = '판단 필요';
    r.reasons.push('산정 제외 면적 입력 전');
  }
  return { row: r };
}

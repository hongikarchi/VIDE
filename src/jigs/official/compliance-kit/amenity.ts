// 주차·조경·공개공지 (SPEC-15.8, PLAN-48 T-238): the plan values from the model and the legal values
// from the same massing-kit functions the 규모검토 uses (`legalParking`, `landscapeAreas`,
// `openSpaceRequirement`), fed with the 규제 조건 filtered by SPEC-15.5 6. Required minimums: 적합
// when planned ≥ required.

import type { ComplianceState } from '../../../contracts/compliance.ts';
import { intersectRegions, unionArea } from '../massing-kit/floors.ts';
import { landscapeAreas } from '../massing-kit/landscape.ts';
import { openSpaceRequirement } from '../massing-kit/open-space.ts';
import { legalParking } from '../massing-kit/parking.ts';
import type { PlanRegion } from '../massing-kit/setback.ts';
import type { UseTotal } from '../massing-kit/use-mix.ts';
import type { Ctx } from './context.ts';
import { lookup, readAll, readLimit, type LimitRead } from './limits-read.ts';
import { floorAreas, naOf, type CheckOut } from './scale.ts';
import {
  AXIS_REASONS,
  casesOf,
  combine,
  draft,
  product,
  setState,
  useItems,
  type Outcome,
  type RowDraft,
} from './verdict.ts';

type AxisValue = { key: string; label: string };

const regionsOf = (ctx: Ctx, role: 'landscape' | 'landscape-roof' | 'open-space'): PlanRegion[] =>
  ctx.objs(role).flatMap((o) => (o.shape.kind === 'region' ? [o.shape.region] : []));

const siteAxis = (ctx: Ctx) => ({
  name: 'site',
  values:
    ctx.siteAreas.length > 1 ? ctx.siteAreas.map((s) => ({ key: s.key, label: s.label })) : [],
});

/** A '판단 필요' 값 never decides 적합 or 위반 (SPEC-15.5 6). */
function undecidedValue(r: RowDraft, reads: readonly LimitRead[]) {
  const u = reads.find((x) => x.kind === 'undecided-value');
  if (u && (r.state === '적합' || r.state === '위반')) {
    r.state = '판단 필요';
    r.reasons.push(u.reason);
  }
}

// ── 주차 ────────────────────────────────────────────────────────────────────────────────────────

export function parkingRow(ctx: Ctx): CheckOut {
  const r = draft('parking', '주차 대수', ['parking', 'floor']);
  r.lower = true;
  if (!ctx.limits) return { row: setState(r, '사람 입력 필요', ctx.limitsMissing) };
  const rules = readAll(ctx.regs, 'parkingRule');
  if (rules.every((x) => x.kind === 'na')) return naOf('parking', rules[0]);
  const choices = ['parkingRounding', 'parkingRoundScope', 'parkingAreaBasis'].map((id) =>
    readLimit(ctx.regs, id),
  );
  useItems(r, [...rules.filter((x) => x.item), ...choices.filter((x) => x.item)], '㎡/대');
  const stalls = ctx.objs('parking');
  let planned: number;
  if (stalls.length) {
    planned = stalls.reduce((s, o) => s + o.count, 0);
    r.objectIds.push(...stalls.map((o) => o.objectId));
    r.numbers.push({
      label: '계획 주차 대수',
      value: planned,
      unit: '대',
      kind: '모델',
      ref: 'model:parking',
      note: `주차 구획 객체 ${stalls.length}개(vide-count 반영)`,
    });
  } else if (ctx.settings.noneParking) {
    planned = 0;
    r.numbers.push({
      label: '계획 주차 대수',
      value: 0,
      unit: '대',
      kind: '사람 입력',
      ref: 'setting:noneParking',
      note: '없음 확정',
    });
  } else return { row: setState(r, '검사 불가', '모델에 주차 구획 없음') };
  r.planned = { value: planned, unit: '대' };
  if (!ctx.unitsKnown) return { row: setState(r, '검사 불가', '문서 단위 모름(용도별 면적)') };
  const missingChoice = choices.filter((x) => x.kind === 'none');
  if (missingChoice.length)
    return { row: setState(r, '사람 입력 필요', ...missingChoice.map((x) => x.reason)) };
  const floors = ctx.objs('floor');
  if (!floors.length) return { row: setState(r, '검사 불가', '층 윤곽 없음(용도별 면적)') };
  const ft = ctx.floorTables();
  if (ft.needsGround) return { row: setState(r, '사람 입력 필요', '기준 지반 높이') };
  r.objectIds.push(...floors.map((o) => o.objectId));
  const noUse = [
    ...new Set(ft.tables.flatMap((t) => t.floors.filter((f) => !f.use).map((f) => f.label))),
  ];
  if (noUse.length) return { row: setState(r, '사람 입력 필요', `층 용도(${noUse.join(', ')})`) };
  const outcomes: Outcome[] = [];
  let ruleRead: LimitRead | null = null;
  for (const t of ft.tables) {
    const a = floorAreas(ctx, t);
    const byUse = new Map<string, UseTotal>();
    for (const f of t.floors) {
      const use = f.use!.trim();
      const u =
        byUse.get(use) ??
        byUse.set(use, { use, above: 0, below: 0, total: 0, farArea: 0 }).get(use)!;
      if (f.above) {
        u.above += f.area;
        u.farArea += f.area - Math.min(a.exclusionOf.get(f.label) ?? 0, f.area);
      } else u.below += f.area;
      u.total += f.area;
    }
    const uses = [...byUse.values()].sort((x, y) => x.use.localeCompare(y.use));
    const unmatched = uses.filter((u) => !lookup(ctx.regs, 'parkingRule', u.use));
    if (unmatched.length)
      return {
        row: setState(
          r,
          '사람 입력 필요',
          ...unmatched.map((u) => `용도 ${u.use}의 주차 산정 기준`),
        ),
      };
    for (const u of uses)
      r.numbers.push({
        label: `${u.use} 면적${t.ground ? `(${t.ground.label})` : ''}`,
        value: u.total,
        unit: '㎡',
        kind: '모델',
        ref: 'model:floor',
        note: `지상 ${u.above} · 지하 ${u.below} · 산정 제외 뺀 지상 ${u.farArea}`.slice(0, 300),
      });
    const reads = uses.map((u) => readLimit(ctx.regs, 'parkingRule', u.use));
    ruleRead ??= reads.find((x) => x.kind === 'value') ?? reads[0] ?? null;
    const legal = legalParking(uses, ctx.items);
    if (legal.count === null) {
      const undecided = legal.rows.some((x) => x.status === '미검토');
      return { row: setState(r, undecided ? '판단 필요' : '사람 입력 필요', legal.status) };
    }
    r.numbers.push({
      label: `법정 주차 대수${t.ground ? `(${t.ground.label})` : ''}`,
      value: legal.count,
      unit: '대',
      kind: '계산',
      ref: 'regulation:parkingRule',
      note: `${legal.rows.map((x) => `${x.use} ${x.ruleText}`).join(', ')} · 끝수 처리 전 ${legal.raw}`.slice(
        0,
        300,
      ),
    });
    outcomes.push({
      label: t.ground?.label ?? '계산',
      keys: { ground: t.ground?.key ?? '-' },
      state: planned >= legal.count ? '적합' : '위반',
      planned,
      limit: legal.count,
    });
  }
  const { state, reasons } = combine(outcomes);
  setState(r, state, ...reasons);
  undecidedValue(r, [...rules, ...choices]);
  r.cases = casesOf(outcomes, true);
  const legalMax = Math.max(...outcomes.map((o) => o.limit ?? 0));
  if (ruleRead) r.limit = { value: legalMax, unit: '대', read: ruleRead };
  return { row: r };
}

// ── 조경 ────────────────────────────────────────────────────────────────────────────────────────

export function landscapeRow(ctx: Ctx): CheckOut {
  const r = draft('landscape', '조경 면적', ['landscape', 'landscape-roof', 'open-space']);
  r.lower = true;
  if (!ctx.limits) return { row: setState(r, '사람 입력 필요', ctx.limitsMissing) };
  const read = readLimit(ctx.regs, 'landscapeRatio');
  if (read.kind === 'na') return naOf('landscape', read);
  useItems(r, [read], '비율');
  if (!ctx.unitsKnown) return { row: setState(r, '검사 불가', '문서 단위 모름') };
  const site: PlanRegion[] = [{ outer: ctx.limits.site.ring, holes: [] }];
  const ground = regionsOf(ctx, 'landscape');
  const roof = regionsOf(ctx, 'landscape-roof');
  const open = regionsOf(ctx, 'open-space');
  r.objectIds.push(
    ...ctx.objs('landscape').map((o) => o.objectId),
    ...ctx.objs('landscape-roof').map((o) => o.objectId),
  );
  let planned = 0;
  let roofArea = 0;
  let overlap = 0;
  if (!ground.length && !roof.length) {
    if (!ctx.settings.noneLandscape)
      return { row: setState(r, '검사 불가', '모델에 조경 영역 없음') };
    r.numbers.push({
      label: '계획 조경 면적',
      value: 0,
      unit: '㎡',
      kind: '사람 입력',
      ref: 'setting:noneLandscape',
      note: '없음 확정',
    });
  } else {
    const inSite = ground.length ? intersectRegions(ground, site) : [];
    planned = inSite.length ? unionArea([inSite]) : 0;
    roofArea = roof.length ? unionArea([roof]) : 0;
    if (inSite.length && open.length) {
      const both = intersectRegions(inSite, open);
      overlap = both.length ? unionArea([both]) : 0;
    }
    r.numbers.push({
      label: '계획 조경 면적(지상, 대지 안)',
      value: planned,
      unit: '㎡',
      kind: '모델',
      ref: 'model:landscape',
    });
    if (roofArea > 0)
      r.numbers.push({
        label: '옥상 등 조경 면적',
        value: roofArea,
        unit: '㎡',
        kind: '모델',
        ref: 'model:landscape-roof',
        note: '산입 비율은 법규 판단 — 넣지 않은 경우와 그대로 넣은 경우',
      });
    if (overlap > 1e-6)
      r.numbers.push({
        label: '공개공지와 겹친 조경 면적',
        value: overlap,
        unit: '㎡',
        kind: '모델',
        ref: 'model:open-space',
      });
  }
  r.planned = { value: planned, unit: '㎡' };
  if (read.kind === 'none') return { row: setState(r, '사람 입력 필요', read.reason) };
  const legalOf = new Map(
    ctx.siteAreas.map((s) => [
      s.key,
      landscapeAreas(ctx.items, s.value, ctx.limits!.site.ring, []).legal,
    ]),
  );
  for (const s of ctx.siteAreas)
    r.numbers.push({
      label: `법정 조경 면적(${s.label})`.slice(0, 120),
      value: legalOf.get(s.key) ?? null,
      unit: '㎡',
      kind: '계산',
      ref: 'regulation:landscapeRatio',
      note: '조경 면적 비율 × 대지면적',
    });
  if ([...legalOf.values()].some((v) => v === null))
    return { row: setState(r, '사람 입력 필요', `${read.title} 사람 입력 필요`) };
  const combos = product<AxisValue>([
    siteAxis(ctx),
    {
      name: 'roofLandscape',
      values:
        roofArea > 0
          ? [
              { key: 'out', label: '옥상 등 조경 제외' },
              { key: 'in', label: '옥상 등 조경 포함' },
            ]
          : [],
    },
    {
      name: 'overlap',
      values:
        overlap > 1e-6
          ? [
              { key: 'in', label: '공개공지와 겹친 조경 포함' },
              { key: 'out', label: '공개공지와 겹친 조경 제외' },
            ]
          : [],
    },
    {
      name: 'limit',
      values:
        read.kind === 'undecided-applies'
          ? [
              { key: 'in', label: `${read.title} 적용` },
              { key: 'out', label: `${read.title} 미적용` },
            ]
          : [],
    },
  ]);
  const outcomes: Outcome[] = combos.map((c) => {
    const p =
      planned +
      (c.keys.roofLandscape === 'in' ? roofArea : 0) -
      (c.keys.overlap === 'out' ? overlap : 0);
    const legal =
      c.keys.limit === 'out'
        ? null
        : legalOf.get((c.keys.site ?? ctx.siteAreas[0].key) as 'site:area')!;
    const state: ComplianceState = legal === null || p >= legal ? '적합' : '위반';
    return { label: c.labels.join(' · ') || '계산', keys: c.keys, state, planned: p, limit: legal };
  });
  const { state, reasons } = combine(outcomes, { ...AXIS_REASONS, limit: read.reason });
  setState(r, state, ...reasons);
  undecidedValue(r, [read]);
  r.cases = casesOf(outcomes, true);
  r.limit = { value: Math.max(...[...legalOf.values()].map((v) => v!)), unit: '㎡', read };
  return { row: r };
}

// ── 공개공지 ────────────────────────────────────────────────────────────────────────────────────

export function openSpaceRow(ctx: Ctx): CheckOut {
  const r = draft('open-space', '공개공지 면적', ['open-space']);
  r.lower = true;
  r.reasons.push('위치 요건은 검사하지 않음');
  if (!ctx.limits) return { row: setState(r, '사람 입력 필요', ctx.limitsMissing) };
  const read = readLimit(ctx.regs, 'publicOpenSpace');
  if (read.kind === 'na') return naOf('open-space', read);
  useItems(r, [read], '비율');
  if (!ctx.unitsKnown) return { row: setState(r, '검사 불가', '문서 단위 모름') };
  if (read.kind === 'none') return { row: setState(r, '사람 입력 필요', read.reason) };
  if (read.kind === 'undecided-applies')
    return { row: setState(r, '판단 필요', '공개공지 대상 여부 판단 필요') };
  const regions = regionsOf(ctx, 'open-space');
  let planned = 0;
  if (regions.length) {
    const inSite = intersectRegions(regions, [{ outer: ctx.limits.site.ring, holes: [] }]);
    planned = inSite.length ? unionArea([inSite]) : 0;
    r.objectIds.push(...ctx.objs('open-space').map((o) => o.objectId));
    r.numbers.push({
      label: '계획 공개공지 면적(대지 안)',
      value: planned,
      unit: '㎡',
      kind: '모델',
      ref: 'model:open-space',
    });
  } else if (ctx.settings.noneOpenSpace) {
    r.numbers.push({
      label: '계획 공개공지 면적',
      value: 0,
      unit: '㎡',
      kind: '사람 입력',
      ref: 'setting:noneOpenSpace',
      note: '없음 확정',
    });
  } else return { row: setState(r, '검사 불가', '모델에 공개공지 영역 없음') };
  r.planned = { value: planned, unit: '㎡' };
  const outcomes: Outcome[] = [];
  for (const s of ctx.siteAreas) {
    const req = openSpaceRequirement(ctx.items, s.value);
    if (req.required === null) return { row: setState(r, '사람 입력 필요', req.message) };
    r.numbers.push({
      label: `필요 공개공지 면적(${s.label})`.slice(0, 120),
      value: req.required,
      unit: '㎡',
      kind: '계산',
      ref: 'regulation:publicOpenSpace',
      note: '공개공지 비율 × 대지면적',
    });
    outcomes.push({
      label: ctx.siteAreas.length > 1 ? s.label : '계산',
      keys: { site: s.key },
      state: planned >= req.required ? '적합' : '위반',
      planned,
      limit: req.required,
    });
  }
  const { state, reasons } = combine(outcomes);
  setState(r, state, ...reasons);
  undecidedValue(r, [read]);
  r.cases = casesOf(outcomes, true);
  r.limit = { value: Math.max(...outcomes.map((o) => o.limit!)), unit: '㎡', read };
  return { row: r };
}

// 형상 제한 (SPEC-15.7, PLAN-48 T-238): the parts of the building inside each forbidden volume of
// the massing work copy — the plan bands of the 2D rules raised from the 기준 지반, the 일조 금지
// 부피 and everything outside the 최대 외피 — moved to each ground case (SPEC-15.5 5), and the part
// outside the site. Each part keeps its volume, extent, segments and objects (SPEC-15.7 4).

import type { ComplianceState, Exceedance, Mesh, ZoneRule } from '../../../contracts/compliance.ts';
import { ZONE_RULES } from '../../../contracts/compliance.ts';
import { regionSolid } from '../massing-kit/floors.ts';
import { solidUnionAll, type Solid } from '../geometry-kit/solid.ts';
import { shapeBuilding, type Building, type BuildingPart } from './building.ts';
import type { Ctx } from './context.ts';
import {
  booleanPiece,
  boxOf,
  shiftSolid,
  sliceAbove,
  solidMesh,
  PIECE_THICKNESS,
  type BooleanOp,
  type PreparedSolid,
} from './geometry.ts';
import type { GroundCase } from './ground.ts';
import { numOf, readAll, readLimit, type LimitRead } from './limits-read.ts';
import { naOf, type CheckOut } from './scale.ts';
import {
  AXIS_REASONS,
  casesOf,
  combine,
  draft,
  setState,
  useItems,
  worstOf,
  type Outcome,
  type RowDraft,
} from './verdict.ts';

export const ZONE_ITEM: Record<ZoneRule, string> = {
  roadSetback: 'roadSetback',
  chamfer: 'chamferLength',
  limitLine: 'limitLine',
  openSpaceRoad: 'openSpaceRoad',
  openSpaceAdjacent: 'openSpaceAdjacent',
  civilSetback: 'civilSetback',
  otherSetback: 'otherSetback',
};
/** massing-kit `RuleId` of each zone rule (how 미반영 조건 may name it). */
const ZONE_RULE_ID: Record<ZoneRule, string> = {
  roadSetback: 'road-setback',
  chamfer: 'chamfer',
  limitLine: 'limit-line',
  openSpaceRoad: 'open-space-road',
  openSpaceAdjacent: 'open-space-adjacent',
  civilSetback: 'civil',
  otherSetback: 'other',
};
export const ZONE_TITLES: Record<ZoneRule, string> = {
  roadSetback: '건축선 후퇴',
  chamfer: '가각',
  limitLine: '건축한계선',
  openSpaceRoad: '대지 안의 공지(건축선에서)',
  openSpaceAdjacent: '대지 안의 공지(인접 대지 경계선에서)',
  civilSetback: '민법상 이격',
  otherSetback: '기타 이격',
};
const SUN_ITEMS = ['sunBaseHeight', 'sunNearDistance', 'sunRatio', 'sunDistance', 'sunDatumRoad'];

const boxesMeet = (a: PreparedSolid['box'], b: PreparedSolid['box']) =>
  a.min[0] <= b.max[0] &&
  b.min[0] <= a.max[0] &&
  a.min[1] <= b.max[1] &&
  b.min[1] <= a.max[1] &&
  a.min[2] <= b.max[2] &&
  b.min[2] <= a.max[2];

interface Run {
  pieces: Exceedance[];
  failed: string[];
  volume: number;
}

/** The building's parts inside (`intersect`) or outside (`subtract`) a volume. */
function runParts(
  b: Building,
  forbidden: Solid,
  op: BooleanOp,
  ground: GroundCase | null,
  meta: { rule: string; variant: 'base' | 'without'; segments: string[] },
): Run {
  const run: Run = { pieces: [], failed: [], volume: 0 };
  const fBox = forbidden.length ? boxOf(forbidden) : null;
  for (const part of b.parts) {
    const a = op === 'subtract' && ground ? sliceAbove(part.solid, ground.local) : part.solid.solid;
    if (!a.length) continue;
    if (op === 'intersect' && (!fBox || !boxesMeet(part.solid.box, fBox))) continue;
    const piece = booleanPiece(a, forbidden, op, part.solid.volume);
    if (piece === 'failed') {
      run.failed.push(part.objectId);
      continue;
    }
    if (!piece) continue;
    run.volume += piece.volume;
    run.pieces.push(exceedanceOf(part, piece.solid, piece.volume, piece.box, ground, meta));
  }
  return run;
}

function exceedanceOf(
  part: BuildingPart,
  solid: Solid,
  volume: number,
  box: PreparedSolid['box'],
  ground: GroundCase | null,
  meta: { rule: string; variant: 'base' | 'without'; segments: string[] },
): Exceedance {
  const groundCase = ground?.key ?? 'ground:none';
  const mesh: Mesh = solidMesh(solid);
  return {
    id: `${meta.rule}:${meta.variant}:${groundCase}:${part.objectId}`.slice(0, 80),
    no: 1, // renumbered over the whole result (SPEC-15.11)
    rule: meta.rule.slice(0, 60),
    variant: meta.variant,
    groundCase,
    volume,
    min: box.min,
    max: box.max,
    segments: meta.segments.slice(0, 40),
    objectIds: [part.objectId],
    rooftopOnly: part.role === 'rooftop',
    mesh,
  };
}

/** One reading's state from its run (SPEC-15.7 1·6). */
function runState(run: Run): { state: ComplianceState; reason?: string } {
  if (run.failed.length) return { state: '검사 불가', reason: '형상 연산 실패' };
  if (!run.pieces.length) return { state: '적합' };
  if (run.pieces.every((p) => p.rooftopOnly))
    return { state: '판단 필요', reason: '옥탑 등의 산입' };
  return { state: '위반' };
}

const unappliedFor = (ctx: Ctx, ids: readonly string[]) =>
  (ctx.limits?.unapplied ?? []).filter((u) => ids.includes(u.id));

/**
 * The common preconditions of a shape row (SPEC-15.5 5, 15.14): units, the same document, the
 * checked 최대 외피, the 기준 지반 and a building to test.
 */
function prerequisites(
  ctx: Ctx,
  r: RowDraft,
  { ground = true, envelope = true } = {},
): Building | null {
  if (envelope) {
    const prep = ctx.prepared;
    const bad = ctx.limits!.variants.filter((v) => !prep(v.envelope).ok);
    if (bad.length) {
      setState(r, '검사 불가', '외피 점검 실패');
      return null;
    }
  }
  if (ground && !ctx.grounds.length) {
    setState(r, '사람 입력 필요', '기준 지반 높이');
    return null;
  }
  const b = shapeBuilding(ctx);
  if (b.failed.length) {
    r.objectIds.push(...b.failed);
    setState(r, '검사 불가', `형상 연산 실패(닫힌 솔리드 점검 실패 ${b.failed.length}개)`);
    return null;
  }
  if (!b.parts.length) {
    setState(r, '검사 불가', '건물 매스 없음');
    return null;
  }
  r.unconfirmed.push(...b.notes);
  if (ground) r.numbers.push(...ctx.groundNumbers);
  return b;
}

/** Units and the document (before any item is read as missing). */
function placed(ctx: Ctx, r: RowDraft): boolean {
  if (!ctx.unitsKnown) {
    setState(r, '검사 불가', '문서 단위 모름');
    return false;
  }
  if (ctx.docProblem) {
    setState(r, '검사 불가', ctx.docProblem);
    return false;
  }
  return true;
}

function volumeRow(r: RowDraft, runs: Run[]) {
  const max = runs.length ? Math.max(...runs.map((x) => x.volume)) : 0;
  r.planned = { value: max, unit: '㎥' };
  for (const run of runs) {
    r.exceedances.push(...run.pieces);
    r.objectIds.push(...run.pieces.flatMap((p) => p.objectIds), ...run.failed);
  }
}

// ── 평면 규칙 ───────────────────────────────────────────────────────────────────────────────────

export function zoneRow(ctx: Ctx, rule: ZoneRule): CheckOut {
  const id = `zone:${rule}` as const;
  const r = draft(id, ZONE_TITLES[rule], ['mass', 'rooftop']);
  if (!ctx.limits) return { row: setState(r, '검사 불가', ctx.limitsMissing) };
  const itemId = ZONE_ITEM[rule];
  const reads = readAll(ctx.regs, itemId);
  const active = reads.filter((x) => x.kind !== 'na');
  if (!active.length) return naOf(id, reads[0]);
  useItems(r, active);
  const zone = ctx.limits.zones.find((z) => z.rule === rule) ?? null;
  for (const other of zone?.items ?? [])
    if (other !== itemId)
      useItems(
        r,
        readAll(ctx.regs, other).filter((x) => x.item),
      );
  if (!placed(ctx, r)) return { row: r };
  const unapplied = unappliedFor(ctx, [itemId, rule, ZONE_RULE_ID[rule]]);
  if (unapplied.length && active.every((x) => x.kind === 'value' || x.kind === 'undecided-value'))
    return {
      row: setState(
        r,
        '사람 입력 필요',
        ...unapplied.map((u) => `미반영 조건: ${u.title} — ${u.reason}`),
      ),
    };
  const needsGeometry = active.some((x) => x.kind !== 'none');
  let geo: { state: ComplianceState; reasons: string[]; outcomes: Outcome[] } | null = null;
  const regions = zone?.regions ?? [];
  if (needsGeometry && regions.length) {
    const b = prerequisites(ctx, r);
    if (!b) return { row: r };
    const runs: Run[] = [];
    const outcomes: Outcome[] = ctx.grounds.map((g) => {
      const top = Math.max(...b.parts.map((p) => p.solid.box.max[2])) + 1;
      let column: Solid;
      try {
        column = solidUnionAll(
          regions
            .filter(() => top > g.local + PIECE_THICKNESS)
            .map((reg) => regionSolid(reg, g.local, top)),
        );
      } catch {
        const run: Run = { pieces: [], failed: b.parts.map((p) => p.objectId), volume: 0 };
        runs.push(run);
        return {
          label: g.label,
          keys: { ground: g.key },
          state: '검사 불가',
          planned: null,
          limit: null,
          reason: '형상 연산 실패',
        };
      }
      const run = runParts(b, column, 'intersect', g, {
        rule: ZONE_TITLES[rule],
        variant: 'base',
        segments: zone?.segments ?? [],
      });
      runs.push(run);
      const s = runState(run);
      return {
        label: g.label,
        keys: { ground: g.key },
        state: s.state,
        planned: run.volume,
        limit: 0,
        reason: s.reason,
      };
    });
    volumeRow(r, runs);
    const c = combine(outcomes);
    geo = { ...c, outcomes };
  }
  const partStates = active.map((read) => partOf(read, geo, regions.length > 0));
  if (partStates.length === 1) {
    const [p] = partStates;
    setState(r, p.state, ...p.reasons);
    if (geo) {
      const outcomes =
        p.read.kind === 'undecided-applies'
          ? [
              ...geo.outcomes.map((o) => ({
                ...o,
                label: `${o.label} · 적용`,
                keys: { ...o.keys, limit: 'in' },
              })),
              {
                label: '미적용',
                keys: { ground: '-', limit: 'out' },
                state: '적합' as const,
                planned: 0,
                limit: null,
              },
            ]
          : geo.outcomes;
      r.cases = casesOf(outcomes);
    }
  } else {
    r.parts = partStates.map((p) => ({
      label: (p.read.target ?? p.read.title).slice(0, 120),
      target: p.read.target?.slice(0, 80) ?? null,
      state: p.state,
      planned: r.planned?.value ?? null,
      limit: numOf(p.read),
      reason: (p.reasons.join('; ') || (p.state === '적합' ? '' : p.state)).slice(0, 300),
    }));
    setState(
      r,
      worstOf(partStates.map((p) => p.state)),
      ...partStates
        .filter((p) => p.state !== '적합')
        .flatMap((p) => p.reasons.map((x) => `${p.read.target ?? p.read.title}: ${x}`)),
    );
  }
  return { row: r };
}

function partOf(
  read: LimitRead,
  geo: { state: ComplianceState; reasons: string[] } | null,
  hasBand: boolean,
): { read: LimitRead; state: ComplianceState; reasons: string[] } {
  if (read.kind === 'none') return { read, state: '사람 입력 필요', reasons: [read.reason] };
  if (!hasBand || !geo) {
    if (read.kind === 'undecided-applies')
      return { read, state: '판단 필요', reasons: [`${read.reason} — 금지 띠 없이 계산됨`] };
    if (numOf(read) === 0) return { read, state: '적합', reasons: ['거리 0 — 금지 띠 없음'] };
    return { read, state: '검사 불가', reasons: ['금지 띠를 만들지 못함'] };
  }
  if (read.kind === 'undecided-applies')
    return geo.state === '적합'
      ? { read, state: '적합', reasons: [] }
      : geo.state === '위반' || geo.state === '판단 필요'
        ? { read, state: '판단 필요', reasons: [read.reason, ...geo.reasons] }
        : { read, state: geo.state, reasons: geo.reasons };
  if (read.kind === 'undecided-value' && (geo.state === '적합' || geo.state === '위반'))
    return { read, state: '판단 필요', reasons: [read.reason] };
  return { read, state: geo.state, reasons: geo.reasons };
}

// ── 정북 일조 ───────────────────────────────────────────────────────────────────────────────────

export function sunRow(ctx: Ctx): CheckOut {
  const r = draft('sun', '정북 일조', ['mass', 'rooftop']);
  if (!ctx.limits) return { row: setState(r, '검사 불가', ctx.limitsMissing) };
  const sun = readLimit(ctx.regs, 'sun');
  if (sun.kind === 'na') return naOf('sun', sun);
  useItems(r, [sun, ...SUN_ITEMS.map((id) => readLimit(ctx.regs, id)).filter((x) => x.item)]);
  if (!placed(ctx, r)) return { row: r };
  if (sun.kind === 'none') return { row: setState(r, '사람 입력 필요', sun.reason) };
  const unapplied = unappliedFor(ctx, ['sun', ...SUN_ITEMS, 'sun-ground', 'sun-slope']);
  if (unapplied.length && sun.kind !== 'undecided-applies')
    return {
      row: setState(
        r,
        '사람 입력 필요',
        ...unapplied.map((u) => `미반영 조건: ${u.title} — ${u.reason}`),
      ),
    };
  const variants = ctx.limits.variants;
  if (sun.kind !== 'undecided-applies' && !variants.find((v) => v.id === 'base')?.sunCut)
    return { row: setState(r, '검사 불가', '일조 금지 부피를 만들지 못함') };
  if (sun.kind === 'undecided-applies' && !variants.some((v) => v.sunCut))
    return { row: setState(r, '판단 필요', `${sun.reason} — 일조 금지 부피 없이 계산됨`) };
  const b = prerequisites(ctx, r);
  if (!b) return { row: r };
  const prep = ctx.prepared;
  const bad = variants.filter((v) => v.sunCut && !prep(v.sunCut).ok);
  if (bad.length) return { row: setState(r, '검사 불가', '일조 금지 부피 점검 실패') };
  const runs: Run[] = [];
  const outcomes: Outcome[] = [];
  for (const v of variants)
    for (const g of ctx.grounds) {
      const label = [
        variants.length > 1 ? (v.id === 'base' ? '기준 외피' : '판단 필요 미적용 외피') : '',
        ctx.grounds.length > 1 ? g.label : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const keys = { variant: v.id, ground: g.key };
      if (!v.sunCut) {
        outcomes.push({ label: label || '계산', keys, state: '적합', planned: 0, limit: 0 });
        continue;
      }
      const run = runParts(b, shiftSolid(prep(v.sunCut).solid, g.shift), 'intersect', g, {
        rule: '정북 일조',
        variant: v.id,
        segments: [],
      });
      runs.push(run);
      const s = runState(run);
      outcomes.push({
        label: label || '계산',
        keys,
        state: s.state,
        planned: run.volume,
        limit: 0,
        reason: s.reason,
      });
    }
  volumeRow(r, runs);
  let { state, reasons } = combine(outcomes);
  if (sun.kind === 'undecided-value' && (state === '적합' || state === '위반')) {
    state = '판단 필요';
    reasons = [sun.reason];
  }
  setState(r, state, ...reasons);
  r.cases = casesOf(outcomes);
  return { row: r };
}

// ── 최대 외피 ───────────────────────────────────────────────────────────────────────────────────

export function envelopeRow(ctx: Ctx): CheckOut {
  const r = draft('envelope', '최대 외피', ['mass', 'rooftop']);
  if (!ctx.limits) return { row: setState(r, '검사 불가', ctx.limitsMissing) };
  const limits = ctx.limits;
  const capItems = [...new Set(limits.variants.flatMap((v) => v.heightCap?.items ?? []))];
  useItems(
    r,
    capItems.flatMap((id) => readAll(ctx.regs, id).filter((x) => x.item)),
  );
  if (!placed(ctx, r)) return { row: r };
  const b = prerequisites(ctx, r);
  if (!b) return { row: r };
  const prep = ctx.prepared;
  const relief = readAll(ctx.regs, 'incentiveHeight').filter((x) => numOf(x) !== null);
  const reliefSum = relief.reduce((s, x) => s + numOf(x)!, 0);
  if (relief.length) useItems(r, relief, 'm');
  const runs: Run[] = [];
  const outcomes: Outcome[] = [];
  for (const v of limits.variants) {
    r.numbers.push({
      label: `최대 외피 부피(${v.id === 'base' ? '기준' : '판단 필요 미적용'})`,
      value: v.envelopeVolume,
      unit: '㎥',
      kind: '계산',
      ref: 'site:envelope',
    });
    if (v.heightCap)
      r.numbers.push({
        label: `외피 높이 상한(${v.id === 'base' ? '기준' : '판단 필요 미적용'})`,
        value: v.heightCap.value,
        unit: 'm',
        kind: '규제 조건',
        ref: `regulation:${v.heightCap.items[0]}`.slice(0, 200),
        note: v.heightCap.items.join(', ').slice(0, 300),
      });
    r.unconfirmed.push(...v.unconfirmed);
    for (const g of ctx.grounds) {
      const label = [
        limits.variants.length > 1 ? (v.id === 'base' ? '기준 외피' : '판단 필요 미적용 외피') : '',
        ctx.grounds.length > 1 ? g.label : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const run = runParts(b, shiftSolid(prep(v.envelope).solid, g.shift), 'subtract', g, {
        rule: '최대 외피',
        variant: v.id,
        segments: [],
      });
      runs.push(run);
      let s = runState(run);
      if (s.state === '위반' && v.heightCap && reliefSum > 0) {
        const cap = g.local + v.heightCap.value;
        const tol = PIECE_THICKNESS;
        if (run.pieces.every((p) => p.min[2] >= cap - tol && p.max[2] <= cap + reliefSum + tol))
          s = { state: '판단 필요', reason: '높이 완화 적용 미확정' };
      }
      outcomes.push({
        label: label || '계산',
        keys: { variant: v.id, ground: g.key },
        state: s.state,
        planned: run.volume,
        limit: 0,
        reason: s.reason,
      });
    }
  }
  volumeRow(r, runs);
  const { state, reasons } = combine(outcomes, { ...AXIS_REASONS });
  setState(r, state, ...reasons);
  r.cases = casesOf(outcomes);
  if (limits.unapplied.length) {
    r.unconfirmed.push(`미반영 조건 ${limits.unapplied.length}개`);
    if (state === '적합')
      r.reasons.push(`미반영 조건 ${limits.unapplied.length}개 — 그 제한 없이 만든 외피`);
  }
  return { row: r };
}

// ── 대지 밖 ─────────────────────────────────────────────────────────────────────────────────────

export function outsideSiteRow(ctx: Ctx): CheckOut {
  const r = draft('outside-site', '대지 밖', ['mass', 'rooftop']);
  if (!ctx.limits) return { row: setState(r, '검사 불가', ctx.limitsMissing) };
  if (!placed(ctx, r)) return { row: r };
  const b = prerequisites(ctx, r, { ground: false, envelope: false });
  if (!b) return { row: r };
  r.numbers.push({ label: '대지 경계', value: null, unit: '', kind: '대지', ref: 'site:ring' });
  const zmin = Math.min(...b.parts.map((p) => p.solid.box.min[2])) - 1;
  const zmax = Math.max(...b.parts.map((p) => p.solid.box.max[2])) + 1;
  let site: Solid;
  try {
    site = regionSolid({ outer: ctx.limits.site.ring, holes: [] }, zmin, zmax);
  } catch {
    return { row: setState(r, '검사 불가', '대지 경계로 형상을 만들 수 없음') };
  }
  const run = runParts(b, site, 'subtract', null, {
    rule: '대지 밖',
    variant: 'base',
    segments: [],
  });
  volumeRow(r, [run]);
  const s = runState(run);
  if (s.state === '검사 불가')
    return { row: setState(r, '검사 불가', s.reason ?? '형상 연산 실패') };
  if (run.pieces.length)
    return { row: setState(r, '판단 필요', '대지 경계 밖 부분 — 대지 경계와 모델 위치 확인') };
  return { row: setState(r, '적합') };
}

export const zoneRows = (ctx: Ctx) => ZONE_RULES.map((rule) => zoneRow(ctx, rule));

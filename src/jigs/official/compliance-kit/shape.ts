// 형상 제한 (SPEC-15.7, PLAN-48 T-238): the parts of the building inside each forbidden volume of
// the massing work copy — the plan bands of the 2D rules raised from the 기준 지반, the 일조 금지
// 부피 and everything outside the 최대 외피 — moved to each ground case (SPEC-15.5 5), and the part
// outside the site. Each part keeps its volume, extent, segments and objects (SPEC-15.7 4).

import type {
  ComplianceLimits,
  ComplianceState,
  Exceedance,
  Mesh,
  ZoneRule,
} from '../../../contracts/compliance.ts';
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
import { numOf, pendingItems, readAll, readLimit, type LimitRead } from './limits-read.ts';
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

interface ExceedanceMeta {
  rule: string;
  variant: 'base' | 'without';
  segments: string[];
  /** The 구간 the band belongs to (one band per target). */
  part?: string;
}

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
  meta: ExceedanceMeta,
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
  meta: ExceedanceMeta,
): Exceedance {
  const groundCase = ground?.key ?? 'ground:none';
  const mesh: Mesh = solidMesh(solid);
  const band = meta.part ? `@${meta.part}` : '';
  return {
    id: `${meta.rule}${band}:${meta.variant}:${groundCase}:${part.objectId}`.slice(0, 80),
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

/** Why a 미반영 조건 matters, as the row says it. */
const unappliedText = (u: { title: string; reason: string }) =>
  `미반영 조건: ${u.title} — ${u.reason}`;

type Band = ComplianceLimits['zones'][number]['regions'];
type Geo = { state: ComplianceState; reasons: string[]; outcomes: Outcome[] };

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
  // 미반영 조건 (SPEC-15.7 6): the bands the massing work copy made are still checked. A 구간 the
  // rule was not applied to needs a person, a rule-wide one keeps the row from 적합 — and a 위반
  // found in another 구간 stays 위반 (SPEC-15.9 2).
  const unapplied = unappliedFor(ctx, [itemId, rule, ZONE_RULE_ID[rule]]);
  const unappliedAt = new Map<string, string[]>();
  const ruleWide: string[] = [];
  for (const u of unapplied) {
    if (u.segments?.length)
      for (const seg of u.segments)
        unappliedAt.set(seg, [...(unappliedAt.get(seg) ?? []), unappliedText(u)]);
    else ruleWide.push(unappliedText(u));
  }
  const regions: Band = zone?.regions ?? [];
  const segOf =
    zone?.regionSegments && zone.regionSegments.length === regions.length
      ? zone.regionSegments
      : null;
  const targets = new Set(active.flatMap((x) => (x.target ? [x.target] : [])));
  // Only an applied item with a value makes a band (massing-kit `limitStep`): one such item owns
  // every region even when the limits do not say which region is whose.
  const banded = active.filter((x) => x.kind === 'value' || x.kind === 'undecided-value');
  /** The band of one 구간: its own regions when the limits say which region is whose. */
  const bandOf = (read: LimitRead): { regions: Band; segments: string[] } | null => {
    if (!segOf) {
      if (!banded.includes(read)) return { regions: [], segments: [] };
      return banded.length === 1 ? { regions, segments: zone?.segments ?? [] } : null;
    }
    const picked = regions.flatMap((_, i) =>
      (read.target ? segOf[i] === read.target : !targets.has(segOf[i] ?? '')) ? [i] : [],
    );
    return {
      regions: picked.map((i) => regions[i]),
      segments: [...new Set(picked.flatMap((i) => (segOf[i] ? [segOf[i]!] : [])))],
    };
  };
  let b: Building | null = null;
  if (active.some((x) => x.kind !== 'none') && regions.length) {
    b = prerequisites(ctx, r);
    if (!b) return { row: r };
  }
  const runs: Run[] = [];
  /** The building's parts inside one band, for every ground case. */
  const geometryOf = (band: Band, segments: string[], part?: string): Geo => {
    const building = b!;
    const outcomes: Outcome[] = ctx.grounds.map((g) => {
      const top = Math.max(...building.parts.map((p) => p.solid.box.max[2])) + 1;
      let column: Solid;
      try {
        column = solidUnionAll(
          band
            .filter(() => top > g.local + PIECE_THICKNESS)
            .map((reg) => regionSolid(reg, g.local, top)),
        );
      } catch {
        runs.push({ pieces: [], failed: building.parts.map((p) => p.objectId), volume: 0 });
        return {
          label: g.label,
          keys: { ground: g.key },
          state: '검사 불가',
          planned: null,
          limit: null,
          reason: '형상 연산 실패',
        };
      }
      const run = runParts(building, column, 'intersect', g, {
        rule: ZONE_TITLES[rule],
        variant: 'base',
        segments,
        ...(part ? { part } : {}),
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
    return { ...combine(outcomes), outcomes };
  };
  type Part = {
    read: LimitRead;
    state: ComplianceState;
    reasons: string[];
    planned: number | null;
  };
  const parts: Part[] = [];
  let single: Outcome[] | null = null;
  let joined: Geo | null = null;
  for (const read of active) {
    const own = read.target ? unappliedAt.get(read.target) : undefined;
    if (read.kind === 'none') {
      parts.push({ read, state: '사람 입력 필요', reasons: [read.reason], planned: null });
      continue;
    }
    const band = bandOf(read);
    let geo: Geo | null = null;
    let indistinct = false;
    if (b && band && band.regions.length)
      geo = geometryOf(
        band.regions,
        band.segments,
        segOf && active.length > 1 ? (read.target ?? '대지 전체') : undefined,
      );
    else if (b && !band) {
      joined ??= geometryOf(regions, zone?.segments ?? []);
      geo = joined;
      indistinct = true;
    }
    if (active.length === 1 && geo) single = geo.outcomes;
    const planned = geo ? Math.max(0, ...geo.outcomes.map((o) => o.planned ?? 0)) : null;
    if (own && geo?.state !== '위반') {
      parts.push({ read, state: '사람 입력 필요', reasons: own, planned });
      continue;
    }
    const p = partOf(read, geo, !!geo);
    if (indistinct && p.state !== '적합' && p.state !== '검사 불가')
      parts.push({
        read,
        state: '판단 필요',
        reasons: ['구간별 금지 띠를 나눌 수 없음 — 행 전체 결과만 확정', ...p.reasons],
        planned,
      });
    else parts.push({ read, state: p.state, reasons: p.reasons, planned });
  }
  volumeRow(r, runs);
  if (segOf && parts.length > 1) {
    const sums = ctx.grounds.map((g) =>
      runs
        .flatMap((run) => run.pieces)
        .filter((x) => x.groundCase === g.key)
        .reduce((t, x) => t + x.volume, 0),
    );
    r.planned = { value: Math.max(0, ...sums), unit: '㎥' };
  }
  if (parts.length === 1) {
    const [p] = parts;
    setState(r, p.state, ...p.reasons);
    if (single && (p.state === '적합' || p.state === '위반' || p.state === '판단 필요')) {
      const outcomes =
        p.read.kind === 'undecided-applies'
          ? [
              ...single.map((o) => ({
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
          : single;
      r.cases = casesOf(outcomes);
    }
  } else {
    r.parts = parts.map((p) => ({
      label: (p.read.target ?? p.read.title).slice(0, 120),
      target: p.read.target?.slice(0, 80) ?? null,
      state: p.state,
      planned: p.planned,
      limit: numOf(p.read),
      reason: (p.reasons.join('; ') || (p.state === '적합' ? '' : p.state)).slice(0, 300),
    }));
    let state = worstOf(parts.map((p) => p.state));
    const reasons = parts
      .filter((p) => p.state !== '적합')
      .flatMap((p) => p.reasons.map((x) => `${p.read.target ?? p.read.title}: ${x}`));
    // Bands that cannot be told apart: the row is 위반 when the joined band is and every item is a
    // decided value (some band is crossed, whichever it is); each 구간 stays 판단 필요.
    if (
      joined?.state === '위반' &&
      state !== '위반' &&
      active.every((x) => x.kind === 'value') &&
      !unapplied.length
    ) {
      state = '위반';
      reasons.unshift('구간을 나눌 수 없으나 금지 띠 안에 든 부분이 있음');
    }
    setState(r, state, ...reasons);
  }
  if (ruleWide.length) {
    r.unconfirmed.push(...ruleWide);
    if (r.state !== '위반') {
      r.state = '사람 입력 필요';
      r.reasons.push(...ruleWide);
      r.cases = [];
    }
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
  // 미반영 조건 (a datum 구간 left out, values missing): the part of the 금지 부피 the massing work
  // copy made is still checked; a 위반 there stays 위반, otherwise the row needs a person.
  const unapplied = unappliedFor(ctx, ['sun', ...SUN_ITEMS, 'sun-ground', 'sun-slope']).map(
    unappliedText,
  );
  const variants = ctx.limits.variants;
  if (sun.kind !== 'undecided-applies' && !variants.find((v) => v.id === 'base')?.sunCut)
    return {
      row: unapplied.length
        ? setState(r, '사람 입력 필요', ...unapplied)
        : setState(r, '검사 불가', '일조 금지 부피를 만들지 못함'),
    };
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
  r.cases = casesOf(outcomes);
  if (unapplied.length) {
    r.unconfirmed.push(...unapplied);
    if (sun.kind !== 'undecided-applies' && state !== '위반') {
      state = '사람 입력 필요';
      reasons = unapplied;
      r.cases = [];
    }
  }
  setState(r, state, ...reasons);
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
  const pending = pendingItems(ctx.regs, 'incentiveHeight');
  if (pending.length)
    useItems(
      r,
      pending.map((x) => x.read),
      'm',
    );
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
      const tol = PIECE_THICKNESS;
      if (s.state === '위반' && !v.heightCap) {
        // No height item: the envelope stops at the massing work copy's 검토 높이, which is not
        // a limit — what is above it is not judged (SPEC-15.5 6 '사람 입력 필요').
        const top = prep(v.envelope).box.max[2] + g.shift;
        if (run.pieces.every((p) => p.min[2] >= top - tol))
          s = {
            state: '사람 입력 필요',
            reason: '높이 상한 사람 입력 필요 — 검토 높이 위 부분은 판정하지 않음',
          };
      }
      if (s.state === '위반' && v.heightCap) {
        const cap = g.local + v.heightCap.value;
        const inBand = (extra: number) =>
          run.pieces.every((p) => p.min[2] >= cap - tol && p.max[2] <= cap + extra + tol);
        if (reliefSum > 0 && inBand(reliefSum))
          s = { state: '판단 필요', reason: '높이 완화 적용 미확정' };
        else if (
          pending.length &&
          (pending.some((x) => x.value === null)
            ? run.pieces.every((p) => p.min[2] >= cap - tol)
            : inBand(reliefSum + pending.reduce((t, x) => t + x.value!, 0)))
        )
          s = { state: '사람 입력 필요', reason: pending.map((x) => x.read.reason).join('; ') };
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

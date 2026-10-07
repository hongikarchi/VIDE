// The `vide/buildable-mass` steps after the envelope (PLAN-45 T-211·T-212, SPEC-12.10~12.12): 층 나누기 ·
// 공개공지 · 대안 · 고른 대안 (after the human step) · 용도 배분 · AI 초안 받기 (after the human
// step) · 주차·조경. Library functions called with `(inputs, params, overrides)` (ARCH-03 §2.3).
// Numbers come from the outlines, the person's table (수정 사항) and the 규제 조건 items only.

import {
  alternativeRow,
  makeAlternatives,
  TRIM_TITLES,
  type Alternative,
  type AlternativeKind,
  type AlternativeRow,
  type FloorShape,
  type TrimMethod,
} from './alternatives.ts';
import {
  basementRegions,
  floorLevels,
  floorRegions,
  meshSolid,
  regionsArea,
  subtractRegions,
  unionRegions,
} from './floors.ts';
import { landscapeAreas } from './landscape.ts';
import { openSpaceCandidates, openSpaceRequirement, pickCandidate } from './open-space.ts';
import { entryZone, legalParking, parkingTypes, PARKING_TYPE_TITLES } from './parking.ts';
import type { StepOverride } from './rules.ts';
import type { PlanRegion } from './setback.ts';
import {
  linesOf,
  STUDY_NOTE,
  type PlanOutput,
  type RegulationsOutput,
  type SiteOutput,
} from './steps.ts';
import { acceptUseDraft, allocateUses, useTable } from './use-mix.ts';
import type { SolidMesh } from '../geometry-kit/solid.ts';

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const stepsOf = (inputs: Record<string, unknown>) =>
  (inputs.steps ?? {}) as Record<string, unknown>;

interface EnvelopeVariant {
  id: string;
  title: string;
  height: number;
  maxMesh: SolidMesh;
}
interface EnvelopeOutput {
  variants: EnvelopeVariant[];
  unconfirmed: number;
}

/** Closed curve items (plan, z = 0) of regions. */
const regionCurves = (
  prefix: string,
  regions: readonly PlanRegion[],
  attrs: Record<string, string>,
) =>
  regions.flatMap((r, k) =>
    [r.outer, ...r.holes].map((ring, h) => ({
      key: `${prefix}:${k}${h ? `.${h}` : ''}`,
      curve: [...ring, ring[0]].map((p) => [p[0], p[1], 0]),
      ...attrs,
    })),
  );

// ── 층 나누기 ────────────────────────────────────────────────────────────────────────────────────

export interface FloorsOutput {
  variant: string;
  height: number;
  floors: FloorShape[];
  basement: FloorShape[];
  /** One basement floor's outline (대지 − 지하 이격), also when no basement is planned. */
  basementRegions: PlanRegion[];
  basementArea: number;
  rows: { floor: string; z0: number; z1: number; height: number; area: number }[];
  notes: string[];
}

/**
 * 층 나누기 (SPEC-12.10 1): the maximum envelope of the 판단 필요 항목 적용 variant cut by the floor
 * heights of the 계획 조건; basements from the site minus the 지하 이격.
 */
export function floorsStep(inputs: Record<string, unknown>) {
  const steps = stepsOf(inputs);
  const site = steps.site as SiteOutput;
  const plan = steps.plan as PlanOutput;
  const envelope = steps.envelope as EnvelopeOutput;
  if (!site || !plan || !envelope?.variants?.length) throw new Error('앞 단계의 결과가 없습니다');
  if (!(plan.floorHeightGround > 0) || !(plan.floorHeightTypical > 0))
    throw new Error('층고(1층·기준층) 사람 입력 필요 — 층을 나눌 수 없습니다');
  const variant = envelope.variants[0];
  const solid = meshSolid(variant.maxMesh);
  const levels = floorLevels(
    plan.floorHeightGround,
    plan.floorHeightTypical,
    variant.height,
    plan.basementFloors,
    plan.basementFloorHeight,
  );
  const floors: FloorShape[] = [];
  for (const l of levels.filter((l) => l.index > 0)) {
    const regions = floorRegions(solid, site.ring, l.z0, l.z1);
    const area = r6(regionsArea(regions));
    if (!(area > 1e-6)) break;
    floors.push({ ...l, regions, area });
  }
  const below = basementRegions(site.ring, plan.basementSetback);
  const belowArea = r6(regionsArea(below));
  const basement: FloorShape[] = levels
    .filter((l) => l.index < 0)
    .map((l) => ({ ...l, regions: below, area: belowArea }));
  const notes = [
    `${variant.title} 최대 외피 기준(높이 ${r6(variant.height)} m)`,
    '층 윤곽 = 층 윗면 높이의 외피 단면(외피는 위로 갈수록 넓어지지 않음)',
  ];
  if (envelope.variants.length > 1)
    notes.push('판단 필요 항목 미적용 외피는 대안에 쓰지 않음 — 판단 뒤 다시 계산');
  if (plan.basementFloors > 0 && !(plan.basementFloorHeight > 0))
    notes.push('지하 층고 사람 입력 필요 — 지하층을 만들지 않음');
  return {
    variant: variant.id,
    height: variant.height,
    floors,
    basement,
    basementRegions: below,
    basementArea: belowArea,
    rows: [...floors, ...basement].map((f) => ({
      floor: f.floor,
      z0: f.z0,
      z1: f.z1,
      height: r6(f.z1 - f.z0),
      area: f.area,
    })),
    notes,
  } satisfies FloorsOutput;
}

// ── 공개공지 ─────────────────────────────────────────────────────────────────────────────────────

/** 공개공지 (SPEC-12.10 5): 필요 면적, 후보 영역과 표. */
export function openSpaceStep(inputs: Record<string, unknown>, params: Record<string, unknown>) {
  const steps = stepsOf(inputs);
  const site = steps.site as SiteOutput;
  const regs = steps.regulations as RegulationsOutput;
  if (!site || !regs) throw new Error('앞 단계의 결과가 없습니다');
  const own = (inputs.site ?? {}) as Record<string, unknown>;
  const drawn = linesOf(own.openSpaceZones)
    .filter((l) => l.closed && l.points.length >= 3)
    .map((l) => ({ id: l.id, ring: l.points }));
  const requirement = openSpaceRequirement(regs.items, site.area_m2);
  const candidates = openSpaceCandidates(site, drawn, requirement, regs.items);
  const picked =
    requirement.state === 'required'
      ? pickCandidate(candidates, num(params.openSpaceCandidate, 0))
      : null;
  return {
    requirement,
    candidates,
    rows: candidates.map((c) => ({
      no: c.no,
      source: c.source,
      area: c.area,
      required: c.required,
      verdict: c.verdict,
      incentive: c.incentiveText,
      picked: picked?.no === c.no ? '대안에 씀' : '',
      note: c.note,
    })),
    picked: picked ? { no: picked.no, id: picked.id, area: picked.area } : null,
    lines: candidates.flatMap((c) =>
      regionCurves(`open:${c.no}`, c.regions, {
        kind: `공개공지 후보 ${c.no}`,
        areaText: c.area.toFixed(2),
      }),
    ),
  };
}
type OpenSpaceOutput = ReturnType<typeof openSpaceStep>;

// ── 대안 ────────────────────────────────────────────────────────────────────────────────────────

export interface AlternativesOutput {
  alternatives: Alternative[];
  rows: AlternativeRow[];
  bars: { label: string; value: number; shade: string }[];
  skipped: { id: string; title: string; reason: string }[];
  problems: string[];
  method: string;
  siteArea: number;
  note: string;
}

const HUMAN_BASES: readonly string[] = ['max', 'base', 'incentive', 'open-space'];

/** 대안 (SPEC-12.10 2~5): the closed list, at most 8, and the table. */
export function alternativesStep(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  overrides: StepOverride[] = [],
) {
  const steps = stepsOf(inputs);
  const site = steps.site as SiteOutput;
  const regs = steps.regulations as RegulationsOutput;
  const floors = steps.floors as FloorsOutput;
  const open = steps.openSpace as OpenSpaceOutput;
  const envelope = steps.envelope as EnvelopeOutput | undefined;
  if (!site || !regs || !floors || !open) throw new Error('앞 단계의 결과가 없습니다');
  const method: TrimMethod = params.trimMethod === 'drop-floors' ? 'drop-floors' : 'shrink-top';
  const humanBase = (
    HUMAN_BASES.includes(String(params.humanBase)) ? params.humanBase : 'max'
  ) as Exclude<AlternativeKind, 'human'>;
  const picked = open.picked
    ? (open.candidates.find((c) => c.no === open.picked!.no) ?? null)
    : null;
  const made = makeAlternatives({
    floors: floors.floors,
    basement: floors.basement,
    siteArea: site.area_m2,
    north: site.north,
    items: regs.items,
    method,
    openSpace: picked
      ? { no: picked.no, id: picked.id, regions: picked.regions, area: picked.area }
      : null,
    openSpaceState: open.requirement.state,
    humanBase,
    overrides,
    envelope: envelope?.variants?.length ? meshSolid(envelope.variants[0].maxMesh) : null,
  });
  const unconfirmed = envelope?.unconfirmed ?? regs.unconfirmed.length;
  const rows = made.alternatives.map((a) =>
    alternativeRow(a, site.area_m2, regs.items, unconfirmed),
  );
  return {
    alternatives: made.alternatives,
    rows,
    bars: rows.map((r) => ({
      label: r.title,
      value: r.far,
      shade: r.id === 'max' ? 'base' : r.farVerdict === '초과' ? 'strong' : 'alt',
    })),
    skipped: made.skipped,
    problems: made.problems,
    method: TRIM_TITLES[method],
    siteArea: site.area_m2,
    note: STUDY_NOTE,
  } satisfies AlternativesOutput;
}

// ── 고른 대안 ────────────────────────────────────────────────────────────────────────────────────

/**
 * 고른 대안 (SPEC-12.10 7): runs only after the person confirmed the human step, whose fingerprint
 * covers the alternatives and the setting — if either changes, the step waits for 다시 확인.
 */
export function chosenStep(inputs: Record<string, unknown>, params: Record<string, unknown>) {
  const alts = stepsOf(inputs).alternatives as AlternativesOutput;
  if (!alts) throw new Error('대안 단계의 결과가 없습니다');
  const id = String(params.chosenAlternative ?? 'unset');
  if (id === 'unset') throw new Error('고른 대안이 없습니다 — 대안 하나를 고르고 확정하세요');
  const alternative = alts.alternatives.find((a) => a.id === id);
  if (!alternative) throw new Error(`고른 대안 ${id}가 대안 표에 없습니다`);
  return {
    id,
    title: alternative.title,
    row: alts.rows.find((r) => r.id === id)!,
    alternative,
    origin: '사용자가 확정함',
    note: STUDY_NOTE,
  };
}

// ── 용도 배분 ────────────────────────────────────────────────────────────────────────────────────

/** 용도 배분 (SPEC-12.11) for every alternative, and the floor masses to make in Rhino. */
export function useMixStep(
  inputs: Record<string, unknown>,
  _params: Record<string, unknown>,
  overrides: StepOverride[] = [],
) {
  const steps = stepsOf(inputs);
  const alts = steps.alternatives as AlternativesOutput;
  const plan = steps.plan as PlanOutput;
  const regs = steps.regulations as RegulationsOutput;
  if (!alts || !plan || !regs) throw new Error('앞 단계의 결과가 없습니다');
  const table = useTable(overrides);
  const unconfirmed = new Map(alts.rows.map((r) => [r.id, r.unconfirmed]));
  const perAlt = alts.alternatives.map((a) => ({
    id: a.id,
    title: a.title,
    ...allocateUses(a, plan.mainUse, table.rows, regs.items),
  }));
  const items: Record<string, unknown>[] = [];
  for (const a of alts.alternatives) {
    const uses = perAlt.find((p) => p.id === a.id)!;
    for (const f of [...a.floors, ...a.basement]) {
      const use =
        uses.floors
          .find((u) => u.floor === f.floor)
          ?.uses.map((u) => u.use)
          .join(', ') ?? '';
      f.regions.forEach((r, k) =>
        items.push({
          key: `alt:${a.id}:${f.floor}:${k}`,
          rings: [r.outer, ...r.holes],
          bottom: f.z0,
          height: r6(f.z1 - f.z0),
          option: a.title,
          floor: f.floor,
          areaText: f.area.toFixed(2),
          use,
          unconfirmed: String(unconfirmed.get(a.id) ?? 0),
        }),
      );
    }
  }
  return {
    alternatives: perAlt,
    floorRows: perAlt.flatMap((p) =>
      p.floors.map((f) => ({
        alternative: p.title,
        floor: f.floor,
        uses: f.uses
          .map((u) => (u.ratio === 1 ? u.use : `${u.use} ${r6(u.ratio * 100)}%`))
          .join(', '),
        area: f.area,
        origin: f.origin,
        verdict: f.verdict,
        reason: f.reason,
      })),
    ),
    useRows: perAlt.flatMap((p) => p.byUse.map((u) => ({ alternative: p.title, ...u }))),
    problems: table.problems,
    items,
  };
}
type UseMixOutput = ReturnType<typeof useMixStep>;

/**
 * AI 초안 받기: runs only after the person confirmed the human step that shows the draft; turns the
 * draft into the person's 수정 사항 (ARCH-03 §6.3 적용 요청). Nothing enters the table before.
 */
export function applyUseDraft(inputs: Record<string, unknown>) {
  const steps = stepsOf(inputs);
  const alts = steps.alternatives as AlternativesOutput;
  if (!alts) throw new Error('대안 단계의 결과가 없습니다');
  const floors = new Set(
    alts.alternatives.flatMap((a) => [...a.floors, ...a.basement].map((f) => f.floor)),
  );
  const { overrides, refused } = acceptUseDraft(steps.useDraft, floors);
  return {
    apply: { overrides },
    accepted: overrides.length,
    refused,
    note: overrides.length
      ? `AI 초안 ${overrides.length}개 층을 사람이 받아 용도 표에 넣습니다`
      : '받을 초안이 없습니다',
  };
}

// ── 주차·조경 ────────────────────────────────────────────────────────────────────────────────────

/** 주차와 대지 안의 공지 (SPEC-12.12). */
export function parkingStep(inputs: Record<string, unknown>, params: Record<string, unknown>) {
  const steps = stepsOf(inputs);
  const site = steps.site as SiteOutput;
  const regs = steps.regulations as RegulationsOutput;
  const uses = steps.useMix as UseMixOutput;
  const alts = steps.alternatives as AlternativesOutput;
  const floors = steps.floors as FloorsOutput;
  const open = steps.openSpace as OpenSpaceOutput;
  if (!site || !regs || !uses || !alts || !floors || !open)
    throw new Error('앞 단계의 결과가 없습니다');
  const own = (inputs.site ?? {}) as Record<string, unknown>;
  const landscapeDrawn = linesOf(own.landscapeZones)
    .filter((l) => l.closed && l.points.length >= 3)
    .map((l) => ({ id: l.id, ring: l.points }));
  const landscape = landscapeAreas(regs.items, site.area_m2, site.ring, landscapeDrawn);
  const exclusions = linesOf(own.parkingExclusions).map((l) => ({
    id: l.id,
    points: l.closed ? [...l.points, l.points[0]] : l.points,
  }));
  const entry = entryZone(site.segments, site.corners, exclusions, regs.items, site.tolerance);
  const planned = Math.max(0, Math.floor(num(params.plannedParking, 0)));
  const perCar = {
    ground: num(params.parkingAreaGround, 0),
    underground: num(params.parkingAreaUnder, 0),
    mechanical: num(params.parkingAreaMech, 0),
  };
  const perAlt = alts.alternatives.map((a) => {
    const byUse = uses.alternatives.find((u) => u.id === a.id)?.byUse ?? [];
    const legal = legalParking(byUse, regs.items);
    return {
      id: a.id,
      title: a.title,
      legal,
      planned: planned || null,
      used: planned || legal.count,
    };
  });
  const chosenId = String(params.parkingAlternative ?? 'base');
  const target =
    alts.alternatives.find((a) => a.id === chosenId) ??
    alts.alternatives.find((a) => a.id === 'base') ??
    alts.alternatives[0];
  const t = perAlt.find((p) => p.id === target.id)!;
  // 지상 여유 = 대지 − 건축면적(층 윤곽의 합) − 공개공지(그 대안이 비운 후보) − 그린 조경 영역.
  const openRegions = target.openSpace
    ? (open.candidates.find((c) => c.no === target.openSpace!.no)?.regions ?? [])
    : [];
  const footprint = unionRegions(target.floors.map((f) => f.regions));
  const free = subtractRegions(
    [{ outer: site.ring, holes: [] }],
    unionRegions([footprint, openRegions, landscape.regions].filter((l) => l.length)),
  );
  const freeArea = r6(regionsArea(free));
  const types = parkingTypes(t.used, perCar, freeArea, floors.basementArea, target.basement.length);
  const under = types.find((r) => r.type === 'underground')!;
  const plan = steps.plan as PlanOutput | undefined;
  const bh = plan?.basementFloorHeight ?? 0;
  const masses: Record<string, unknown>[] = [];
  if (under.floors && bh > 0)
    for (let k = 1; k <= under.floors; k++)
      floors.basementRegions.forEach((r, i) =>
        masses.push({
          key: `park:under:B${k}:${i}`,
          rings: [r.outer, ...r.holes],
          bottom: r6(-k * bh),
          height: r6(bh),
          option: `${target.title} · ${PARKING_TYPE_TITLES.underground}`,
          floor: `B${k}`,
          areaText: floors.basementArea.toFixed(2),
          use: '주차장(추정)',
        }),
      );
  const lines = [
    ...entry.pieces.map((p, i) => ({
      key: `entry:${p.segment}:${i}`,
      curve: [
        [p.a[0], p.a[1], 0],
        [p.b[0], p.b[1], 0],
      ],
      kind: '주차 진입 가능 구간',
      areaText: '',
    })),
    ...regionCurves('ground-free', free, {
      kind: `지상 여유(${target.title})`,
      areaText: freeArea.toFixed(2),
    }),
    ...regionCurves('landscape', landscape.regions, {
      kind: '조경(그린 영역)',
      areaText: landscape.planned.toFixed(2),
    }),
    ...regionCurves('open-space', openRegions, {
      kind: `공개공지(${target.title})`,
      areaText: (target.openSpace?.area ?? 0).toFixed(2),
    }),
  ];
  const unresolved = [
    ...entry.unresolved,
    ...perAlt
      .filter((p) => p.legal.count === null)
      .slice(0, 1)
      .map((p) => `법정 주차 대수: ${p.legal.status}`),
    ...(landscape.legal === null ? [`법정 조경 면적: ${landscape.legalStatus}`] : []),
  ];
  return {
    alternatives: perAlt.map((p) => ({
      id: p.id,
      title: p.title,
      raw: p.legal.raw,
      legal: p.legal.count,
      status: p.legal.status,
      planned: p.planned,
      used: p.used,
    })),
    useRows: t.legal.rows.map((r) => ({ alternative: target.title, ...r })),
    target: { id: target.id, title: target.title },
    landscape: {
      ratio: landscape.ratio,
      legal: landscape.legal,
      legalStatus: landscape.legalStatus,
      planned: landscape.planned,
      verdict: landscape.verdict,
    },
    publicOpenSpace: {
      required: open.requirement.required,
      state: open.requirement.message,
      planned: target.openSpace?.area ?? null,
    },
    entry: { pieces: entry.pieces, length: entry.length },
    ground: { free: freeArea, footprint: r6(regionsArea(footprint)) },
    types,
    lines,
    masses,
    unresolved,
    note: STUDY_NOTE,
  };
}

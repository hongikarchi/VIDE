// 넘겨줄 결과 (PLAN-45 T-213, SPEC-12.2·12.13 1): the `vide/buildable-mass` output the 건축개요 jig
// (`vide/building-summary`) takes as its `jig-output` input — the confirmed 고른 대안 with its floors
// (areas, 제외 면적, 산정 면적, uses), its table row, the 규제 조건 items as they are (값 · 적용 여부 ·
// 확정 상태 · 출처 · 근거), the plan, the 용도·주차·조경·공개공지 numbers of that alternative and what is
// still 미확정. No outlines (the summary needs numbers, not geometry) and no new arithmetic: every
// number is one the earlier steps computed, so the summary's `numbers-in-source` check can find it.

import type { AltFloor } from './alternatives.ts';
import type { AlternativesOutput, FloorsOutput } from './mass-steps.ts';
import type { ParkingTypeRow, LegalParking } from './parking.ts';
import type { RegulationItem } from './rules.ts';
import {
  SQUARE_DATUM,
  STUDY_NOTE,
  type PlanOutput,
  type RegulationsOutput,
  type SiteOutput,
} from './steps.ts';
import type { FloorUse, UseTotal } from './use-mix.ts';

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface HandoffFloor {
  floor: string;
  index: number;
  z0: number;
  z1: number;
  height: number;
  area: number;
  exclusion: number;
  exclusionBasis: string;
  farArea: number;
  change: string;
  outside: boolean;
  uses: { use: string; ratio: number; area: number }[];
  useOrigin: string;
  useVerdict: string;
}

/** The 고른 대안 as other jigs read it (schema `schemas/outputs/chosen.json` of buildable-mass). */
export interface ChosenHandoff {
  kind: 'vide/buildable-mass#chosen';
  alternative: {
    id: string;
    title: string;
    flags: string[];
    farTarget: number | null;
    farTargetSource: string;
    notes: string[];
    openSpace: { no: number; area: number } | null;
  };
  /** The alternative's row of the 대안 표 (SPEC-12.10 3). */
  row: AlternativesOutput['rows'][number];
  floors: HandoffFloor[];
  basement: HandoffFloor[];
  site: { area_m2: number; northBasis: string; northDeg: number };
  plan: {
    mainUse: string | null;
    floorHeightGround: number;
    floorHeightTypical: number;
    basementFloors: number;
    basementFloorHeight: number;
  };
  regulations: {
    items: RegulationItem[];
    legal: { available: boolean; reason: string };
    needsInput: { id: string; title: string }[];
  };
  uses: UseTotal[];
  parking: {
    legal: number | null;
    raw: number;
    status: string;
    planned: number | null;
    rows: LegalParking['rows'];
    /** 주차 방식 대안, when the jig computed them for this alternative (SPEC-12.12 5). */
    types: ParkingTypeRow[] | null;
  };
  landscape: {
    ratio: number | null;
    legal: number | null;
    legalStatus: string;
    planned: number;
    verdict: string;
  };
  publicOpenSpace: { required: number | null; state: string; planned: number | null };
  /** 미확정 조건 of this alternative (SPEC-12.13 5): 판단 필요·가정 items, 미반영 조건, flags. */
  unconfirmed: { title: string; status: string }[];
  chosenBy: '사용자가 확정함';
  note: string;
}

interface UseMixLike {
  alternatives: { id: string; floors: FloorUse[]; byUse: UseTotal[] }[];
}
interface ParkingLike {
  alternatives: {
    id: string;
    raw: number;
    legal: number | null;
    status: string;
    planned: number | null;
  }[];
  target: { id: string };
  types: ParkingTypeRow[];
  landscape: ChosenHandoff['landscape'];
  publicOpenSpace: { required: number | null; state: string };
  useRows: (LegalParking['rows'][number] & { alternative: string })[];
}
interface ChosenLike {
  id: string;
  title: string;
  row: AlternativesOutput['rows'][number];
  alternative: AlternativesOutput['alternatives'][number];
}
interface EnvelopeLike {
  unresolved?: { title: string; reason: string }[];
}

const floorOf = (f: AltFloor, uses: FloorUse | undefined): HandoffFloor => ({
  floor: f.floor,
  index: f.index,
  z0: f.z0,
  z1: f.z1,
  height: r6(f.z1 - f.z0),
  area: f.area,
  exclusion: f.exclusion,
  exclusionBasis: f.exclusionBasis,
  farArea: f.farArea,
  change: f.change,
  outside: !!f.outside,
  uses: (uses?.uses ?? []).map((u) => ({ use: u.use, ratio: u.ratio, area: u.area })),
  useOrigin: uses?.origin ?? '',
  useVerdict: uses?.verdict ?? '미검토',
});

/** 넘겨줄 결과: runs after 고른 대안 (so only once the person confirmed the choice). */
export function handoffStep(inputs: Record<string, unknown>): ChosenHandoff {
  const steps = (inputs.steps ?? {}) as Record<string, unknown>;
  const chosen = steps.chosen as ChosenLike | undefined;
  const site = steps.site as SiteOutput | undefined;
  const regs = steps.regulations as RegulationsOutput | undefined;
  const plan = steps.plan as PlanOutput | undefined;
  const uses = steps.useMix as UseMixLike | undefined;
  const parking = steps.parking as ParkingLike | undefined;
  const envelope = steps.envelope as EnvelopeLike | undefined;
  if (!chosen || !site || !regs || !plan)
    throw new Error('고른 대안이 없습니다 — 대안을 확정하세요');
  const alt = chosen.alternative;
  const altUses = uses?.alternatives.find((u) => u.id === alt.id);
  const useOf = (floor: string) => altUses?.floors.find((u) => u.floor === floor);
  const p = parking?.alternatives.find((a) => a.id === alt.id);
  const flags = alt.flags.includes('조건 미확정')
    ? [{ title: `${alt.title}: 인센티브 조건 미확정`, status: '판단 필요' }]
    : [];
  return {
    kind: 'vide/buildable-mass#chosen',
    alternative: {
      id: alt.id,
      title: alt.title,
      flags: [...alt.flags],
      farTarget: alt.farTarget,
      farTargetSource: alt.farTargetSource,
      notes: [...alt.notes],
      openSpace: alt.openSpace ? { no: alt.openSpace.no, area: alt.openSpace.area } : null,
    },
    row: chosen.row,
    floors: alt.floors.map((f) => floorOf(f, useOf(f.floor))),
    basement: alt.basement.map((f) => floorOf(f, useOf(f.floor))),
    site: { area_m2: site.area_m2, northBasis: site.northBasis, northDeg: site.northDeg },
    plan: {
      mainUse: plan.mainUse,
      floorHeightGround: plan.floorHeightGround,
      floorHeightTypical: plan.floorHeightTypical,
      basementFloors: plan.basementFloors,
      basementFloorHeight: plan.basementFloorHeight,
    },
    regulations: {
      items: regs.items,
      legal: regs.legal,
      needsInput: regs.needsInput,
    },
    uses: altUses?.byUse ?? [],
    parking: {
      legal: p?.legal ?? null,
      raw: p?.raw ?? 0,
      status: p?.status ?? '주차 단계 결과 없음',
      planned: p?.planned ?? null,
      rows:
        parking?.target.id === alt.id
          ? parking.useRows.map(({ alternative: _a, ...row }) => row)
          : [],
      types: parking && parking.target.id === alt.id ? parking.types : null,
    },
    landscape: parking?.landscape ?? {
      ratio: null,
      legal: null,
      legalStatus: '주차·조경 단계 결과 없음',
      planned: 0,
      verdict: '미검토',
    },
    publicOpenSpace: {
      required: parking?.publicOpenSpace.required ?? null,
      state: parking?.publicOpenSpace.state ?? '주차·조경 단계 결과 없음',
      planned: alt.openSpace?.area ?? null,
    },
    unconfirmed: [
      ...regs.unconfirmed.map((u) => ({ title: u.title, status: u.status })),
      ...(envelope?.unresolved ?? []).map((u) => ({
        title: `${u.title}: ${u.reason}`,
        // Computed with it, the reading open (F-7); everything else was left out.
        status: SQUARE_DATUM.test(u.reason) ? '판단 필요' : '미반영',
      })),
      ...flags,
    ],
    chosenBy: '사용자가 확정함',
    note: STUDY_NOTE,
  };
}

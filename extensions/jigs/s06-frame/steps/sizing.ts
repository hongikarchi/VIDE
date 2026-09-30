// S-06 frame jig ⑨ 단면 선정 (PLAN-23 T-056, SPEC-06.12, SPEC-06.11 8): KS H sections per group
// (role × span band, curved members apart) within the depth limit, by vide/structure-analysis
// `sizeGroups`. The first iteration reuses the analysis of step 'analysis' — the confirmed result
// when it belongs to this model, else the preview (then `previewOnly: true`); later iterations run
// previews through `deps.analyze` (default: the worker). A group with no KS H under the limit is
// '후보 없음' and keeps its section; the heaviest section is never taken silently. When no analysis
// can run, groups are listed with status 'unchecked' and their current section.
//
// Like step 'analysis' this needs the native core in a worker thread: run it in the engine
// (library-style step) or pass `deps.analyze`.

import type { StructureSummary } from '../../../../src/contracts/structure-model.ts';
import {
  analyzeSummary,
  hProps,
  memberGeometry,
  sectionProps,
  sizeGroups,
  spanBand,
  TAG_LABEL,
  DEFAULT_DEPTH_MAX_MM,
  DEFAULT_SPAN_BANDS_M,
  SIZING_NOTE,
  STEEL_DENSITY_KGPM3,
  type SizingAnalyze,
  type SizingResult,
} from '../../../../src/jigs/official/structure-analysis/index.ts';
import type { AnalysisOutput } from './analysis.ts';
import type { ModelOutput } from './model.ts';

export type SizingGroupRole = 'column' | 'girder' | 'beam' | 'edge';
export type SizingGroupStatus = 'ok' | 'no-candidate' | 'unchecked';

export interface SizingGroupOut {
  id: string;
  role: SizingGroupRole;
  /** Korean role label for tables: 기둥·거더·테두리보·작은보. */
  roleLabel: string;
  /** Span band label, e.g. '6–9 m'. */
  band: string;
  memberIds: string[];
  /** Chosen section; the current one for '후보 없음' and unchecked groups (null when unknown). */
  sectionId: string | null;
  sectionName: string | null;
  /** Largest observed ratio of the group with the section last analysed (null when unchecked). */
  maxRatio: number | null;
  status: SizingGroupStatus;
  /** Korean verdict for tables: '선정'·'후보 없음'·'미검토'. */
  judgement: string;
  /** '후보 없음': the lightest KS H beyond the limit that would do, when there is one. */
  beyondLimit?: string;
}
export interface SectionOut {
  name: string;
  h_mm: number;
  b_mm: number;
  tw_mm: number;
  tf_mm: number;
  /** Quantity-grade unit weight from the dimensions (7,850 kg/m³). */
  kgpm: number;
}
export interface SizingOutput {
  schema: 'vide.s06.sizing/1';
  /** True unless the first iteration used the confirmed result of this model. */
  previewOnly: boolean;
  /** Which analysis the first iteration used. */
  basis: 'confirmed' | 'preview' | 'none';
  modelHash: string;
  status: 'converged' | 'not-converged' | 'error' | 'unavailable';
  groups: SizingGroupOut[];
  sectionsById: Record<string, SectionOut>;
  iterations: number;
  notes: string[];
  summary: {
    groups: number;
    ok: number;
    noCandidate: number;
    unchecked: number;
    maxRatio: number | null;
    steel_t: number | null;
  };
}

export interface SizingInputs {
  steps: { model: ModelOutput; analysis?: AnalysisOutput | null };
}
export interface SizingParams {
  /** Depth limit of girders, edge girders and beams (mm). */
  depthMax_mm: number;
  /** Jig setting `depthMax` in metres; wins over `depthMax_mm` when given. */
  depthMax?: number;
  /** Depth limit of columns (mm). */
  columnDepthMax_mm: number;
  targetRatio: number;
  steelGrade: string;
  maxIterations: number;
  spanBands_m: number[];
}
export const DEFAULT_SIZING_PARAMS: SizingParams = {
  depthMax_mm: 900,
  columnDepthMax_mm: DEFAULT_DEPTH_MAX_MM.column,
  targetRatio: 0.9,
  steelGrade: 'SM355',
  maxIterations: 6,
  spanBands_m: DEFAULT_SPAN_BANDS_M,
};
export interface SizingDeps {
  analyze?: SizingAnalyze;
}

const KEY = 's06-frame:sizing';
const JUDGEMENT: Record<SizingGroupStatus, string> = {
  ok: '선정',
  'no-candidate': '후보 없음',
  unchecked: '미검토',
};
const r3 = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(Math.min(v, 999).toFixed(3));

/** Group role of a design member: the edge tag stands apart from girders. */
const roleOf = (model: ModelOutput, id: string): SizingGroupRole | null => {
  const role = model.map.roles[id];
  if (role === 'column') return 'column';
  if (role === 'girder') return model.map.tags[id] === 'edge' ? 'edge' : 'girder';
  if (role === 'beam') return 'beam';
  return null;
};

/** The summary the first iteration may reuse, and what it was. */
function givenSummary(
  model: ModelOutput,
  analysis: AnalysisOutput | null | undefined,
): { summary: StructureSummary | null; basis: SizingOutput['basis'] } {
  if (!analysis || analysis.modelHash !== model.modelHash) return { summary: null, basis: 'none' };
  const confirmed = analysis.confirmed;
  if (confirmed && confirmed.modelHash === model.modelHash && confirmed.result?.status === 'ok')
    return { summary: confirmed.result, basis: 'confirmed' };
  if (analysis.preview?.status === 'ok') return { summary: analysis.preview, basis: 'preview' };
  return { summary: null, basis: 'none' };
}

function sectionOut(
  id: string,
  sections: ModelOutput['model']['sections'],
): SectionOut | undefined {
  const s = sections.find((x) => x.id === id);
  if (!s) return undefined;
  const d = s.dims_mm;
  const props =
    s.shape === 'H' ? hProps({ h: d.h, b: d.b, tw: d.tw, tf: d.tf, r: d.r }) : undefined;
  const area = props?.A_mm2 ?? sectionProps(s)?.A_mm2;
  return {
    name: s.name ?? id,
    h_mm: d.h,
    b_mm: d.b,
    tw_mm: d.tw,
    tf_mm: d.tf,
    kgpm: area === undefined ? 0 : Number((area * 1e-6 * STEEL_DENSITY_KGPM3).toFixed(2)),
  };
}

/** Groups by role and span band with the current sections, for when nothing could be analysed. */
function uncheckedGroups(model: ModelOutput, bands: number[]): SizingGroupOut[] {
  const geometry = memberGeometry(model.model, model.map);
  const sectionOfMember = new Map(model.model.members.map((m) => [m.id, m.section]));
  const names = new Map(model.model.sections.map((s) => [s.id, s.name ?? s.id]));
  const groups = new Map<string, SizingGroupOut>();
  for (const [id, segments] of Object.entries(model.map.physical)) {
    const role = roleOf(model, id);
    if (!role || !segments.length) continue;
    const g = geometry[id];
    const band = spanBand(g?.length_m ?? 0, bands);
    const key = [role, band, g?.curved ? '곡선' : ''].filter(Boolean).join('|');
    const sectionId = sectionOfMember.get(segments[0]) ?? null;
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key,
        role,
        roleLabel: TAG_LABEL[role] ?? role,
        band,
        memberIds: [],
        sectionId,
        sectionName: sectionId ? (names.get(sectionId) ?? sectionId) : null,
        maxRatio: null,
        status: 'unchecked',
        judgement: JUDGEMENT.unchecked,
      };
      groups.set(key, group);
    }
    group.memberIds.push(id);
  }
  for (const g of groups.values()) g.memberIds.sort();
  return [...groups.values()];
}

/** Step 'sizing': KS H sections per group within the depth limit (T-056 ⑨). */
export async function sizing(
  inputs: SizingInputs,
  params: Partial<SizingParams> = {},
  _overrides: unknown[] = [],
  deps: SizingDeps = {},
): Promise<SizingOutput> {
  const p = { ...DEFAULT_SIZING_PARAMS, ...params };
  const depthMax =
    typeof p.depthMax === 'number' && p.depthMax > 0 ? p.depthMax * 1000 : p.depthMax_mm;
  const model = inputs.steps.model;
  const bands = [...p.spanBands_m].sort((a, b) => a - b);
  const { summary: given, basis } = givenSummary(model, inputs.steps.analysis);
  const notes: string[] = [];
  const material = model.model.materials[0];
  if (material && material.grade !== p.steelGrade)
    notes.push(
      `강종 설정 ${p.steelGrade}이 모델 재료 ${material.grade}와 다름 — 모델 재료로 선정했습니다.`,
    );
  if (basis === 'preview')
    notes.push('확정 해석이 없어 미확정 미리보기로 선정했습니다 — 탐색용 예비값입니다.');
  if (basis === 'none')
    notes.push('이 모델의 해석 결과가 없어 선정 중 미리보기 해석을 새로 돌렸습니다.');

  // The first iteration reuses the given result; later ones run previews.
  const analyze = deps.analyze ?? analyzeSummary;
  let first = true;
  const analyzer: SizingAnalyze = (m, map, options) => {
    if (first && given) {
      first = false;
      return { summary: given };
    }
    first = false;
    return analyze(m, map, options);
  };

  let result: SizingResult | undefined;
  let failure: string | undefined;
  try {
    result = await sizeGroups(
      model.model,
      model.map,
      {
        target: p.targetRatio,
        maxIterations: p.maxIterations,
        depthMax_mm: { girder: depthMax, beam: depthMax, column: p.columnDepthMax_mm },
        spanBands_m: bands,
        zoneOf: (id) => (model.map.tags[id] === 'edge' ? '테두리보' : undefined),
        key: KEY,
        assumptions: model.assumptions,
      },
      analyzer,
    );
  } catch (error) {
    failure = String((error as { message?: string })?.message ?? error);
  }

  if (!result || result.status === 'error') {
    const groups = uncheckedGroups(model, bands);
    const sectionsById: Record<string, SectionOut> = {};
    for (const g of groups) {
      const s = g.sectionId && sectionOut(g.sectionId, model.model.sections);
      if (s && g.sectionId) sectionsById[g.sectionId] = s;
    }
    notes.push(
      failure
        ? `해석을 돌리지 못해 단면을 선정하지 않았습니다(${failure}).`
        : '미리보기 해석이 실패해 단면을 선정하지 않았습니다.',
      ...(result?.issues ?? []).map((i) => i.message),
    );
    return {
      schema: 'vide.s06.sizing/1',
      previewOnly: basis !== 'confirmed',
      basis,
      modelHash: model.modelHash,
      status: failure ? 'unavailable' : 'error',
      groups,
      sectionsById,
      iterations: result?.iterations ?? 0,
      notes,
      summary: {
        groups: groups.length,
        ok: 0,
        noCandidate: 0,
        unchecked: groups.length,
        maxRatio: null,
        steel_t: null,
      },
    };
  }

  const names = new Map(
    [...model.model.sections, ...result.model.sections].map((s) => [s.id, s.name ?? s.id]),
  );
  // A '후보 없음' group whose own section met the target in the first analysis keeps it as the
  // choice: only lighter candidates failed (e.g. a slenderness limit hit on a probe).
  const kept = new Set<string>();
  const groups: SizingGroupOut[] = result.groups.map((g) => {
    const role: SizingGroupRole = g.zone.includes('테두리보') ? 'edge' : g.role;
    const first = g.from.length === 1 && g.history[0]?.section === g.from[0] ? g.history[0] : null;
    const keeps =
      g.status === 'no-candidate' &&
      !!first &&
      first.ratio !== null &&
      first.ratio <= p.targetRatio + 1e-9 &&
      (first.deflectionRatio === null || first.deflectionRatio <= 1 + 1e-9);
    if (keeps) kept.add(g.id);
    const status: SizingGroupStatus =
      g.status === 'ok' || keeps
        ? 'ok'
        : g.status === 'no-candidate'
          ? 'no-candidate'
          : 'unchecked';
    // '후보 없음' and unchanged groups keep the section the model had before sizing.
    const sectionId = g.section ?? g.from[0] ?? result!.assignments[g.members[0]] ?? null;
    return {
      id: g.id,
      role,
      roleLabel: TAG_LABEL[role] ?? role,
      band: g.band,
      memberIds: g.members,
      sectionId,
      sectionName: g.name ?? (sectionId ? (names.get(sectionId) ?? sectionId) : null),
      // A kept section shows the ratio it had in the first analysis, not a candidate's.
      maxRatio: r3(!g.section && first ? first.ratio : g.ratio),
      status,
      judgement: keeps ? '지금 단면 유지' : JUDGEMENT[status],
      ...(g.beyondLimit && !keeps ? { beyondLimit: g.beyondLimit.name } : {}),
    };
  });
  const sectionsById: Record<string, SectionOut> = {};
  for (const g of groups) {
    const s =
      g.sectionId &&
      (sectionOut(g.sectionId, result.model.sections) ??
        sectionOut(g.sectionId, model.model.sections));
    if (s && g.sectionId) sectionsById[g.sectionId] = s;
  }
  if (result.groups.some((g) => g.status === 'not-converged'))
    notes.push('반복 안에 수렴하지 않은 묶음은 무거운 단면을 택하고 미검토로 둡니다.');
  for (const id of kept)
    notes.push(`${id}: 더 가벼운 후보가 해석에서 목표를 넘어 지금 단면을 유지합니다.`);
  notes.push(
    ...result.issues
      .filter(
        (i) =>
          i.code !== 'SIZING_NO_CANDIDATE' ||
          ![...kept].some((id) => i.message.startsWith(`${id}:`)),
      )
      .map((i) => i.message),
    SIZING_NOTE,
  );
  // Notes read in Korean: a group id's role ('girder|9–12 m') becomes its label ('거더 9–12 m').
  for (let i = 0; i < notes.length; i++)
    notes[i] = notes[i].replace(
      /\b(column|girder|edge|beam)\|/g,
      (_, role: string) => `${TAG_LABEL[role] ?? role} `,
    );
  const ratios = groups.map((g) => g.maxRatio).filter((v): v is number => v !== null);
  return {
    schema: 'vide.s06.sizing/1',
    previewOnly: basis !== 'confirmed',
    basis,
    modelHash: model.modelHash,
    status: result.status,
    groups,
    sectionsById,
    iterations: result.iterations,
    notes,
    summary: {
      groups: groups.length,
      ok: groups.filter((g) => g.status === 'ok').length,
      noCandidate: groups.filter((g) => g.status === 'no-candidate').length,
      unchecked: groups.filter((g) => g.status === 'unchecked').length,
      maxRatio: ratios.length ? Math.max(...ratios) : null,
      steel_t:
        result.summary && result.summary.status === 'ok'
          ? Number(result.summary.steel_t.toFixed(2))
          : null,
    },
  };
}

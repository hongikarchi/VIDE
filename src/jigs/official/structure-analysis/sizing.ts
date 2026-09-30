// sizeGroups (PLAN-23 T-054, SPEC-06.12): section sizing over the KS H table within a depth limit.
// Members are grouped by role × span band × zone (curved zones apart); every candidate under the
// limit is compared and the lightest one whose estimated ratio meets the target is taken, up and
// down alike. The estimate scales the observed ratio by the capacity the governing clause depends
// on (capacity.ts: F2 moment with the member's Lb, E3 compression and KL/r with its K·L, web area
// for shear; I3 for the reference deflection); the next analysis corrects it, up to `maxIterations`
// analyses, and a candidate that an analysis has already shown to fail is not tried again. A group
// with no candidate under the limit is left as '후보 없음' — the heaviest section is never chosen
// silently. Every analysis here is a '미확정 미리보기'; the proposal must be applied and confirmed
// again before it counts.

import type { StructureModelInput, StructureSummary } from '../../../contracts/structure-model.ts';
import type { DraftIssue } from '../../structure/input.ts';
import { KS_H, hId, hName, type HSize } from '../../structure/sections.ts';
import { analyzeSummary } from './analyze.ts';
import {
  capacity,
  estimateContext,
  type EstimateContext,
  type EstimateSection,
} from './capacity.ts';
import { memberGeometry } from './curvature.ts';
import type { MemberMap } from './frame-plan.ts';
import type { AnalyzeOptions, AnalyzeOutcome } from './run.ts';
import { hProps, sectionProps } from './section-props.ts';
import { LABELS } from './summary.ts';

export type SizingRole = 'column' | 'girder' | 'beam';

export interface SizingOptions {
  /** Target strength ratio of the governing member of a group (default 0.90). */
  target?: number;
  /** Reference deflection / limit the chosen section must keep (default 1.0; sizing only, A8). */
  deflectionTarget?: number;
  /** Analyses at most (default 6). */
  maxIterations?: number;
  /** Depth limit per role (mm); default girder 900, beam 900, column 400. */
  depthMax_mm?: Partial<Record<SizingRole, number>>;
  /** Roles to size (default all three); other members keep their section. */
  roles?: SizingRole[];
  /** Upper bounds of the span bands (m); default 6, 9, 12. */
  spanBands_m?: number[];
  /** Zone key of a design member (curved members get their own zone automatically). */
  zoneOf?: (id: string) => string | undefined;
  /** Candidate table override, lightest first is not required. */
  candidates?: (role: SizingRole) => HSize[];
  /** Analysis key (requests supersede each other per key). */
  key?: string;
  assumptions?: string[];
}

/** The analysis to run per iteration: the worker path by default, `runAnalysis` in tests. */
export type SizingAnalyze = (
  model: StructureModelInput,
  map: MemberMap,
  options: AnalyzeOptions,
) => AnalyzeOutcome | Promise<AnalyzeOutcome>;

export interface SizingCandidate {
  id: string;
  name: string;
  h_mm: number;
  weight_kgpm: number;
}

export interface SizingGroup {
  id: string;
  role: SizingRole;
  band: string;
  zone: string;
  members: string[];
  /** Candidates under the depth limit. */
  candidates: number;
  /** Distinct section ids the members started with. */
  from: string[];
  /** Chosen section, or null for '후보 없음' and groups that could not be estimated. */
  section: string | null;
  name: string | null;
  /** Observed ratios of the governing member with the section last analysed. */
  ratio: number | null;
  deflectionRatio: number | null;
  status: 'ok' | 'no-candidate' | 'not-converged' | 'unchanged';
  /** The lightest section of the whole table that would do when none fits under the limit. */
  beyondLimit?: SizingCandidate;
  /** Sections analysed per iteration with the group's worst ratio. */
  history: { section: string; ratio: number | null; deflectionRatio: number | null }[];
}

export interface SizingResult {
  schema: 'vide.structure.sizing/1';
  mode: 'preview';
  label: string;
  status: 'converged' | 'not-converged' | 'error';
  iterations: number;
  ms: number;
  target: number;
  groups: SizingGroup[];
  /** Design member id → section id for every member of a sized group. */
  assignments: Record<string, string>;
  /** The proposal: the input model with the chosen sections applied. */
  model: StructureModelInput;
  /** Preview summary of the proposal; absent when the last change was not analysed. */
  summary?: StructureSummary;
  issues: DraftIssue[];
  assumptions: string[];
  note: string;
}

export const DEFAULT_DEPTH_MAX_MM: Record<SizingRole, number> = {
  girder: 900,
  beam: 900,
  column: 400,
};
export const DEFAULT_SPAN_BANDS_M = [6, 9, 12];
export const SIZING_NOTE =
  '선정 단면은 제안이며 미확정 미리보기로 검토했음 — 적용한 뒤 다시 확정해야 확정 결과·보고서·Rhino 부재 만들기에 쓰임';

interface Candidate extends SizingCandidate {
  size: HSize;
  est: EstimateSection;
}
interface GroupState extends SizingGroup {
  table: Candidate[];
  /** Sections an analysis showed to miss the target; never tried again. */
  rejected: Set<string>;
  /** Sections an analysis showed to meet the target, with what it saw. */
  passed: Map<string, { ratio: number | null; deflectionRatio: number | null }>;
  /** Probes of the next lighter candidate spent (one per group). */
  probes: number;
}

/** A settled group probes the next lighter candidate once when its estimate misses by ≤ this. */
const PROBE_MARGIN = 0.15;

const estimateOf = (
  section: Pick<StructureModelInput['sections'][number], 'shape' | 'dims_mm' | 'props'> | undefined,
): EstimateSection | undefined => {
  if (!section) return undefined;
  const props = sectionProps(section);
  if (!props) return undefined;
  const d = section.dims_mm;
  const isH = section.shape === 'H' || section.shape === 'BH';
  return {
    props,
    ...(isH && d.h > 0 && d.tf > 0 ? { h_mm: d.h, tf_mm: d.tf } : {}),
    web_mm2: isH && d.h > 0 && d.tw > 0 ? d.h * d.tw : props.A_mm2,
  };
};

const candidateOf = (size: HSize): Candidate => {
  const p = hProps(size);
  return {
    id: hId(size),
    name: hName(size),
    h_mm: size.h,
    weight_kgpm: p.weight_kgpm,
    size,
    est: { props: p, h_mm: size.h, tf_mm: size.tf, web_mm2: size.h * size.tw },
  };
};

const byWeight = (a: Candidate, b: Candidate) => a.weight_kgpm - b.weight_kgpm || a.h_mm - b.h_mm;

/** KS H candidates of a role, lightest first. Columns use the wide-flange (b/h ≥ 0.9) series. */
export function ksCandidates(role: SizingRole, depthMax_mm = DEFAULT_DEPTH_MAX_MM[role]): HSize[] {
  return KS_H.filter((s) => s.h <= depthMax_mm && (role !== 'column' || s.b / s.h >= 0.9))
    .map(candidateOf)
    .sort(byWeight)
    .map((c) => c.size);
}

/** Span band label of a length for sorted upper bounds, e.g. '≤6 m', '6–9 m', '>12 m'. */
export function spanBand(length_m: number, bands: number[]): string {
  for (let k = 0; k < bands.length; k++)
    if (length_m <= bands[k] + 1e-9)
      return k === 0 ? `≤${bands[k]} m` : `${bands[k - 1]}–${bands[k]} m`;
  return bands.length ? `>${bands[bands.length - 1]} m` : '전체';
}

const KS_SECTION = (size: HSize): StructureModelInput['sections'][number] => ({
  id: hId(size),
  name: hName(size),
  shape: 'H',
  dims_mm: { h: size.h, b: size.b, tw: size.tw, tf: size.tf, ...(size.r ? { r: size.r } : {}) },
  source: 'KS D 3502',
  provenance: { by: 'auto', assumed: false, note: '단면 선정(미확정 미리보기)' },
});

export async function sizeGroups(
  model: StructureModelInput,
  map: MemberMap,
  options: SizingOptions = {},
  analyze: SizingAnalyze = analyzeSummary,
): Promise<SizingResult> {
  const started = performance.now();
  const target = options.target ?? 0.9;
  const deflectionTarget = options.deflectionTarget ?? 1.0;
  const maxIterations = Math.max(1, options.maxIterations ?? 6);
  const depth = { ...DEFAULT_DEPTH_MAX_MM, ...(options.depthMax_mm ?? {}) };
  const roles = new Set<string>(options.roles ?? ['column', 'girder', 'beam']);
  const bands = [...(options.spanBands_m ?? DEFAULT_SPAN_BANDS_M)].sort((a, b) => a - b);
  const issues: DraftIssue[] = [];
  const assumptions = [...(options.assumptions ?? [])];
  const geometry = memberGeometry(model, map);
  const designLength = new Map((model.designMembers ?? []).map((d) => [d.id, d.length_m]));

  // Candidate tables per role (under the limit) and the whole table for the '후보 없음' hint.
  const tables = new Map<SizingRole, Candidate[]>();
  const tableOf = (role: SizingRole) => {
    let table = tables.get(role);
    if (!table) {
      table = (options.candidates?.(role) ?? ksCandidates(role, depth[role]))
        .map(candidateOf)
        .sort(byWeight);
      tables.set(role, table);
    }
    return table;
  };
  const wholeTables = new Map<SizingRole, Candidate[]>();
  const wholeOf = (role: SizingRole) => {
    let table = wholeTables.get(role);
    if (!table) {
      table = ksCandidates(role, Number.POSITIVE_INFINITY).map(candidateOf).sort(byWeight);
      wholeTables.set(role, table);
    }
    return table;
  };

  // Groups: role × span band × zone, curved members apart.
  const groups = new Map<string, GroupState>();
  for (const [id, segments] of Object.entries(map.physical)) {
    const role = map.roles[id];
    if (!roles.has(role) || !segments.length) continue;
    const g = geometry[id];
    const length = g?.length_m ?? designLength.get(id) ?? 0;
    const band = spanBand(length, bands);
    const zone = [options.zoneOf?.(id) ?? '', g?.curved ? '곡선' : ''].filter(Boolean).join('|');
    const key = [role, band, zone].filter(Boolean).join('|');
    let state = groups.get(key);
    if (!state) {
      const table = tableOf(role as SizingRole);
      state = {
        id: key,
        role: role as SizingRole,
        band,
        zone,
        members: [],
        candidates: table.length,
        from: [],
        section: null,
        name: null,
        ratio: null,
        deflectionRatio: null,
        status: 'unchanged',
        history: [],
        table,
        rejected: new Set(),
        passed: new Map(),
        probes: 0,
      };
    }
    state.members.push(id);
    groups.set(key, state);
  }
  for (const g of groups.values()) g.members.sort();
  // Design lengths and material of every member: fixed by the geometry, not by the section.
  const contexts = new Map<string, EstimateContext | undefined>();
  for (const g of groups.values())
    for (const id of g.members) contexts.set(id, estimateContext(model, map.physical[id], g.role));

  const current = structuredClone(model);
  const memberIndex = new Map(current.members.map((m, k) => [m.id, k]));
  const sectionOf = (id: string) => {
    const k = memberIndex.get(map.physical[id]?.[0] ?? '');
    return k === undefined ? undefined : current.members[k].section;
  };
  for (const g of groups.values())
    g.from = [...new Set(g.members.map((id) => sectionOf(id)).filter((s): s is string => !!s))];
  const apply = (g: GroupState, candidate: Candidate) => {
    if (!current.sections.some((s) => s.id === candidate.id))
      current.sections.push(KS_SECTION(candidate.size));
    for (const id of g.members)
      for (const seg of map.physical[id]) {
        const k = memberIndex.get(seg);
        if (k !== undefined) current.members[k].section = candidate.id;
      }
  };
  /** Back to the one section the group started with ('후보 없음' never keeps a failed candidate). */
  const restoreStart = (g: GroupState) => {
    for (const id of g.members)
      for (const seg of map.physical[id]) {
        const k = memberIndex.get(seg);
        if (k !== undefined) current.members[k].section = g.from[0];
      }
  };
  const fits = (
    c: Candidate,
    est: EstimateSection,
    context: EstimateContext,
    clause: string | null,
    ratio: number | null,
    deflection: number | null,
    margin = 1,
  ) =>
    (ratio === null ||
      (ratio * capacity(est, clause, context)) / capacity(c.est, clause, context) <=
        target * margin + 1e-9) &&
    (deflection === null ||
      (deflection * est.props.I3_mm4) / c.est.props.I3_mm4 <= deflectionTarget * margin + 1e-9);

  let iterations = 0;
  let status: SizingResult['status'] = 'not-converged';
  let summary: StructureSummary | undefined;
  let analysedMatches = false;
  // Section last analysed per group (all members share one after the first application).
  const analysed = new Map<string, string | undefined>();
  const pending = new Map<string, Candidate>();
  const restore = new Set<string>();
  while (iterations < maxIterations) {
    iterations++;
    const outcome = await analyze(current, map, {
      mode: 'preview',
      key: options.key,
      stability: false,
      assumptions,
    });
    summary = outcome.summary;
    if (summary.status !== 'ok') {
      issues.push({
        level: 'error',
        code: 'SIZING_ANALYSIS',
        message: `미리보기 해석 ${summary.status} — 단면 선정을 멈춤`,
      });
      status = 'error';
      break;
    }
    const rows = new Map(summary.members.map((r) => [r[0], r]));
    const sections = new Map(current.sections.map((s) => [s.id, s]));
    let stable = true;
    pending.clear();
    restore.clear();
    for (const g of groups.values()) {
      // Observation per member: ratio, governing clause, reference deflection ratio, section.
      const seen = g.members.map((id) => {
        const row = rows.get(id);
        const sectionId = sectionOf(id);
        const est = estimateOf(sections.get(sectionId ?? ''));
        const context = contexts.get(id);
        const ratio = row?.[2] ?? null;
        const clause = row && row[3] !== null ? summary!.clauses[row[3]] : null;
        const deflection = row && row[4] !== null && row[5] ? row[4] / row[5] : null;
        return { id, sectionId, est, context, ratio, clause, deflection };
      });
      const ratioMax = seen.reduce<number | null>(
        (m, s) => (s.ratio !== null && (m === null || s.ratio > m) ? s.ratio : m),
        null,
      );
      const deflectionMax = seen.reduce<number | null>(
        (m, s) => (s.deflection !== null && (m === null || s.deflection > m) ? s.deflection : m),
        null,
      );
      const current_ = [...new Set(seen.map((s) => s.sectionId ?? '?'))].join('+');
      analysed.set(g.id, current_);
      g.history.push({ section: current_, ratio: ratioMax, deflectionRatio: deflectionMax });
      g.ratio = ratioMax;
      g.deflectionRatio = deflectionMax;
      const usable = seen.filter(
        (s) => s.est && s.context && (s.ratio !== null || s.deflection !== null),
      );
      if (!usable.length) {
        g.status = 'unchanged';
        g.section = null;
        g.name = null;
        continue;
      }
      // The analysed section itself is remembered: rejected when it misses the target (never tried
      // again), passed when it meets it (a known-good fallback).
      if (!current_.includes('+')) {
        const misses =
          (ratioMax !== null && ratioMax > target + 1e-9) ||
          (deflectionMax !== null && deflectionMax > deflectionTarget + 1e-9);
        if (misses) g.rejected.add(current_);
        else g.passed.set(current_, { ratio: ratioMax, deflectionRatio: deflectionMax });
      }
      const accepts = (c: Candidate, margin = 1) =>
        usable.every((s) => fits(c, s.est!, s.context!, s.clause, s.ratio, s.deflection, margin));
      const chosen = g.table.find((c) => !g.rejected.has(c.id) && accepts(c));
      if (!chosen) {
        g.status = 'no-candidate';
        g.section = null;
        g.name = null;
        const beyond = wholeOf(g.role).find((c) => c.h_mm > depth[g.role] && accepts(c));
        g.beyondLimit = beyond
          ? { id: beyond.id, name: beyond.name, h_mm: beyond.h_mm, weight_kgpm: beyond.weight_kgpm }
          : undefined;
        // A candidate applied earlier that now leaves no candidate goes back to the starting
        // section, analysed once more so the other groups are sized against the kept section.
        if (g.from.length === 1 && current_ !== g.from[0]) {
          stable = false;
          restore.add(g.id);
        }
        continue;
      }
      g.status = 'ok';
      g.section = chosen.id;
      g.name = chosen.name;
      if (current_ !== chosen.id) {
        stable = false;
        pending.set(g.id, chosen);
        continue;
      }
      // Settled on a section the analysis confirmed: with two analyses to spare, try the next
      // lighter candidate once when the estimate misses the target by a small margin only (the
      // estimate is conservative for slender columns and LTB); a failed probe is rejected and the
      // group returns to this known-good section.
      if (g.probes < 1 && iterations + 2 <= maxIterations) {
        const k = g.table.findIndex((c) => c.id === chosen.id);
        const lighter = g.table
          .slice(0, Math.max(0, k))
          .reverse()
          .find((c) => !g.rejected.has(c.id));
        if (lighter && accepts(lighter, 1 + PROBE_MARGIN)) {
          g.probes++;
          stable = false;
          pending.set(g.id, lighter);
        }
      }
    }
    if (stable) {
      status = 'converged';
      analysedMatches = true;
      break;
    }
    if (iterations < maxIterations) for (const [key, c] of pending) apply(groups.get(key)!, c);
    // Restored even on the last iteration: '후보 없음' reports the starting section.
    for (const key of restore) restoreStart(groups.get(key)!);
  }

  if (status === 'not-converged') {
    // Out of iterations with changes still pending. A pending section an earlier analysis
    // confirmed is known good and is applied as such; otherwise the heavier of the last analysed
    // section and the pending one is taken and said so (SPEC-06.12).
    const moving: string[] = [];
    for (const [key, c] of pending) {
      const g = groups.get(key)!;
      const known = g.passed.get(c.id);
      if (known) {
        apply(g, c);
        g.status = 'ok';
        g.section = c.id;
        g.name = c.name;
        g.ratio = known.ratio;
        g.deflectionRatio = known.deflectionRatio;
        continue;
      }
      const last = analysed.get(key);
      const previous =
        g.table.find((x) => x.id === last) ?? wholeOf(g.role).find((x) => x.id === last);
      const pick = previous && previous.weight_kgpm > c.weight_kgpm ? previous : c;
      apply(g, pick);
      g.status = 'not-converged';
      g.section = pick.id;
      g.name = pick.name;
      moving.push(key);
    }
    if (moving.length)
      issues.push({
        level: 'warning',
        code: 'SIZING_NOT_CONVERGED',
        message: `${maxIterations}회 안에 수렴하지 않음 — 마지막 두 단면 중 무거운 쪽을 택함(${moving.join(', ')})`,
        members: moving.flatMap((k) => groups.get(k)!.members).slice(0, 40),
      });
    else status = 'converged';
  }
  const noCandidate = [...groups.values()].filter((g) => g.status === 'no-candidate');
  for (const g of noCandidate)
    issues.push({
      level: 'warning',
      code: 'SIZING_NO_CANDIDATE',
      message: `${g.id}: 후보 없음(춤 상한 ${depth[g.role]} mm 초과 필요${g.beyondLimit ? `: ${g.beyondLimit.name}` : ', KS H 표 밖'}) — 단면을 바꾸지 않음`,
      members: g.members.slice(0, 40),
    });
  // Drop sections nothing refers to any more.
  const used = new Set(current.members.map((m) => m.section));
  current.sections = current.sections.filter((s) => used.has(s.id));

  const assignments: Record<string, string> = {};
  for (const g of groups.values())
    for (const id of g.members) {
      const s = sectionOf(id);
      if (s) assignments[id] = s;
    }
  assumptions.push(
    `단면 선정 목표 검정비 ${target}, 참고 처짐 ≤ 한계 × ${deflectionTarget}(선정 기준에만 씀)`,
    '명목 수평하중은 출발 모델의 강재 자중 기준(선정 중 갱신하지 않음)',
  );
  return {
    schema: 'vide.structure.sizing/1',
    mode: 'preview',
    label: LABELS.preview,
    status,
    iterations,
    ms: Number((performance.now() - started).toFixed(1)),
    target,
    groups: [...groups.values()].map(
      ({ table: _table, rejected: _rejected, passed: _passed, probes: _probes, ...g }) => g,
    ),
    assignments,
    model: current,
    ...(analysedMatches && summary ? { summary } : {}),
    issues,
    assumptions,
    note: SIZING_NOTE,
  };
}

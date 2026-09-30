// S-06 frame jig ⑪ 부호·일람표 (PLAN-23 T-056, SPEC-06.12): marks by role, section and curvature
// with the project prefix, kept stable across runs through the ledger of the previous output
// (vide/structure-analysis `stableMarks`), and the schedule with its CSV (`schedule` + `toCsv`).
// The sections are the ones step 'sizing' chose; the ratio column is the sizing group's largest
// observed ratio, so a schedule made from a preview says '미확정 미리보기' in its CSV title.
// Marks that linked drawings or data already use (`knownMarks`) are warned about.

import type { MarkLedger, StructureModelInput } from '../../../../src/contracts/structure-model.ts';
import {
  schedule as buildSchedule,
  stableMarks,
  toCsv,
  TAG_LABEL,
} from '../../../../src/jigs/official/structure-analysis/index.ts';
import type { ModelOutput } from './model.ts';
import type { SizingOutput } from './sizing.ts';

export interface ScheduleRowOut {
  mark: string;
  /** column | girder | edge | beam | arm (cantilever beam) … */
  role: string;
  /** Korean role label for tables. */
  roleLabel: string;
  section: string;
  count: number;
  totalLength_m: number;
  kgpm: number | null;
  t: number | null;
  maxRatio: number | null;
  curved: boolean;
  memberIds: string[];
}
export interface ScheduleIssue {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  members?: string[];
}
export interface ScheduleOutput {
  schema: 'vide.s06.schedule/1';
  prefix: string;
  /** '미확정 미리보기' unless the sizing started from a confirmed result. */
  label: string;
  /** The sections came from preview sizing (a report never writes this schedule as final). */
  previewOnly: boolean;
  marks: { memberId: string; mark: string }[];
  rows: ScheduleRowOut[];
  totals: { count: number; t: number };
  csv: string;
  /** Carried to the next run so the same member keeps its mark. */
  ledger: MarkLedger;
  unlisted: string[];
  assumptions: string[];
  issues: ScheduleIssue[];
}

export interface ScheduleInputs {
  steps: { model: ModelOutput; sizing: SizingOutput; schedule?: ScheduleOutput | null };
}
export interface ScheduleParams {
  /** Project prefix of every mark: 'S06' → 'S06-SG1'. Empty = none. */
  markPrefix: string;
  /** Marks already used by linked drawings or data. */
  knownMarks: string[];
}
export const DEFAULT_SCHEDULE_PARAMS: ScheduleParams = { markPrefix: 'S06', knownMarks: [] };

const PREVIEW_LABEL = '미확정 미리보기';
const CONFIRMED_LABEL = '확정 해석 기준 선정(적용 뒤 재확정 필요)';

/** The model with the sections step 'sizing' chose. */
export function applySizing(model: ModelOutput, sizing: SizingOutput): StructureModelInput {
  const out = structuredClone(model.model);
  const index = new Map(out.members.map((m, k) => [m.id, k]));
  for (const g of sizing.groups) {
    if (!g.sectionId) continue;
    const s = sizing.sectionsById[g.sectionId];
    if (s && !out.sections.some((x) => x.id === g.sectionId))
      out.sections.push({
        id: g.sectionId,
        name: s.name,
        shape: 'H',
        dims_mm: { h: s.h_mm, b: s.b_mm, tw: s.tw_mm, tf: s.tf_mm },
        source: 'KS D 3502',
        provenance: { by: 'auto', assumed: false, note: '단면 선정' },
      });
    if (!out.sections.some((x) => x.id === g.sectionId)) continue;
    for (const id of g.memberIds)
      for (const seg of model.map.physical[id] ?? []) {
        const k = index.get(seg);
        if (k !== undefined) out.members[k].section = g.sectionId;
      }
  }
  return out;
}

const r3 = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(3));

/** Step 'schedule': stable marks and the member schedule with its CSV (T-056 ⑪). */
export function schedule(
  inputs: ScheduleInputs,
  params: Partial<ScheduleParams> = {},
): ScheduleOutput {
  const p = { ...DEFAULT_SCHEDULE_PARAMS, ...params };
  const model = inputs.steps.model;
  const sizing = inputs.steps.sizing;
  const prefix = (p.markPrefix ?? '').trim();
  const projectPrefix = prefix && !/[-_]$/.test(prefix) ? `${prefix}-` : prefix;
  const sized = applySizing(model, sizing);
  // The previous ledger keeps marks only while the prefix is the same.
  const prior = inputs.steps.schedule;
  const previous = prior && prior.prefix === prefix ? prior.ledger : undefined;
  const marked = stableMarks(sized, model.map, {
    rule: { projectPrefix },
    ...(previous ? { previous } : {}),
  });
  const issues: ScheduleIssue[] = marked.issues.map((i) => ({
    level: i.level,
    code: i.code,
    message: i.message,
    ...(i.members ? { members: i.members } : {}),
  }));
  const label = sizing.previewOnly ? PREVIEW_LABEL : CONFIRMED_LABEL;
  const table = buildSchedule(sized, model.map, marked.marks, {
    assumptions: [...marked.assumptions],
  });
  table.label = label;
  // Ratio per mark: the largest ratio of the sizing groups its members belong to.
  const ratioOf = new Map<string, number | null>();
  for (const g of sizing.groups) for (const id of g.memberIds) ratioOf.set(id, g.maxRatio);
  for (const row of table.rows) {
    const ratios = row.members
      .map((id) => ratioOf.get(id))
      .filter((v): v is number => typeof v === 'number');
    row.maxRatio = ratios.length ? r3(Math.max(...ratios)) : null;
    row.governing = null;
    row.status = null;
  }
  const known = new Set(p.knownMarks ?? []);
  const clashes = [...new Set(Object.values(marked.marks))].filter((m) => known.has(m)).sort();
  if (clashes.length)
    issues.push({
      level: 'warning',
      code: 'MARK_IN_LINKED',
      message: `연결 도면·자료에 같은 부호가 있음: ${clashes.join(', ')} — 접두를 바꾸거나 확인하세요`,
    });
  const noCandidate = sizing.groups.filter((g) => g.status === 'no-candidate');
  if (noCandidate.length)
    issues.push({
      level: 'warning',
      code: 'SCHEDULE_NO_CANDIDATE',
      message: `후보 없음 묶음 ${noCandidate.length}개는 지금 단면 그대로 일람표에 올림`,
      members: noCandidate.flatMap((g) => g.memberIds).slice(0, 40),
    });

  const rows: ScheduleRowOut[] = table.rows.map((r) => {
    const role = r.tag ?? r.role;
    return {
      mark: r.mark,
      role,
      roleLabel: TAG_LABEL[role] ?? TAG_LABEL[r.role] ?? role,
      section: r.sectionName,
      count: r.count,
      totalLength_m: r.totalLength_m,
      kgpm: r.unitWeight_kgpm,
      t: r.weight_t,
      maxRatio: r.maxRatio,
      curved: r.curved,
      memberIds: r.members,
    };
  });
  const marks = Object.entries(marked.marks)
    .map(([memberId, mark]) => ({ memberId, mark }))
    .sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
  return {
    schema: 'vide.s06.schedule/1',
    prefix,
    label,
    previewOnly: sizing.previewOnly !== false,
    marks,
    rows,
    totals: { count: table.totals.count, t: table.totals.weight_t },
    csv: toCsv(table),
    ledger: marked.ledger,
    unlisted: table.unlisted,
    assumptions: table.assumptions,
    issues,
  };
}

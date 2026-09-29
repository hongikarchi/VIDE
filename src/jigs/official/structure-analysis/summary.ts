// Result → summary (`vide.structure.summary/1`, ARCH-02 §4.1): per design member and per segment
// [status, ratio], the governing clause, the reference deflection, restraint reactions per column,
// the combinations as analysed, assumptions and the unchecked list. Small by construction.

import {
  summaryStatusCodes,
  type StructureModel,
  type StructureResult,
  type StructureSummary,
} from '../../../contracts/structure-model.ts';
import type { DraftIssue } from '../../structure/input.ts';
import { referenceDeflection, type DeflectionRow } from './deflection.ts';
import type { MemberMap } from './frame-plan.ts';

export const DISCLAIMER = '탐색용 예비값 — 구조계산서·구조기술사 최종 검토를 대체하지 않음';
export const MARGIN_NAME = '중력 조합 부재 검정 여유';
export const LABELS = { confirmed: '확정 결과', preview: '미확정 미리보기' } as const;

/** Items this library does not review, in addition to what the core reports (SPEC-06.7). */
export const LIBRARY_UNCHECKED = [
  '설계 부재 처짐 판정(참고 처짐으로만 표시)',
  '상단선 기준 편심',
  '데크 슬래브·진동·내화',
  '기존 구조물의 보강',
];

export interface SummarizeOptions {
  mode: 'confirmed' | 'preview';
  assumptions?: string[];
  issues?: DraftIssue[];
  /** Total time including the core (ms); defaults to the core's elapsed time. */
  ms?: number;
  deflection?: DeflectionRow[];
}

type Code = 0 | 1 | 2 | 3 | 4;
const CODE: Record<(typeof summaryStatusCodes)[number], Code> = {
  ok: 0,
  warn: 1,
  ng: 2,
  na: 3,
  err: 4,
};
/** Worst-first order for the verdict of a design member. */
const SEVERITY: Code[] = [2, 4, 3, 1, 0];
const round = (v: number | null | undefined, digits: number) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(digits));

const issueRows = (issues: DraftIssue[] = []): StructureSummary['issues'] =>
  issues.map((i) => ({
    level: i.level,
    code: i.code,
    message: i.message,
    ...(i.nodes?.length ? { nodes: i.nodes.slice(0, 40) } : {}),
    ...(i.members?.length ? { members: i.members.slice(0, 40) } : {}),
  }));

const comboRows = (model: Pick<StructureModel, 'combinations'>): StructureSummary['combos'] =>
  model.combinations.map((c) => ({
    id: c.id,
    limitState: c.limitState,
    terms: Object.fromEntries(c.terms.map((t) => [t.pattern, t.factor])),
  }));

/** A summary with nothing analysed: check errors (`invalid`), a mechanism or a core failure. */
export function emptySummary(
  status: 'invalid' | 'unstable' | 'error',
  options: SummarizeOptions & {
    model?: Pick<StructureModel, 'combinations' | 'checkSettings'>;
    modelHash?: string;
    error?: string;
  },
): StructureSummary {
  return {
    schema: 'vide.structure.summary/1',
    mode: options.mode,
    label: LABELS[options.mode],
    status,
    ...(options.error ? { error: options.error } : {}),
    modelHash: options.modelHash ?? '',
    coreVersion: '',
    ms: options.ms ?? 0,
    combos: options.model ? comboRows(options.model) : [],
    statusCodes: [...summaryStatusCodes],
    colorBands: options.model?.checkSettings.colorBands ?? [0.7, 1.0],
    clauses: [],
    members: [],
    reactions: { sumZ_kN: {}, lateral_kN: {}, perColumn: [], maxLateral_kN: 0 },
    maxRatio: null,
    steel_t: 0,
    counts: { ok: 0, warn: 0, ng: 0, na: 0, err: 0 },
    margin: { name: MARGIN_NAME, value: null },
    issues: issueRows(options.issues),
    assumptions: options.assumptions ?? [],
    unchecked: [...LIBRARY_UNCHECKED],
    disclaimer: DISCLAIMER,
  };
}

/** Design values every segment needs before its pass counts (SPEC-06.6: otherwise '미완'). */
export function designIncomplete(member: StructureModel['members'][number]): boolean {
  const d = member.design;
  if (!d || !(d.K2 && d.K3)) return true;
  return member.kind === 'frame' && !d.Lb_m;
}

export function summarize(
  model: StructureModel,
  map: MemberMap,
  result: StructureResult,
  options: SummarizeOptions,
): StructureSummary {
  if (result.status !== 'ok')
    return emptySummary(result.diagnostics.mechanisms.length ? 'unstable' : 'error', {
      ...options,
      model,
      modelHash: result.modelHash,
      error: result.error,
      issues: [
        ...(options.issues ?? []),
        {
          level: 'error',
          code: result.diagnostics.mechanisms.length ? 'MECHANISM' : 'ANALYSIS',
          message: result.diagnostics.mechanisms.length
            ? `불안정(기구) — ${result.diagnostics.mechanisms.length}개 자유도가 구속되지 않음`
            : `해석 실패: ${result.error}`,
          nodes: [...new Set(result.diagnostics.mechanisms.map((m) => m.node))],
        },
      ],
    });
  const bands = model.checkSettings.colorBands;
  const members = new Map(model.members.map((m) => [m.id, m]));
  const checks = new Map(result.checks.map((c) => [c.member, c]));
  const clauses: string[] = [];
  const clauseIndex = (clause: string | undefined | null) => {
    if (!clause) return null;
    let k = clauses.indexOf(clause);
    if (k < 0) k = clauses.push(clause) - 1;
    return k;
  };
  const incomplete: string[] = [];
  const segmentVerdict = (
    id: string,
  ): { code: Code; ratio: number | null; clause: number | null } => {
    const check = checks.get(id);
    const member = members.get(id);
    if (!check || !member) return { code: CODE.err, ratio: null, clause: null };
    const ratio = round(check.ratio, 3);
    const clause = clauseIndex(check.governing?.clause);
    if (check.status === 'error') return { code: CODE.err, ratio, clause };
    if (check.status === 'fail') return { code: CODE.ng, ratio, clause };
    if (check.status === 'incomplete') return { code: CODE.na, ratio, clause };
    if (designIncomplete(member)) {
      incomplete.push(id);
      return { code: CODE.na, ratio, clause };
    }
    return { code: ratio !== null && ratio >= bands[0] ? CODE.warn : CODE.ok, ratio, clause };
  };
  const deflection = new Map(
    (options.deflection ?? referenceDeflection(model, result, map)).map((row) => [row.id, row]),
  );
  const counts = { ok: 0, warn: 0, ng: 0, na: 0, err: 0 };
  let maxRatio: number | null = null;
  const rows: StructureSummary['members'] = [];
  for (const [id, segments] of Object.entries(map.physical)) {
    const verdicts = segments.map(segmentVerdict);
    const code = SEVERITY.find((c) => verdicts.some((v) => v.code === c)) ?? CODE.ok;
    let ratio: number | null = null,
      clause: number | null = null;
    for (const v of verdicts)
      if (v.ratio !== null && (ratio === null || v.ratio > ratio)) {
        ratio = v.ratio;
        clause = v.clause;
      }
    if (ratio !== null && (maxRatio === null || ratio > maxRatio)) maxRatio = ratio;
    counts[summaryStatusCodes[code]]++;
    const d = deflection.get(id);
    // A single segment repeats the member row, so its list stays empty (size, ARCH-03 §13).
    rows.push([
      id,
      code,
      ratio,
      clause,
      round(d?.deflection_mm, 1),
      round(d?.limit_mm, 1),
      verdicts.length > 1 ? verdicts.map((v) => [v.code, v.ratio]) : [],
    ]);
  }
  // Restraint reactions per column node, worst combination; sums per combination.
  const restraint = model.analysis.lateralRestraint?.nodes ?? [];
  const combos = comboRows(model);
  const comboIndex = new Map(combos.map((c, k) => [c.id, k]));
  const sumZ: Record<string, number> = {};
  const lateral: Record<string, [number, number]> = {};
  for (const combo of result.combos) {
    let z = 0;
    let x = 0,
      y = 0;
    for (const [node, out] of Object.entries(result.nodes)) {
      const r = out.reaction?.[combo];
      if (!r) continue;
      z += r[2];
      if (restraint.includes(node)) {
        x += r[0];
        y += r[1];
      }
    }
    sumZ[combo] = round(z, 2)!;
    lateral[combo] = [round(x, 2)!, round(y, 2)!];
  }
  const perColumn: StructureSummary['reactions']['perColumn'] = [];
  let maxLateral = 0;
  const z_m = new Map(model.nodes.map((n) => [n.id, n.xyz_m[2]]));
  for (const node of restraint) {
    const out = result.nodes[node];
    if (!out?.reaction) continue;
    let worst: { combo: string; r: number[]; size: number } | undefined;
    for (const [combo, r] of Object.entries(out.reaction)) {
      const size = Math.hypot(r[0], r[1]);
      if (!worst || size > worst.size) worst = { combo, r, size };
    }
    if (!worst) continue;
    maxLateral = Math.max(maxLateral, worst.size);
    perColumn.push([
      map.columnOfNode[node] ?? node,
      round(z_m.get(node), 3)!,
      comboIndex.get(worst.combo) ?? 0,
      round(worst.r[0], 2)!,
      round(worst.r[1], 2)!,
    ]);
  }
  const issues = [...(options.issues ?? [])];
  if (incomplete.length)
    issues.push({
      level: 'warning',
      code: 'DESIGN_INCOMPLETE',
      message: `설계 부재 값(Lb·K)이 없는 조각 ${incomplete.length}개 — '미완'으로 둠`,
      members: incomplete.slice(0, 40),
    });
  const unchecked = [...new Set([...result.notChecked, ...LIBRARY_UNCHECKED])];
  return {
    schema: 'vide.structure.summary/1',
    mode: options.mode,
    label: LABELS[options.mode],
    status: 'ok',
    modelHash: result.modelHash,
    coreVersion: result.coreVersion,
    ms: round(options.ms ?? result.elapsed_ms, 1)!,
    combos,
    statusCodes: [...summaryStatusCodes],
    colorBands: bands,
    clauses,
    members: rows,
    reactions: {
      sumZ_kN: sumZ,
      lateral_kN: lateral,
      perColumn,
      maxLateral_kN: round(maxLateral, 2)!,
    },
    maxRatio,
    steel_t: round(result.summary.steel_kN / 9.80665, 2)!,
    counts,
    margin: { name: MARGIN_NAME, value: maxRatio === null ? null : round(1 - maxRatio, 3) },
    issues: issueRows(issues),
    assumptions: options.assumptions ?? [],
    unchecked,
    disclaimer: DISCLAIMER,
  };
}

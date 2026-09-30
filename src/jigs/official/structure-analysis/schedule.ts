// schedule + toCsv (PLAN-23 T-054, SPEC-06.12): one row per mark with role, section, count, total
// length, unit weight and weight (quantity-grade, from the section dimensions), the worst verdict,
// the largest ratio and its clause, and for curved members radius, rise and chord. '미완' members
// never count as passed. A schedule made from a preview says so in its label and never '확정'.

import {
  summaryStatusCodes,
  type StructureModelInput,
  type StructureSchedule,
  type StructureSummary,
} from '../../../contracts/structure-model.ts';
import { csvText, type CsvCell } from './csv.ts';
import { memberGeometry } from './curvature.ts';
import type { MemberMap } from './frame-plan.ts';
import { membersByMark, type MarkResult } from './marks.ts';
import { STEEL_DENSITY_KGPM3, sectionProps } from './section-props.ts';
import { DISCLAIMER, LABELS } from './summary.ts';

export interface ScheduleOptions {
  /** The analysis the verdict columns come from; without one the rows carry no verdict. */
  summary?: StructureSummary;
  density_kgpm3?: number;
  assumptions?: string[];
}

export const TAG_LABEL: Record<string, string> = {
  column: '기둥',
  girder: '거더',
  edge: '테두리보',
  beam: '작은보',
  arm: '내민보',
  trimmer: '개구부 보',
  brace: '가새',
  other: '기타',
};
export const STATUS_LABEL: Record<(typeof summaryStatusCodes)[number], string> = {
  ok: '통과',
  warn: '주의',
  ng: '초과',
  na: '미완',
  err: '오류',
};
const ROLE_ORDER = ['column', 'girder', 'beam', 'brace', 'other'];
/** Worst first, as the summary ranks a design member. */
const SEVERITY = [2, 4, 3, 1, 0];
const round = (v: number | null | undefined, digits: number) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(digits));
const markOrder = (a: string, b: string) => {
  const [pa, na] = a.match(/^(.*?)(\d+)$/)?.slice(1) ?? [a, '0'];
  const [pb, nb] = b.match(/^(.*?)(\d+)$/)?.slice(1) ?? [b, '0'];
  return pa === pb ? Number(na) - Number(nb) : pa < pb ? -1 : 1;
};

export function schedule(
  model: Pick<StructureModelInput, 'nodes' | 'members' | 'sections'> & {
    meta?: { mergeTolerance_m?: number };
  },
  map: MemberMap,
  marks: Record<string, string> | Pick<MarkResult, 'marks'>,
  options: ScheduleOptions = {},
): StructureSchedule {
  const byId =
    'marks' in marks && typeof marks.marks === 'object'
      ? marks.marks
      : (marks as Record<string, string>);
  const density = options.density_kgpm3 ?? STEEL_DENSITY_KGPM3;
  const summary = options.summary;
  const rows = new Map(summary?.members.map((r) => [r[0], r]) ?? []);
  const geometry = memberGeometry(model, map);
  const sections = new Map(model.sections.map((s) => [s.id, s]));
  const memberById = new Map(model.members.map((m) => [m.id, m]));
  const groups = membersByMark(byId);
  const out: StructureSchedule['rows'] = [];
  for (const [mark, members] of groups) {
    members.sort();
    const first = members[0];
    const sectionId = memberById.get(map.physical[first]?.[0] ?? '')?.section ?? '?';
    const section = sections.get(sectionId);
    const props = section ? sectionProps(section) : undefined;
    const unitWeight = props ? props.A_mm2 * 1e-6 * density : null;
    const totalLength = members.reduce((sum, id) => sum + (geometry[id]?.length_m ?? 0), 0);
    const counts = { ok: 0, warn: 0, ng: 0, na: 0, err: 0 };
    let worst: number | null = null;
    let maxRatio: number | null = null;
    let governing: string | null = null;
    for (const id of members) {
      const row = rows.get(id);
      if (!row) continue;
      counts[summaryStatusCodes[row[1]]]++;
      if (worst === null || SEVERITY.indexOf(row[1]) < SEVERITY.indexOf(worst)) worst = row[1];
      if (row[2] !== null && (maxRatio === null || row[2] > maxRatio)) {
        maxRatio = row[2];
        governing = row[3] === null ? null : (summary?.clauses[row[3]] ?? null);
      }
    }
    const curved = members.filter((id) => geometry[id]?.curved);
    const mean = (pick: (g: NonNullable<(typeof geometry)[string]>) => number | null) => {
      const values = curved.map((id) => pick(geometry[id]!)).filter((v): v is number => v !== null);
      return values.length
        ? round(values.reduce((s, v) => s + v, 0) / values.length, 3)!
        : undefined;
    };
    out.push({
      mark,
      role: map.roles[first] ?? 'other',
      ...(map.tags[first] ? { tag: map.tags[first] } : {}),
      section: sectionId,
      sectionName: section?.name ?? sectionId,
      count: members.length,
      totalLength_m: round(totalLength, 3)!,
      unitWeight_kgpm: round(unitWeight, 2),
      weight_t: unitWeight === null ? null : round((unitWeight * totalLength) / 1000, 3),
      maxRatio: round(maxRatio, 3),
      governing,
      status: worst === null ? null : summaryStatusCodes[worst],
      counts,
      curved: curved.length > 0,
      ...(curved.length
        ? {
            radius_m: mean((g) => g.radius_m),
            rise_m: mean((g) => g.rise_m),
            chord_m: mean((g) => g.chord_m),
          }
        : {}),
      members,
    });
  }
  out.sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || markOrder(a.mark, b.mark),
  );
  const unlisted = Object.keys(map.physical)
    .filter((id) => !byId[id])
    .sort();
  const totals = out.reduce(
    (t, r) => ({
      count: t.count + r.count,
      length_m: t.length_m + r.totalLength_m,
      weight_t: t.weight_t + (r.weight_t ?? 0),
    }),
    { count: 0, length_m: 0, weight_t: 0 },
  );
  return {
    schema: 'vide.structure.schedule/1',
    mode: summary?.mode ?? 'preview',
    label: summary?.label ?? LABELS.preview,
    modelHash: summary?.modelHash ?? '',
    rows: out,
    totals: {
      count: totals.count,
      length_m: round(totals.length_m, 3)!,
      weight_t: round(totals.weight_t, 3)!,
    },
    unlisted,
    assumptions: [
      ...(options.assumptions ?? []),
      `단위중량은 단면 치수로 계산한 물량용 값(밀도 ${density} kg/m³) — 검정에 쓰지 않음`,
    ],
    disclaimer: DISCLAIMER,
  };
}

export const SCHEDULE_CSV_HEADER = [
  '부호',
  '역할',
  '단면',
  '개수',
  '총길이 (m)',
  '단위중량 (kg/m)',
  '중량 (t)',
  '최대 검정비',
  '지배 조항',
  '판정',
  '미완 수',
  '곡선',
  '반지름 (m)',
  '솟음 (m)',
  '현 길이 (m)',
  '부재',
];

/** CSV of a schedule: a title row with the result label, the header, one row per mark, totals. */
export function toCsv(table: StructureSchedule): string {
  const rows: CsvCell[][] = [
    ['부재 일람표', table.label, table.disclaimer],
    SCHEDULE_CSV_HEADER,
    ...table.rows.map((r) => [
      r.mark,
      TAG_LABEL[r.tag ?? r.role] ?? TAG_LABEL[r.role] ?? r.role,
      r.sectionName,
      r.count,
      r.totalLength_m,
      r.unitWeight_kgpm,
      r.weight_t,
      r.maxRatio,
      r.governing,
      r.status ? STATUS_LABEL[r.status] : '',
      r.counts.na,
      r.curved ? '곡선' : '',
      r.radius_m ?? null,
      r.rise_m ?? null,
      r.chord_m ?? null,
      r.members.join(' '),
    ]),
    ['합계', '', '', table.totals.count, table.totals.length_m, '', table.totals.weight_t],
  ];
  if (table.unlisted.length)
    rows.push([
      '부호 없음',
      '',
      '',
      table.unlisted.length,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      table.unlisted.join(' '),
    ]);
  return csvText(rows);
}

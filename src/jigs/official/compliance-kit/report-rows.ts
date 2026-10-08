// 결과 표 행 (SPEC-15.12, PLAN-48 T-238): the CSV columns of the result table, one row per check,
// then the 미적용 항목. The report and the screen (T-239) render these; nothing is recalculated.

import type { ComplianceResult } from '../../../contracts/compliance.ts';
import { textOf } from './verdict.ts';

export const REPORT_COLUMNS = [
  '검사',
  '묶음',
  '상태',
  '계획 값',
  '한계 값',
  '단위',
  '여유',
  '한계 값 확정 상태',
  '출처 구분',
  '근거 조항',
  '이유',
  '미확정 사항',
] as const;

export type ReportRow = Record<(typeof REPORT_COLUMNS)[number], string>;

export function reportRows(result: ComplianceResult): ReportRow[] {
  const rows: ReportRow[] = result.items.map((i) => ({
    검사: i.title,
    묶음: i.group,
    상태: i.state,
    '계획 값': i.planned?.text ?? '',
    '한계 값': i.limit?.text ?? '',
    단위: i.limit?.unit ?? i.planned?.unit ?? '',
    여유: i.margin === null ? '' : textOf(i.margin, i.limit?.unit ?? i.planned?.unit ?? ''),
    '한계 값 확정 상태': i.limit?.status ?? '',
    '출처 구분': i.limit?.origin ?? '',
    '근거 조항': i.basis.map((b) => [b.clause, b.answer].filter(Boolean).join(' ')).join(' / '),
    이유: i.reason,
    '미확정 사항': i.unconfirmed.join(' / '),
  }));
  for (const n of result.notApplicable)
    rows.push({
      검사: n.title,
      묶음: '',
      상태: '미적용',
      '계획 값': '',
      '한계 값': '',
      단위: '',
      여유: '',
      '한계 값 확정 상태': '',
      '출처 구분': '',
      '근거 조항': n.basis,
      이유: '규제 조건이 미적용(확정) — 검사하지 않음',
      '미확정 사항': '',
    });
  return rows;
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** CSV text (UTF-8 BOM so spreadsheet programs read the Korean). */
export function reportCsv(result: ComplianceResult): string {
  const lines = [
    REPORT_COLUMNS.join(','),
    ...reportRows(result).map((r) => REPORT_COLUMNS.map((c) => cell(r[c])).join(',')),
  ];
  return String.fromCharCode(0xfeff) + lines.join('\r\n') + '\r\n';
}

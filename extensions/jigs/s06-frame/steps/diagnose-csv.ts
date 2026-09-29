// CSV of the S-06 diagnosis tables (SPEC-06.14: 표의 CSV). Same file form as the quantity CSV
// (UTF-8 BOM, quoted cells, CRLF); text cells that a spreadsheet would run as a formula get a
// leading apostrophe. Numbers stay numbers, so negative distances (overlaps) are not touched.

import type { DiagnoseOutput, Measure, ObjectRef } from './diagnose.ts';
import { VERDICT_LABEL, type Verdict } from './labels.ts';

export type DiagnoseTable = 'interference' | 'spans' | 'curves';

function cell(value: string | number | null | undefined) {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') return Number.isFinite(value) ? `"${value}"` : '""';
  const text = /^[\s]*[=+@-]/.test(value) ? "'" + value : value;
  return '"' + text.replaceAll('"', '""') + '"';
}
const round = (value: number | null | undefined, digits = 3) =>
  value === null || value === undefined ? null : Number(value.toFixed(digits));
const verdict = (value: Verdict | null) => (value ? VERDICT_LABEL[value] : '');
const target = (ref?: ObjectRef) => (ref ? `${ref.layer} · ${ref.name || ref.id}` : '');
const measure = (m: Measure) => [
  verdict(m.verdict),
  round(m.distance),
  round(m.area, 2),
  target(m.target),
];

export function diagnoseCsv(output: DiagnoseOutput, table: DiagnoseTable): string {
  const { tables, params } = output;
  let rows: (string | number | null)[][];
  if (table === 'interference') {
    rows = [
      [
        '기둥',
        '이름',
        '레이어',
        '객체 ID',
        '판정',
        '파일캡↔기존 기초 판정',
        '파일캡 거리 (m, 음수 = 겹침)',
        '파일캡 겹침 면적 (㎡)',
        '파일캡 가장 가까운 기존 기초',
        '오픈컷↔기존 기초 판정',
        '오픈컷 거리 (m, 음수 = 겹침)',
        '오픈컷 겹침 면적 (㎡)',
        '오픈컷 가장 가까운 기존 기초',
        '기둥↔유수지 보 판정',
        '유수지 보 거리 (m, 음수 = 겹침)',
        '유수지 보 겹침 면적 (㎡)',
        '가장 가까운 유수지 보',
        '미완 이유',
      ],
      ...tables.interference.map((row) => [
        row.key,
        row.column.name ?? '',
        row.column.layer,
        row.column.id,
        verdict(row.verdict),
        ...measure(row.cap),
        ...measure(row.openCut),
        ...measure(row.basin),
        [row.cap, row.openCut, row.basin]
          .map((m) => m.reason)
          .filter(Boolean)
          .join(' / '),
      ]),
    ];
  } else if (table === 'spans') {
    const kind = { span: '경간', overhang: '내민 구간', unsupported: '지지 없음' } as const;
    rows = [
      [
        '구간',
        '거더',
        '구분',
        '시작 기둥',
        '끝 기둥',
        '평면 길이 (m)',
        '곡선 길이 (m)',
        '판정',
        '경간 상한 (m)',
        '레이어',
        '객체 ID',
        '비고',
      ],
      ...tables.spans.map((row) => [
        row.key,
        row.girderKey,
        kind[row.kind],
        row.from ?? '끝',
        row.to ?? '끝',
        round(row.length),
        round(row.length3d),
        verdict(row.verdict),
        row.kind === 'span' ? params.spanMax : null,
        row.girder.layer,
        row.girder.id,
        row.reason ?? '',
      ]),
    ];
  } else {
    rows = [
      [
        '거더',
        '레이어',
        '객체 ID',
        '평면 길이 (m)',
        '곡선 길이 (m)',
        '기둥 수',
        '경간 수',
        '평면 길이 > 경간 상한 (참고, 경간 초과 아님)',
      ],
      ...tables.curves.map((row) => [
        row.key,
        row.girder.layer,
        row.girder.id,
        round(row.planLength),
        round(row.length3d),
        row.supports,
        row.spans,
        row.overLimit ? '예' : '',
      ]),
    ];
  }
  return '﻿' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

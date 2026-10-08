// 일람표 (SPEC-16.7 7, 16.11; PLAN-49 T-256): the four tables — panels, types, nodes, joints — as
// rows keyed by `SCHEDULE_COLUMNS` with the shown units (lengths mm with one decimal, areas m² with
// three, angles ° with one; the joint total in m). A stage not yet computed leaves its columns empty
// (null). `scheduleCsv` writes one table as UTF-8 CSV text with a BOM and the Korean header (the
// export itself is T-257). `sampleDeviation` comes from a make (SPEC-16.9 7) and is empty here
// unless given.

import {
  SCHEDULE_COLUMNS,
  type MemberSet,
  type PanelLayout,
  type PanelTyping,
} from '../../../contracts/paneling.ts';
import { CLASS_LABELS } from './classify.ts';

export type ScheduleTable = keyof typeof SCHEDULE_COLUMNS;
export type Cell = string | number | null;
export type ScheduleRow = Record<string, Cell>;

const mm = (m: number | null | undefined) =>
  m === null || m === undefined ? null : Math.round(m * 10000) / 10 + 0;
const m2 = (a: number | null | undefined) =>
  a === null || a === undefined ? null : Math.round(a * 1000) / 1000 + 0;
const deg = (a: number) => Math.round(a * 10) / 10 + 0;
const m3 = (a: number) => Math.round(a * 1000) / 1000 + 0;

const STATUS: Record<string, string> = {
  'over-type-tol': '허용 오차 넘음',
  dropped: '뺌',
  'over-stock': '판재 초과',
};

/** The four tables from the stage results (`members` and `typing` may be missing). */
export function scheduleRows(
  layout: PanelLayout,
  members?: MemberSet | null,
  typing?: PanelTyping | null,
  sampleDeviation?: ReadonlyMap<string, number>,
): Record<ScheduleTable, ScheduleRow[]> {
  const member = new Map((members?.members ?? []).map((m) => [m.panelId, m]));
  const typed = new Map((typing?.panels ?? []).map((t) => [t.panelId, t]));
  const overStock = new Set(members?.overStock ?? []);
  const panels = sortedPanels(layout).map((p) => {
    const m = member.get(p.id);
    const t = typed.get(p.id);
    const failure = t?.failure ?? m?.failure ?? p.failure;
    const status = failure
      ? (STATUS[failure.code] ?? '실패')
      : overStock.has(p.id)
        ? '판재 초과'
        : m?.jointUneven
          ? '줄눈 틈 고르지 않음'
          : '정상';
    const row: ScheduleRow = {
      id: p.id,
      face: p.faceIndex,
      row: p.row,
      col: p.col,
      boundary: p.boundary ? '경계' : '',
      type: t && t.type !== 'T-00' ? t.type : null,
      class: t ? CLASS_LABELS[t.class] : null,
      width: mm(p.width),
      height: mm(p.height),
      plateWidth: m ? mm(m.flatSize[0]) : null,
      plateHeight: m ? mm(m.flatSize[1]) : null,
      thickness: m ? mm(m.thickness) : null,
      area: m2(m ? m.area : p.area),
      opening: p.opening ? (p.opening.ratio * 100).toFixed(1) : null,
      flatness: t ? mm(t.flatness) : null,
      planarGap: t ? mm(t.planarGap) : null,
      offSurface: t ? mm(t.offSurface) : null,
      jointGapMin: m?.jointGap ? mm(m.jointGap[0]) : null,
      jointGapMax: m?.jointGap ? mm(m.jointGap[1]) : null,
      sampleDeviation: mm(sampleDeviation?.get(p.id)),
      status,
      reason: failure?.message ?? (t?.flat === null && typing ? '펼침 없음 · 곡면' : ''),
    };
    return row;
  });
  const types = (typing?.types ?? []).map((t) => ({
    type: t.type,
    count: t.count,
    class: CLASS_LABELS[t.class],
    vertexCount: t.vertexCount,
    representative: t.representative,
    plateWidth: mm(t.size[0]),
    plateHeight: mm(t.size[1]),
    maxDeviation: mm(t.maxDeviation),
    mirrorOf: t.mirrorOf ?? '',
  }));
  const nodes = (typing?.nodes ?? []).map((n) => ({
    type: n.type,
    count: n.count,
    valence: n.valence,
    angles: n.angles.map(deg).join(' / '),
  }));
  const joints = (typing?.joints ?? []).map((j) => ({
    type: j.type,
    count: j.count,
    dihedral: `${deg(j.dihedral[0])} ~ ${deg(j.dihedral[1])}`,
    length: mm(j.length),
    totalLength: m3(j.totalLength),
  }));
  return { panels, types, nodes, joints };
}

/** One table as CSV text: BOM, the Korean header of `SCHEDULE_COLUMNS`, comma separated, CRLF. */
export function scheduleCsv(table: ScheduleTable, rows: readonly ScheduleRow[]): string {
  const columns = SCHEDULE_COLUMNS[table];
  const cell = (v: Cell) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(([, header]) => cell(header)).join(',')];
  for (const row of rows) lines.push(columns.map(([key]) => cell(row[key] ?? null)).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Panels in number order: face, row, column, then the id. */
export function sortedPanels<
  T extends { id: string; faceIndex: number; row: number; col: number },
>(layout: { panels: readonly T[] }): T[] {
  return layout.panels.slice().sort(comparePanels);
}

export function comparePanels(
  a: { id: string; faceIndex: number; row: number; col: number },
  b: { id: string; faceIndex: number; row: number; col: number },
): number {
  return (
    a.faceIndex - b.faceIndex ||
    a.row - b.row ||
    a.col - b.col ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

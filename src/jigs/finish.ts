// 마감 일람표 jig engine (SPEC-11, PLAN-43 T-198): pure functions over the finish-code library
// (`vide/finish-codes`) and a project's rooms and sheet. Search and filters (SPEC-11.3), layer
// thicknesses with the project's adjustments, room checks and paste import (SPEC-11.4), and the
// rows of 실 마감표 and 마감 일람표 with their CSV (SPEC-11.5). No node: imports: the screen and the
// engine both use it; the library itself is passed in.
import {
  FINISH_CODES_PER_CELL,
  FINISH_ROOMS_MAX,
  FINISH_TEXT_MAX,
  ROOM_ELEMENTS,
  type FinishCode,
  type FinishLayer,
  type FinishLibrary,
  type FinishRoom,
  type FinishSheet,
  type RoomElement,
} from '../contracts/finish.ts';

export type Thicknesses = FinishSheet['thk'];

/** Thickness text: at most two decimals, no trailing zeros. */
export const num = (n: number) => String(Math.round(n * 100) / 100);

// ── Names ───────────────────────────────────────────────────────────────────────────────────
export const elementName = (lib: FinishLibrary, k: string) =>
  lib.system.elements.find((e) => e.k === k)?.ko ?? k;
export const familyName = (lib: FinishLibrary, el: string, fam: number | string) =>
  lib.system.families[el]?.[String(fam)] ?? '';
export const finishName = (lib: FinishLibrary, d: number | string) =>
  lib.system.finishes.find((f) => String(f.k) === String(d))?.ko ?? String(d);
export const kindName = (lib: FinishLibrary, k: string) =>
  lib.system.kinds.find((kind) => kind.k === k)?.ko ?? k;
/** `W3xx 경량스터드 벽체`: the code's category band and name. */
export const categoryText = (lib: FinishLibrary, code: FinishCode) =>
  `${code.el}${code.fam}xx ${familyName(lib, code.el, code.fam)}`;

// ── Layers and thickness (SPEC-11.3) ────────────────────────────────────────────────────────
export interface ResolvedLayer extends FinishLayer {
  /** Index in the code's layers. */
  i: number;
  /** The library's thickness. */
  def: number;
  /** Above the 실무 상한. */
  over: boolean;
  /** The recommended range is one value: not adjustable. */
  fixed: boolean;
}
export function layersOf(lib: FinishLibrary, code: string, thk: Thicknesses = {}): ResolvedLayer[] {
  const entry = lib.codes[code];
  if (!entry) return [];
  const own = thk[code] ?? {};
  return entry.layers.map((layer, i) => {
    const t = own[String(i)] ?? layer.t;
    return {
      ...layer,
      t,
      i,
      def: layer.t,
      over: layer.hard != null && t > layer.hard,
      fixed: layer.hi === layer.lo,
    };
  });
}
export const totalOf = (lib: FinishLibrary, code: string, thk: Thicknesses = {}) =>
  Math.round(layersOf(lib, code, thk).reduce((sum, layer) => sum + layer.t, 0) * 100) / 100;
export const warningsOf = (lib: FinishLibrary, code: string, thk: Thicknesses = {}) =>
  layersOf(lib, code, thk).filter((layer) => layer.over);
/**
 * The project's thicknesses with one layer set (a new object). A value equal to the library's,
 * empty or not a number removes the adjustment; a fixed layer cannot change; negative is 0.
 */
export function setThickness(
  lib: FinishLibrary,
  thk: Thicknesses,
  code: string,
  index: number,
  value: number | null,
): Thicknesses {
  const layer = lib.codes[code]?.layers[index];
  if (!layer || layer.hi === layer.lo) return thk;
  const own = { ...(thk[code] ?? {}) };
  if (value == null || !Number.isFinite(value) || Math.max(0, value) === layer.t)
    delete own[String(index)];
  else own[String(index)] = Math.max(0, Math.round(value * 100) / 100);
  const next = { ...thk };
  if (Object.keys(own).length) next[code] = own;
  else delete next[code];
  return next;
}
export const resetThickness = (thk: Thicknesses, code: string): Thicknesses => {
  const next = { ...thk };
  delete next[code];
  return next;
};
const layerText = (layer: ResolvedLayer) => (layer.t > 0 ? `T${num(layer.t)} ` : '') + layer.nm;
/** All layers, base to finish: `T150 무근콘크리트 / T24 시멘트몰탈 / 타일`. */
export const stackText = (lib: FinishLibrary, code: string, thk: Thicknesses = {}) =>
  layersOf(lib, code, thk).map(layerText).join(' / ') || '—';
/** The layers under the finish (the last layer is the finish when the code has one). */
export function baseText(lib: FinishLibrary, code: string, thk: Thicknesses = {}) {
  const layers = layersOf(lib, code, thk);
  const base = lib.codes[code]?.fin ? layers.slice(0, -1) : layers;
  return base.map(layerText).join(' / ') || '—';
}

// ── Search (SPEC-11.3 2) ────────────────────────────────────────────────────────────────────
export interface FinishFilter {
  /** One element (F·W·C…); empty: every element. */
  el?: string;
  /** Category digits: any of them. */
  fam?: string[];
  /** Finish digits: any of them. */
  fin?: string[];
  /** Tags: all of them. */
  tag?: string[];
  q?: string;
  /** Total thickness at most (mm). */
  tmax?: number;
  show?: 'all' | 'adopted' | 'rest';
}
export interface FilterContext {
  adopted?: readonly string[];
  thk?: Thicknesses;
}
export function matchCode(
  lib: FinishLibrary,
  code: string,
  filter: FinishFilter,
  { adopted = [], thk = {} }: FilterContext = {},
) {
  const entry = lib.codes[code];
  if (!entry) return false;
  if (filter.el && entry.el !== filter.el) return false;
  const on = adopted.includes(code);
  if (filter.show === 'adopted' && !on) return false;
  if (filter.show === 'rest' && on) return false;
  if (filter.fam?.length && !filter.fam.includes(String(entry.fam))) return false;
  if (filter.fin?.length && !filter.fin.includes(String(entry.fin_d))) return false;
  if (filter.tag?.some((tag) => !entry.tags.includes(tag))) return false;
  if (filter.tmax != null && totalOf(lib, code, thk) > filter.tmax) return false;
  const words = (filter.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    const hay = [code, entry.nm, entry.fin, ...entry.tags, ...entry.layers.map((l) => l.nm)]
      .join(' ')
      .toLowerCase();
    if (words.some((word) => !hay.includes(word))) return false;
  }
  return true;
}
export const searchCodes = (lib: FinishLibrary, filter: FinishFilter, context?: FilterContext) =>
  Object.keys(lib.codes)
    .sort()
    .filter((code) => matchCode(lib, code, filter, context));
/** How many codes the filter would keep with one more choice (the counts beside the choices). */
export function facetCount(
  lib: FinishLibrary,
  filter: FinishFilter,
  key: 'el' | 'fam' | 'fin' | 'tag',
  value: string,
  context?: FilterContext,
) {
  const next: FinishFilter = { ...filter };
  if (key === 'el') next.el = value;
  if (key === 'el') next.fam = [];
  if (key === 'fam') next.fam = [value];
  if (key === 'fin') next.fin = [value];
  if (key === 'tag') next.tag = [...new Set([...(filter.tag ?? []), value])];
  return searchCodes(lib, next, context).length;
}

// ── Rooms (SPEC-11.4) ───────────────────────────────────────────────────────────────────────
export type AssignIssue = 'unknown' | 'element' | 'duplicate';
export const ASSIGN_ISSUE_TEXT: Record<AssignIssue, string> = {
  unknown: '라이브러리에 없는 코드',
  element: '부위가 다른 코드',
  duplicate: '이미 넣은 코드',
};
/** Why a code cannot go in a room's element cell, or null when it can. */
export function assignIssue(
  lib: FinishLibrary,
  element: RoomElement,
  code: string,
  cell: readonly string[] = [],
): AssignIssue | null {
  const entry = lib.codes[code];
  if (!entry) return 'unknown';
  if (entry.el !== element) return 'element';
  if (cell.includes(code)) return 'duplicate';
  return null;
}
export interface RoomIssue {
  room: number;
  roomId: string;
  element?: RoomElement;
  code?: string;
  reason: AssignIssue | 'limit' | 'id';
}
/** Every rule a saved room list breaks (SPEC-11.4 2·5); empty when it can be saved. */
export function validateRooms(lib: FinishLibrary, rooms: readonly FinishRoom[]): RoomIssue[] {
  const issues: RoomIssue[] = [];
  if (rooms.length > FINISH_ROOMS_MAX) issues.push({ room: -1, roomId: '', reason: 'limit' });
  const ids = new Set<string>();
  rooms.forEach((room, index) => {
    if (ids.has(room.id)) issues.push({ room: index, roomId: room.id, reason: 'id' });
    ids.add(room.id);
    if ([room.floor, room.no, room.name].some((value) => value.length > FINISH_TEXT_MAX))
      issues.push({ room: index, roomId: room.id, reason: 'limit' });
    for (const element of ROOM_ELEMENTS) {
      const cell = room[element];
      if (cell.length > FINISH_CODES_PER_CELL)
        issues.push({ room: index, roomId: room.id, element, reason: 'limit' });
      cell.forEach((code, at) => {
        const reason = assignIssue(lib, element, code, cell.slice(0, at));
        if (reason) issues.push({ room: index, roomId: room.id, element, code, reason });
      });
    }
  });
  return issues;
}
/** Codes used in the rooms, sorted. */
export const usedCodes = (rooms: readonly FinishRoom[]) =>
  [...new Set(rooms.flatMap((room) => ROOM_ELEMENTS.flatMap((element) => room[element])))].sort();
/** The adopted list with the used codes added (assigning adopts, SPEC-11.3 1). */
export const withUsed = (adopted: readonly string[], rooms: readonly FinishRoom[]) =>
  [...new Set([...adopted, ...usedCodes(rooms)])].sort();

/** The codes in one pasted cell: split at spaces, commas, 가운뎃점, semicolons, slashes, newlines. */
export const splitCodes = (text: string) =>
  text
    .split(/[\s,;·/、]+/)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);

/** Rows of a pasted table: tab-separated when it has a tab, else comma-separated; quotes kept. */
export function parseTable(text: string): string[][] {
  const delimiter = text.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim()));
}
const HEADER_WORDS = /층|실번|실명|바닥|천장|^벽|floor|room|name|wall|ceiling/i;
export interface PasteSkip {
  /** 1-based row in the pasted text. */
  line: number;
  element: RoomElement;
  code: string;
  reason: AssignIssue;
}
export interface PasteResult {
  rooms: FinishRoom[];
  skipped: PasteSkip[];
  /** The first row was a header and was not read as a room. */
  header: boolean;
}
/**
 * Rooms from a pasted table (SPEC-11.4 4): columns 층별, 실번호, 실명, 바닥, 벽, 천장. A first row
 * of header words is skipped; codes that break the room rules are left out and listed.
 */
export function parseRoomPaste(lib: FinishLibrary, text: string, newId: () => string): PasteResult {
  const rows = parseTable(text);
  const header =
    rows.length > 0 &&
    rows[0].filter((cell) => HEADER_WORDS.test(cell.trim())).length >= 2 &&
    !rows[0].some((cell) => splitCodes(cell).some((code) => lib.codes[code]));
  const skipped: PasteSkip[] = [];
  const rooms = rows.slice(header ? 1 : 0).map((cells, index) => {
    const line = index + (header ? 2 : 1);
    const room: FinishRoom = {
      id: newId(),
      floor: (cells[0] ?? '').trim().slice(0, FINISH_TEXT_MAX),
      no: (cells[1] ?? '').trim().slice(0, FINISH_TEXT_MAX),
      name: (cells[2] ?? '').trim().slice(0, FINISH_TEXT_MAX),
      F: [],
      W: [],
      C: [],
    };
    ROOM_ELEMENTS.forEach((element, at) => {
      for (const code of splitCodes(cells[3 + at] ?? '')) {
        const reason = assignIssue(lib, element, code, room[element]);
        if (reason) skipped.push({ line, element, code, reason });
        else if (room[element].length < FINISH_CODES_PER_CELL) room[element].push(code);
      }
    });
    return room;
  });
  return { rooms, skipped, header };
}

// ── 실 마감표 (SPEC-11.5 1) ─────────────────────────────────────────────────────────────────
export interface ScheduleCell {
  code: string;
  base: string;
  finish: string;
  /** Total thickness text, '—' when none. */
  thk: string;
}
export interface RoomScheduleRow {
  roomId: string;
  floor: string;
  no: string;
  name: string;
  /** Line in the room (0-based) and the room's line count. */
  line: number;
  lines: number;
  cells: Record<RoomElement, ScheduleCell | null>;
}
function scheduleCell(lib: FinishLibrary, code: string | undefined, thk: Thicknesses) {
  if (!code || !lib.codes[code]) return null;
  const total = totalOf(lib, code, thk);
  return {
    code,
    base: baseText(lib, code, thk),
    finish: lib.codes[code].fin || '—',
    thk: total > 0 ? num(total) : '—',
  };
}
export function roomScheduleRows(
  lib: FinishLibrary,
  rooms: readonly FinishRoom[],
  thk: Thicknesses = {},
): RoomScheduleRow[] {
  return rooms.flatMap((room) => {
    const lines = Math.max(1, ...ROOM_ELEMENTS.map((element) => room[element].length));
    return Array.from({ length: lines }, (_, line) => ({
      roomId: room.id,
      floor: room.floor,
      no: room.no,
      name: room.name,
      line,
      lines,
      cells: {
        F: scheduleCell(lib, room.F[line], thk),
        W: scheduleCell(lib, room.W[line], thk),
        C: scheduleCell(lib, room.C[line], thk),
      },
    }));
  });
}

// ── 마감 일람표 (SPEC-11.5 2) ───────────────────────────────────────────────────────────────
export interface CodeScheduleRow {
  code: string;
  el: string;
  element: string;
  category: string;
  assembly: string;
  finish: string;
  thk: string;
  tags: string;
  /** Room names using the code, each once, in room order. */
  rooms: string[];
  unused: boolean;
}
export function codeScheduleRows(
  lib: FinishLibrary,
  rooms: readonly FinishRoom[],
  sheet: Pick<FinishSheet, 'adopted' | 'thk'>,
  unused: 'hide' | 'ghost' = 'hide',
): CodeScheduleRow[] {
  const used = new Set(usedCodes(rooms));
  const codes = [...new Set([...sheet.adopted, ...used])]
    .filter((code) => lib.codes[code] && (unused === 'ghost' || used.has(code)))
    .sort();
  return codes.map((code) => {
    const entry = lib.codes[code];
    const where: string[] = [];
    for (const room of rooms)
      if (ROOM_ELEMENTS.some((element) => room[element].includes(code))) {
        const label = room.name || room.no;
        if (label && !where.includes(label)) where.push(label);
      }
    const total = totalOf(lib, code, sheet.thk);
    return {
      code,
      el: entry.el,
      element: elementName(lib, entry.el),
      category: categoryText(lib, entry),
      assembly: baseText(lib, code, sheet.thk),
      finish: entry.fin || '—',
      thk: total > 0 ? num(total) : '—',
      tags: entry.tags.join('·'),
      rooms: where,
      unused: !used.has(code),
    };
  });
}
/** `실1, 실2, 실3, 실4 외 2`. */
export const roomsText = (rooms: readonly string[], unused = false) =>
  rooms.length
    ? rooms.slice(0, 4).join(', ') + (rooms.length > 4 ? ` 외 ${rooms.length - 4}` : '')
    : unused
      ? '미배정'
      : '';

// ── CSV (SPEC-11.5 6) ───────────────────────────────────────────────────────────────────────
const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
/** UTF-8 BOM, CRLF, every field quoted: Excel opens it as it is. */
export const toCsv = (rows: readonly (readonly unknown[])[]) =>
  '﻿' + rows.map((row) => row.map(quote).join(',')).join('\r\n') + '\r\n';
export function roomScheduleCsv(
  lib: FinishLibrary,
  rooms: readonly FinishRoom[],
  thk: Thicknesses = {},
) {
  const head = ['층별', '실번호', '실명'];
  for (const element of ROOM_ELEMENTS) {
    const name = elementName(lib, element);
    head.push(`${name} 바탕`, `${name} 마감`, `${name} THK`, `${name} 코드`);
  }
  return toCsv([
    head,
    ...roomScheduleRows(lib, rooms, thk).map((row) => [
      row.floor,
      row.no,
      row.name,
      ...ROOM_ELEMENTS.flatMap((element) => {
        const cell = row.cells[element];
        return cell ? [cell.base, cell.finish, cell.thk, cell.code] : ['', '', '', ''];
      }),
    ]),
  ]);
}
export function codeScheduleCsv(
  lib: FinishLibrary,
  rooms: readonly FinishRoom[],
  sheet: Pick<FinishSheet, 'adopted' | 'thk'>,
  unused: 'hide' | 'ghost' = 'hide',
) {
  return toCsv([
    ['코드', '부위', '카테고리', '구성', '마감', 'THK', '속성', '적용 실'],
    ...codeScheduleRows(lib, rooms, sheet, unused).map((row) => [
      row.code,
      row.element,
      row.category,
      row.assembly,
      row.finish,
      row.thk,
      row.tags,
      row.rooms.join(', ') || (row.unused ? '미배정' : ''),
    ]),
  ]);
}
export function libraryCsv(lib: FinishLibrary, codes: readonly string[], thk: Thicknesses = {}) {
  return toCsv([
    [
      '코드',
      '부위',
      '카테고리',
      '마감재',
      '구성',
      '구성 상세',
      '마감',
      '총두께',
      'THK 조정',
      '속성',
      '설계 주의',
    ],
    ...codes
      .filter((code) => lib.codes[code])
      .map((code) => {
        const entry = lib.codes[code];
        return [
          code,
          elementName(lib, entry.el),
          categoryText(lib, entry),
          finishName(lib, entry.fin_d),
          entry.nm,
          stackText(lib, code, thk),
          entry.fin,
          num(totalOf(lib, code, thk)),
          thk[code] ? 'O' : '',
          entry.tags.join('·'),
          entry.note,
        ];
      }),
  ]);
}

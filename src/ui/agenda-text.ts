// 대시보드의 할 일 (SPEC-01.14 2): reading a date, a time and a kind out of what the user typed, on
// this PC, with no AI call — '내일 3시 구조 회의', '금요일까지 보고서', '10/7 14:00 현장 회의'. The
// words that gave the date or time leave the text; when nothing is read the text stays as typed.
// '까지' after the date or time (or the word '마감') makes it a 마감, '회의'/'미팅' a 회의.

import type { AgendaKind } from '../contracts/agenda.ts';

/** app.ts fires this after the AI added or changed 할 일, or [되돌리기] took it back. */
export const AGENDA_CHANGED = 'vide:agenda-changed';

const pad = (n: number) => String(n).padStart(2, '0');
/** A local date as 'YYYY-MM-DD'. */
export const isoDate = (at: Date) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const fromIso = (value: string) => {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (at: Date, days: number) =>
  new Date(at.getFullYear(), at.getMonth(), at.getDate() + days);
const valid = (y: number, m: number, d: number) => {
  const at = new Date(y, m - 1, d);
  return at.getFullYear() === y && at.getMonth() === m - 1 && at.getDate() === d ? at : null;
};

export interface ParsedAgenda {
  text: string;
  date: string | null;
  time: string | null;
  kind: AgendaKind;
}
/** The small label a kind shows ('할 일' is the plain one and shows none in the list). */
export const KIND_LABELS: Record<AgendaKind, string> = {
  task: '할 일',
  meeting: '회의',
  deadline: '마감',
};

const WEEKDAYS = '일월화수목금토';
// A token stands alone: after the start or a space, before the end, a space or a particle.
const START = '(?<=^|\\s)';
const END = '(?:까지|부터|에는|에|엔)?(?=\\s|$|[,.])';
const datePatterns: { re: RegExp; read: (m: RegExpExecArray, today: Date) => Date | null }[] = [
  {
    re: new RegExp(`${START}(\\d{4})-(\\d{1,2})-(\\d{1,2})${END}`),
    read: (m) => valid(+m[1], +m[2], +m[3]),
  },
  {
    re: new RegExp(`${START}(\\d{1,2})\\s*/\\s*(\\d{1,2})${END}`),
    read: (m, today) => nearDate(+m[1], +m[2], today),
  },
  {
    re: new RegExp(`${START}(\\d{1,2})월\\s*(\\d{1,2})일${END}`),
    read: (m, today) => nearDate(+m[1], +m[2], today),
  },
  {
    re: new RegExp(`${START}(오늘|내일|낼|모레|글피)${END}`),
    read: (m, today) => addDays(today, { 오늘: 0, 내일: 1, 낼: 1, 모레: 2, 글피: 3 }[m[1]] ?? 0),
  },
  {
    re: new RegExp(`${START}(?:(이번\\s*주|다음\\s*주|담주)\\s*)?([${WEEKDAYS}])요일${END}`),
    read: (m, today) => {
      const target = WEEKDAYS.indexOf(m[2]);
      if (!m[1]) return addDays(today, (target - today.getDay() + 7) % 7);
      // 이번 주 / 다음 주: weeks start on Monday.
      const monday = addDays(today, -((today.getDay() + 6) % 7));
      const day = addDays(monday, (target + 6) % 7);
      return /이번/.test(m[1]) ? day : addDays(day, 7);
    },
  },
];
const PART = '(오전|오후|아침|낮|저녁|밤)';
const timePatterns: { re: RegExp; read: (m: RegExpExecArray) => [number, number] | null }[] = [
  {
    re: new RegExp(`${START}(?:${PART}\\s*)?(\\d{1,2}):(\\d{2})${END}`),
    read: (m) => clock(m[1], +m[2], +m[3], true),
  },
  {
    re: new RegExp(`${START}(?:${PART}\\s*)?(\\d{1,2})시(?:\\s*(\\d{1,2})분|\\s*(반))?${END}`),
    read: (m) => clock(m[1], +m[2], m[4] ? 30 : m[3] ? +m[3] : 0, false),
  },
];
/** A month/day without a year: this year, or next year when it is long past (in Oct, '1/5'). */
function nearDate(month: number, day: number, today: Date) {
  const year = today.getFullYear();
  const at = valid(year, month, day);
  if (!at) return null;
  return at.getTime() < addDays(today, -60).getTime() ? valid(year + 1, month, day) : at;
}
/**
 * '3시' alone is the afternoon for 1–7 (work hours: '3시 회의' is 15:00); '오전'/'아침' keep the
 * morning, '오후'/'저녁'/'밤' move 1–11 to the afternoon. 'HH:MM' is taken as written.
 */
function clock(
  part: string | undefined,
  hour: number,
  minute: number,
  literal: boolean,
): [number, number] | null {
  if (minute > 59) return null;
  if (part) {
    if (hour < 1 || hour > 12) return null;
    if (/오전|아침/.test(part)) hour = hour === 12 ? 0 : hour;
    else if (hour < 12) hour += 12;
  } else if (!literal && hour >= 1 && hour <= 7) hour += 12;
  if (hour > 23) return null;
  return [hour, minute];
}

/** '마감'/'회의'/'미팅' in the words ('회의록' is not a meeting). */
const DEADLINE_WORD = /마감/;
const MEETING_WORD = /회의(?!록)|미팅/;

/**
 * Reads the first date and the first time in the text (today = the PC's local day), and the kind:
 * '까지' right after the date or time, or the word '마감', is a 마감; '회의'/'미팅' a 회의; else 할 일.
 */
export function parseAgendaText(input: string, now = new Date()): ParsedAgenda {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let text = input;
  let date: string | null = null,
    time: string | null = null,
    until = false;
  for (const { re, read } of timePatterns) {
    const m = re.exec(text);
    const value = m && read(m);
    if (!m || !value) continue;
    time = `${pad(value[0])}:${pad(value[1])}`;
    until ||= m[0].endsWith('까지');
    text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
    break;
  }
  for (const { re, read } of datePatterns) {
    const m = re.exec(text);
    const value = m && read(m, today);
    if (!m || !value) continue;
    date = isoDate(value);
    until ||= m[0].endsWith('까지');
    text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
    break;
  }
  const rest = text.replace(/\s+/g, ' ').trim();
  const kind: AgendaKind =
    until || DEADLINE_WORD.test(input) ? 'deadline' : MEETING_WORD.test(input) ? 'meeting' : 'task';
  // Only a date or a time and no words left: keep what was typed as the text too.
  if ((!date && !time) || !rest) return { text: input.trim(), date, time, kind };
  if (time && !date) date = isoDate(today);
  return { text: rest, date, time, kind };
}

/** Where an item stands against today (SPEC-01.14 3). */
export function agendaWhen(
  item: { date: string | null; done: boolean },
  today: string,
): 'undated' | 'overdue' | 'today' | 'later' {
  if (!item.date) return 'undated';
  if (item.date < today) return 'overdue';
  return item.date === today ? 'today' : 'later';
}

/** '10/7 (화)' — the short date shown on a row. */
export function shortDate(value: string) {
  const at = fromIso(value);
  return `${at.getMonth() + 1}/${at.getDate()} (${WEEKDAYS[at.getDay()]})`;
}
/** '내일' / '모레' / '10/7 (화)' for a later date; '어제' / '지남 · 9/30 (화)' for an earlier one. */
export function dateLabel(value: string, today: string) {
  const days = Math.round((fromIso(value).getTime() - fromIso(today).getTime()) / 86400000);
  if (days === 0) return '오늘';
  if (days === 1) return '내일';
  if (days === 2) return '모레';
  if (days < 0) return `지남 · ${shortDate(value)}`;
  return shortDate(value);
}

/**
 * The notice after an AI write ([되돌리기] beside it): what was added or changed. An item one turn
 * added and then changed is named once, as added, with its last text.
 */
export function agendaNotice(body: unknown) {
  const changes = (body as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes) || !changes.length) return undefined;
  const items = new Map<unknown, { text: string; added: boolean }>();
  changes.forEach((change, index) => {
    const key = change?.id ?? index;
    items.set(key, {
      text: String(change?.text ?? ''),
      added: Boolean(items.get(key)?.added) || change?.op === 'add',
    });
  });
  const named = [...items.values()];
  const names = named
    .slice(0, 3)
    .map((item) => `'${item.text}'`)
    .join(', ');
  const more = named.length > 3 ? ` 외 ${named.length - 3}개` : '';
  return named.every((item) => item.added)
    ? `AI가 할 일을 더했습니다: ${names}${more}`
    : `AI가 할 일을 바꿨습니다: ${names}${more}`;
}

/** One AI 할 일 write as the conversation's ledger lists it. */
export interface AgendaWrite {
  id: string;
  requestId?: string | null;
  body?: unknown;
}
/** The AI 할 일 writes of one turn, shown as one notice with one [되돌리기]. */
export interface AgendaTurn {
  ledgerIds: string[];
  body: { changes: unknown[] };
}
/**
 * Groups the AI's 할 일 writes by the turn (request) that made them (SPEC-01.14 6): a turn that
 * wrote several times gets one notice, shown when the turn ends, and one [되돌리기] for all.
 */
export class AgendaTurns {
  #pending = new Map<string, AgendaTurn>();
  add(write: AgendaWrite) {
    const key = write.requestId || `ledger:${write.id}`;
    const turn = this.#pending.get(key) ?? { ledgerIds: [], body: { changes: [] } };
    const changes = (write.body as { changes?: unknown } | null)?.changes;
    turn.ledgerIds.push(write.id);
    if (Array.isArray(changes)) turn.body.changes.push(...changes);
    this.#pending.set(key, turn);
  }
  /** The turns to show now: `finished` (a request whose turn ended) and writes made outside a turn. */
  take(finished?: string) {
    const ready: AgendaTurn[] = [];
    for (const [key, turn] of this.#pending)
      if (key === finished || key.startsWith('ledger:')) {
        ready.push(turn);
        this.#pending.delete(key);
      }
    return ready;
  }
}

// 대시보드 › 오늘 › 달력 (SPEC-01.14 3): one month, weeks starting on Sunday.
/** The first day of the month `value` falls in, 'YYYY-MM-01'. */
export const monthOf = (value: string) => `${value.slice(0, 7)}-01`;
/** The first day of the month `by` months from `month`. */
export function shiftMonth(month: string, by: number) {
  const at = fromIso(month);
  return isoDate(new Date(at.getFullYear(), at.getMonth() + by, 1));
}
/** Every day of the weeks that hold the month, Sunday first (35 or 42 days, or 28 for a February). */
export function monthDays(month: string) {
  const first = fromIso(month);
  const start = addDays(first, -first.getDay());
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const weeks = Math.ceil((first.getDay() + last.getDate()) / 7);
  return Array.from({ length: weeks * 7 }, (_, index) => isoDate(addDays(start, index)));
}
/** '2026년 10월'. */
export function monthLabel(month: string) {
  const at = fromIso(month);
  return `${at.getFullYear()}년 ${at.getMonth() + 1}월`;
}
/** '10월 7일 (수)'. */
export function dayLabel(value: string) {
  const at = fromIso(value);
  return `${at.getMonth() + 1}월 ${at.getDate()}일 (${WEEKDAYS[at.getDay()]})`;
}
/** The weekday letters, Sunday first. */
export const WEEKDAY_LETTERS = [...WEEKDAYS];

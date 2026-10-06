// 대시보드의 할 일 (SPEC-01.14 2): reading a date, a time and a kind out of what the user typed, on
// this PC, with no AI call — '내일 3시 구조 회의', '금요일까지 보고서', '10/7 14:00 현장 회의'.
// Ranges too (PLAN-39): '2시~4시', '2시부터 4시까지', '10/7~10/9', '10월 7일~9일'. The words that
// gave the date or time leave the text; when nothing is read the text stays as typed. The word
// '마감' makes a 마감, '접수'/'제출' a 접수, '까지' after the date or time a 마감 (not the '까지'
// closing a range), '협의'/'회의'/'미팅' a 협의.

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
  endDate: string | null;
  endTime: string | null;
  kind: AgendaKind;
}
/**
 * The small label a kind shows ('할 일' is the plain one and shows none in the list). `meeting`
 * kept its id when '회의' became '협의' (2026-10-06).
 */
export const KIND_LABELS: Record<AgendaKind, string> = {
  task: '할 일',
  meeting: '협의',
  receipt: '접수',
  deadline: '마감',
};
/** 협의 is an event: no done check, and it passes when its day is over (SPEC-01.14 1). */
export const isEvent = (item: { kind?: AgendaKind }) => item.kind === 'meeting';

const WEEKDAYS = '일월화수목금토';
// A token stands alone: after the start or a space, before the end, a space or a particle.
const START = '(?<=^|\\s)';
const END = '(?:까지|부터|에는|에|엔)?(?=\\s|$|[,.~～〜\\-–])';
/** What joins the two ends of a range: '~' or '-' ('부터' at the first end needs only a space). */
const RANGE = /^\s*[~～〜\-–]\s*/;
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

/**
 * '마감' as a word of its own ('설계 도서 마감', '마감일은 금요일'), not the finishing work of a
 * building: '마감재', '외부 마감 상세', '마감 공사' are not a 마감. '회의'/'미팅' ('회의록',
 * '회의실' are not a meeting).
 */
const FINISH_WORK = '상세|디테일|공사|공정|작업|자재|재료|도면|면|선|색|부위|부분|계획|마무리';
const DEADLINE_WORD = new RegExp(
  `${START}마감(?:일|날)?(?:까지|이다|임|은|는|이|을|에)?(?=$|\\s|[,.!])(?!\\s*(?:${FINISH_WORK})(?=$|\\s|[,.]|은|는|이|을|의|에|및|과|와))`,
);
const MEETING_WORD = /회의(?!록|실)|미팅|협의(?!서|록)/;
/** '접수'/'제출' ('접수처', '제출물' are not one). */
const RECEIPT_WORD = /접수(?!처|증|번호)|제출(?!물|처)/;
/** '하루 종일' / '종일' after a date: an all-day item, nothing to keep in the text. */
const ALL_DAY = /(?<=^|\s)(?:하루\s*)?종일(?=\s|$|[,.])/;
/** The second end of '10월 7일~9일': a day of the start's month. */
const BARE_DAY = /^(\d{1,2})일(?:까지)?(?=\s|$|[,.])/;

/**
 * Reads the first date and the first time in the text (today = the PC's local day), each with the
 * other end of a range right after it, and the kind: the word '마감' is a 마감; '접수'/'제출' a
 * 접수; '까지' right after the date or time (not closing a range) a 마감; '협의'/'회의'/'미팅' a
 * 협의; else 할 일.
 */
export function parseAgendaText(input: string, now = new Date()): ParsedAgenda {
  return readAgenda(input, now).parsed;
}

const PICKED_DATE = /^(\d{4}-\d{2}-\d{2})\s+/;
/**
 * The add box on the calendar starts with the picked day ('2026-10-07 '). A date the user typed
 * after it wins ('금요일까지 보고서' stays a 마감 on Friday); otherwise the picked day is the date.
 */
export function parseAgendaDraft(draft: string, now = new Date()): ParsedAgenda {
  const picked = PICKED_DATE.exec(draft);
  if (picked) {
    const own = readAgenda(draft.slice(picked[0].length), now);
    if (own.dateRead) return own.parsed;
  }
  return parseAgendaText(draft, now);
}

/**
 * The other end of a range right after a read token ending at `end`: a '~'/'-' and the next token,
 * or after a token ending in '부터' just the next one. `next` reads a token at the start of a text.
 */
function rangeAfter<T>(
  text: string,
  end: number,
  token: string,
  next: (rest: string) => { length: number; value: T } | undefined,
) {
  const after = text.slice(end);
  const join = token.endsWith('부터') ? /^\s*/.exec(after) : RANGE.exec(after);
  if (!join) return undefined;
  const found = next(after.slice(join[0].length));
  return found && { value: found.value, end: end + join[0].length + found.length };
}
/** A pattern's match at the very start of `rest`, read. */
function readAt<T>(
  patterns: { re: RegExp; read: (m: RegExpExecArray) => T | null }[],
  rest: string,
) {
  for (const { re, read } of patterns) {
    const m = re.exec(rest);
    const value = m && m.index === 0 ? read(m) : null;
    if (m && value) return { length: m[0].length, value };
  }
  return undefined;
}

function readAgenda(input: string, now: Date): { parsed: ParsedAgenda; dateRead: boolean } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let text = input;
  let date: string | null = null,
    time: string | null = null,
    endDate: string | null = null,
    endTime: string | null = null,
    until = false;
  for (const { re, read } of timePatterns) {
    const m = re.exec(text);
    const value = m && read(m);
    if (!m || !value) continue;
    time = `${pad(value[0])}:${pad(value[1])}`;
    let end = m.index + m[0].length;
    const range = rangeAfter(text, end, m[0], (rest) => readAt(timePatterns, rest));
    const start = value[0] * 60 + value[1];
    let last = range ? range.value[0] * 60 + range.value[1] : -1;
    // '오후 8시~10시': an end before the start is read 12 hours later.
    if (range && last <= start && last + 720 < 1440) last += 720;
    if (range && last > start) {
      endTime = `${pad(Math.floor(last / 60))}:${pad(last % 60)}`;
      end = range.end;
    } else until ||= m[0].endsWith('까지');
    text = text.slice(0, m.index) + text.slice(end);
    break;
  }
  for (const { re, read } of datePatterns) {
    const m = re.exec(text);
    const value = m && read(m, today);
    if (!m || !value) continue;
    date = isoDate(value);
    let end = m.index + m[0].length;
    const range = rangeAfter(text, end, m[0], (rest) => {
      const day = BARE_DAY.exec(rest);
      if (day) {
        const at = valid(value.getFullYear(), value.getMonth() + 1, +day[1]);
        return at ? { length: day[0].length, value: at } : undefined;
      }
      return readAt(
        datePatterns.map(({ re, read }) => ({ re, read: (n: RegExpExecArray) => read(n, today) })),
        rest,
      );
    });
    if (range && isoDate(range.value) > date) {
      endDate = isoDate(range.value);
      end = range.end;
    } else until ||= m[0].endsWith('까지');
    text = text.slice(0, m.index) + text.slice(end);
    if (ALL_DAY.test(text)) text = text.replace(ALL_DAY, '');
    break;
  }
  const rest = text.replace(/\s+/g, ' ').trim();
  const kind: AgendaKind = DEADLINE_WORD.test(input)
    ? 'deadline'
    : RECEIPT_WORD.test(input)
      ? 'receipt'
      : until
        ? 'deadline'
        : MEETING_WORD.test(input)
          ? 'meeting'
          : 'task';
  // Only a date or a time and no words left: keep what was typed as the text too.
  const dateRead = Boolean(date);
  if ((!date && !time) || !rest)
    return { parsed: { text: input.trim(), date, time, endDate, endTime, kind }, dateRead };
  if (time && !date) date = isoDate(today);
  return { parsed: { text: rest, date, time, endDate, endTime, kind }, dateRead };
}

/** An item as the list and the calendar place it. */
export interface AgendaPlace {
  date: string | null;
  endDate?: string | null;
  time?: string | null;
  kind?: AgendaKind;
  done: boolean;
}
/** The last day an item covers ('YYYY-MM-DD'): its end day, else its day. */
export const lastDay = (item: { date: string | null; endDate?: string | null }) =>
  item.endDate ?? item.date;
/**
 * Where an item stands against today (SPEC-01.14 3): an item over several days is today's while
 * today falls in it and overdue once its last day passed; a 협의 that passed is just past.
 */
export function agendaWhen(
  item: AgendaPlace,
  today: string,
): 'undated' | 'overdue' | 'today' | 'later' | 'past' {
  if (!item.date) return 'undated';
  if (item.date > today) return 'later';
  if ((lastDay(item) ?? item.date) < today) return isEvent(item) ? 'past' : 'overdue';
  return 'today';
}
/** '14:00~16:00', '14:00' or '' — the time an item shows. */
export const timeLabel = (item: { time?: string | null; endTime?: string | null }) =>
  item.time ? `${item.time}${item.endTime ? `~${item.endTime}` : ''}` : '';
/** '10/7~10/9 (금)' — the days of an item over several days. */
export function spanLabel(item: { date: string | null; endDate?: string | null }) {
  if (!item.date || !item.endDate) return '';
  const end = fromIso(item.endDate);
  return `${shortDate(item.date).replace(/ \(.\)$/, '')}~${end.getMonth() + 1}/${end.getDate()} (${WEEKDAYS[end.getDay()]})`;
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

/** Where today stands (SPEC-01.14 3·10): the 오늘 progress n/m and whether 퇴근하기 is offered. */
export interface TodayProgress {
  /** Items dated today or earlier: the open ones and those finished today (m). */
  total: number;
  /** Of those, the finished ones (n). */
  done: number;
  /** Every item finished today, undated ones too (what 퇴근하기 takes off the list). */
  doneToday: number;
  /** Nothing dated today or earlier is open and something was finished today. */
  finished: boolean;
}
/** The local date of a timestamp ('doneAt'), 'YYYY-MM-DD'. */
export const dayOf = (at: string) => isoDate(new Date(at));
export function todayProgress(
  items: readonly {
    date: string | null;
    done: boolean;
    doneAt: string | null;
    kind?: AgendaKind;
  }[],
  today: string,
): TodayProgress {
  const finishedToday = (item: { doneAt: string | null }) =>
    Boolean(item.doneAt && dayOf(item.doneAt) === today);
  // A 협의 has no done check: it never holds the day back (SPEC-01.14 3·10).
  const due = items.filter(
    (item) =>
      !isEvent(item) && item.date && item.date <= today && (!item.done || finishedToday(item)),
  );
  const done = due.filter((item) => item.done).length;
  const doneToday = items.filter((item) => item.done && finishedToday(item)).length;
  return { total: due.length, done, doneToday, finished: done === due.length && doneToday > 0 };
}

/**
 * 글·파일에서 할 일 만들기 (SPEC-01.14 9): the turn's words. The instruction goes before what the
 * user pasted; the attached files travel as the request's files (read by their kept path).
 */
export function extractionBody(text: string, now: Date, files: readonly string[] = []) {
  const typed = text.trim();
  const from = [typed ? '글' : '', files.length ? `첨부 파일(${files.join(', ')})` : '']
    .filter(Boolean)
    .join('과 ');
  const lines = [
    `[글·파일에서 할 일 만들기] 아래 ${from}에서 할 일·협의·접수·마감을 뽑아 agenda_add로 이 프로젝트 할 일에 바로 넣어 주세요.`,
    `오늘은 ${isoDate(now)} (${WEEKDAYS[now.getDay()]})입니다. '내일'·'금요일까지' 같은 날짜는 오늘 기준으로 'YYYY-MM-DD'로, 시각은 'HH:MM'(24시간)으로 적고, 없으면 비웁니다(하루 종일). '2시~4시'처럼 끝 시각이 있으면 endTime, '10/7~10/9'처럼 여러 날이면 endDate를 적습니다.`,
    "회의·협의는 kind 'meeting', 허가·도서 제출과 접수는 'receipt', 기한까지 할 일은 'deadline', 그 밖은 kind를 비웁니다. 장소가 적혀 있으면 location, 담당자·참석자가 적혀 있으면 attendees에 적힌 그대로('김 대리, 설비 업체') 넣습니다.",
    '먼저 agenda_list로 지금 목록을 읽고 같은 항목은 다시 넣지 않습니다. 묻지 말고 바로 넣은 뒤 넣은 항목을 짧게 알려 주세요. 넣을 것이 없으면 그렇다고만 답합니다.',
  ];
  return typed ? `${lines.join('\n')}\n\n---\n${typed}` : lines.join('\n');
}
/**
 * The requests the dashboard sent (글·파일에서 할 일 만들기): the dashboard shows their result and
 * [되돌리기] itself, so the conversation's notice (followAppActions) is not shown for them again.
 */
export const dashboardAgendaRequests = new Set<string>();

/** One item placed in a week's row of the month (SPEC-01.14 3, PLAN-39 T-182). */
export interface WeekPlace<T> {
  item: T;
  /** The first and last column it covers in this week (0 = Sunday). */
  from: number;
  to: number;
  /** Its line in the week (0 = top). */
  lane: number;
  /** It began before this week / goes on after it (the bar's cut ends). */
  before: boolean;
  after: boolean;
}
/** Lines a day shows before '+n'. */
export const WEEK_LANES = 5;
/**
 * Lays one week of the month out in lines: items over several days first (earlier start, then
 * longer), as bars across their days, then one-day items (all day, then by time, then the user's
 * order), each in the first line free on all its days. What does not fit in WEEK_LANES lines is
 * counted per day as '+n'.
 */
export function weekLanes<
  T extends { date: string | null; endDate?: string | null; time?: string | null; order?: number },
>(week: readonly string[], items: readonly T[], lanes = WEEK_LANES) {
  const first = week[0],
    last = week[week.length - 1];
  const shown = items
    .filter((item) => item.date && item.date <= last && (lastDay(item) ?? '') >= first)
    .map((item) => ({ item, start: item.date!, end: lastDay(item)! }))
    .sort((a, b) => {
      const multi = Number(b.end > b.start) - Number(a.end > a.start);
      if (multi) return multi;
      if (a.end > a.start) return a.start.localeCompare(b.start) || b.end.localeCompare(a.end);
      return (
        a.start.localeCompare(b.start) ||
        (a.item.time ?? '').localeCompare(b.item.time ?? '') ||
        (a.item.order ?? 0) - (b.item.order ?? 0)
      );
    });
  const taken: boolean[][] = [];
  const placed: WeekPlace<T>[] = [];
  const more = week.map(() => 0);
  for (const { item, start, end } of shown) {
    const from = start < first ? 0 : week.indexOf(start);
    const to = end > last ? week.length - 1 : week.indexOf(end);
    let lane = 0;
    while (lane < lanes && (taken[lane] ?? []).slice(from, to + 1).some(Boolean)) lane++;
    if (lane >= lanes) {
      for (let day = from; day <= to; day++) more[day]++;
      continue;
    }
    taken[lane] ??= week.map(() => false);
    for (let day = from; day <= to; day++) taken[lane][day] = true;
    placed.push({ item, from, to, lane, before: start < first, after: end > last });
  }
  return { placed, more };
}

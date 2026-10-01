// 대시보드의 할 일 (SPEC-01.14 2): reading a date and time out of what the user typed, on this PC,
// with no AI call — '내일 3시 구조 회의', '금요일까지 보고서', '10/7 14:00 현장 회의'. The words
// that gave the date or time leave the text; when nothing is read the text stays as typed.

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
}

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

/** Reads the first date and the first time in the text (today = the PC's local day). */
export function parseAgendaText(input: string, now = new Date()): ParsedAgenda {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let text = input;
  let date: string | null = null,
    time: string | null = null;
  for (const { re, read } of timePatterns) {
    const m = re.exec(text);
    const value = m && read(m);
    if (!m || !value) continue;
    time = `${pad(value[0])}:${pad(value[1])}`;
    text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
    break;
  }
  for (const { re, read } of datePatterns) {
    const m = re.exec(text);
    const value = m && read(m, today);
    if (!m || !value) continue;
    date = isoDate(value);
    text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
    break;
  }
  const rest = text.replace(/\s+/g, ' ').trim();
  // Only a date or a time and no words left: keep what was typed as the text too.
  if ((!date && !time) || !rest) return { text: input.trim(), date, time };
  if (time && !date) date = isoDate(today);
  return { text: rest, date, time };
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

/** The notice after an AI write ([되돌리기] beside it): what was added or changed. */
export function agendaNotice(body: unknown) {
  const changes = (body as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes) || !changes.length) return undefined;
  const added = changes.filter((change) => change?.op === 'add');
  const names = changes
    .slice(0, 3)
    .map((change) => `'${String(change?.text ?? '')}'`)
    .join(', ');
  const more = changes.length > 3 ? ` 외 ${changes.length - 3}개` : '';
  return added.length === changes.length
    ? `AI가 할 일을 더했습니다: ${names}${more}`
    : `AI가 할 일을 바꿨습니다: ${names}${more}`;
}

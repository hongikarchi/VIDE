import type { AgendaItem } from '../contracts/agenda.ts';

/**
 * 일정 노트의 폴더 사본 (SPEC-10.9 4, SPEC-10.10, ARCH-01 「작업 폴더(PLAN-52)」 산출물 경로): one
 * month of the project's 할 일·일정 items as Markdown, `<ops>/일정/<YYYY-MM>.md`. An item belongs to
 * the month of its date (a period: its first day); items with no date are not on the schedule.
 */
const KIND_LABELS: Record<AgendaItem['kind'], string> = {
  task: '할 일',
  meeting: '협의',
  receipt: '접수',
  deadline: '마감',
};

/** 'YYYY-MM' of a 'YYYY-MM-DD'. */
export const monthKey = (date: string) => date.slice(0, 7);

/** The months that have dated items, oldest first. */
export function scheduleMonths(items: readonly Pick<AgendaItem, 'date'>[]): string[] {
  return [...new Set(items.flatMap((item) => (item.date ? [monthKey(item.date)] : [])))].sort();
}

const dayTitle = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  const day = '일월화수목금토'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}월 ${d}일 (${day})`;
};
const shortDay = (date: string) => {
  const [, m, d] = date.split('-').map(Number);
  return `${m}월 ${d}일`;
};
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** One item's line: '- 10:00~11:00 [협의] 설비 협의 · 장소 현장 사무실 · 참석 김 대리'. */
function itemLine(item: AgendaItem) {
  const time = item.time ? `${item.time}${item.endTime ? `~${item.endTime}` : ''} ` : '';
  const until = item.endDate ? ` (~${shortDay(item.endDate)})` : '';
  const parts = [`[${KIND_LABELS[item.kind]}] ${oneLine(item.text)}${until}`];
  if (item.location?.trim()) parts.push(`장소 ${oneLine(item.location)}`);
  if (item.attendees?.trim()) parts.push(`참석 ${oneLine(item.attendees)}`);
  if (item.kind !== 'meeting' && item.done) parts.push('완료');
  return `- ${time}${parts.join(' · ')}`;
}

/**
 * The month `month` ('YYYY-MM') as Markdown: a title, then one H2 per day with items in date and
 * time order (all-day items first). A month with no items says so.
 */
export function scheduleMarkdown(items: readonly AgendaItem[], month: string): string {
  const [y, m] = month.split('-').map(Number);
  const shown = items
    .filter((item) => item.date && monthKey(item.date) === month)
    .sort(
      (a, b) =>
        a.date!.localeCompare(b.date!) ||
        (a.time ?? '').localeCompare(b.time ?? '') ||
        a.order - b.order,
    );
  const lines = [`# ${y}년 ${m}월 일정`, ''];
  if (!shown.length) lines.push('이 달에 날짜가 있는 할 일·일정이 없습니다.');
  let day = '';
  for (const item of shown) {
    if (item.date !== day) {
      if (day) lines.push('');
      day = item.date!;
      lines.push(`## ${dayTitle(day)}`, '');
    }
    lines.push(itemLine(item));
  }
  return lines.join('\n') + '\n';
}

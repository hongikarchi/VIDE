// 대시보드 › 오늘 › 달력 (SPEC-01.14 3, Design SCR-20, PLAN-26 T-110): this project's 할 일 in one
// month. A day shows short titles with a dot for the kind; a click picks the day (its list below,
// the add box prefilled by the parent); dragging an item to another day saves only its date, to
// the '날짜 없음' box clears it. Items without a date sit in that box beside the month.
import { useState, type DragEvent, type ReactNode } from 'react';
import type { AgendaItem } from '../contracts/agenda.ts';
import {
  KIND_LABELS,
  WEEKDAY_LETTERS,
  dayLabel,
  monthDays,
  monthLabel,
  monthOf,
  shiftMonth,
} from './agenda-text.ts';

/** Titles a day shows before '+n'. */
const DAY_ITEMS = 3;
const byTime = (a: AgendaItem, b: AgendaItem) =>
  (a.time ?? '99').localeCompare(b.time ?? '99') || a.order - b.order;

export function AgendaCalendar({
  items,
  today,
  month,
  selected,
  busy,
  onMonth,
  onSelect,
  onMove,
  row,
}: {
  items: AgendaItem[];
  today: string;
  /** The month shown, 'YYYY-MM-01'. */
  month: string;
  selected: string | undefined;
  busy: boolean;
  onMonth: (month: string) => void;
  onSelect: (date: string) => void;
  /** Saves only the item's date (null: no date). */
  onMove: (entry: AgendaItem, date: string | null) => void;
  /** The list row the 목록 view uses, for the picked day. */
  row: (entry: AgendaItem) => ReactNode;
}) {
  const [over, setOver] = useState<string | undefined>();
  const [dragging, setDragging] = useState<string | undefined>();
  const byDate = new Map<string, AgendaItem[]>();
  for (const entry of items)
    if (entry.date) byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry]);
  for (const list of byDate.values()) list.sort(byTime);
  const undated = items.filter((entry) => !entry.date && !entry.done);
  const days = monthDays(month);

  const chip = (entry: AgendaItem) => (
    <span
      key={entry.id}
      className="dash-cal-item"
      data-kind={entry.kind}
      data-done={entry.done || undefined}
      data-dragging={dragging === entry.id || undefined}
      title={`${KIND_LABELS[entry.kind]} · ${entry.time ? entry.time + ' ' : ''}${entry.text}`}
      draggable={!busy}
      onDragStart={(event: DragEvent) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', entry.id);
        setDragging(entry.id);
      }}
      onDragEnd={() => {
        setDragging(undefined);
        setOver(undefined);
      }}
    >
      <span className="dash-cal-dot" aria-hidden="true" />
      {entry.time ? <span className="dash-cal-time">{entry.time}</span> : null}
      <span className="dash-cal-title">{entry.text}</span>
    </span>
  );
  /** Drop handlers for a day (a date) or the 날짜 없음 box (null). */
  const target = (date: string | null) => ({
    'data-over': over === (date ?? 'none') || undefined,
    onDragOver: (event: DragEvent) => {
      if (!dragging) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setOver(date ?? 'none');
    },
    onDragLeave: () => setOver((now) => (now === (date ?? 'none') ? undefined : now)),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      const id = event.dataTransfer.getData('text/plain') || dragging;
      setDragging(undefined);
      setOver(undefined);
      const entry = items.find((item) => item.id === id);
      if (entry && entry.date !== date) onMove(entry, date);
    },
  });

  const picked = selected ? (byDate.get(selected) ?? []) : [];
  return (
    <div className="dash-cal">
      <div className="dash-cal-body">
        <div className="dash-cal-month" aria-label={`달력 ${monthLabel(month)}`} role="group">
          <div className="dash-cal-nav">
            <button
              type="button"
              className="dash-cal-step"
              aria-label="이전 달"
              onClick={() => onMonth(shiftMonth(month, -1))}
            >
              ‹
            </button>
            <strong className="dash-cal-label">{monthLabel(month)}</strong>
            <button
              type="button"
              className="dash-cal-step"
              aria-label="다음 달"
              onClick={() => onMonth(shiftMonth(month, 1))}
            >
              ›
            </button>
            {monthOf(today) !== month ? (
              <button type="button" className="link-button" onClick={() => onMonth(monthOf(today))}>
                이번 달
              </button>
            ) : null}
          </div>
          <div className="dash-cal-grid">
            {WEEKDAY_LETTERS.map((letter) => (
              <span key={letter} className="dash-cal-weekday" aria-hidden="true">
                {letter}
              </span>
            ))}
            {days.map((date) => {
              const list = byDate.get(date) ?? [];
              const open = list.filter((entry) => !entry.done).length;
              return (
                <div
                  key={date}
                  role="button"
                  tabIndex={0}
                  className="dash-cal-day"
                  aria-label={`${dayLabel(date)}${open ? `, ${open}개` : ''}`}
                  aria-pressed={selected === date}
                  data-outside={monthOf(date) !== month || undefined}
                  data-today={date === today || undefined}
                  data-date={date}
                  onClick={() => onSelect(date)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(date);
                    }
                  }}
                  {...target(date)}
                >
                  <span className="dash-cal-date">{Number(date.slice(8))}</span>
                  {list.slice(0, DAY_ITEMS).map(chip)}
                  {list.length > DAY_ITEMS ? (
                    <span className="dash-cal-more">+{list.length - DAY_ITEMS}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        <div className="dash-cal-undated" role="group" aria-label="날짜 없음" {...target(null)}>
          <h4 className="dash-folder-sub">날짜 없음 {undated.length || ''}</h4>
          {undated.length ? (
            undated.map(chip)
          ) : (
            <p className="dash-cal-hint">날짜를 빼려면 여기로 끌어 놓으세요.</p>
          )}
        </div>
      </div>
      {selected ? (
        <div className="dash-cal-picked">
          <h4 className="dash-folder-sub">{dayLabel(selected)}</h4>
          {picked.length ? (
            <ul className="dash-agenda-list" aria-label={`${dayLabel(selected)} 할 일`}>
              {picked.map((entry) => row(entry))}
            </ul>
          ) : (
            <p className="dash-empty">이 날 할 일이 없습니다. 위 칸에 적고 Enter.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

// 대시보드 › 일정 (SPEC-01.14 3, Design SCR-20 「대시보드의 일정」, PLAN-26 T-110, PLAN-30 T-135,
// PLAN-39 T-182): this project's dated 할 일 in one large month. Each week is one row of lines: an
// item over several days is a bar across its days (cut where the week ends), one-day items follow
// with a dot for the kind, five lines a day and then '+n' (`weekLanes`). A day (or its [+]) opens
// the 일정 form for a new item on that day, an item opens it for that item; the parent draws the
// form and this places it beside what was clicked. Dragging an item — from the month or a row of
// the 할 일 area — onto another day moves it there with its period kept (the engine moves the end
// day). The day under the pointer decides, also when a bar lies over the day.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react';
import type { AgendaItem } from '../contracts/agenda.ts';
import {
  KIND_LABELS,
  WEEKDAY_LETTERS,
  WEEK_LANES,
  dayLabel,
  monthDays,
  monthLabel,
  monthOf,
  shiftMonth,
  timeLabel,
  weekLanes,
} from './agenda-text.ts';

/** The drag type a 할 일 row carries so a day of the month takes it (the item id). */
export const AGENDA_DRAG = 'application/x-vide-agenda';
/** The form's width; it stays inside the calendar. */
const FORM_WIDTH = 320;

/** What the open form hangs from: a day ('day:2026-10-07') or an item ('item:<id>'). */
export type CalendarAnchor = `day:${string}` | `item:${string}`;

export function AgendaCalendar({
  items,
  today,
  month,
  busy,
  onMonth,
  onPick,
  onOpen,
  onMove,
  form,
  onClose,
}: {
  items: AgendaItem[];
  today: string;
  /** The month shown, 'YYYY-MM-01'. */
  month: string;
  busy: boolean;
  onMonth: (month: string) => void;
  /** A day or its [+]: a new item on that day. */
  onPick: (date: string) => void;
  /** An item: its form. */
  onOpen: (entry: AgendaItem) => void;
  /** Moves the item to that day (its period kept). */
  onMove: (entry: AgendaItem, date: string) => void;
  /** The open 일정 form and what it hangs from. */
  form?: { anchor: CalendarAnchor; content: ReactNode };
  /** A press outside the open form closes it. */
  onClose: () => void;
}) {
  const [over, setOver] = useState<string | undefined>();
  const [dragging, setDragging] = useState<string | undefined>();
  const [place, setPlace] = useState<CSSProperties | undefined>();
  const box = useRef<HTMLDivElement>(null);
  const days = monthDays(month);
  const weeks = Array.from({ length: days.length / 7 }, (_, index) =>
    days.slice(index * 7, index * 7 + 7),
  );
  const dated = items.filter((entry) => entry.date);

  // The form sits under what was clicked, kept inside the calendar's width.
  const anchor = form?.anchor;
  useLayoutEffect(() => {
    const root = box.current;
    if (!anchor || !root) return setPlace(undefined);
    const target = root.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`);
    const outer = root.getBoundingClientRect();
    const rect = target?.getBoundingClientRect() ?? outer;
    const left = Math.max(0, Math.min(rect.left - outer.left, outer.width - FORM_WIDTH));
    setPlace({ left, top: rect.top - outer.top + Math.min(rect.height, 28) + 2 });
  }, [anchor, month]);

  useEffect(() => {
    if (!anchor) return;
    const outside = (event: PointerEvent) => {
      const pop = box.current?.querySelector('.dash-event-pop');
      if (pop && !pop.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [anchor, onClose]);

  /** The day under the pointer: the day cell itself, or the column of the week where it is. */
  const dayAt = (event: DragEvent, week: string[]) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('.dash-cal-day');
    if (cell?.dataset.date) return cell.dataset.date;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const column = Math.floor(((event.clientX - rect.left) / rect.width) * 7);
    return week[Math.max(0, Math.min(6, column))];
  };
  const drop = (week: string[]) => ({
    onDragOver: (event: DragEvent) => {
      if (!dragging && !event.dataTransfer.types.includes(AGENDA_DRAG)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setOver(dayAt(event, week));
    },
    onDragLeave: (event: DragEvent) => {
      if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node))
        setOver(undefined);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      const id = event.dataTransfer.getData('text/plain') || dragging;
      const date = dayAt(event, week);
      setDragging(undefined);
      setOver(undefined);
      const entry = items.find((item) => item.id === id);
      if (entry && date && entry.date !== date) onMove(entry, date);
    },
  });

  return (
    <div className="dash-cal" ref={box}>
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
        <div className="dash-cal-weekdays" aria-hidden="true">
          {WEEKDAY_LETTERS.map((letter) => (
            <span key={letter} className="dash-cal-weekday">
              {letter}
            </span>
          ))}
        </div>
        {weeks.map((week) => {
          const { placed, more } = weekLanes(week, dated);
          return (
            <div key={week[0]} className="dash-cal-week" {...drop(week)}>
              {week.map((date, column) => {
                const open = dated.filter(
                  (entry) =>
                    !entry.done && entry.date! <= date && (entry.endDate ?? entry.date!) >= date,
                ).length;
                return (
                  <div
                    key={date}
                    role="button"
                    tabIndex={0}
                    className="dash-cal-day"
                    style={{ gridColumn: column + 1 }}
                    aria-label={`${dayLabel(date)}${open ? `, ${open}개` : ''}`}
                    aria-pressed={anchor === `day:${date}`}
                    data-outside={monthOf(date) !== month || undefined}
                    data-today={date === today || undefined}
                    data-over={over === date || undefined}
                    data-date={date}
                    data-anchor={`day:${date}`}
                    onClick={() => onPick(date)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onPick(date);
                      }
                    }}
                  >
                    <span className="dash-cal-date">{Number(date.slice(8))}</span>
                    <button
                      type="button"
                      className="dash-cal-plus"
                      aria-label={`${dayLabel(date)} 일정 추가`}
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation();
                        onPick(date);
                      }}
                    >
                      +
                    </button>
                  </div>
                );
              })}
              {placed.map(({ item: entry, from, to, lane, before, after }) => {
                const span = to > from || before || after;
                return (
                  <button
                    type="button"
                    key={entry.id}
                    className="dash-cal-item"
                    style={{ gridColumn: `${from + 1} / ${to + 2}`, gridRow: lane + 2 }}
                    data-kind={entry.kind}
                    data-span={span || undefined}
                    data-before={before || undefined}
                    data-after={after || undefined}
                    data-done={entry.done || undefined}
                    data-dragging={dragging === entry.id || undefined}
                    data-id={entry.id}
                    data-anchor={`item:${entry.id}`}
                    title={[
                      KIND_LABELS[entry.kind],
                      timeLabel(entry),
                      entry.text,
                      entry.location ? `@${entry.location}` : '',
                      entry.attendees ?? '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    draggable={!busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(entry);
                    }}
                    onDragStart={(event: DragEvent) => {
                      event.stopPropagation();
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', entry.id);
                      event.dataTransfer.setData(AGENDA_DRAG, entry.id);
                      setDragging(entry.id);
                    }}
                    onDragEnd={() => {
                      setDragging(undefined);
                      setOver(undefined);
                    }}
                  >
                    {span ? null : <span className="dash-cal-dot" aria-hidden="true" />}
                    {entry.time && !span ? (
                      <span className="dash-cal-time">{entry.time}</span>
                    ) : null}
                    <span className="dash-cal-title">{entry.text}</span>
                  </button>
                );
              })}
              {more.map((count, column) =>
                count ? (
                  <span
                    key={column}
                    className="dash-cal-more"
                    style={{ gridColumn: column + 1, gridRow: WEEK_LANES + 2 }}
                  >
                    +{count}
                  </span>
                ) : null,
              )}
            </div>
          );
        })}
      </div>
      {form ? (
        <div
          className="dash-event-pop"
          role="dialog"
          aria-label={form.anchor.startsWith('day:') ? '일정 추가' : '일정 고치기'}
          style={place ?? { left: 0, top: 0 }}
        >
          {form.content}
        </div>
      ) : null}
    </div>
  );
}

// 대시보드 › 할 일 · 일정 (SPEC-01.14, Design SCR-20, PLAN-30, PLAN-39): the project's 할 일 as two
// areas over the same items. '할 일' (a fixed column on the left, 2026-10-06 user choice '안 A: 할
// 일 | 큰 달력') shows what is open for today — past-due, today's (an item over several days while
// today falls in it) and undated items — in the user's order, under a 오늘 head with the day's
// progress n/m; later dates fold under '예정 n', finished ones under '완료 n'. A 협의 has no done
// check and leaves the list once its day is over. When today's items are all done it offers
// [퇴근하기] (finished items go to the day log, tomorrow's first items show). [글·파일에서 할 일
// 만들기] (dashboard-agenda-extract.tsx) has the AI collect items from pasted notes or files.
// '일정' is the large month (dashboard-calendar.tsx): a day opens the 일정 form for a new item, an
// item opens it for that item (dashboard-agenda-form.tsx); a row of either area dragged onto a day
// moves it there with its period kept.
// Enter adds (a date, time and range are read from the words on this PC, agenda-text.ts), the box
// finishes, a click on the text edits in place with the same fields as the form, [빼기] removes,
// drag or ↑↓ reorders. iPad sessions may edit too. The board reads its own data (`…/agenda`) and
// again when shown, on focus and after an AI write.
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { api } from './gateway.ts';
import type { AgendaItem, DayLogEntry } from '../contracts/agenda.ts';
import {
  AGENDA_CHANGED,
  KIND_LABELS,
  agendaWhen,
  dateLabel,
  isEvent,
  isoDate,
  lastDay,
  monthOf,
  parseAgendaDraft,
  shortDate,
  spanLabel,
  timeLabel,
  todayProgress,
} from './agenda-text.ts';
import { AGENDA_DRAG, AgendaCalendar, type CalendarAnchor } from './dashboard-calendar.tsx';
import { AgendaFromText } from './dashboard-agenda-extract.tsx';
import {
  AgendaForm,
  FIELD_KEYS,
  blankFields,
  changedFields,
  createBody,
  fieldsOf,
  type AgendaFields,
} from './dashboard-agenda-form.tsx';

const reasons: Record<string, string> = {
  REVISION_CONFLICT: '다른 화면에서 바뀌어 최신 목록을 다시 읽었습니다.',
  NOT_FOUND: '이미 빠진 할 일이라 최신 목록을 다시 읽었습니다.',
  AGENDA_LIMIT: '할 일이 너무 많습니다. 완료한 것을 비운 뒤 더하세요.',
  INVALID_INPUT: '내용을 확인하세요.',
};
const todayLabel = (at: Date) =>
  at.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
const byDateTime = (a: AgendaItem, b: AgendaItem) =>
  `${a.date} ${a.time ?? '99'}`.localeCompare(`${b.date} ${b.time ?? '99'}`);
/** Nothing but a date: nothing to add yet. */
const onlyDate = (draft: string) => /^\d{4}-\d{2}-\d{2}$/.test(draft.trim());

/**
 * An edit of one item, in place of its row or over the calendar: the form's fields, and the
 * revision and fields of the item when editing began (`from`). Saving sends that revision and only
 * what the user changed from `from`, so a change another screen made meanwhile is refused
 * (REVISION_CONFLICT) instead of being overwritten.
 */
interface Edit {
  id: string;
  revision: number;
  fields: AgendaFields;
  from: AgendaFields;
  where: 'row' | 'calendar';
}
const editOf = (entry: AgendaItem, where: Edit['where']): Edit => ({
  id: entry.id,
  revision: entry.revision,
  fields: fieldsOf(entry),
  from: fieldsOf(entry),
  where,
});

/** The add box: Enter adds, the line below shows the date, time and kind read from the words. */
function AddBox({
  draft,
  today,
  onDraft,
  onAdd,
}: {
  draft: string;
  today: string;
  onDraft: (value: string) => void;
  onAdd: () => void;
}) {
  const preview =
    draft.trim() && !onlyDate(draft) ? parseAgendaDraft(draft, new Date()) : undefined;
  return (
    <>
      <form
        className="dash-agenda-add"
        onSubmit={(event) => {
          event.preventDefault();
          onAdd();
        }}
      >
        <input
          type="text"
          aria-label="할 일 추가"
          placeholder="할 일 — 예: 내일 3시 구조 협의, 금요일 도면 제출"
          value={draft}
          maxLength={500}
          onChange={(event) => onDraft(event.target.value)}
        />
      </form>
      {preview && (preview.date || preview.time) ? (
        <p className="dash-agenda-hint" aria-live="polite">
          {preview.date
            ? preview.endDate
              ? spanLabel(preview)
              : dateLabel(preview.date, today).replace(/^지남 · /, '')
            : ''}
          {preview.time ? ` ${timeLabel(preview)}` : ''} · {preview.text}
          {preview.kind !== 'task' ? (
            <span className="dash-agenda-kind" data-kind={preview.kind}>
              {KIND_LABELS[preview.kind]}
            </span>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

export function AgendaBoard({ projectId, shown }: { projectId: string; shown: number }) {
  const [items, setItems] = useState<AgendaItem[] | undefined>();
  const [dayEnd, setDayEnd] = useState<DayLogEntry | undefined>();
  const [failed, setFailed] = useState(false);
  const [taskDraft, setTaskDraft] = useState('');
  const [edit, setEdit] = useState<Edit | undefined>();
  /** A new 일정 being written in the calendar's form: its day and fields. */
  const [adding, setAdding] = useState<{ date: string; fields: AgendaFields } | undefined>();
  const [showLater, setShowLater] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | undefined>();
  const [month, setMonth] = useState(() => monthOf(isoDate(new Date())));
  const base = `/projects/${encodeURIComponent(projectId)}/agenda`;
  const now = new Date();
  const today = isoDate(now);
  const tomorrow = isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));

  const load = useCallback(() => {
    const day = isoDate(new Date());
    return Promise.all([api(base), api(`${base}/log?from=${day}&to=${day}`)])
      .then(([list, log]) => {
        setItems((list as { items: AgendaItem[] }).items);
        setDayEnd(
          (log as { entries: DayLogEntry[] }).entries.find((entry) => entry.kind === 'day-end'),
        );
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [base]);
  useEffect(() => {
    void load();
  }, [load, shown]);
  useEffect(() => {
    const again = () => void load();
    addEventListener(AGENDA_CHANGED, again);
    addEventListener('focus', again);
    return () => {
      removeEventListener(AGENDA_CHANGED, again);
      removeEventListener('focus', again);
    };
  }, [load]);

  /**
   * One write; on a conflict or a vanished item the list is read again and the reason shown.
   * Answers true, or the error code.
   */
  const write = async (path: string, method: string, data: unknown): Promise<true | string> => {
    setBusy(true);
    setReason('');
    try {
      const next = (await api(path, method, data)) as { items: AgendaItem[]; entry?: DayLogEntry };
      setItems(next.items);
      if (next.entry) setDayEnd(next.entry);
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      setReason(reasons[code] ?? (error as Error).message);
      if (code === 'REVISION_CONFLICT' || code === 'NOT_FOUND') void load();
      return code;
    } finally {
      setBusy(false);
    }
  };
  // The add box is never disabled: a disabled box loses the focus, and the next 할 일 typed after
  // Enter would go nowhere. Enter empties the box at once; the adds are saved one after another,
  // and one that fails comes back into the box (unless something new was typed there).
  const adds = useRef<Promise<unknown>>(Promise.resolve());
  const addFrom = (draft: string) => {
    if (!draft.trim() || onlyDate(draft)) return;
    setTaskDraft('');
    adds.current = adds.current.then(async () => {
      if ((await write(base, 'POST', parseAgendaDraft(draft, new Date()))) !== true)
        setTaskDraft((now) => (now.trim() ? now : draft));
    });
  };
  const item = (id: string) => `${base}/${encodeURIComponent(id)}`;
  const toggle = (entry: AgendaItem) =>
    void write(item(entry.id), 'PUT', { revision: entry.revision, done: !entry.done });
  const remove = (entry: AgendaItem) =>
    void write(`${item(entry.id)}/remove`, 'POST', { revision: entry.revision });
  const save = async () => {
    if (!edit) return;
    if (!edit.fields.text.trim()) return setReason('내용이 비면 [빼기]로 빼세요.');
    const changed = changedFields(edit.fields, edit.from);
    if (!Object.keys(changed).length) return setEdit(undefined);
    const result = await write(item(edit.id), 'PUT', { revision: edit.revision, ...changed });
    if (result === true || result === 'NOT_FOUND') return setEdit(undefined);
    if (result !== 'REVISION_CONFLICT') return;
    // Changed on another screen meanwhile: the form takes the newer item and keeps only what the
    // user changed here; Enter again saves that over the newer one.
    let latest: AgendaItem | undefined;
    try {
      latest = ((await api(base)) as { items: AgendaItem[] }).items.find(
        (row) => row.id === edit.id,
      );
    } catch {
      return;
    }
    if (!latest) return setEdit(undefined);
    const fresh = editOf(latest, edit.where);
    setEdit((now) => {
      if (now?.id !== edit.id) return now;
      const fields = { ...fresh.fields };
      for (const key of FIELD_KEYS)
        if (now.fields[key] !== now.from[key]) Object.assign(fields, { [key]: now.fields[key] });
      return { ...fresh, fields };
    });
  };
  /** [날짜 빼기] in the form: the item leaves the calendar for the undated 할 일. */
  const clearDate = async () => {
    if (!edit) return;
    const result = await write(item(edit.id), 'PUT', { revision: edit.revision, date: null });
    if (result === true || result === 'NOT_FOUND') setEdit(undefined);
  };
  const removeEdited = async () => {
    if (!edit) return;
    const result = await write(`${item(edit.id)}/remove`, 'POST', { revision: edit.revision });
    if (result === true || result === 'NOT_FOUND') setEdit(undefined);
  };
  const addPlanned = async () => {
    if (!adding?.fields.text.trim()) return;
    if ((await write(base, 'POST', createBody(adding.fields))) === true) setAdding(undefined);
  };

  const open = items?.filter((entry) => !entry.done) ?? [];
  const current = open.filter((entry) =>
    ['overdue', 'today', 'undated'].includes(agendaWhen(entry, today)),
  );
  const later = open.filter((entry) => agendaWhen(entry, today) === 'later').sort(byDateTime);
  const done = (items?.filter((entry) => entry.done) ?? []).sort((a, b) =>
    (b.doneAt ?? '').localeCompare(a.doneAt ?? ''),
  );
  const progress = todayProgress(items ?? [], today);
  const dueOpen = open.some((entry) => !isEvent(entry) && entry.date && entry.date <= today);
  /** Left work today: the day's entry is there and nothing new was finished or is due since. */
  const ended = Boolean(dayEnd) && !dueOpen && progress.doneToday === 0;
  const nextDay = open
    .filter((entry) => entry.date && entry.date <= tomorrow && lastDay(entry)! >= tomorrow)
    .sort(byDateTime);
  /** Moves one item of the 할 일 list to another place and saves the order of that list. */
  const move = (id: string, to: number) => {
    const ids = current.map((entry) => entry.id);
    const from = ids.indexOf(id);
    if (from < 0 || to < 0 || to >= ids.length || from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void write(`${base}/order`, 'POST', { ids });
  };
  /** The calendar's drag: only the start day is sent (the engine keeps the period). */
  const moveTo = (entry: AgendaItem, date: string) =>
    void write(item(entry.id), 'PUT', { revision: entry.revision, date });
  const pick = (date: string) => {
    setEdit(undefined);
    setAdding({ date, fields: blankFields(date) });
  };
  const openItem = (entry: AgendaItem) => {
    setAdding(undefined);
    setEdit(editOf(entry, 'calendar'));
  };
  const closeForm = useCallback(() => {
    setAdding(undefined);
    setEdit((now) => (now?.where === 'calendar' ? undefined : now));
  }, []);

  const row = (entry: AgendaItem, index?: number) => {
    const when = agendaWhen(entry, today);
    const editing = edit?.id === entry.id && edit.where === 'row';
    const event = isEvent(entry) && !entry.done;
    const reorder = index !== undefined && !entry.done;
    const at = index ?? 0;
    return (
      <li
        key={entry.id}
        className="dash-agenda-row"
        data-when={entry.done ? 'done' : event ? 'event' : when}
        data-editing={editing || undefined}
        data-dragging={dragging === entry.id || undefined}
        draggable={!entry.done && !editing}
        onDragStart={(drag: DragEvent) => {
          if (entry.done) return;
          drag.dataTransfer.effectAllowed = 'move';
          drag.dataTransfer.setData('text/plain', entry.id);
          // Lets the calendar take it: a day moves it there.
          drag.dataTransfer.setData(AGENDA_DRAG, entry.id);
          setDragging(entry.id);
        }}
        onDragEnd={() => setDragging(undefined)}
        onDragOver={(drag: DragEvent) => {
          if (reorder && dragging) drag.preventDefault();
        }}
        onDrop={(drag: DragEvent) => {
          drag.preventDefault();
          const id = drag.dataTransfer.getData('text/plain') || dragging;
          setDragging(undefined);
          if (reorder && id) move(id, at);
        }}
      >
        {event ? (
          <span className="dash-agenda-event" aria-hidden="true" />
        ) : (
          <input
            type="checkbox"
            aria-label={`${entry.text} 완료`}
            checked={entry.done}
            disabled={busy}
            onChange={() => toggle(entry)}
          />
        )}
        {editing ? (
          <AgendaForm
            variant="row"
            fields={edit.fields}
            busy={busy}
            submitLabel="저장"
            onChange={(fields) => setEdit({ ...edit, fields })}
            onSubmit={() => void save()}
            onCancel={() => setEdit(undefined)}
          />
        ) : (
          <button
            type="button"
            className="dash-agenda-text"
            title="눌러서 고치기"
            onClick={() => {
              setAdding(undefined);
              setEdit(editOf(entry, 'row'));
            }}
          >
            {entry.text}
          </button>
        )}
        {editing ? null : (
          <span className="dash-agenda-meta">
            {entry.kind !== 'task' ? (
              <span className="dash-agenda-kind" data-kind={entry.kind}>
                {KIND_LABELS[entry.kind]}
              </span>
            ) : null}
            {entry.location ? (
              <span className="dash-agenda-where" title={entry.location}>
                @{entry.location}
              </span>
            ) : null}
            {entry.time ? <span className="dash-agenda-time">{timeLabel(entry)}</span> : null}
            {entry.date && entry.endDate
              ? spanLabel(entry)
              : entry.date && (when !== 'today' || entry.done)
                ? entry.done
                  ? shortDate(entry.date)
                  : dateLabel(entry.date, today)
                : null}
            {entry.source === 'ai' ? <span className="dash-agenda-by">AI</span> : null}
          </span>
        )}
        {editing ? null : (
          <span className="dash-agenda-tools">
            {reorder ? (
              <>
                <button
                  type="button"
                  aria-label={`${entry.text} 위로`}
                  disabled={busy || at === 0}
                  onClick={() => move(entry.id, at - 1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`${entry.text} 아래로`}
                  disabled={busy || at === current.length - 1}
                  onClick={() => move(entry.id, at + 1)}
                >
                  ↓
                </button>
              </>
            ) : null}
            <button
              type="button"
              aria-label={`${entry.text} 빼기`}
              disabled={busy}
              onClick={() => remove(entry)}
            >
              빼기
            </button>
          </span>
        )}
      </li>
    );
  };

  /** 퇴근하기 (SPEC-01.14 10): offered when today is done; afterwards tomorrow's first items. */
  const finish = ended ? (
    <div className="dash-day-end" role="status" aria-label="퇴근">
      <p className="dash-day-end-title">
        퇴근했습니다 <span className="dash-day-end-count">· 완료 {dayEnd!.body.done.length}</span>
      </p>
      <h4 className="dash-folder-sub">내일</h4>
      {nextDay.length ? (
        <ul className="dash-day-end-next" aria-label="내일 할 일">
          {nextDay.slice(0, 3).map((entry) => (
            <li key={entry.id}>
              {entry.time ? <span className="dash-agenda-time">{timeLabel(entry)}</span> : null}
              <span>{entry.text}</span>
              {entry.kind !== 'task' ? (
                <span className="dash-agenda-kind" data-kind={entry.kind}>
                  {KIND_LABELS[entry.kind]}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="dash-day-end-none">내일 정해진 일은 없습니다.</p>
      )}
    </div>
  ) : progress.finished ? (
    <div className="dash-day-end" role="status" aria-label="퇴근">
      <p className="dash-day-end-title">
        오늘 할 일을 다 했습니다.{' '}
        <span className="dash-day-end-count">완료 {progress.doneToday}</span>
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void write(`${base}/day-end`, 'POST', {})}
      >
        퇴근하기
      </button>
    </div>
  ) : null;

  /** The open 일정 form over the calendar: a new one on a day, or the item clicked there. */
  const calendarForm: { anchor: CalendarAnchor; content: ReactNode } | undefined = adding
    ? {
        anchor: `day:${adding.date}`,
        content: (
          <AgendaForm
            key={`day:${adding.date}`}
            variant="popover"
            fields={adding.fields}
            busy={busy}
            submitLabel="추가"
            onChange={(fields) => setAdding({ ...adding, fields })}
            onSubmit={() => void addPlanned()}
            onCancel={() => setAdding(undefined)}
          />
        ),
      }
    : edit?.where === 'calendar'
      ? {
          anchor: `item:${edit.id}`,
          content: (
            <AgendaForm
              key={`item:${edit.id}`}
              variant="popover"
              fields={edit.fields}
              busy={busy}
              submitLabel="저장"
              onChange={(fields) => setEdit({ ...edit, fields })}
              onSubmit={() => void save()}
              onCancel={() => setEdit(undefined)}
              onRemove={() => void removeEdited()}
              onClearDate={() => void clearDate()}
            />
          ),
        }
      : undefined;

  const body = (content: ReactNode) =>
    failed ? (
      <p className="dash-empty">할 일을 읽지 못했습니다.</p>
    ) : !items ? (
      <p className="dash-empty">읽는 중…</p>
    ) : (
      content
    );
  return (
    <div className="dash-agenda-board">
      <div className="dash-agenda-pair">
        <section className="dash-section dash-agenda" aria-label="할 일">
          <div className="dash-section-head">
            <h3>할 일</h3>
          </div>
          <div className="dash-today-head">
            <h4>오늘</h4>
            <span className="dash-agenda-day">{todayLabel(now)}</span>
            {progress.total ? (
              <span className="dash-today-progress" aria-label="오늘 진행">
                <span className="dash-today-count">
                  {progress.done}/{progress.total}
                </span>
                <span className="dash-today-bar" aria-hidden="true">
                  <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                </span>
              </span>
            ) : null}
          </div>
          {finish}
          <AddBox
            draft={taskDraft}
            today={today}
            onDraft={setTaskDraft}
            onAdd={() => addFrom(taskDraft)}
          />
          <AgendaFromText projectId={projectId} />
          {reason ? (
            <p className="dash-folder-reason" role="alert">
              {reason}
            </p>
          ) : null}
          {body(
            <>
              {current.length ? (
                <ul className="dash-agenda-list" aria-label="오늘 할 일">
                  {current.map((entry, index) => row(entry, index))}
                </ul>
              ) : finish ? null : (
                <p className="dash-empty">
                  {open.length
                    ? '오늘 할 일은 다 했습니다.'
                    : '할 일이 없습니다. 위 칸에 적고 Enter.'}
                </p>
              )}
              {later.length ? (
                <div className="dash-agenda-fold">
                  <button
                    type="button"
                    className="link-button"
                    aria-expanded={showLater}
                    onClick={() => setShowLater(!showLater)}
                  >
                    예정 {later.length}
                  </button>
                  {showLater ? (
                    <ul className="dash-agenda-list" aria-label="예정">
                      {later.map((entry) => row(entry))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {done.length ? (
                <div className="dash-agenda-done">
                  <div className="dash-section-head">
                    <button
                      type="button"
                      className="link-button"
                      aria-expanded={showDone}
                      onClick={() => setShowDone(!showDone)}
                    >
                      완료 {done.length}
                    </button>
                    {showDone ? (
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy}
                        onClick={() => void write(`${base}/remove-done`, 'POST', {})}
                      >
                        완료 비우기
                      </button>
                    ) : null}
                  </div>
                  {showDone ? (
                    <ul className="dash-agenda-list" aria-label="완료한 할 일">
                      {done.map((entry) => row(entry))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>,
          )}
        </section>
        <section className="dash-section dash-schedule" aria-label="일정">
          <div className="dash-section-head">
            <h3>일정</h3>
            <button type="button" className="link-button" onClick={() => pick(today)}>
              + 일정
            </button>
          </div>
          {body(
            <AgendaCalendar
              items={items ?? []}
              today={today}
              month={month}
              busy={busy}
              onMonth={setMonth}
              onPick={pick}
              onOpen={openItem}
              onMove={moveTo}
              form={calendarForm}
              onClose={closeForm}
            />,
          )}
        </section>
      </div>
    </div>
  );
}

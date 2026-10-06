// 대시보드 › 할 일 · 일정 (SPEC-01.14, Design SCR-20, PLAN-30): the project's 할 일 as two areas
// over the same items (2026-10-06, '달력이랑 to-do list는 분리될 것'). '할 일' shows what is open
// for today — past-due, today's and undated items — in the user's order, under a 오늘 head with
// the day's progress n/m; later dates fold under '예정 n', finished ones under '완료 n'. When
// today's items are all done it offers [퇴근하기] (finished items go to the day log, tomorrow's
// first items show). [글·파일에서 할 일 만들기] (dashboard-agenda-extract.tsx) has the AI collect
// items from pasted notes or files. '일정' is the month (dashboard-calendar.tsx) with its own add
// box; a row of either area dragged onto a day changes only its date.
// Enter adds (a date and time are read from the words on this PC, agenda-text.ts), the box
// finishes, a click on the text edits in place, [빼기] removes, drag or ↑↓ reorders. iPad sessions
// may edit too. The board reads its own data (`…/agenda`) and again when shown, on focus and after
// an AI write.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { api } from './gateway.ts';
import type { AgendaItem, AgendaKind, DayLogEntry } from '../contracts/agenda.ts';
import {
  AGENDA_CHANGED,
  KIND_LABELS,
  agendaWhen,
  dateLabel,
  isoDate,
  monthOf,
  parseAgendaDraft,
  shortDate,
  todayProgress,
} from './agenda-text.ts';
import { AGENDA_DRAG, AgendaCalendar } from './dashboard-calendar.tsx';
import { AgendaFromText } from './dashboard-agenda-extract.tsx';

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
/** Nothing but the date a picked day put in the box: nothing to add yet. */
const onlyDate = (draft: string) => /^\d{4}-\d{2}-\d{2}$/.test(draft.trim());

/** Fields as the edit form holds them ('' for none). */
interface Fields {
  text: string;
  date: string;
  time: string;
  kind: AgendaKind;
}
/**
 * An edit in place: the form's fields, and the revision and fields of the item when editing began
 * (`from`). Saving sends that revision and only what the user changed from `from`, so a change
 * another screen made meanwhile is refused (REVISION_CONFLICT) instead of being overwritten.
 */
interface Edit extends Fields {
  id: string;
  revision: number;
  from: Fields;
}
const fieldsOf = (entry: AgendaItem): Fields => ({
  text: entry.text,
  date: entry.date ?? '',
  time: entry.time ?? '',
  kind: entry.kind,
});
const editOf = (entry: AgendaItem): Edit => ({
  id: entry.id,
  revision: entry.revision,
  ...fieldsOf(entry),
  from: fieldsOf(entry),
});

/** One add box: Enter adds, the line below shows the date, time and kind read from the words. */
function AddBox({
  label,
  placeholder,
  draft,
  today,
  box,
  onDraft,
  onAdd,
}: {
  label: string;
  placeholder: string;
  draft: string;
  today: string;
  box?: RefObject<HTMLInputElement | null>;
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
          ref={box}
          type="text"
          aria-label={label}
          placeholder={placeholder}
          value={draft}
          maxLength={500}
          onChange={(event) => onDraft(event.target.value)}
        />
      </form>
      {preview && (preview.date || preview.time) ? (
        <p className="dash-agenda-hint" aria-live="polite">
          {preview.date ? dateLabel(preview.date, today).replace(/^지남 · /, '') : ''}
          {preview.time ? ` ${preview.time}` : ''} · {preview.text}
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
  const [planDraft, setPlanDraft] = useState('');
  const [edit, setEdit] = useState<Edit | undefined>();
  const [showLater, setShowLater] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | undefined>();
  const [month, setMonth] = useState(() => monthOf(isoDate(new Date())));
  const [picked, setPicked] = useState<string | undefined>();
  const planBox = useRef<HTMLInputElement>(null);
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
  // The add boxes are never disabled: a disabled box loses the focus, and the next 할 일 typed
  // after Enter would go nowhere. Enter empties the box at once; the adds are saved one after
  // another, and one that fails comes back into its box (unless something new was typed there).
  const adding = useRef<Promise<unknown>>(Promise.resolve());
  const addFrom = (
    draft: string,
    setDraft: (update: (now: string) => string) => void,
    start = '',
  ) => {
    if (!draft.trim() || onlyDate(draft)) return;
    setDraft(() => start);
    adding.current = adding.current.then(async () => {
      if ((await write(base, 'POST', parseAgendaDraft(draft, new Date()))) !== true)
        setDraft((now) => (now.trim() && now !== start ? now : draft));
    });
  };
  const item = (id: string) => `${base}/${encodeURIComponent(id)}`;
  const toggle = (entry: AgendaItem) =>
    void write(item(entry.id), 'PUT', { revision: entry.revision, done: !entry.done });
  const remove = (entry: AgendaItem) =>
    void write(`${item(entry.id)}/remove`, 'POST', { revision: entry.revision });
  const save = async () => {
    if (!edit) return;
    if (!edit.text.trim()) return setReason('내용이 비면 [빼기]로 빼세요.');
    const changed: Record<string, unknown> = { revision: edit.revision };
    if (edit.text.trim() !== edit.from.text.trim()) changed.text = edit.text.trim();
    if (edit.date !== edit.from.date) changed.date = edit.date || null;
    if (edit.time !== edit.from.time) changed.time = edit.time || null;
    if (edit.kind !== edit.from.kind) changed.kind = edit.kind;
    if (Object.keys(changed).length === 1) return setEdit(undefined);
    const result = await write(item(edit.id), 'PUT', changed);
    if (result === true) return setEdit(undefined);
    if (result === 'NOT_FOUND') return setEdit(undefined);
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
    const fresh = editOf(latest);
    setEdit((now) =>
      now?.id !== edit.id
        ? now
        : {
            ...fresh,
            text: now.text !== now.from.text ? now.text : fresh.text,
            date: now.date !== now.from.date ? now.date : fresh.date,
            time: now.time !== now.from.time ? now.time : fresh.time,
            kind: now.kind !== now.from.kind ? now.kind : fresh.kind,
          },
    );
  };

  const open = items?.filter((entry) => !entry.done) ?? [];
  const current = open.filter((entry) => agendaWhen(entry, today) !== 'later');
  const later = open.filter((entry) => agendaWhen(entry, today) === 'later').sort(byDateTime);
  const done = (items?.filter((entry) => entry.done) ?? []).sort((a, b) =>
    (b.doneAt ?? '').localeCompare(a.doneAt ?? ''),
  );
  const progress = todayProgress(items ?? [], today);
  const dueOpen = open.some((entry) => entry.date && entry.date <= today);
  /** Left work today: the day's entry is there and nothing new was finished or is due since. */
  const ended = Boolean(dayEnd) && !dueOpen && progress.doneToday === 0;
  const nextDay = open.filter((entry) => entry.date === tomorrow).sort(byDateTime);
  /** Moves one item of the 할 일 list to another place and saves the order of that list. */
  const move = (id: string, to: number) => {
    const ids = current.map((entry) => entry.id);
    const from = ids.indexOf(id);
    if (from < 0 || to < 0 || to >= ids.length || from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void write(`${base}/order`, 'POST', { ids });
  };
  /** The calendar's drag: only the date is sent (the time and the rest stay). */
  const moveTo = (entry: AgendaItem, date: string | null) =>
    void write(item(entry.id), 'PUT', { revision: entry.revision, date });
  /** A day picked on the calendar: its list below, and the 일정 box starts with its date. */
  const pick = (date: string) => {
    setPicked(date);
    setPlanDraft((now) => `${date} ${now.replace(/^\d{4}-\d{2}-\d{2}\s*/, '')}`);
    planBox.current?.focus();
  };

  const row = (entry: AgendaItem, index?: number) => {
    const when = agendaWhen(entry, today);
    const editing = edit?.id === entry.id;
    const reorder = index !== undefined && !entry.done;
    const at = index ?? 0;
    return (
      <li
        key={entry.id}
        className="dash-agenda-row"
        data-when={entry.done ? 'done' : when}
        data-editing={editing || undefined}
        data-dragging={dragging === entry.id || undefined}
        draggable={!entry.done && !editing}
        onDragStart={(event: DragEvent) => {
          if (entry.done) return;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', entry.id);
          // Lets the calendar take it: a day changes only its date.
          event.dataTransfer.setData(AGENDA_DRAG, entry.id);
          setDragging(entry.id);
        }}
        onDragEnd={() => setDragging(undefined)}
        onDragOver={(event: DragEvent) => {
          if (reorder && dragging) event.preventDefault();
        }}
        onDrop={(event: DragEvent) => {
          event.preventDefault();
          const id = event.dataTransfer.getData('text/plain') || dragging;
          setDragging(undefined);
          if (reorder && id) move(id, at);
        }}
      >
        <input
          type="checkbox"
          aria-label={`${entry.text} 완료`}
          checked={entry.done}
          disabled={busy}
          onChange={() => toggle(entry)}
        />
        {editing ? (
          <form
            className="dash-agenda-edit"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEdit(undefined);
            }}
          >
            <input
              type="text"
              aria-label="할 일 고치기"
              autoFocus
              value={edit.text}
              maxLength={500}
              onChange={(event) => setEdit({ ...edit, text: event.target.value })}
            />
            <input
              type="date"
              aria-label="날짜"
              value={edit.date}
              onChange={(event) => setEdit({ ...edit, date: event.target.value })}
            />
            <input
              type="time"
              aria-label="시각"
              value={edit.time}
              onChange={(event) => setEdit({ ...edit, time: event.target.value })}
            />
            <select
              aria-label="종류"
              value={edit.kind}
              onChange={(event) => setEdit({ ...edit, kind: event.target.value as AgendaKind })}
            >
              {(Object.keys(KIND_LABELS) as AgendaKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
            <button type="submit" disabled={busy}>
              저장
            </button>
            <button type="button" className="link-button" onClick={() => setEdit(undefined)}>
              취소
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="dash-agenda-text"
            title="눌러서 고치기"
            onClick={() => setEdit(editOf(entry))}
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
            {entry.time ? <span className="dash-agenda-time">{entry.time}</span> : null}
            {entry.date && (when !== 'today' || entry.done)
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
              {entry.time ? <span className="dash-agenda-time">{entry.time}</span> : null}
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
            label="할 일 추가"
            placeholder="할 일 — 예: 내일 3시 구조 회의, 금요일 도면 제출"
            draft={taskDraft}
            today={today}
            onDraft={setTaskDraft}
            onAdd={() => addFrom(taskDraft, setTaskDraft)}
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
          </div>
          <AddBox
            label="일정 추가"
            placeholder="일정 — 예: 10/8 2시 설비 미팅"
            draft={planDraft}
            today={today}
            box={planBox}
            onDraft={setPlanDraft}
            onAdd={() => addFrom(planDraft, setPlanDraft, picked ? `${picked} ` : '')}
          />
          {body(
            <AgendaCalendar
              items={items ?? []}
              today={today}
              month={month}
              selected={picked}
              busy={busy}
              onMonth={setMonth}
              onSelect={pick}
              onMove={moveTo}
              row={(entry) => row(entry)}
            />,
          )}
        </section>
      </div>
    </div>
  );
}

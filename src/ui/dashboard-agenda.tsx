// 대시보드 › 오늘 (SPEC-01.14, Design SCR-20): the project's 할 일 at the top of the dashboard. The
// list shows what is open for today — past-due, today's and undated items — in the user's order;
// later dates sit under '예정' by date, finished ones fold under '완료 n'. Enter adds (a date and
// time are read from the words on this PC, agenda-text.ts), the box finishes, a click on the text
// edits in place, [빼기] removes, drag or ↑↓ reorders. iPad sessions may edit too. The section
// reads its own data (`…/agenda`) and again when shown, on focus and after an AI write.
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { api } from './gateway.ts';
import type { AgendaItem } from '../contracts/agenda.ts';
import {
  AGENDA_CHANGED,
  agendaWhen,
  dateLabel,
  isoDate,
  parseAgendaText,
  shortDate,
} from './agenda-text.ts';

const reasons: Record<string, string> = {
  REVISION_CONFLICT: '다른 화면에서 바뀌어 최신 목록을 다시 읽었습니다.',
  NOT_FOUND: '이미 빠진 할 일이라 최신 목록을 다시 읽었습니다.',
  AGENDA_LIMIT: '할 일이 너무 많습니다. 완료한 것을 비운 뒤 더하세요.',
  INVALID_INPUT: '내용을 확인하세요.',
};
const todayLabel = (at: Date) =>
  at.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });

/** Fields as the edit form holds them ('' for none). */
interface Fields {
  text: string;
  date: string;
  time: string;
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
});
const editOf = (entry: AgendaItem): Edit => ({
  id: entry.id,
  revision: entry.revision,
  ...fieldsOf(entry),
  from: fieldsOf(entry),
});

export function AgendaToday({ projectId, shown }: { projectId: string; shown: number }) {
  const [items, setItems] = useState<AgendaItem[] | undefined>();
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [edit, setEdit] = useState<Edit | undefined>();
  const [showDone, setShowDone] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | undefined>();
  const base = `/projects/${encodeURIComponent(projectId)}/agenda`;
  const now = new Date();
  const today = isoDate(now);

  const load = useCallback(
    () =>
      api(base)
        .then((value) => {
          setItems((value as { items: AgendaItem[] }).items);
          setFailed(false);
        })
        .catch(() => setFailed(true)),
    [base],
  );
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
      const next = (await api(path, method, data)) as { items: AgendaItem[] };
      setItems(next.items);
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
  const adding = useRef<Promise<unknown>>(Promise.resolve());
  const add = () => {
    if (!draft.trim()) return;
    const typed = draft;
    setDraft('');
    adding.current = adding.current.then(async () => {
      if ((await write(base, 'POST', parseAgendaText(typed, new Date()))) !== true)
        setDraft((now) => now || typed);
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
          },
    );
  };

  const open = items?.filter((entry) => !entry.done) ?? [];
  const current = open.filter((entry) => agendaWhen(entry, today) !== 'later');
  const later = open
    .filter((entry) => agendaWhen(entry, today) === 'later')
    .sort((a, b) => `${a.date} ${a.time ?? '99'}`.localeCompare(`${b.date} ${b.time ?? '99'}`));
  const done = (items?.filter((entry) => entry.done) ?? []).sort((a, b) =>
    (b.doneAt ?? '').localeCompare(a.doneAt ?? ''),
  );
  /** Moves one item of the 오늘 list to another place and saves the order of that list. */
  const move = (id: string, to: number) => {
    const ids = current.map((entry) => entry.id);
    const from = ids.indexOf(id);
    if (from < 0 || to < 0 || to >= ids.length || from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void write(`${base}/order`, 'POST', { ids });
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
        draggable={reorder && !editing}
        onDragStart={(event: DragEvent) => {
          if (!reorder) return;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', entry.id);
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

  const preview = draft.trim() ? parseAgendaText(draft, now) : undefined;
  return (
    <section className="dash-section dash-agenda" aria-label="오늘">
      <div className="dash-section-head">
        <h3>오늘</h3>
        <span className="dash-agenda-day">{todayLabel(now)}</span>
      </div>
      <form
        className="dash-agenda-add"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          type="text"
          aria-label="할 일 추가"
          placeholder="할 일이나 일정 — 예: 내일 3시 구조 회의, 금요일 도면 제출"
          value={draft}
          maxLength={500}
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>
      {preview && (preview.date || preview.time) ? (
        <p className="dash-agenda-hint" aria-live="polite">
          {preview.date ? dateLabel(preview.date, today).replace(/^지남 · /, '') : ''}
          {preview.time ? ` ${preview.time}` : ''} · {preview.text}
        </p>
      ) : null}
      {reason ? (
        <p className="dash-folder-reason" role="alert">
          {reason}
        </p>
      ) : null}
      {failed ? (
        <p className="dash-empty">할 일을 읽지 못했습니다.</p>
      ) : !items ? (
        <p className="dash-empty">읽는 중…</p>
      ) : !current.length ? (
        <p className="dash-empty">
          {open.length ? '오늘 할 일은 다 했습니다.' : '할 일이 없습니다. 위 칸에 적고 Enter.'}
        </p>
      ) : (
        <ul className="dash-agenda-list" aria-label="오늘 할 일">
          {current.map((entry, index) => row(entry, index))}
        </ul>
      )}
      {later.length ? (
        <>
          <h4 className="dash-folder-sub">예정 {later.length}</h4>
          <ul className="dash-agenda-list" aria-label="예정">
            {later.map((entry) => row(entry))}
          </ul>
        </>
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
    </section>
  );
}

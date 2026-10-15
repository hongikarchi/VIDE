import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AgendaItem } from '../contracts/agenda.ts';
import { api } from './gateway.ts';
import { isoDate, monthOf } from './agenda-text.ts';
import { AgendaCalendar, type CalendarAnchor } from './dashboard-calendar.tsx';
import {
  AgendaForm,
  blankFields,
  changedFields,
  createBody,
  fieldsOf,
  type AgendaFields,
} from './dashboard-agenda-form.tsx';
import './dashboard.css';

/**
 * 일정 노트 (SPEC-10.9 4, Design SCR-23): the project's 할 일·일정 items as the dashboard's month
 * calendar (SCR-20), in the notes screen. No new data: the same items and the same rules (a day
 * or its [+] adds, an item opens its form, a drag moves it). Nothing is typed into a note body.
 */
type Open =
  | { mode: 'add'; date: string; fields: AgendaFields }
  | { mode: 'edit'; item: AgendaItem; fields: AgendaFields };

export function ScheduleView({ projectId }: { projectId: string }) {
  const base = `/projects/${encodeURIComponent(projectId)}/agenda`;
  const today = isoDate(new Date());
  const [items, setItems] = useState<AgendaItem[] | null>(null);
  const [month, setMonth] = useState(monthOf(today));
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Open | undefined>();
  const [problem, setProblem] = useState('');
  const load = useCallback(async () => {
    try {
      setItems(((await api(base)) as { items: AgendaItem[] }).items);
    } catch {
      setProblem('할 일·일정을 읽지 못했습니다.');
    }
  }, [base]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);
  /** One write; any refusal reloads the list (another screen changed it meanwhile). */
  const write = async (path: string, method: string, data: unknown) => {
    setBusy(true);
    setProblem('');
    try {
      await api(path, method, data);
      return true;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      setProblem(
        code === 'REVISION_CONFLICT' || code === 'NOT_FOUND'
          ? '다른 화면에서 바뀌어 최신 일정을 다시 읽었습니다.'
          : '일정을 바꾸지 못했습니다.',
      );
      return false;
    } finally {
      setBusy(false);
      void load();
    }
  };
  const item = (id: string) => `${base}/${encodeURIComponent(id)}`;
  const submit = async () => {
    if (!open) return;
    if (open.mode === 'add') {
      if (!open.fields.text.trim()) return;
      if (await write(base, 'POST', createBody(open.fields))) setOpen(undefined);
      return;
    }
    const changed = changedFields(open.fields, fieldsOf(open.item));
    if (!Object.keys(changed).length) return setOpen(undefined);
    await write(item(open.item.id), 'PUT', { revision: open.item.revision, ...changed });
    setOpen(undefined);
  };
  const form: { anchor: CalendarAnchor; content: ReactNode } | undefined = open
    ? {
        anchor: open.mode === 'add' ? `day:${open.date}` : `item:${open.item.id}`,
        content: (
          <AgendaForm
            key={open.mode === 'add' ? `day:${open.date}` : `item:${open.item.id}`}
            variant="popover"
            fields={open.fields}
            busy={busy}
            submitLabel={open.mode === 'add' ? '추가' : '저장'}
            author={open.mode === 'edit' ? open.item : undefined}
            onChange={(fields) => setOpen({ ...open, fields })}
            onSubmit={() => void submit()}
            onCancel={() => setOpen(undefined)}
            onRemove={
              open.mode === 'edit'
                ? () =>
                    void write(`${item(open.item.id)}/remove`, 'POST', {
                      revision: open.item.revision,
                    }).then(() => setOpen(undefined))
                : undefined
            }
            onClearDate={
              open.mode === 'edit'
                ? () =>
                    void write(item(open.item.id), 'PUT', {
                      revision: open.item.revision,
                      date: null,
                    }).then(() => setOpen(undefined))
                : undefined
            }
          />
        ),
      }
    : undefined;
  return (
    <section className="note-open notes-schedule" aria-label="일정">
      <header className="note-head">
        <h2 className="note-title notes-schedule-title">일정</h2>
        <p className="note-tip">
          대시보드의 일정과 같은 할 일·일정 항목입니다. 날짜를 누르면 더하고, 항목을 누르면
          고칩니다.
        </p>
        {problem ? (
          <p className="note-message" role="status">
            {problem}
          </p>
        ) : null}
      </header>
      {items === null ? (
        <p className="notes-empty">불러오는 중…</p>
      ) : (
        <AgendaCalendar
          items={items}
          today={today}
          month={month}
          busy={busy}
          onMonth={setMonth}
          onPick={(date) => setOpen({ mode: 'add', date, fields: blankFields(date) })}
          onOpen={(entry) => setOpen({ mode: 'edit', item: entry, fields: fieldsOf(entry) })}
          onMove={(entry, date) =>
            void write(item(entry.id), 'PUT', { revision: entry.revision, date })
          }
          form={form}
          onClose={() => setOpen(undefined)}
        />
      )}
    </section>
  );
}

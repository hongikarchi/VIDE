import { randomUUID } from 'node:crypto';
import {
  agendaCreateSchema,
  agendaItemSchema,
  agendaOrderSchema,
  agendaUpdateSchema,
  dayLogEntrySchema,
  dayLogQuerySchema,
  type AgendaChange,
  type AgendaItem,
  type DayLogDone,
  type DayLogEntry,
} from '../contracts/agenda.ts';
import { DomainError, type Store } from './store.ts';

/**
 * A project's 할 일 (SPEC-01.14, ARCH-01 §3 「대시보드의 할 일」, schema 7–8, 11). Edits carry the
 * revision read last (REVISION_CONFLICT otherwise, like table-views.ts); reordering changes only
 * `ord`. Data access only: who may write is the server's.
 */
const pad = (n: number) => String(n).padStart(2, '0');
/** The PC's local date, 'YYYY-MM-DD'. */
export const localDate = (at = new Date()) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/** The day `days` after a 'YYYY-MM-DD' (before it when negative). */
const shiftDate = (value: string, days: number) => {
  const [y, m, d] = value.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + days));
};
const dayNumber = (value: string) => {
  const [y, m, d] = value.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};
const minutesOf = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
const clockOf = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
/** 위치 and 참석자: trimmed, and empty is none. */
const freeText = (value: string | null | undefined) => value?.trim() || null;
interface Span {
  date: string | null;
  time: string | null;
  endDate: string | null;
  endTime: string | null;
}
/**
 * The rules of a period (SPEC-01.14 1·4, ARCH-01 §3): a time without a date is today's; no date,
 * no times and no end day; no start time, no end time; an end day equal to the start is none; the
 * end never before the start (INVALID_INPUT).
 */
function settle(span: Span, today: string): Span {
  let { date, endDate, endTime } = span;
  const { time } = span;
  if (time && !date) date = today;
  if (!date) return { date: null, time: null, endDate: null, endTime: null };
  if (!time) endTime = null;
  if (endDate === date) endDate = null;
  if (endDate && endDate < date) throw new DomainError('INVALID_INPUT');
  if (endTime && !endDate && time && endTime <= time) throw new DomainError('INVALID_INPUT');
  return { date, time, endDate, endTime };
}

const decode = (row: Record<string, unknown>): AgendaItem =>
  agendaItemSchema.parse({
    id: row.id,
    text: row.text,
    date: row.date ?? null,
    time: row.time ?? null,
    endDate: row.endDate ?? null,
    endTime: row.endTime ?? null,
    kind: row.kind ?? 'task',
    location: row.location ?? null,
    attendees: row.attendees ?? null,
    done: row.doneAt != null,
    doneAt: row.doneAt ?? null,
    order: row.ord,
    source: row.source,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
const decodeLog = (row: Record<string, unknown>): DayLogEntry =>
  dayLogEntrySchema.parse({ ...row, body: JSON.parse(String(row.body)) });
/** The one line a day-end entry reads as: '2026-10-06 · 완료 3 · 도면 정리, 회의록 검토'. */
export const dayEndLine = (date: string, done: readonly DayLogDone[]) =>
  `${date} · 완료 ${done.length}` +
  (done.length ? ` · ${done.map((item) => item.text).join(', ')}` : '');
function parsed<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: unknown,
) {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError('INVALID_INPUT');
  return result.data as T;
}

export class Agenda {
  private readonly store: Store;
  private readonly now: () => Date;
  constructor(store: Store, { now = () => new Date() }: { now?: () => Date } = {}) {
    this.store = store;
    this.now = now;
  }
  /** Every item of the project in the user's order (open and done). */
  list(projectId: string): AgendaItem[] {
    this.store.project(projectId);
    return this.store
      .db(projectId)
      .prepare('SELECT * FROM agenda_items WHERE projectId=? ORDER BY ord, createdAt, id')
      .all(projectId)
      .map((row) => decode(row as Record<string, unknown>));
  }
  get(projectId: string, id: string): AgendaItem {
    this.store.project(projectId);
    const row = this.store
      .db(projectId)
      .prepare('SELECT * FROM agenda_items WHERE projectId=? AND id=?')
      .get(projectId, id);
    if (!row) throw new DomainError('NOT_FOUND');
    return decode(row as Record<string, unknown>);
  }
  /** Adds at the end of the order. A time without a date is today's. */
  add(projectId: string, value: unknown, source: 'user' | 'ai' = 'user'): AgendaItem {
    const input = parsed(agendaCreateSchema, value);
    this.store.project(projectId);
    return this.store.tx(this.store.db(projectId), () => {
      const count = this.store
        .db(projectId)
        .prepare('SELECT count(*) AS n, max(ord) AS last FROM agenda_items WHERE projectId=?')
        .get(projectId) as { n: number; last: number | null };
      // No item count cap (ADR-031 7).
      const id = randomUUID(),
        at = this.now().toISOString();
      const span = settle(
        {
          date: input.date ?? null,
          time: input.time ?? null,
          endDate: input.endDate ?? null,
          endTime: input.endTime ?? null,
        },
        localDate(this.now()),
      );
      this.store
        .db(projectId)
        .prepare(
          'INSERT INTO agenda_items(id,projectId,text,date,time,doneAt,ord,source,revision,createdAt,updatedAt,kind,endDate,endTime,location,attendees) VALUES(?,?,?,?,?,NULL,?,?,1,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          projectId,
          input.text.trim(),
          span.date,
          span.time,
          (count.last ?? 0) + 1,
          source,
          at,
          at,
          input.kind ?? 'task',
          span.endDate,
          span.endTime,
          freeText(input.location),
          freeText(input.attendees),
        );
      return this.get(projectId, id);
    });
  }
  /**
   * Changes the fields given; a stale revision is REVISION_CONFLICT. Clearing the date clears the
   * times and the end day. A new start day alone moves the end day with it (the period is kept), a
   * new start time alone moves the end time with it (cleared when it would pass midnight).
   */
  set(projectId: string, id: string, value: unknown): AgendaItem {
    const input = parsed(agendaUpdateSchema, value);
    return this.store.tx(this.store.db(projectId), () => {
      const before = this.get(projectId, id);
      if (input.revision !== before.revision) throw new DomainError('REVISION_CONFLICT');
      const date = input.date === undefined ? before.date : input.date;
      const time = input.time !== undefined ? input.time : input.date === null ? null : before.time;
      let endDate = input.endDate === undefined ? before.endDate : input.endDate;
      let endTime = input.endTime === undefined ? before.endTime : input.endTime;
      if (input.endDate === undefined && before.endDate && before.date && date)
        endDate = shiftDate(before.endDate, dayNumber(date) - dayNumber(before.date));
      if (input.endTime === undefined && before.endTime && before.time && time && !endDate) {
        const end = minutesOf(time) + minutesOf(before.endTime) - minutesOf(before.time);
        endTime = end < 24 * 60 ? clockOf(end) : null;
      }
      const span = settle({ date, time, endDate, endTime }, localDate(this.now()));
      const at = this.now().toISOString();
      const doneAt =
        input.done === undefined ? before.doneAt : input.done ? (before.doneAt ?? at) : null;
      this.store
        .db(projectId)
        .prepare(
          'UPDATE agenda_items SET text=?,date=?,time=?,endDate=?,endTime=?,kind=?,location=?,attendees=?,doneAt=?,revision=revision+1,updatedAt=? WHERE projectId=? AND id=?',
        )
        .run(
          input.text?.trim() ?? before.text,
          span.date,
          span.time,
          span.endDate,
          span.endTime,
          input.kind ?? before.kind,
          input.location === undefined ? before.location : freeText(input.location),
          input.attendees === undefined ? before.attendees : freeText(input.attendees),
          doneAt,
          at,
          projectId,
          id,
        );
      return this.get(projectId, id);
    });
  }
  /**
   * The given items take the places they already hold among themselves, in the given order, so
   * items not shown (later dates, done ones) keep theirs. Revisions do not change.
   */
  order(projectId: string, value: unknown): AgendaItem[] {
    const { ids } = parsed(agendaOrderSchema, value);
    if (new Set(ids).size !== ids.length) throw new DomainError('INVALID_INPUT');
    return this.store.tx(this.store.db(projectId), () => {
      const places = ids.map((id) => this.get(projectId, id).order).sort((a, b) => a - b);
      const update = this.store
        .db(projectId)
        .prepare('UPDATE agenda_items SET ord=? WHERE projectId=? AND id=?');
      ids.forEach((id, index) => update.run(places[index], projectId, id));
      return this.list(projectId);
    });
  }
  /** Removes one item; a revision, when given, must still be current. */
  remove(projectId: string, id: string, revision?: unknown) {
    const item = this.get(projectId, id);
    if (revision !== undefined && revision !== item.revision)
      throw new DomainError('REVISION_CONFLICT');
    this.store
      .db(projectId)
      .prepare('DELETE FROM agenda_items WHERE projectId=? AND id=?')
      .run(projectId, id);
    return this.list(projectId);
  }
  /** [완료 비우기]: removes every done item. */
  removeDone(projectId: string) {
    this.store.project(projectId);
    this.store
      .db(projectId)
      .prepare('DELETE FROM agenda_items WHERE projectId=? AND doneAt IS NOT NULL')
      .run(projectId);
    return this.list(projectId);
  }
  /**
   * Takes back what an AI write changed ([되돌리기]): an added item is removed, a changed one gets
   * its earlier text, date, time, kind (when recorded) and done state back. An item removed since, or changed or
   * finished after the write (its revision moved on, an added one too), is left as it is and
   * counted as skipped. The changes go newest first; an item a later change in the same list was
   * taken back on counts as being at the revision before that change (an add then a set of one
   * item, in one turn, both go back).
   */
  revert(projectId: string, changes: readonly AgendaChange[]) {
    this.store.project(projectId);
    return this.store.tx(this.store.db(projectId), () => {
      let reverted = 0,
        skipped = 0;
      const rewound = new Map<string, number>();
      for (const change of [...changes].reverse()) {
        const row = this.store
          .db(projectId)
          .prepare('SELECT revision FROM agenda_items WHERE projectId=? AND id=?')
          .get(projectId, change.id) as { revision: number } | undefined;
        if (!row || (rewound.get(change.id) ?? row.revision) !== change.revision) {
          skipped++;
          continue;
        }
        if (change.op === 'add') {
          this.store
            .db(projectId)
            .prepare('DELETE FROM agenda_items WHERE projectId=? AND id=?')
            .run(projectId, change.id);
          reverted++;
        } else {
          const { text, date, time, doneAt, kind } = change.before;
          // The fields recorded from schema 11 on go back too; an older record leaves them.
          const later = (['endDate', 'endTime', 'location', 'attendees'] as const).filter(
            (key) => change.before[key] !== undefined,
          );
          this.store
            .db(projectId)
            .prepare(
              `UPDATE agenda_items SET text=?,date=?,time=?,kind=coalesce(?,kind),doneAt=?,${later
                .map((key) => `${key}=?,`)
                .join('')}revision=revision+1,updatedAt=? WHERE projectId=? AND id=?`,
            )
            .run(
              text,
              date,
              time,
              kind ?? null,
              doneAt,
              ...later.map((key) => change.before[key] ?? null),
              this.now().toISOString(),
              projectId,
              change.id,
            );
          rewound.set(change.id, change.revision - 1);
          reverted++;
        }
      }
      return { reverted, skipped, items: this.list(projectId) };
    });
  }
  /**
   * 퇴근하기 (SPEC-01.14 10): the items finished today (their doneAt falls on this PC's local
   * today) leave the list, and the day's 'day-end' entry of the day log gets them and its one-line
   * summary again. Done again the same day, the entry grows. Items finished on an earlier day stay.
   */
  dayEnd(projectId: string): { entry: DayLogEntry; items: AgendaItem[] } {
    this.store.project(projectId);
    const db = this.store.db(projectId);
    const read = () =>
      db
        .prepare("SELECT * FROM day_log WHERE projectId=? AND date=? AND kind='day-end'")
        .get(projectId, localDate(this.now())) as Record<string, unknown> | undefined;
    return this.store.tx(db, () => {
      const today = localDate(this.now());
      const finished = this.list(projectId).filter(
        (item) => item.doneAt && localDate(new Date(item.doneAt)) === today,
      );
      const row = read();
      const before = row ? decodeLog(row) : undefined;
      const done: DayLogDone[] = [
        ...(before?.body.done ?? []),
        ...finished.map(({ id, text, kind, date, time, doneAt, source }) => ({
          id,
          text,
          kind,
          date,
          time,
          doneAt,
          source,
        })),
      ];
      const at = this.now().toISOString();
      const body = JSON.stringify({ ...(before?.body ?? {}), done });
      if (before)
        db.prepare('UPDATE day_log SET text=?, body=?, updatedAt=? WHERE id=?').run(
          dayEndLine(today, done),
          body,
          at,
          before.id,
        );
      else
        db.prepare(
          'INSERT INTO day_log(id,projectId,date,kind,text,body,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)',
        ).run(randomUUID(), projectId, today, 'day-end', dayEndLine(today, done), body, at, at);
      const remove = db.prepare('DELETE FROM agenda_items WHERE projectId=? AND id=?');
      for (const item of finished) remove.run(projectId, item.id);
      return { entry: decodeLog(read()!), items: this.list(projectId) };
    });
  }
  /** The day log, newest date first; `from`/`to` (inclusive) narrow it. */
  log(projectId: string, value: unknown = {}): DayLogEntry[] {
    const { from, to } = parsed(dayLogQuerySchema, value);
    this.store.project(projectId);
    return this.store
      .db(projectId)
      .prepare(
        'SELECT * FROM day_log WHERE projectId=? AND date>=? AND date<=? ORDER BY date DESC, kind',
      )
      .all(projectId, from ?? '0000-00-00', to ?? '9999-99-99')
      .map((row) => decodeLog(row as Record<string, unknown>));
  }
}

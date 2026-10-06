import { z } from 'zod';

/**
 * A project's 할 일 (SPEC-01.14, ARCH-01 §3 「대시보드의 할 일」, schema 7–8, 11): one list per
 * project. A dated item shows on the calendar; one with no start time is all day. `endDate` (after
 * `date`) makes it span several days, `endTime` (after `time` on the same day) gives a time range.
 * Its kind is '할 일', '협의', '접수' or '마감' (task | meeting | receipt | deadline; `meeting` kept
 * its id when '회의' became '협의', 2026-10-06). 협의 is an event with no done check; the others are
 * checked off. Dates and times are the PC's local calendar ('YYYY-MM-DD', 'HH:MM'), never UTC.
 */
export const agendaDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
  });
export const agendaTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const agendaKindSchema = z.enum(['task', 'meeting', 'receipt', 'deadline']);
export type AgendaKind = z.infer<typeof agendaKindSchema>;
export const AGENDA_TEXT_MAX = 500;
export const AGENDA_LOCATION_MAX = 200;
export const AGENDA_ATTENDEES_MAX = 300;
/** 위치 and 참석자 (free text; empty is none). */
const location = z.string().max(AGENDA_LOCATION_MAX);
const attendees = z.string().max(AGENDA_ATTENDEES_MAX);

const text = z
  .string()
  .max(AGENDA_TEXT_MAX)
  .refine((value) => Boolean(value.trim()));

export const agendaItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  date: agendaDateSchema.nullable(),
  time: agendaTimeSchema.nullable(),
  /** The last day of an item over several days (after `date`); null: one day. */
  endDate: agendaDateSchema.nullable(),
  /** The end of its time range (after `time` on the same day); null: no range. */
  endTime: agendaTimeSchema.nullable(),
  kind: agendaKindSchema,
  location: z.string().nullable(),
  attendees: z.string().nullable(),
  done: z.boolean(),
  doneAt: z.string().nullable(),
  /** Position in the user's order (smaller first); only its order means anything. */
  order: z.number(),
  source: z.enum(['user', 'ai']),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgendaItem = z.infer<typeof agendaItemSchema>;

/** `POST …/agenda`: a time without a date is today's; no kind is 'task'. */
export const agendaCreateSchema = z
  .object({
    text,
    date: agendaDateSchema.nullable().optional(),
    time: agendaTimeSchema.nullable().optional(),
    endDate: agendaDateSchema.nullable().optional(),
    endTime: agendaTimeSchema.nullable().optional(),
    kind: agendaKindSchema.optional(),
    location: location.nullable().optional(),
    attendees: attendees.nullable().optional(),
  })
  .strict();
export type AgendaCreate = z.infer<typeof agendaCreateSchema>;

/** `PUT …/agenda/:id`: the revision read last; only the fields given change. */
export const agendaUpdateSchema = z
  .object({
    revision: z.number().int().positive(),
    text: text.optional(),
    date: agendaDateSchema.nullable().optional(),
    time: agendaTimeSchema.nullable().optional(),
    endDate: agendaDateSchema.nullable().optional(),
    endTime: agendaTimeSchema.nullable().optional(),
    kind: agendaKindSchema.optional(),
    location: location.nullable().optional(),
    attendees: attendees.nullable().optional(),
    done: z.boolean().optional(),
  })
  .strict();
export type AgendaUpdate = z.infer<typeof agendaUpdateSchema>;

/** `POST …/agenda/order`: the ids in their new order (the shown ones; others keep their place). */
export const agendaOrderSchema = z
  .object({ ids: z.array(z.string().min(1).max(100)).min(1) })
  .strict();

/**
 * `POST …/agenda/undo`: the ledger item an AI write recorded ([되돌리기]), or the items of one turn
 * (`ledgerIds`, in the order they were made) taken back together.
 */
export const agendaUndoSchema = z
  .object({
    conversationId: z.string().min(1).max(100),
    ledgerId: z.string().min(1).max(100).optional(),
    ledgerIds: z.array(z.string().min(1).max(100)).min(1).max(100).optional(),
  })
  .strict()
  .refine((input) => (input.ledgerId === undefined) !== (input.ledgerIds === undefined));

/** What an AI write changed, kept in its ledger item so [되돌리기] can take it back. */
export const agendaChangeSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    id: z.string(),
    text: z.string(),
    date: z.string().nullable(),
    time: z.string().nullable(),
    /** Recorded from schema 8 on; older records have none. */
    kind: agendaKindSchema.optional(),
    /** The revision the add left (1); an item changed since is not removed. */
    revision: z.number().int(),
  }),
  z.object({
    op: z.literal('set'),
    id: z.string(),
    text: z.string(),
    /** The revision the write left; a later edit by someone else is not undone. */
    revision: z.number().int(),
    before: z.object({
      text: z.string(),
      date: z.string().nullable(),
      time: z.string().nullable(),
      doneAt: z.string().nullable(),
      /** Recorded from schema 8 on; an older record leaves the kind as it is. */
      kind: agendaKindSchema.optional(),
      /** Recorded from schema 11 on; an older record leaves these as they are. */
      endDate: z.string().nullable().optional(),
      endTime: z.string().nullable().optional(),
      location: z.string().nullable().optional(),
      attendees: z.string().nullable().optional(),
    }),
  }),
]);
export type AgendaChange = z.infer<typeof agendaChangeSchema>;

/**
 * The project's day log (SPEC-01.14 10, ARCH-01 §3, schema 10): one entry per date and kind.
 * 퇴근하기 writes 'day-end' — a one-line summary and the items finished that day, taken off the
 * list. The shape is kept plain (date, kind, text, body) so a later shared-notes or work-journal
 * feature can read these entries and write its own kinds beside them.
 */
export const dayLogDoneSchema = z.object({
  id: z.string(),
  text: z.string(),
  kind: agendaKindSchema,
  date: z.string().nullable(),
  time: z.string().nullable(),
  doneAt: z.string().nullable(),
  source: z.enum(['user', 'ai']),
});
export type DayLogDone = z.infer<typeof dayLogDoneSchema>;
export const dayLogEntrySchema = z.object({
  id: z.string(),
  date: agendaDateSchema,
  kind: z.string(),
  /** '2026-10-06 · 완료 3 · 도면 정리, 회의록 검토, 구조 회의'. */
  text: z.string(),
  body: z.object({ done: z.array(dayLogDoneSchema) }).passthrough(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DayLogEntry = z.infer<typeof dayLogEntrySchema>;
/** `GET …/agenda/log?from=&to=`: both optional, inclusive. */
export const dayLogQuerySchema = z
  .object({ from: agendaDateSchema.optional(), to: agendaDateSchema.optional() })
  .strict();

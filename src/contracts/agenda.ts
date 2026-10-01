import { z } from 'zod';

/**
 * A project's 할 일 (SPEC-01.14, ARCH-01 §3 「대시보드의 할 일」, schema 7): one list per project.
 * An item with a time is shown as 일정 in the same list; there is no separate event kind. Dates
 * and times are the PC's local calendar ('YYYY-MM-DD', 'HH:MM'), never converted to UTC.
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
export const AGENDA_TEXT_MAX = 500;
/** Items one project keeps (open and done together). */
export const AGENDA_MAX_ITEMS = 1000;
const text = z
  .string()
  .max(AGENDA_TEXT_MAX)
  .refine((value) => Boolean(value.trim()));

export const agendaItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  date: agendaDateSchema.nullable(),
  time: agendaTimeSchema.nullable(),
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

/** `POST …/agenda`: a time without a date is today's. */
export const agendaCreateSchema = z
  .object({
    text,
    date: agendaDateSchema.nullable().optional(),
    time: agendaTimeSchema.nullable().optional(),
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
    done: z.boolean().optional(),
  })
  .strict();
export type AgendaUpdate = z.infer<typeof agendaUpdateSchema>;

/** `POST …/agenda/order`: the ids in their new order (the shown ones; others keep their place). */
export const agendaOrderSchema = z
  .object({ ids: z.array(z.string().min(1).max(100)).min(1).max(AGENDA_MAX_ITEMS) })
  .strict();

/** `POST …/agenda/undo`: the ledger item an AI write recorded ([되돌리기]). */
export const agendaUndoSchema = z
  .object({ conversationId: z.string().min(1).max(100), ledgerId: z.string().min(1).max(100) })
  .strict();

/** What an AI write changed, kept in its ledger item so [되돌리기] can take it back. */
export const agendaChangeSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    id: z.string(),
    text: z.string(),
    date: z.string().nullable(),
    time: z.string().nullable(),
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
    }),
  }),
]);
export type AgendaChange = z.infer<typeof agendaChangeSchema>;

import type { Agenda } from '../core/agenda.ts';
import { agendaChangeSchema, agendaUndoSchema } from '../contracts/agenda.ts';
import type { LedgerItem } from '../core/conversation-store.ts';
import { DomainError } from '../core/store.ts';
import { z } from 'zod';

/**
 * 대시보드의 할 일 (SPEC-01.14, ARCH-01 §3): `GET·POST …/agenda`, `PUT …/agenda/:id`,
 * `POST …/agenda/order`, `POST …/agenda/:id/remove`, `POST …/agenda/remove-done` and
 * `POST …/agenda/undo` (an AI write's [되돌리기]), `GET …/agenda/log` and `POST …/agenda/day-end`
 * (퇴근하기, the day log). Removing is a POST like the folders routes, so
 * the DELETE whitelist stays as it is. Remote sessions may use all of them (SPEC-01.14 5).
 */
export const agendaStatuses: Record<string, number> = { AGENDA_LIMIT: 409, AGENDA_UNDONE: 409 };

const changesOf = z.object({
  appAction: z.literal('agenda'),
  changes: z.array(agendaChangeSchema),
});

export async function agendaRoutes(
  url: URL,
  method: string | undefined,
  {
    agenda,
    body,
    send,
    ledger,
  }: {
    agenda: Agenda;
    body: () => Promise<Record<string, unknown>>;
    send: (status: number, value: unknown) => void;
    /** The conversation ledger: one item of a project's conversation, and recording the undo. */
    ledger: {
      item: (projectId: string, conversationId: string, ledgerId: string) => LedgerItem;
      undone: (
        projectId: string,
        conversationId: string,
        ledgerId: string,
        result: { reverted: number; skipped: number },
      ) => void;
    };
  },
) {
  const match = /^\/api\/v1\/projects\/([^/]+)\/agenda(?:\/([^/]+)(\/remove)?)?$/.exec(
    url.pathname,
  );
  if (!match) return false;
  const [, projectId, name, remove] = match;
  if (!name) {
    if (method === 'GET') send(200, { items: agenda.list(projectId) });
    else if (method === 'POST') {
      const item = agenda.add(projectId, await body());
      send(200, { item, items: agenda.list(projectId) });
    } else throw new DomainError('NOT_FOUND');
    return true;
  }
  // The day log and 퇴근하기 (SPEC-01.14 10, schema 10).
  if (method === 'GET' && name === 'log' && !remove) {
    const query: Record<string, string> = {};
    for (const key of ['from', 'to']) {
      const value = url.searchParams.get(key);
      if (value) query[key] = value;
    }
    send(200, { entries: agenda.log(projectId, query) });
  } else if (method === 'POST' && name === 'day-end' && !remove)
    send(200, agenda.dayEnd(projectId));
  else if (method === 'POST' && remove) {
    const input = await body();
    send(200, { items: agenda.remove(projectId, name, input.revision) });
  } else if (method === 'POST' && name === 'order')
    send(200, { items: agenda.order(projectId, await body()) });
  else if (method === 'POST' && name === 'remove-done')
    send(200, { items: agenda.removeDone(projectId) });
  else if (method === 'POST' && name === 'undo') {
    const input = agendaUndoSchema.safeParse(await body());
    if (!input.success) throw new DomainError('INVALID_INPUT');
    const { conversationId } = input.data;
    // One turn's writes go back together: their changes in the order made, reverted newest first.
    const writes = (input.data.ledgerIds ?? [input.data.ledgerId!]).map((ledgerId) => {
      const item = ledger.item(projectId, conversationId, ledgerId);
      const recorded = changesOf.safeParse(item.body);
      if (!recorded.success) throw new DomainError('NOT_FOUND');
      return {
        ledgerId,
        at: item.createdAt,
        undone: Boolean(item.supersededBy),
        changes: recorded.data.changes,
      };
    });
    writes.sort((a, b) => a.at.localeCompare(b.at));
    const open = writes.filter((write) => !write.undone);
    if (!open.length) throw new DomainError('AGENDA_UNDONE');
    const result = agenda.revert(
      projectId,
      open.flatMap((write) => write.changes),
    );
    for (const write of open)
      ledger.undone(projectId, conversationId, write.ledgerId, {
        reverted: result.reverted,
        skipped: result.skipped,
      });
    send(200, result);
  } else if (method === 'PUT' && !remove) {
    const item = agenda.set(projectId, name, await body());
    send(200, { item, items: agenda.list(projectId) });
  } else throw new DomainError('NOT_FOUND');
  return true;
}

import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type { Agenda } from '../core/agenda.ts';
import {
  agendaDateSchema,
  agendaKindSchema,
  agendaTimeSchema,
  AGENDA_ATTENDEES_MAX,
  AGENDA_LOCATION_MAX,
  AGENDA_TEXT_MAX,
} from '../contracts/agenda.ts';
import type { KnowledgeCollector } from '../knowledge/collect/collector.ts';

/**
 * 자료 정리 (SPEC-08.9, ARCH-01 §3 「자료 정리」) and 자료에서 찾은 할 일·일정 (SPEC-01.14 11):
 * `GET …/knowledge/collect` (state), `POST …/knowledge/collect` (start: the first collection or an
 * update) and `POST …/knowledge/collect/stop` — starting and stopping only at this PC; `GET
 * …/knowledge/collect/survey` (what a run reads and skips, T-261) and `POST
 * …/knowledge/collect/exclude {exclude}` (folders left out), also only at this PC; `GET
 * …/agenda-proposals`, `POST …/agenda-proposals/add {items}` (the picked ones, possibly edited, go
 * through the normal agenda add with `source: 'ai'`) and `POST …/agenda-proposals/dismiss {ids}`.
 */
export const collectStatuses: Record<string, number> = {
  NO_PROJECT_FOLDER: 409,
  AI_NOT_SIGNED_IN: 409,
  KNOWLEDGE_IS_COPY: 409,
};

const edited = z
  .object({
    id: z.number().int().positive(),
    text: z.string().max(AGENDA_TEXT_MAX).optional(),
    kind: agendaKindSchema.optional(),
    date: agendaDateSchema.nullable().optional(),
    time: agendaTimeSchema.nullable().optional(),
    endDate: agendaDateSchema.nullable().optional(),
    endTime: agendaTimeSchema.nullable().optional(),
    location: z.string().max(AGENDA_LOCATION_MAX).nullable().optional(),
    attendees: z.string().max(AGENDA_ATTENDEES_MAX).nullable().optional(),
  })
  .strict();
const addSchema = z.object({ items: z.array(edited).min(1).max(100) }).strict();
const excludeSchema = z.object({ exclude: z.array(z.string().min(1).max(1024)).max(200) }).strict();
const dismissSchema = z
  .object({ ids: z.array(z.number().int().positive()).min(1).max(500) })
  .strict();

export async function collectRoutes(
  url: URL,
  method: string | undefined,
  {
    collector,
    agenda,
    project,
    body,
    send,
    remote,
  }: {
    collector: KnowledgeCollector;
    agenda: Agenda;
    project: (projectId: string) => unknown;
    body: () => Promise<Record<string, unknown>>;
    send: (status: number, value: unknown) => void;
    remote: boolean;
  },
) {
  const match =
    /^\/api\/v1\/projects\/([^/]+)\/(?:knowledge\/collect(?:\/(stop|survey|exclude))?|agenda-proposals(?:\/(add|dismiss))?)$/.exec(
      url.pathname,
    );
  if (!match) return false;
  const [, projectId, sub, action] = match;
  const stop = sub === 'stop';
  project(projectId);
  const collect = url.pathname.includes('/knowledge/collect');
  if (collect && (sub === 'survey' || sub === 'exclude')) {
    // What a run would read and skip (T-261), and the folders left out: this PC's folders only.
    if (remote) throw new DomainError('FORBIDDEN');
    if (sub === 'survey' && method === 'GET') {
      send(200, await collector.survey(projectId));
      return true;
    }
    if (sub !== 'exclude' || method !== 'POST') return false;
    const { exclude } = excludeSchema.parse(await body());
    collector.setExclusions(projectId, exclude);
    send(200, await collector.survey(projectId));
    return true;
  }
  if (collect) {
    if (method === 'GET' && !stop) {
      send(200, collector.status(projectId));
      return true;
    }
    if (method !== 'POST') return false;
    // The folders are this PC's, and a run uses its CPU and AI subscription (SPEC-08.9 1).
    if (remote) throw new DomainError('FORBIDDEN');
    send(200, stop ? collector.stop(projectId) : await collector.start(projectId));
    return true;
  }
  if (method === 'GET' && !action) {
    send(200, { proposals: collector.proposals(projectId) });
    return true;
  }
  if (method !== 'POST' || !action) return false;
  if (action === 'dismiss') {
    const { ids } = dismissSchema.parse(await body());
    collector.decide(
      projectId,
      ids.map((id) => ({ id, status: 'dismissed' as const })),
    );
    send(200, { proposals: collector.proposals(projectId) });
    return true;
  }
  const { items } = addSchema.parse(await body());
  const pending = new Map(collector.proposals(projectId).map((p) => [p.id, p]));
  let added = 0;
  for (const item of items) {
    const proposal = pending.get(item.id);
    if (!proposal) continue;
    const { id: _id, ...changes } = item;
    const value = {
      text: proposal.text,
      kind: proposal.kind,
      date: proposal.date,
      time: proposal.time,
      endDate: proposal.endDate,
      endTime: proposal.endTime,
      location: proposal.location,
      attendees: proposal.attendees,
      ...changes,
    };
    const made = agenda.add(projectId, value, 'ai');
    collector.decide(projectId, [{ id: proposal.id, status: 'added', agendaId: made.id }]);
    added++;
  }
  send(200, {
    added,
    items: agenda.list(projectId),
    proposals: collector.proposals(projectId),
  });
  return true;
}

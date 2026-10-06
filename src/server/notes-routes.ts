import type { IncomingMessage, ServerResponse } from 'node:http';
import { DomainError } from '../core/store.ts';
import type { SharedNotes } from './shared-notes.ts';

/**
 * 노트·일지 on the PC (SPEC-10, ARCH-01 §6 「공유 노트」). The engine is a member of the site
 * through its host key; these routes are the PC screen's (local or remote session):
 *  `GET|POST …/notes`, `POST …/notes/journal {date?}`, `POST …/notes/journal/append {text, date?}`
 *  (the day summary of [퇴근하기]), `POST …/notes/agenda-from-text {text}` (check-list items →
 *  할 일), `PUT …/notes/:id {title?, kind?}`, `POST …/notes/:id/remove`, `POST …/notes/:id/to-agenda`,
 *  `GET …/notes/:id/stream?client=` (Server-Sent Events: sync, update, awareness, status) and
 *  `POST …/notes/:id/updates {client, update?, awareness?}` (base64 Yjs and awareness updates).
 * Removing is a POST like the agenda's, so the DELETE whitelist stays as it is.
 */
export const notesStatuses: Record<string, number> = {
  ACCOUNT_NOT_LINKED: 409,
  SITE_UNREACHABLE: 503,
  SITE_ERROR: 502,
  NOTE_NOT_FOUND: 404,
  NOTE_OWNER_REQUIRED: 403,
  NOTES_NOT_CONFIGURED: 503,
  INVALID_KIND: 400,
  INVALID_DATE: 400,
};
const CLIENT = /^[A-Za-z0-9_-]{8,64}$/;

export async function notesRoutes(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  {
    notes,
    project,
    user,
    body,
    send,
  }: {
    notes: SharedNotes | undefined;
    project: (projectId: string) => unknown;
    user: () => Promise<string | undefined>;
    body: () => Promise<Record<string, unknown>>;
    send: (status: number, value: unknown) => void;
  },
) {
  const match =
    /^\/api\/v1\/projects\/([^/]+)\/notes(?:\/(journal\/append|journal|agenda-from-text|[0-9a-f-]{36})(?:\/(remove|to-agenda|stream|updates))?)?$/.exec(
      url.pathname,
    );
  if (!match) return false;
  const [, projectId, name, action] = match;
  project(projectId);
  if (!notes) throw new DomainError('NOT_FOUND');
  const method = request.method;
  if (!name) {
    if (method === 'GET') {
      const listed = await notes.list(projectId);
      send(200, { ...listed, user: (await user()) ?? '나' });
    } else if (method === 'POST') send(200, await notes.create(projectId, await body()));
    else throw new DomainError('NOT_FOUND');
    return true;
  }
  if (
    method !== 'POST' &&
    !(method === 'PUT' && !action) &&
    !(method === 'GET' && action === 'stream')
  )
    throw new DomainError('NOT_FOUND');
  if (name === 'journal' && !action) {
    const input = await body();
    send(
      200,
      await notes.journal(projectId, typeof input.date === 'string' ? input.date : undefined),
    );
  } else if (name === 'journal/append' && !action) {
    const input = await body();
    if (typeof input.text !== 'string') throw new DomainError('INVALID_INPUT');
    send(
      200,
      await notes.appendJournal(
        projectId,
        input.text,
        typeof input.date === 'string' ? input.date : undefined,
      ),
    );
  } else if (name === 'agenda-from-text' && !action) {
    const input = await body();
    if (typeof input.text !== 'string' || input.text.length > 200_000)
      throw new DomainError('INVALID_INPUT');
    const result = notes.agendaFromText(projectId, input.text);
    send(200, { added: result.added.length, skipped: result.skipped.length, items: result.added });
  } else if (!action && method === 'PUT')
    send(200, await notes.update(projectId, name, await body()));
  else if (action === 'remove') send(200, await notes.remove(projectId, name));
  else if (action === 'to-agenda') {
    const result = await notes.toAgenda(projectId, name);
    send(200, { added: result.added.length, skipped: result.skipped.length, items: result.added });
  } else if (action === 'updates') {
    const input = await body();
    if (typeof input.client !== 'string' || !CLIENT.test(input.client))
      throw new DomainError('INVALID_INPUT');
    send(200, await notes.receive(projectId, name, input.client, input));
  } else if (action === 'stream') {
    const client = url.searchParams.get('client') ?? '';
    if (!CLIENT.test(client)) throw new DomainError('INVALID_INPUT');
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    const stop = await notes.stream(projectId, name, client, (event) =>
      response.write(`data: ${JSON.stringify(event)}\n\n`),
    );
    // A comment line keeps proxies (the tunnel, the site relay) from closing an idle stream.
    const keep = setInterval(() => response.write(': keep\n\n'), 20_000);
    keep.unref?.();
    // The response closes when the screen goes away (a GET request's own 'close' comes at once).
    response.on('close', () => {
      clearInterval(keep);
      stop();
    });
  } else throw new DomainError('NOT_FOUND');
  return true;
}

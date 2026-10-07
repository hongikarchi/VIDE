import type { FinishLibrary } from '../contracts/finish.ts';
import type { FinishStore } from '../core/finish-store.ts';
import { DomainError } from '../core/store.ts';

/**
 * 마감 일람표 jig (SPEC-11, PLAN-43 T-198): `GET /api/v1/finish/library` (the official library
 * `vide/finish-codes`, the same for every project), `GET …/projects/:id/finish` (rooms and sheet),
 * `PUT …/finish/rooms {rooms}` and `PUT …/finish/sheet {adopted, thk, notes, title}` (each replaces
 * the whole part; a list breaking a room rule is refused whole). Remote sessions may read and
 * edit: nothing here touches a host document (SPEC-11.6).
 */
export const finishStatuses: Record<string, number> = { FINISH_CODE_INVALID: 422 };

let loaded: Promise<FinishLibrary> | undefined;
/** The library, loaded on first use (about 0.4 MB of JSON). */
export function finishLibraryData(): Promise<FinishLibrary> {
  loaded ??= import('../jigs/official/finish-codes/index.ts').then((module) =>
    module.finishLibrary(),
  );
  return loaded;
}

export async function finishRoutes(
  url: URL,
  method: string | undefined,
  {
    finish,
    body,
    send,
  }: {
    finish: FinishStore;
    body: () => Promise<Record<string, unknown>>;
    send: (status: number, value: unknown) => void;
  },
) {
  if (url.pathname === '/api/v1/finish/library') {
    if (method !== 'GET') throw new DomainError('NOT_FOUND');
    send(200, await finishLibraryData());
    return true;
  }
  const match = /^\/api\/v1\/projects\/([^/]+)\/finish(?:\/(rooms|sheet))?$/.exec(url.pathname);
  if (!match) return false;
  const [, projectId, part] = match;
  if (!part && method === 'GET') send(200, finish.state(projectId));
  else if (part === 'rooms' && method === 'PUT')
    send(200, finish.saveRooms(projectId, await body(), await finishLibraryData()));
  else if (part === 'sheet' && method === 'PUT')
    send(200, finish.saveSheet(projectId, await body(), await finishLibraryData()));
  else throw new DomainError('NOT_FOUND');
  return true;
}

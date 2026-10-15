import { DatabaseSync } from 'node:sqlite';
import type { Store } from '../core/store.ts';
import { DomainError } from '../contracts/errors.ts';
import { Records, RecordRefusal } from '../core/records.ts';
import {
  RECORD_SOURCES,
  RECORD_STATES,
  RECORD_TYPES,
  recordImportSchema,
  recordInputSchema,
  recordPatchSchema,
  recordLinkInputSchema,
  recordStateInputSchema,
  recordStatesInputSchema,
  recordTypeSchema,
  type RecordFilters,
  type RecordSource,
  type RecordState,
  type RecordType,
} from '../contracts/records.ts';

/**
 * 프로젝트 기록 (SPEC-17, ARCH-01 §5 「프로젝트 기록(PLAN-53, SPEC-17)」, T-321): the records list,
 * one record, a person's record, edits, corrections, O/X, follows links, chains, the o/x/. and
 * JSONL exports and the marks import, the 부위 사전 and milestones — all under
 * `/api/v1/projects/:p/`. A remote session reads only (SPEC-17.6). `GET …/parts/status` and
 * `GET …/objects/:o/records` answer when their deps are given (T-324/T-325).
 */
export const recordsStatuses: Record<string, number> = {
  RECORD_NOT_FOUND: 404,
  PART_NOT_FOUND: 404,
  MILESTONE_NOT_FOUND: 404,
  RECORD_LINK_CYCLE: 409,
  RECORD_SOURCE_DUPLICATE: 409,
  RECORD_SUPERSEDED: 409,
  RECORD_MARKS_MISMATCH: 409,
  RECORD_AI_FORBIDDEN: 403,
  INPUT_TOO_LARGE: 413,
  // 기록 사본 (T-331): the same value as `workspace-routes.ts`.
  NO_WORKSPACE: 404,
};

export interface RecordsRouteDeps {
  records: Records;
  /** Throws NOT_FOUND for an unknown project. */
  project: (projectId: string) => unknown;
  body: () => Promise<Record<string, unknown>>;
  send: (status: number, value: unknown) => void;
  /** A text answer (the JSONL export). */
  deliver: (status: number, contentType: string, payload: string) => void;
  /** A remote session: reads only. */
  remote: boolean;
  /** The session account's display name, if known ('user' otherwise). */
  actor?: () => string | undefined;
  /** `GET …/parts/status` → `{parts: PartStatus[]}` (T-325). */
  partsStatus?: (projectId: string) => Promise<unknown>;
  /** `GET …/objects/:o/records?linkId=` → `{records, via}` (T-324). */
  objectRecords?: (projectId: string, objectId: string, linkId?: string) => Promise<unknown>;
  /** `POST …/records/import-file {kind, name, text}` (T-329·T-330, `records-import.ts`). */
  importFile?: (projectId: string, input: unknown, by: string) => Promise<unknown>;
  /** `…/records/mirror[/import|rewrite]` — the work-folder copy (T-331, `records-mirror.ts`). */
  mirror?: {
    status(projectId: string, options?: { flush?: boolean }): Promise<unknown>;
    importFolder(projectId: string, by: string): Promise<unknown>;
    rewrite(projectId: string): Promise<unknown>;
  };
}

/**
 * Whether every execution of a request was undone (`result.executions[].state`), read from the
 * stored row without expanding its geometry. No executions → false.
 */
export function requestUndone(source: Store | DatabaseSync) {
  return (projectId: string, requestId: string): boolean => {
    const db = source instanceof DatabaseSync ? source : source.db(projectId);
    const row = db
      .prepare(
        `SELECT json_extract(result, '$.executions') AS e FROM workspace_requests
          WHERE projectId=? AND id=? AND json_valid(result)`,
      )
      .get(projectId, requestId);
    if (!row || typeof row.e !== 'string') return false;
    const executions = JSON.parse(row.e) as unknown;
    return (
      Array.isArray(executions) &&
      executions.length > 0 &&
      executions.every(
        (execution) =>
          execution &&
          typeof execution === 'object' &&
          (execution as { state?: unknown }).state === 'undone',
      )
    );
  };
}

const commaList = <T extends string>(value: string | null, allowed: readonly T[]) => {
  if (!value) return undefined;
  const list = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of list) if (!allowed.includes(item as T)) throw new DomainError('INVALID_INPUT');
  return list.length ? (list as T[]) : undefined;
};
const count = (value: string | null) => {
  if (value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new DomainError('INVALID_INPUT');
  return number;
};
/** The list filters of `GET …/records` (and the exports). */
export function recordFiltersOf(params: URLSearchParams): RecordFilters {
  const filters: RecordFilters = {};
  const state = commaList<RecordState>(params.get('state'), RECORD_STATES);
  const type = commaList<RecordType>(params.get('type'), RECORD_TYPES);
  const source = commaList<RecordSource>(params.get('source'), RECORD_SOURCES);
  if (state) filters.state = state;
  if (type) filters.type = type;
  if (source) filters.source = source;
  for (const key of ['part', 'chapter', 'from', 'to', 'q'] as const) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  const limit = count(params.get('limit'));
  const offset = count(params.get('offset'));
  if (limit !== undefined) filters.limit = Math.min(limit, 10_000);
  if (offset !== undefined) filters.offset = offset;
  return filters;
}

const ROUTE = /^\/api\/v1\/projects\/([^/]+)\/(records|parts|milestones|objects)(?:\/(.*))?$/;

export async function recordsRoutes(
  url: URL,
  method: string | undefined,
  deps: RecordsRouteDeps,
): Promise<boolean> {
  const match = ROUTE.exec(url.pathname);
  if (!match) return false;
  const projectId = decodeURIComponent(match[1]!);
  const kind = match[2]!;
  const rest = (match[3] ?? '').split('/').filter(Boolean).map(decodeURIComponent);
  // `…/objects/:o/records` only; every other objects path belongs to someone else.
  if (kind === 'objects' && !(rest.length === 2 && rest[1] === 'records')) return false;
  if (kind === 'objects' && !deps.objectRecords) return false;
  const { records, send } = deps;
  const write = method !== 'GET';
  const by = () => deps.actor?.()?.trim() || 'user';
  try {
    deps.project(projectId);
    if (write && deps.remote) throw new DomainError('FORBIDDEN');
    if (kind === 'objects') {
      if (method !== 'GET') throw new DomainError('NOT_FOUND');
      send(
        200,
        await deps.objectRecords!(projectId, rest[0]!, url.searchParams.get('linkId') || undefined),
      );
      return true;
    }
    if (kind === 'milestones') {
      if (!rest.length && method === 'GET')
        send(200, { milestones: records.milestones(projectId) });
      else if (!rest.length && method === 'POST')
        send(200, { milestone: records.addMilestone(projectId, await deps.body()) });
      else if (rest.length === 1 && method === 'DELETE')
        send(200, records.removeMilestone(projectId, rest[0]!));
      else throw new DomainError('NOT_FOUND');
      return true;
    }
    if (kind === 'parts') {
      if (!rest.length && method === 'GET') send(200, { parts: records.parts(projectId) });
      else if (!rest.length && method === 'POST')
        send(200, { part: records.addPart(projectId, await deps.body()) });
      else if (rest.length === 1 && rest[0] === 'status' && method === 'GET') {
        if (!deps.partsStatus) throw new DomainError('NOT_FOUND');
        send(200, await deps.partsStatus(projectId));
      } else if (rest.length === 1 && method === 'PUT')
        send(200, { part: records.setPart(projectId, rest[0]!, await deps.body()) });
      else if (rest.length === 1 && method === 'DELETE')
        send(200, records.removePart(projectId, rest[0]!));
      else throw new DomainError('NOT_FOUND');
      return true;
    }
    // records
    const [id, sub, extra] = rest;
    if (!id) {
      if (method === 'GET') send(200, records.list(projectId, recordFiltersOf(url.searchParams)));
      else if (method === 'POST') {
        const input = await deps.body();
        // A person's record names its type (R/I/K/E/D); '?' is for automatic candidates only.
        const parsed = recordInputSchema
          .extend({ type: recordTypeSchema.exclude(['?']) })
          .safeParse(input);
        if (!parsed.success) throw new DomainError('INVALID_INPUT');
        send(200, {
          record: records.add(projectId, parsed.data, {
            by: by(),
            state: 'kept',
            source: 'manual',
          }),
        });
      } else throw new DomainError('NOT_FOUND');
      return true;
    }
    if (rest.length === 1 && id === 'import-file' && method === 'POST') {
      if (!deps.importFile) throw new DomainError('NOT_FOUND');
      send(200, await deps.importFile(projectId, await deps.body(), by()));
      return true;
    }
    // 작업 폴더 사본 (T-331): before the `:r` paths. A remote session only reads the state.
    if (id === 'mirror' && deps.mirror && rest.length <= 2) {
      if (rest.length === 1 && method === 'GET')
        send(200, await deps.mirror.status(projectId, { flush: !deps.remote }));
      else if (sub === 'import' && method === 'POST')
        send(200, await deps.mirror.importFolder(projectId, by()));
      else if (sub === 'rewrite' && method === 'POST')
        send(200, await deps.mirror.rewrite(projectId));
      else throw new DomainError('NOT_FOUND');
      return true;
    }
    if (rest.length === 1 && id === 'state' && method === 'POST') {
      const input = recordStatesInputSchema.safeParse(await deps.body());
      if (!input.success) throw new DomainError('INVALID_INPUT');
      send(200, {
        changed: records.setStates(projectId, input.data.ids, input.data.state, by()),
      });
      return true;
    }
    if (rest.length === 1 && id === 'chains' && method === 'GET') {
      const state = commaList<RecordState>(url.searchParams.get('state'), RECORD_STATES);
      send(200, { chains: records.chains(projectId, state ? { state } : {}) });
      return true;
    }
    if (rest.length === 1 && id === 'export' && method === 'GET') {
      const format = url.searchParams.get('format') || 'marks';
      const filters = recordFiltersOf(url.searchParams);
      if (format === 'marks') send(200, records.exportMarks(projectId, filters));
      else if (format === 'jsonl')
        deps.deliver(200, 'text/plain; charset=utf-8', records.toJsonl(projectId, filters));
      else throw new DomainError('INVALID_INPUT');
      return true;
    }
    if (rest.length === 1 && id === 'import' && method === 'POST') {
      const input = recordImportSchema.safeParse(await deps.body());
      if (!input.success) throw new DomainError('INVALID_INPUT');
      send(200, {
        changed: records.importMarks(projectId, input.data.ids, input.data.marks, by()),
      });
      return true;
    }
    if (rest.length === 1) {
      if (method === 'GET') send(200, { record: records.get(projectId, id) });
      else if (method === 'PATCH') {
        const input = await deps.body();
        // As for POST: a person never sets a record back to '?' (automatic candidates only).
        const parsed = recordPatchSchema
          .extend({ type: recordTypeSchema.exclude(['?']).optional() })
          .safeParse(input);
        if (!parsed.success) throw new DomainError('INVALID_INPUT');
        send(200, { record: records.patch(projectId, id, parsed.data, by()) });
      } else throw new DomainError('NOT_FOUND');
      return true;
    }
    if (rest.length === 2 && sub === 'correct' && method === 'POST') {
      send(200, { record: records.correct(projectId, id, await deps.body(), by()) });
      return true;
    }
    if (rest.length === 2 && sub === 'state' && method === 'POST') {
      const input = recordStateInputSchema.safeParse(await deps.body());
      if (!input.success) throw new DomainError('INVALID_INPUT');
      send(200, { record: records.setState(projectId, id, input.data.state, by()) });
      return true;
    }
    if (rest.length === 2 && sub === 'links' && method === 'POST') {
      const input = recordLinkInputSchema.safeParse(await deps.body());
      if (!input.success) throw new DomainError('INVALID_INPUT');
      send(200, { record: records.link(projectId, id, input.data.to) });
      return true;
    }
    if (rest.length === 3 && sub === 'links' && method === 'DELETE') {
      send(200, { record: records.unlink(projectId, id, extra!) });
      return true;
    }
    throw new DomainError('NOT_FOUND');
  } catch (error) {
    // Refusals carrying fields (existingId, expected/got) are answered here with them.
    if (error instanceof RecordRefusal) {
      send(recordsStatuses[error.code] ?? 409, { code: error.code, ...error.details });
      return true;
    }
    throw error;
  }
}

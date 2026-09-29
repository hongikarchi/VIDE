/**
 * Concurrent intake (SPEC-02.9, ARCH-03 §10.3): which host documents a request uses, whom it waits
 * behind and the project limit of AI turns. Overlapping writes wait their turn instead of being
 * refused. Scheduling identity only; this never authorizes native writes or resolves unknown results.
 */

/** How a request uses the host: not at all, reading a document, or writing one. */
export type HostUse = 'none' | 'read' | 'write';
/** AI turns running at once in one project (SPEC-02.9 4): default 3, setting 2-4. */
export const AI_TURN_LIMIT = 3;
export const aiTurnLimit = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) ? Math.min(4, Math.max(2, value)) : 3;

interface ScopeInput {
  id: string;
  host?: string;
  baseRequestId?: string | null;
  linkedTargets?: readonly { host: string; baseRequestId: string }[];
  permission: string;
  provider?: string;
  applyToSource?: boolean;
  parentRequestId?: unknown;
  supersedesRequestId?: unknown;
  // Passthrough request fields, checked here.
  hostUse?: unknown;
  source?: unknown;
  sourceDocument?: unknown;
  jig?: unknown;
}
interface ScopeWork {
  id: string;
  input: ScopeInput;
  state: string;
  result?: {
    sourceDocument?: unknown;
    baseRequestId?: unknown;
    phase?: unknown;
    waitingFor?: unknown;
  } | null;
}
/** Stored on a waiting request's result (`phase: 'queue'`). */
export interface WaitingFor {
  /** `document`: another write holds the same document; `project`: the AI turn limit is reached. */
  kind: 'document' | 'project';
  key: string;
  /** 1 = next in line. */
  position: number;
  host?: string;
  /** The request it waits behind (document). */
  after?: string;
  /** The AI turn limit in force (project). */
  limit?: number;
}
export interface Admission {
  /** Refused: nothing is stored. */
  code?: string;
  /** Accepted to wait: stored as `queued` and started by the executor in turn. */
  waitingFor?: WaitingFor;
}
interface Claim {
  host: string;
  key: string | null;
  /** Writes the user's own document (source apply, or a CAD drawing edited in place). */
  source: boolean;
}

const jigKind = (input: ScopeInput) =>
  input.jig && typeof input.jig === 'object' && 'kind' in input.jig ? input.jig.kind : undefined;
/** Runs through the executor, so it can wait; captures, imports and extensions run at once. */
export const queueable = (input: ScopeInput) =>
  input.provider !== 'extension' && input.source !== 'document' && input.source !== 'file';
/** Calls an AI provider (counted in the AI turn limit). */
export const aiTurn = (input: ScopeInput) => queueable(input) && jigKind(input) !== 'jig-bake';
export function waitingOf(row: Pick<ScopeWork, 'state' | 'result'> | null | undefined) {
  if (row?.state !== 'queued' || row.result?.phase !== 'queue') return;
  const value = row.result.waitingFor;
  if (!value || typeof value !== 'object' || !('kind' in value) || !('position' in value)) return;
  return value as WaitingFor;
}

/**
 * The host use a request declares (`input.hostUse`) or, for requests without one, what it does:
 * extensions and jig table reviews use no host, Syncs and reviews read, the rest write. A
 * declaration that would let a write skip write contention is invalid (undefined).
 */
export function hostUse(input: ScopeInput): HostUse | undefined {
  const kind = jigKind(input);
  const inferred: HostUse =
    input.provider === 'extension' ||
    kind === 'sync-review' ||
    kind === 'structure-draft-review' ||
    kind === 'input-roles'
      ? 'none'
      : input.source === 'document' || input.permission === 'review'
        ? 'read'
        : 'write';
  if (input.hostUse === undefined || input.hostUse === inferred || input.hostUse === 'write')
    return input.hostUse === 'write' ? 'write' : inferred;
  if (input.hostUse === 'read') return inferred === 'write' ? undefined : 'read';
  if (input.hostUse === 'none')
    return input.applyToSource ||
      input.linkedTargets ||
      input.source === 'document' ||
      input.source === 'file'
      ? undefined
      : 'none';
}

function documentKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  if (!('instance' in value) || !('documentId' in value)) return;
  if (typeof value.instance !== 'string' || typeof value.documentId !== 'number') return;
  return JSON.stringify(['document', value.instance, value.documentId]);
}

function claims(input: ScopeInput, rows: ReadonlyMap<string, ScopeWork>): Claim[] {
  const use = hostUse(input);
  const host = input.host || 'rhino';
  if (use === 'none') return [];
  // A Sync reads the document it names; an import opens a new working copy.
  if (input.source === 'document')
    return [{ host, key: documentKey(input.sourceDocument) ?? null, source: false }];
  if (input.source === 'file')
    return [{ host, key: JSON.stringify(['candidate', input.id]), source: false }];
  const claim = (target: string, key: string | null): Claim => ({
    host: target,
    key,
    source: input.applyToSource === true || target === 'zwcad',
  });
  const resolve = (target: string, basis: string | null | undefined): Claim => {
    if (basis === undefined) return claim(target, null);
    if (basis === null) return claim(target, JSON.stringify(['candidate', input.id]));
    const visited = new Set<string>();
    let id = basis;
    while (!visited.has(id)) {
      visited.add(id);
      const row = rows.get(id);
      if (!row || (row.input.host || 'rhino') !== target) return claim(target, null);
      const document = documentKey(row.result?.sourceDocument);
      if (document) return claim(target, document);
      const parent = row.input.baseRequestId ?? row.result?.baseRequestId;
      if (typeof parent !== 'string') return claim(target, JSON.stringify(['candidate', id]));
      id = parent;
    }
    return claim(target, null);
  };
  return input.linkedTargets
    ? input.linkedTargets.map((target) => resolve(target.host, target.baseRequestId))
    : [resolve(host, input.baseRequestId)];
}

const same = (a: Claim, b: Claim) =>
  a.host === b.host && (a.key === null || b.key === null || a.key === b.key);

/**
 * Admission of a request against the requests ahead of it (for a new one, all stored requests):
 * refused only when a write meets an unresolved result on its document; otherwise it runs now or
 * waits for the same document's earlier write, or for a free AI turn (SPEC-02.9 1-5).
 */
export function requestAdmission(
  input: ScopeInput,
  rows: readonly ScopeWork[],
  options: { aiTurns?: number } = {},
): Admission {
  const use = hostUse(input);
  if (!use) return { code: 'INVALID_INPUT' };
  const byId = new Map(rows.map((row) => [row.id, row]));
  const mine = claims(input, byId);
  const others = rows.filter((row) => row.id !== input.id);
  if (
    use === 'write' &&
    others.some(
      (row) =>
        row.state === 'unknown' &&
        hostUse(row.input) !== 'none' &&
        claims(row.input, byId).some((theirs) => mine.some((claim) => same(claim, theirs))),
    )
  )
    return { code: 'HOST_RESULT_UNRESOLVED' };
  const active = others.filter(
    (row) =>
      !row.input.parentRequestId &&
      ['queued', 'running'].includes(row.state) &&
      !rows.some(
        (parent) =>
          parent.id === row.input.supersedesRequestId &&
          ['queued', 'running'].includes(parent.state),
      ),
  );
  let waitingFor: WaitingFor | undefined;
  // Reads and host-free turns never hold anyone back. A read waits only for a write to the same
  // user document (it reads after the write), a write for any earlier write to its document.
  const holds = (row: ScopeWork) => {
    if ((hostUse(row.input) ?? 'write') !== 'write') return;
    for (const theirs of claims(row.input, byId))
      for (const claim of mine)
        if (same(claim, theirs) && (use === 'write' || theirs.source))
          return {
            host: theirs.host,
            // Either side without an identified document stands behind the whole host.
            key: claim.key !== null && theirs.key !== null ? theirs.key : `host:${theirs.host}`,
          };
  };
  const holder = use === 'none' ? undefined : active.find(holds);
  if (holder)
    waitingFor = {
      kind: 'document',
      ...holds(holder)!,
      after: holder.id,
      position: active.filter((row) => waitingOf(row) && holds(row)).length + 1,
    };
  if (!waitingFor && aiTurn(input)) {
    const limit = aiTurnLimit(options.aiTurns ?? AI_TURN_LIMIT);
    if (active.filter((row) => !waitingOf(row) && aiTurn(row.input)).length >= limit)
      waitingFor = {
        kind: 'project',
        key: 'ai-turns',
        limit,
        position: active.filter((row) => waitingOf(row)?.kind === 'project').length + 1,
      };
  }
  if (!waitingFor) return {};
  // A Sync, an import or an extension runs at once or not at all.
  return queueable(input) ? { waitingFor } : { code: 'PROJECT_BUSY' };
}

/** The refusal code of `requestAdmission` (waiting is not a conflict). */
export function requestConflict(
  input: ScopeInput,
  rows: readonly ScopeWork[],
  options: { aiTurns?: number } = {},
): string | undefined {
  return requestAdmission(input, rows, options).code;
}

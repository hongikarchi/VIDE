interface ScopeInput {
  id: string;
  host?: string;
  baseRequestId?: string | null;
  linkedTargets?: { host: string; baseRequestId: string }[];
  permission: string;
  parentRequestId?: unknown;
}
interface ScopeWork {
  id: string;
  input: ScopeInput;
  state: string;
  result?: { sourceDocument?: unknown; baseRequestId?: unknown } | null;
}
interface Target {
  host: string;
  key: string | null;
}

function documentKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  if (!('instance' in value) || !('documentId' in value)) return;
  if (typeof value.instance !== 'string' || typeof value.documentId !== 'number') return;
  return JSON.stringify(['document', value.instance, value.documentId]);
}

function targets(input: ScopeInput, rows: readonly ScopeWork[]): Target[] {
  const resolve = (host: string, basis: string | null | undefined): Target => {
    if (basis === undefined) return { host, key: null };
    if (basis === null) return { host, key: JSON.stringify(['candidate', input.id]) };
    const visited = new Set<string>();
    let id = basis;
    while (!visited.has(id)) {
      visited.add(id);
      const row = rows.find((entry) => entry.id === id);
      if (!row || (row.input.host || 'rhino') !== host) return { host, key: null };
      const document = documentKey(row.result?.sourceDocument);
      if (document) return { host, key: document };
      const parent = row.input.baseRequestId ?? row.result?.baseRequestId;
      if (typeof parent !== 'string') return { host, key: JSON.stringify(['candidate', id]) };
      id = parent;
    }
    return { host, key: null };
  };
  return input.linkedTargets
    ? input.linkedTargets.map((target) => resolve(target.host, target.baseRequestId))
    : [resolve(input.host || 'rhino', input.baseRequestId)];
}

/** Scheduling identity only; this never authorizes native writes or resolves unknown results. */
export function requestConflict(input: ScopeInput, rows: readonly ScopeWork[]): string | undefined {
  const incoming = targets(input, rows);
  const overlaps = (row: ScopeWork) =>
    incoming.some((a) =>
      targets(row.input, rows).some(
        (b) => a.host === b.host && (a.key === null || b.key === null || a.key === b.key),
      ),
    );
  if (
    input.permission === 'candidate' &&
    rows.some((row) => row.state === 'unknown' && overlaps(row))
  )
    return 'HOST_RESULT_UNRESOLVED';
  const active = rows.filter(
    (row) => !row.input.parentRequestId && ['queued', 'running'].includes(row.state),
  );
  if (active.some(overlaps)) return 'PROJECT_BUSY';
  if (active.length >= 2) return 'WORKSPACE_CAPACITY';
}

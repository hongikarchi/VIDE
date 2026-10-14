// 입력의 출처 연결 (SPEC-07.5 7, T-298): which stored Syncs a role card reads a layer from. Each
// open linked file's latest Sync comes first; a closed link's last Sync only when no open file holds
// the picked layer (or no file is open), and then the role card says '닫힌 연결 기준'.

/** A stored Sync the jig context lists, with the linked file it belongs to (when known). */
export interface RoleSyncSource {
  id: string;
  /** The linked file whose Sync this is. */
  linkId?: string;
  /** This is that file's latest Sync. */
  latest?: boolean;
  /** That file is closed (not connected now, SPEC-01.11 7). */
  closed?: boolean;
  /** When the Sync was made (ISO), for newest-first order. */
  at?: string;
}
export interface RoleSyncs {
  /** Latest Syncs of open files, newest first: the default sources. */
  open: string[];
  /** Latest Syncs of closed files, newest first: only for a layer the open files lack. */
  closed: string[];
}

const newestFirst = (a: RoleSyncSource, b: RoleSyncSource) =>
  String(b.at ?? '').localeCompare(String(a.at ?? ''));

/**
 * The Syncs a role reads from. Older Syncs of a file are never sources. A list that names no file
 * (an older context) keeps every Sync, newest first, as open.
 */
export function roleSyncs(sources: readonly RoleSyncSource[]): RoleSyncs {
  if (!sources.some((source) => source.linkId)) {
    const ids = [...sources]
      .map((source, index) => ({ source, index }))
      .sort((a, b) => newestFirst(a.source, b.source) || b.index - a.index)
      .map(({ source }) => source.id);
    return { open: ids, closed: [] };
  }
  const latest = sources.filter((source) => source.linkId && source.latest).sort(newestFirst);
  return {
    open: latest.filter((source) => !source.closed).map((source) => source.id),
    closed: latest.filter((source) => source.closed).map((source) => source.id),
  };
}

/**
 * Whether a linked file counts as closed for its role sources: a host link with no connection now.
 * A file entry (a 3DM/DWG opened in VIDE, a file put in by [모델에 반영]) is read from its own copy
 * and has no connection to lose: never closed (SPEC-07.5 7, SPEC-01.11 4).
 */
export const linkClosed = (link: { kind?: string; connection?: unknown }) =>
  link.kind !== 'file' && !link.connection;
/** The order a person's layer pick tries: open files first, then closed ones (SPEC-07.5 7). */
export const pickOrder = (syncs: RoleSyncs) => [...syncs.open, ...syncs.closed];
/** Where role candidates are looked for: the open files; closed ones only when none is open. */
export const findOrder = (syncs: RoleSyncs) => (syncs.open.length ? syncs.open : syncs.closed);

/**
 * Whether a role's sources come from a closed linked file: a source read from a stored Sync
 * (`sync:<id>`) or from a link by its id.
 */
export function fromClosedLink(
  roleSources: readonly { linkId?: string }[] | undefined,
  sources: readonly RoleSyncSource[],
): boolean {
  return (roleSources ?? []).some((held) => {
    const id = held.linkId ?? '';
    const source = id.startsWith('sync:')
      ? sources.find((s) => s.id === id.slice('sync:'.length))
      : sources.find((s) => s.linkId === id);
    return !!source?.closed;
  });
}
export const CLOSED_SOURCE_NOTE = '닫힌 연결 기준';

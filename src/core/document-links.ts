import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DomainError } from './store.ts';

// Project link files (SPEC-01.11): the documents a user linked to a project from a host plugin.
// A link survives the host window closing; its display comes from the latest Sync of that link.
export const linkInputSchema = z
  .object({
    host: z.enum(['rhino', 'zwcad']),
    name: z.string().min(1).max(260),
    path: z.string().max(1024).optional(),
    instance: z.string().max(200),
    documentId: z.number().int().positive(),
    /** The link id this document carries for the project (ADR-030), when the plugin reads one. */
    storedId: z.string().min(1).max(100).optional(),
    /** The user's answer to a link choice: take over that row (its history continues) or add one. */
    replace: z.union([z.literal('new'), z.string().min(1).max(100)]).optional(),
  })
  .strict();
export type LinkInput = z.infer<typeof linkInputSchema>;
export interface DocumentLink {
  id: string;
  projectId: string;
  host: 'rhino' | 'zwcad';
  name: string;
  path: string | null;
  instance: string;
  documentId: number;
  hidden: boolean;
  linkedAt: string;
  updatedAt: string;
}
interface Row extends Omit<DocumentLink, 'hidden'> {
  hidden: number;
}
const toLink = (row: Row): DocumentLink => ({ ...row, hidden: row.hidden === 1 });
/** Files opened in VIDE have no host window; their entry is keyed by the file name. */
export const fileInstance = (name: string) => 'file:' + name.toLowerCase();
export const isFileLink = (link: { instance: string }) => link.instance.startsWith('file:');
/** A row that no longer names a window (another row of its window took over, T-107). */
const closedInstance = () => 'closed:' + randomUUID();

/** A saved file's path; ZWCAD names an unsaved drawing "Drawing1.dwg", which is no path. */
export const savedPath = (path?: string | null) => {
  const value = path?.trim();
  return value && /[\\/]/.test(value) ? value : undefined;
};
const samePath = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
/** Several rows for one window: the one with the window's current path, then the newest. */
function newestOf<T extends { path: string | null; updatedAt: string }>(
  rows: T[],
  path?: string | null,
) {
  return (
    rows.find((row) => samePath(row.path, path)) ??
    [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  );
}
export interface OpenDocument {
  host?: 'rhino' | 'zwcad';
  instance?: string;
  id: number;
  name: string;
  path?: string;
  /** The VIDE link ids stored in the document (ADR-030), one per project it was linked to. */
  linkIds?: string[];
}
/** How a row found its open document: its own window, the id stored in the document, or path. */
export type MatchHow = 'session' | 'stored' | 'path';
/**
 * A one-time note on a row in the links list (SPEC-01.11 1): the row followed its window to
 * another file or a reopened window (with what it was before, for [새 항목으로 분리]), or the
 * plugin stored the link id in the document (the document is modified until the user saves).
 */
export type LinkNotice =
  | {
      kind: 'followed';
      reason: 'renamed' | 'reopened';
      from: string;
      to: string;
      previous: { name: string; path: string | null; instance: string; documentId: number };
    }
  | { kind: 'stored' };
/** A Link that needs the user's answer (SPEC-01.11 1): which row this document continues. */
export interface LinkChoice {
  /** `copy`: the stored id's row is open in another window; `closed`: closed rows could match. */
  reason: 'copy' | 'closed';
  /** The answer used when the user just confirms: the row automatic matching would pick. */
  default: string;
  choices: {
    id: string;
    name: string;
    path: string | null;
    updatedAt: string;
    match: 'stored' | 'path' | 'name' | 'recent';
  }[];
}
/** A closed row counts as recently closed for the link choice within this time. */
const RECENT_MS = 12 * 60 * 60 * 1000;
/**
 * Which open document each link row shows (SPEC-01.11 1, T-095, T-108): the window's own row first
 * (same instance and documentId), then the row whose id the document stores (ADR-030), then a row
 * of the same saved file; the last two only when the row's own window is gone. One row per open
 * document; the others read as closed.
 */
export function matchOpenDocuments<D extends OpenDocument>(rows: DocumentLink[], open: D[]) {
  const matched = new Map<string, { document: D; session: boolean; how: MatchHow }>();
  const host = (document: D) => document.host ?? 'rhino';
  const hostRows = rows.filter((row) => !isFileLink(row));
  const windowOpen = (row: DocumentLink) =>
    open.some(
      (other) =>
        host(other) === row.host && other.instance === row.instance && other.id === row.documentId,
    );
  for (const document of open) {
    const own = newestOf(
      hostRows.filter(
        (row) =>
          row.host === host(document) &&
          row.instance === document.instance &&
          row.documentId === document.id,
      ),
      savedPath(document.path),
    );
    if (own) matched.set(own.id, { document, session: true, how: 'session' });
  }
  const claimed = () => new Set([...matched.values()].map((entry) => entry.document));
  let taken = claimed();
  for (const document of open) {
    if (taken.has(document) || !document.linkIds?.length) continue;
    const row = hostRows.find(
      (candidate) =>
        candidate.host === host(document) &&
        document.linkIds!.includes(candidate.id) &&
        !matched.has(candidate.id) &&
        !windowOpen(candidate),
    );
    if (row) {
      matched.set(row.id, { document, session: false, how: 'stored' });
      taken = claimed();
    }
  }
  for (const document of open) {
    const path = savedPath(document.path);
    if (taken.has(document) || !path) continue;
    const row = newestOf(
      hostRows.filter(
        (candidate) =>
          candidate.host === host(document) &&
          !matched.has(candidate.id) &&
          samePath(candidate.path, path) &&
          !windowOpen(candidate),
      ),
    );
    if (row) matched.set(row.id, { document, session: false, how: 'path' });
  }
  return matched;
}

export class DocumentLinks {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  list(projectId: string): DocumentLink[] {
    return (
      this.db
        .prepare('SELECT * FROM document_links WHERE projectId=? ORDER BY linkedAt')
        .all(projectId) as unknown as Row[]
    ).map(toLink);
  }
  get(projectId: string, id: string): DocumentLink {
    const row = this.db
      .prepare('SELECT * FROM document_links WHERE projectId=? AND id=?')
      .get(projectId, id) as unknown as Row | undefined;
    if (!row) throw new DomainError('NOT_FOUND');
    return toLink(row);
  }
  /** The row that a document's stored id (ADR-030) names, when it is a host row of this host. */
  private storedRow(projectId: string, input: LinkInput) {
    if (!input.storedId) return undefined;
    return this.list(projectId).find(
      (row) => row.id === input.storedId && row.host === input.host && !isFileLink(row),
    );
  }
  /**
   * Whether a Link needs the user's answer first (SPEC-01.11 1, T-107, T-108): the id the document
   * stores names a row that another open window holds now (a copy of the file), or no row is this
   * window's and closed rows of the same host could be this document (same path, same name, or
   * closed recently). Otherwise the Link goes ahead as `link` resolves it. `open` is the host's
   * open documents (every window, not only this one).
   */
  linkChoice(projectId: string, value: unknown, open: OpenDocument[]): LinkChoice | undefined {
    const input = linkInputSchema.parse(value);
    if (input.replace) return undefined;
    const host = (document: OpenDocument) => document.host ?? input.host;
    const isThis = (document: OpenDocument) =>
      document.instance === input.instance && document.id === input.documentId;
    const windowOpen = (row: DocumentLink) =>
      open.some(
        (document) =>
          host(document) === row.host &&
          document.instance === row.instance &&
          document.id === row.documentId,
      );
    const stored = this.storedRow(projectId, input);
    if (stored) {
      const elsewhere = open.some(
        (document) =>
          !isThis(document) &&
          host(document) === stored.host &&
          document.instance === stored.instance &&
          document.id === stored.documentId,
      );
      return elsewhere
        ? {
            reason: 'copy',
            default: 'new',
            choices: [
              {
                id: stored.id,
                name: stored.name,
                path: stored.path,
                updatedAt: stored.updatedAt,
                match: 'stored',
              },
            ],
          }
        : undefined;
    }
    const rows = this.list(projectId).filter((row) => row.host === input.host && !isFileLink(row));
    if (rows.some((row) => row.instance === input.instance && row.documentId === input.documentId))
      return undefined;
    const path = savedPath(input.path);
    const now = Date.now();
    const order = ['path', 'name', 'recent'] as const;
    const choices = rows
      .filter((row) => !windowOpen(row))
      .flatMap((row) => {
        const match = samePath(row.path, path)
          ? ('path' as const)
          : row.name.toLowerCase() === input.name.toLowerCase()
            ? ('name' as const)
            : now - Date.parse(row.updatedAt) < RECENT_MS
              ? ('recent' as const)
              : undefined;
        return match ? [{ row, match }] : [];
      })
      .sort(
        (a, b) =>
          order.indexOf(a.match) - order.indexOf(b.match) ||
          b.row.updatedAt.localeCompare(a.row.updatedAt),
      )
      .slice(0, 5);
    if (!choices.length) return undefined;
    return {
      reason: 'closed',
      default: choices[0].match === 'path' ? choices[0].row.id : 'new',
      choices: choices.map(({ row, match }) => ({
        id: row.id,
        name: row.name,
        path: row.path,
        updatedAt: row.updatedAt,
        match,
      })),
    };
  }
  /**
   * Link from a plugin: the user's answer (`replace`) first, then the row whose id the document
   * stores (ADR-030), the row of this window (same session), then a row of the same saved file
   * whose own window is gone; that row takes the window's name, path and session (T-095, T-108).
   */
  link(projectId: string, value: unknown): DocumentLink {
    const input = linkInputSchema.parse(value);
    const now = new Date().toISOString();
    const path = savedPath(input.path) ?? null;
    const rows = this.list(projectId).filter((link) => link.host === input.host);
    const chosen =
      input.replace && input.replace !== 'new'
        ? rows.find((link) => link.id === input.replace && !isFileLink(link))
        : undefined;
    if (input.replace && input.replace !== 'new' && !chosen) throw new DomainError('NOT_FOUND');
    const existing =
      input.replace === 'new'
        ? undefined
        : (chosen ??
          this.storedRow(projectId, input) ??
          newestOf(
            rows.filter(
              (link) => link.instance === input.instance && link.documentId === input.documentId,
            ),
            path,
          ) ??
          (path ? newestOf(rows.filter((link) => samePath(link.path, path))) : undefined));
    if (existing) {
      // Another row of this window stays with its file: it no longer reads as this window's.
      if (existing.instance !== input.instance || existing.documentId !== input.documentId)
        this.detachWindow(projectId, input.host, input.instance, input.documentId, existing.id);
      this.db
        .prepare(
          'UPDATE document_links SET name=?, path=?, instance=?, documentId=?, hidden=0, updatedAt=? WHERE id=?',
        )
        .run(input.name, path ?? existing.path, input.instance, input.documentId, now, existing.id);
      return this.get(projectId, existing.id);
    }
    if (input.replace === 'new')
      this.detachWindow(projectId, input.host, input.instance, input.documentId);
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
      .run(id, projectId, input.host, input.name, path, input.instance, input.documentId, now, now);
    return this.get(projectId, id);
  }
  /**
   * Rows of one window that are not the row it continues now (a chosen row, a new row, a split)
   * keep their file but no longer name the window: their instance becomes a closed marker, so they
   * read as closed and reconnect only by their own path or stored id.
   */
  private detachWindow(
    projectId: string,
    host: string,
    instance: string,
    documentId: number,
    keep?: string,
  ) {
    for (const row of this.list(projectId))
      if (
        row.id !== keep &&
        !isFileLink(row) &&
        row.host === host &&
        row.instance === instance &&
        row.documentId === documentId
      )
        this.db
          .prepare('UPDATE document_links SET instance=? WHERE projectId=? AND id=?')
          .run(closedInstance(), projectId, row.id);
  }
  /** One-time notes of the links list (in memory: a restart clears them). */
  private readonly notices = new Map<string, LinkNotice>();
  notice(id: string) {
    return this.notices.get(id);
  }
  note(id: string, notice: LinkNotice) {
    this.notices.set(id, notice);
  }
  dismiss(projectId: string, id: string) {
    this.get(projectId, id);
    this.notices.delete(id);
  }
  /**
   * The open document a row matched (SPEC-01.11 1): the linked window saved under another name
   * (Save As, or a first save), so the row follows the window and keeps its Sync history; a row
   * reconnected by path or by its stored id takes the window's session, so a later Save As there
   * follows it too. Host rows only. updatedAt marks the last match: among rows of one window the
   * live one stays newest, so it is the one that follows when no row has the new path. A row that
   * moved to another saved file, or to a reopened window by path, gets a one-time notice with what
   * it was before (T-107).
   */
  follow(projectId: string, id: string, document: OpenDocument, how: MatchHow = 'session') {
    const link = this.get(projectId, id);
    if (isFileLink(link)) return link;
    const path = savedPath(document.path);
    const next = {
      name: path && document.name ? document.name : link.name,
      path: path ?? link.path,
      instance: document.instance ?? link.instance,
      documentId: document.id,
    };
    const changed =
      next.name !== link.name ||
      next.path !== link.path ||
      next.instance !== link.instance ||
      next.documentId !== link.documentId;
    const sibling = this.list(projectId)
      .filter(
        (row) =>
          row.id !== link.id &&
          !isFileLink(row) &&
          row.host === link.host &&
          row.instance === next.instance &&
          row.documentId === next.documentId,
      )
      .reduce((newest, row) => (row.updatedAt > newest ? row.updatedAt : newest), '');
    if (!changed && sibling < link.updatedAt) return link;
    const renamed = !!link.path && !samePath(link.path, next.path);
    const reopened = how === 'path' && next.instance !== link.instance;
    if (renamed || reopened) {
      const earlier = this.notices.get(id);
      this.notices.set(id, {
        kind: 'followed',
        reason: renamed ? 'renamed' : 'reopened',
        from: earlier?.kind === 'followed' ? earlier.from : link.name,
        to: next.name,
        previous:
          earlier?.kind === 'followed'
            ? earlier.previous
            : {
                name: link.name,
                path: link.path,
                instance: link.instance,
                documentId: link.documentId,
              },
      });
    }
    const now = Date.now();
    const at = new Date(sibling ? Math.max(now, Date.parse(sibling) + 1) : now).toISOString();
    this.db
      .prepare(
        'UPDATE document_links SET name=?, path=?, instance=?, documentId=?, updatedAt=? WHERE projectId=? AND id=?',
      )
      .run(next.name, next.path, next.instance, next.documentId, at, projectId, id);
    return this.get(projectId, id);
  }
  /**
   * [새 항목으로 분리] (SPEC-01.11 1, T-107): the window a row followed gets a new row; the old row
   * keeps its history and goes back to the file it had before the follow, closed (its window, when
   * it is still this one, is marked closed). Only while the follow notice is there.
   */
  split(projectId: string, id: string) {
    const link = this.get(projectId, id);
    const notice = this.notices.get(id);
    if (isFileLink(link) || notice?.kind !== 'followed') throw new DomainError('STALE_REFERENCE');
    const { previous } = notice;
    const now = new Date().toISOString();
    const created = randomUUID();
    this.db
      .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        created,
        projectId,
        link.host,
        link.name,
        link.path,
        link.instance,
        link.documentId,
        link.hidden ? 1 : 0,
        now,
        now,
      );
    const sameWindow =
      previous.instance === link.instance && previous.documentId === link.documentId;
    this.db
      .prepare(
        'UPDATE document_links SET name=?, path=?, instance=?, documentId=? WHERE projectId=? AND id=?',
      )
      .run(
        previous.name,
        previous.path,
        sameWindow ? closedInstance() : previous.instance,
        previous.documentId,
        projectId,
        id,
      );
    this.notices.delete(id);
    return this.get(projectId, created);
  }
  /**
   * [합치기] (SPEC-01.11 1, T-107): `from`'s records move to `into` (its Sync and import requests,
   * jig reads and bakes) and `from` leaves the list. Both are host rows of one host. The caller
   * checks that no request of `from` is running.
   */
  merge(projectId: string, from: string, into: string) {
    const source = this.get(projectId, from);
    const target = this.get(projectId, into);
    if (from === into || isFileLink(source) || isFileLink(target) || source.host !== target.host)
      throw new DomainError('INVALID_INPUT');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const moved = this.db
        .prepare(
          "UPDATE workspace_requests SET input=json_set(input, '$.linkId', ?) WHERE projectId=? AND json_extract(input, '$.linkId')=?",
        )
        .run(into, projectId, from).changes;
      for (const table of ['jig_reads', 'jig_bakes'])
        this.db.prepare(`UPDATE ${table} SET linkId=? WHERE linkId=?`).run(into, from);
      this.db.prepare('DELETE FROM document_links WHERE projectId=? AND id=?').run(projectId, from);
      this.db.exec('COMMIT');
      this.notices.delete(from);
      return { link: this.get(projectId, into), moved: Number(moved) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Showing or hiding is no match: it leaves updatedAt, which decides the live row (T-095). */
  setHidden(projectId: string, id: string, hidden: boolean) {
    this.get(projectId, id);
    this.db
      .prepare('UPDATE document_links SET hidden=? WHERE projectId=? AND id=?')
      .run(hidden ? 1 : 0, projectId, id);
    return this.get(projectId, id);
  }
  /**
   * A file opened in VIDE ("파일에서 열기"): listed like a linked document, keyed by its file name so
   * opening the same file again updates the same entry. Existing entries keep their visibility.
   */
  fileLink(projectId: string, host: 'rhino' | 'zwcad', name: string, hidden = false) {
    const instance = fileInstance(name);
    const existing = this.db
      .prepare('SELECT id FROM document_links WHERE projectId=? AND host=? AND instance=?')
      .get(projectId, host, instance) as { id: string } | undefined;
    if (existing) return this.get(projectId, existing.id);
    const link = this.link(projectId, { host, name, instance, documentId: 1 });
    return hidden ? this.setHidden(projectId, link.id, true) : link;
  }
  /** Removes the file from the project's list; its Sync records and results are kept. */
  remove(projectId: string, id: string) {
    this.get(projectId, id);
    this.db.prepare('DELETE FROM document_links WHERE projectId=? AND id=?').run(projectId, id);
    this.notices.delete(id);
  }
}

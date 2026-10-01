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
}
/**
 * Which open document each link row shows (SPEC-01.11 1, T-095): the window's own row first (same
 * instance and documentId), a row of the same saved file only when its own window is gone. One
 * row per open document; the others read as closed.
 */
export function matchOpenDocuments<D extends OpenDocument>(rows: DocumentLink[], open: D[]) {
  const matched = new Map<string, { document: D; session: boolean }>();
  const host = (document: D) => document.host ?? 'rhino';
  const hostRows = rows.filter((row) => !isFileLink(row));
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
    if (own) matched.set(own.id, { document, session: true });
  }
  const claimed = new Set([...matched.values()].map((entry) => entry.document));
  for (const document of open) {
    const path = savedPath(document.path);
    if (claimed.has(document) || !path) continue;
    const row = newestOf(
      hostRows.filter(
        (candidate) =>
          candidate.host === host(document) &&
          !matched.has(candidate.id) &&
          samePath(candidate.path, path) &&
          !open.some(
            (other) =>
              host(other) === candidate.host &&
              other.instance === candidate.instance &&
              other.id === candidate.documentId,
          ),
      ),
    );
    if (row) matched.set(row.id, { document, session: false });
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
  /**
   * Link from a plugin: the row of this window first (same session), then a row of the same saved
   * file whose own window is gone; that row takes the window's name, path and session (T-095).
   */
  link(projectId: string, value: unknown): DocumentLink {
    const input = linkInputSchema.parse(value);
    const now = new Date().toISOString();
    const path = savedPath(input.path) ?? null;
    const rows = this.list(projectId).filter((link) => link.host === input.host);
    const existing =
      newestOf(
        rows.filter(
          (link) => link.instance === input.instance && link.documentId === input.documentId,
        ),
        path,
      ) ?? (path ? newestOf(rows.filter((link) => samePath(link.path, path))) : undefined);
    if (existing) {
      this.db
        .prepare(
          'UPDATE document_links SET name=?, path=?, instance=?, documentId=?, hidden=0, updatedAt=? WHERE id=?',
        )
        .run(input.name, path ?? existing.path, input.instance, input.documentId, now, existing.id);
      return this.get(projectId, existing.id);
    }
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
      .run(id, projectId, input.host, input.name, path, input.instance, input.documentId, now, now);
    return this.get(projectId, id);
  }
  /**
   * The linked window saved its document under another name (Save As, or a first save): the row
   * follows the window and keeps its Sync history (SPEC-01.11 1). Host rows only.
   */
  follow(projectId: string, id: string, document: { name: string; path?: string | null }) {
    const link = this.get(projectId, id);
    const path = savedPath(document.path);
    if (isFileLink(link) || !path || !document.name) return link;
    if (link.name === document.name && samePath(link.path, path)) return link;
    this.db
      .prepare('UPDATE document_links SET name=?, path=?, updatedAt=? WHERE projectId=? AND id=?')
      .run(document.name, path, new Date().toISOString(), projectId, id);
    return this.get(projectId, id);
  }
  setHidden(projectId: string, id: string, hidden: boolean) {
    this.get(projectId, id);
    this.db
      .prepare('UPDATE document_links SET hidden=?, updatedAt=? WHERE projectId=? AND id=?')
      .run(hidden ? 1 : 0, new Date().toISOString(), projectId, id);
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
  }
}

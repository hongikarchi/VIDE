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
  /** The same file (same path, or the same open window when unsaved) updates its existing link. */
  link(projectId: string, value: unknown): DocumentLink {
    const input = linkInputSchema.parse(value);
    const now = new Date().toISOString();
    const path = input.path?.trim() || null;
    const existing = (path
      ? this.db
          .prepare(
            'SELECT * FROM document_links WHERE projectId=? AND host=? AND lower(path)=lower(?)',
          )
          .get(projectId, input.host, path)
      : this.db
          .prepare(
            'SELECT * FROM document_links WHERE projectId=? AND host=? AND path IS NULL AND instance=? AND documentId=?',
          )
          .get(projectId, input.host, input.instance, input.documentId)) as unknown as
      | Row
      | undefined;
    if (existing) {
      this.db
        .prepare(
          'UPDATE document_links SET name=?, instance=?, documentId=?, hidden=0, updatedAt=? WHERE id=?',
        )
        .run(input.name, input.instance, input.documentId, now, existing.id);
      return this.get(projectId, existing.id);
    }
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
      .run(id, projectId, input.host, input.name, path, input.instance, input.documentId, now, now);
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

import { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.ts';

/**
 * A project's folders on this PC (SPEC-01.13, ARCH-01 §3 「프로젝트 폴더와 파일 읽기 도구」, schema
 * 6): `project` folders the user set in the dashboard and `read` folders the user let the AI read
 * with [이 폴더는 항상]. Paths are real paths (checked by the caller); data access only.
 */
export type FolderKind = 'project' | 'read';
export interface ProjectFolder {
  path: string;
  kind: FolderKind;
  addedAt: string;
}

export class ProjectFolders {
  private readonly source: DatabaseSync | Store;
  /** One DB (tests, a single file), or a Store: each project's rows live in its own DB. */
  constructor(source: DatabaseSync | Store) {
    this.source = source;
  }
  private of(projectId: string) {
    return this.source instanceof DatabaseSync ? this.source : this.source.db(projectId);
  }
  /** Project folders first, then read folders; each in the order they were added. */
  list(projectId: string): ProjectFolder[] {
    return this.of(projectId)
      .prepare(
        `SELECT path, kind, addedAt FROM project_folders WHERE projectId=?
          ORDER BY kind='read', addedAt, path`,
      )
      .all(projectId)
      .map((row) => ({
        path: String(row.path),
        kind: row.kind === 'read' ? 'read' : 'project',
        addedAt: String(row.addedAt),
      }));
  }
  /** A `project` row replaces a `read` row of the same path; a `read` row never demotes one. */
  add(projectId: string, path: string, kind: FolderKind) {
    this.of(projectId)
      .prepare(
        `INSERT INTO project_folders VALUES(?,?,?,?) ON CONFLICT(projectId, path)
          DO UPDATE SET kind='project' WHERE excluded.kind='project'`,
      )
      .run(projectId, path, kind, new Date().toISOString());
    return this.list(projectId);
  }
  remove(projectId: string, path: string) {
    this.of(projectId)
      .prepare('DELETE FROM project_folders WHERE projectId=? AND path=?')
      .run(projectId, path);
    return this.list(projectId);
  }
}

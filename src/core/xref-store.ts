import { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.ts';
import type { XrefFileRead } from './xref-graph.ts';

/**
 * The project's xref reads and display placements (SPEC-01.11 11, ARCH-01 「도면 xref 관계(T-200)」).
 * Derived data, rebuilt by [다시 읽기] and [모델에 반영]: like `request_index` the tables are made
 * on first use and are not part of the versioned schema (an older VIDE ignores them).
 * `xref_files`: one row per drawing read (original path; size and modification time decide whether
 * it is read again; `data` the worker's answer). `xref_placements`: the placement of a link shown
 * as part of a root drawing (row-major 4x4, the link's metres → the root's metres).
 */
const TABLES = `CREATE TABLE IF NOT EXISTS xref_files(projectId TEXT NOT NULL, path TEXT NOT NULL,
  size INTEGER NOT NULL, mtime TEXT NOT NULL, sha256 TEXT NOT NULL, readAt TEXT NOT NULL,
  inFolders INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(projectId, path)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS xref_placements(projectId TEXT NOT NULL, linkId TEXT NOT NULL,
  rootPath TEXT NOT NULL, matrix TEXT NOT NULL, PRIMARY KEY(projectId, linkId)) WITHOUT ROWID;`;

export interface XrefFileRow {
  path: string;
  size: number;
  mtime: string;
  sha256: string;
  readAt: string;
  /** Listed in the project folders (false: reached only as a reference). */
  inFolders: boolean;
  read: XrefFileRead;
}

export class XrefStore {
  private readonly source: DatabaseSync | Store;
  private readonly ready = new WeakSet<DatabaseSync>();
  constructor(source: DatabaseSync | Store) {
    this.source = source;
  }
  private of(projectId: string) {
    const db = this.source instanceof DatabaseSync ? this.source : this.source.db(projectId);
    if (!this.ready.has(db)) {
      db.exec(TABLES);
      this.ready.add(db);
    }
    return db;
  }
  files(projectId: string): XrefFileRow[] {
    return this.of(projectId)
      .prepare('SELECT * FROM xref_files WHERE projectId=? ORDER BY path')
      .all(projectId)
      .map((row) => ({
        path: String(row.path),
        size: Number(row.size),
        mtime: String(row.mtime),
        sha256: String(row.sha256),
        readAt: String(row.readAt),
        inFolders: row.inFolders === 1,
        read: JSON.parse(String(row.data)) as XrefFileRead,
      }));
  }
  /** Replaces every row: the drawings of the last [다시 읽기]. */
  replaceFiles(projectId: string, rows: readonly XrefFileRow[]) {
    const db = this.of(projectId);
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM xref_files WHERE projectId=?').run(projectId);
      const insert = db.prepare('INSERT INTO xref_files VALUES(?,?,?,?,?,?,?,?)');
      for (const row of rows)
        insert.run(
          projectId,
          row.path,
          row.size,
          row.mtime,
          row.sha256,
          row.readAt,
          row.inFolders ? 1 : 0,
          JSON.stringify(row.read),
        );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Placement of each link shown as part of a root (link id → row-major 4x4). */
  placements(projectId: string): Map<string, { rootPath: string; matrix: number[] }> {
    return new Map(
      this.of(projectId)
        .prepare('SELECT linkId, rootPath, matrix FROM xref_placements WHERE projectId=?')
        .all(projectId)
        .map((row) => [
          String(row.linkId),
          { rootPath: String(row.rootPath), matrix: JSON.parse(String(row.matrix)) as number[] },
        ]),
    );
  }
  /** A link's placement; null: drawn in its own coordinates (a root, or no longer placed). */
  place(projectId: string, linkId: string, rootPath: string, matrix: number[] | null) {
    const db = this.of(projectId);
    if (!matrix)
      db.prepare('DELETE FROM xref_placements WHERE projectId=? AND linkId=?').run(
        projectId,
        linkId,
      );
    else
      db.prepare(
        `INSERT INTO xref_placements VALUES(?,?,?,?) ON CONFLICT(projectId, linkId)
          DO UPDATE SET rootPath=excluded.rootPath, matrix=excluded.matrix`,
      ).run(projectId, linkId, rootPath, JSON.stringify(matrix));
  }
}

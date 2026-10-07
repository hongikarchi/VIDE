import { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.ts';

/**
 * The project's title block preview settings (SPEC-14.15 2·3, PLAN-47 T-235): the title block
 * list (block names) and the one registered `.ctb`. Like `xref_files` the table is made on first
 * use and is not part of the versioned schema (an older VIDE ignores it).
 */
const TABLE = `CREATE TABLE IF NOT EXISTS drawing_sheet_settings(projectId TEXT NOT NULL PRIMARY KEY,
  blocks TEXT NOT NULL, ctb TEXT) WITHOUT ROWID;`;

export interface DrawingSheetSettings {
  blocks: string[];
  /** Absolute path of the registered .ctb, or null. */
  ctb: string | null;
}

export class DrawingSheetsStore {
  private readonly source: DatabaseSync | Store;
  private readonly ready = new WeakSet<DatabaseSync>();
  constructor(source: DatabaseSync | Store) {
    this.source = source;
  }
  private of(projectId: string) {
    const db = this.source instanceof DatabaseSync ? this.source : this.source.db(projectId);
    if (!this.ready.has(db)) {
      db.exec(TABLE);
      this.ready.add(db);
    }
    return db;
  }
  settings(projectId: string): DrawingSheetSettings {
    const row = this.of(projectId)
      .prepare('SELECT blocks, ctb FROM drawing_sheet_settings WHERE projectId=?')
      .get(projectId);
    if (!row) return { blocks: [], ctb: null };
    let blocks: string[] = [];
    try {
      const parsed = JSON.parse(String(row.blocks));
      if (Array.isArray(parsed)) blocks = parsed.filter((b) => typeof b === 'string');
    } catch {
      /* A damaged row reads as an empty list. */
    }
    return { blocks, ctb: typeof row.ctb === 'string' ? row.ctb : null };
  }
  save(projectId: string, settings: DrawingSheetSettings) {
    this.of(projectId)
      .prepare(
        `INSERT INTO drawing_sheet_settings VALUES(?,?,?) ON CONFLICT(projectId)
          DO UPDATE SET blocks=excluded.blocks, ctb=excluded.ctb`,
      )
      .run(projectId, JSON.stringify(settings.blocks), settings.ctb);
  }
}

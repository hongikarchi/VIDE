import { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.ts';

/**
 * 체크아웃 기록 (SPEC-01.13 9, ARCH-01 「작업 폴더(PLAN-52)」, schema 18): a local copy of a server
 * file this PC took ('작업 중' while `releasedAt` is null). Paths are real paths; data access only —
 * copying, checks and the site copy are `src/server/workspace-checkout.ts`.
 */
export type CheckoutRole = 'rhino' | 'cad';
export interface CheckoutRow {
  id: string;
  role: CheckoutRole;
  serverPath: string;
  localPath: string;
  pcId: string;
  userId: string;
  checkedOutAt: string;
  releasedAt: string | null;
  /** The server file's mtime (ISO) and SHA-256 when taken, or when last reflected to the server. */
  serverMtime: string;
  serverHash: string;
}

const COLUMNS = `id, role, server_path, local_path, pc_id, user_id, checked_out_at, released_at,
  server_mtime_at_checkout, server_hash_at_checkout`;
const rowOf = (row: Record<string, unknown>): CheckoutRow => ({
  id: String(row.id),
  role: row.role === 'cad' ? 'cad' : 'rhino',
  serverPath: String(row.server_path),
  localPath: String(row.local_path),
  pcId: String(row.pc_id),
  userId: String(row.user_id),
  checkedOutAt: String(row.checked_out_at),
  releasedAt:
    row.released_at === null || row.released_at === undefined ? null : String(row.released_at),
  serverMtime: String(row.server_mtime_at_checkout),
  serverHash: String(row.server_hash_at_checkout),
});

export class Checkouts {
  private readonly source: DatabaseSync | Store;
  /** One DB (tests, a single file), or a Store: each project's rows live in its own DB. */
  constructor(source: DatabaseSync | Store) {
    this.source = source;
  }
  private of(projectId: string) {
    return this.source instanceof DatabaseSync ? this.source : this.source.db(projectId);
  }
  add(projectId: string, row: Omit<CheckoutRow, 'releasedAt'>) {
    this.of(projectId)
      .prepare(`INSERT INTO checkouts(projectId, ${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,NULL,?,?)`)
      .run(
        projectId,
        row.id,
        row.role,
        row.serverPath,
        row.localPath,
        row.pcId,
        row.userId,
        row.checkedOutAt,
        row.serverMtime,
        row.serverHash,
      );
    return this.get(projectId, row.id)!;
  }
  get(projectId: string, id: string): CheckoutRow | null {
    const row = this.of(projectId)
      .prepare(`SELECT ${COLUMNS} FROM checkouts WHERE projectId=? AND id=?`)
      .get(projectId, id);
    return row ? rowOf(row) : null;
  }
  /** Rows still 작업 중 (not released), oldest first. */
  active(projectId: string): CheckoutRow[] {
    return this.of(projectId)
      .prepare(
        `SELECT ${COLUMNS} FROM checkouts WHERE projectId=? AND released_at IS NULL
          ORDER BY checked_out_at, id`,
      )
      .all(projectId)
      .map(rowOf);
  }
  /** Every row, newest first (the file map's events read them). */
  list(projectId: string): CheckoutRow[] {
    return this.of(projectId)
      .prepare(
        `SELECT ${COLUMNS} FROM checkouts WHERE projectId=? ORDER BY checked_out_at DESC, id`,
      )
      .all(projectId)
      .map(rowOf);
  }
  release(projectId: string, id: string, at: string) {
    this.of(projectId)
      .prepare(
        'UPDATE checkouts SET released_at=? WHERE projectId=? AND id=? AND released_at IS NULL',
      )
      .run(at, projectId, id);
    return this.get(projectId, id);
  }
  /** After [서버에 반영]: the server version the local copy now matches. */
  rebase(projectId: string, id: string, server: { mtime: string; hash: string }) {
    this.of(projectId)
      .prepare(
        `UPDATE checkouts SET server_mtime_at_checkout=?, server_hash_at_checkout=?
          WHERE projectId=? AND id=?`,
      )
      .run(server.mtime, server.hash, projectId, id);
    return this.get(projectId, id);
  }
}

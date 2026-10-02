// Moves request results stored before schema 9 (whole `objects`/`scene`/`definitions` JSON) into
// per-object storage (PLAN-27 1단계 순서 8, ARCH-01 §5 「기존 결과 옮기기」). One row per
// transaction: store the model, rewrite the small result with `modelStore: 'manifest'`, rebuild
// the model from storage and compare it with the original after the same float32 conversion. A
// mismatch rolls the row back and leaves it as JSON. The engine starts this after it has opened
// its address; rows left by an interrupted run are moved on the next start.
import type { DatabaseSync } from 'node:sqlite';
import { decodeItem, encodeItem } from '../contracts/geometry-transfer.ts';
import { canonicalJson, ModelStore, type StoredModel } from './model-store.ts';

type Log = (event: string, data: Record<string, unknown>) => void;
export type MoveOutcome =
  | { id: string; moved: true; bytes: number; versions: number; ms: number }
  | { id: string; moved: false; reason: string };

/** The stored form of an item: what `decodeItem` gives back after storage. */
const stored = (item: unknown) => {
  const { meta, geometry } = encodeItem(item);
  return decodeItem(meta, geometry);
};
/** The model as storage will give it back, for comparison. */
export function storedForm(model: StoredModel): StoredModel {
  return {
    ...(model.objects ? { objects: model.objects } : {}),
    scene: model.scene.map(stored),
    ...(model.definitions
      ? {
          definitions: Object.fromEntries(
            Object.entries(model.definitions).map(([k, v]) => [k, stored(v)]),
          ),
        }
      : {}),
  };
}

const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : 'MODEL_MOVE_FAILED';

/** Moves one request row; a row without a scene array or already moved is left as it is. */
export function moveRow(db: DatabaseSync, id: string, store = new ModelStore(db)): MoveOutcome {
  const started = performance.now();
  const row = db
    .prepare('SELECT projectId, state, result FROM workspace_requests WHERE id=?')
    .get(id) as { projectId: string; state: string; result: string | null } | undefined;
  if (!row || !row.result) return { id, moved: false, reason: 'NO_RESULT' };
  if (row.state === 'queued' || row.state === 'running')
    return { id, moved: false, reason: 'BUSY' };
  const bytes = row.result.length;
  const result = JSON.parse(row.result) as Record<string, unknown>;
  if (result.modelStore || !Array.isArray(result.scene))
    return { id, moved: false, reason: 'NOT_A_MODEL' };
  const { objects, scene, definitions, ...rest } = result;
  const model = { objects, scene, definitions } as StoredModel;
  if (model.objects === undefined) delete model.objects;
  if (model.definitions === undefined) delete model.definitions;
  const source = rest.sourceDocument as { revision?: unknown } | undefined;
  db.exec('SAVEPOINT model_move');
  try {
    const written = store.store(row.projectId, id, model, {
      documentRevision: typeof source?.revision === 'number' ? source.revision : null,
    });
    db.prepare('UPDATE workspace_requests SET result=? WHERE id=?').run(
      JSON.stringify({ ...rest, modelStore: 'manifest' }),
      id,
    );
    const rebuilt = store.load(row.projectId, id);
    if (!rebuilt || canonicalJson(rebuilt) !== canonicalJson(storedForm(model)))
      throw Object.assign(new Error('MODEL_MOVE_MISMATCH'), { code: 'MODEL_MOVE_MISMATCH' });
    db.exec('RELEASE model_move');
    return {
      id,
      moved: true,
      bytes,
      versions: written.versions,
      ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    db.exec('ROLLBACK TO model_move; RELEASE model_move');
    return { id, moved: false, reason: errorCode(error) };
  }
}

/** Request rows that still hold a scene array as JSON (one scan). */
export function pendingRows(db: DatabaseSync): string[] {
  return db
    .prepare(
      `SELECT id FROM workspace_requests WHERE result IS NOT NULL
        AND json_type(result,'$.scene')='array' AND state NOT IN ('queued','running') ORDER BY rowid`,
    )
    .all()
    .map((row) => String(row.id));
}

/**
 * Moves every pending row, one per transaction, letting the event loop run between rows.
 * Logs `model-move {request, bytes, versions, ms}` per row and `model-move-failed` for rows left
 * as JSON. `stop()` ends the run after the current row.
 */
export async function moveRows(
  db: DatabaseSync,
  options: { log?: Log; stop?: () => boolean; pause?: () => Promise<void> } = {},
) {
  const store = new ModelStore(db);
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const summary = { moved: 0, failed: 0, skipped: 0, bytes: 0, ms: 0 };
  const started = performance.now();
  for (const id of pendingRows(db)) {
    if (options.stop?.()) break;
    const outcome = moveRow(db, id, store);
    if (outcome.moved) {
      summary.moved++;
      summary.bytes += outcome.bytes;
      options.log?.('model-move', {
        request: id,
        bytes: outcome.bytes,
        versions: outcome.versions,
        ms: outcome.ms,
      });
    } else if (['BUSY', 'NOT_A_MODEL', 'NO_RESULT'].includes(outcome.reason)) summary.skipped++;
    else {
      summary.failed++;
      options.log?.('model-move-failed', { request: id, code: outcome.reason });
    }
    await pause();
  }
  summary.ms = Math.round(performance.now() - started);
  return summary;
}

/**
 * Gives the space of moved rows back once nothing is waiting or running (ARCH-01 §5): true when
 * VACUUM ran. When the engine stays busy the caller tries again later or at the next start.
 */
export function vacuumWhenIdle(db: DatabaseSync, idle: () => boolean): boolean {
  if (!idle()) return false;
  const busy = db
    .prepare("SELECT 1 FROM workspace_requests WHERE state IN ('queued','running') LIMIT 1")
    .get();
  if (busy) return false;
  try {
    db.exec('VACUUM');
    return true;
  } catch {
    // An open transaction or reader: the next idle moment or start tries again.
    return false;
  }
}

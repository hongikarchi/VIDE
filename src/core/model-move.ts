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

/**
 * The stored form of an item: what `decodeItem` gives back after storage (coordinates as float32
 * differences). Code comparing a stored scene item with a fresh one converts both with this.
 */
export const storedItem = (item: unknown) => {
  const { meta, geometry } = encodeItem(item);
  return decodeItem(meta, geometry);
};
/** The model as storage will give it back, for comparison. */
export function storedForm(model: StoredModel): StoredModel {
  return {
    ...(model.objects ? { objects: model.objects } : {}),
    scene: model.scene.map(storedItem),
    ...(model.definitions
      ? {
          definitions: Object.fromEntries(
            Object.entries(model.definitions).map(([k, v]) => [k, storedItem(v)]),
          ),
        }
      : {}),
  };
}

/** Same content: the plain serialization first (same key order), key-sorted when it differs. */
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b) || canonicalJson(a) === canonicalJson(b);
const mismatch = () =>
  Object.assign(new Error('MODEL_MOVE_MISMATCH'), { code: 'MODEL_MOVE_MISMATCH' });
const keyOf = (item: unknown) => {
  const { nativeId, id } = (item ?? {}) as { nativeId?: unknown; id?: unknown };
  return nativeId ?? id;
};
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
    if (!rebuilt || !equal(rebuilt, storedForm(model)))
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

/**
 * `moveRow` in steps, letting the event loop run between them so a large row (tens of MB) never
 * holds the engine for seconds: parse; encode in batches; insert versions in batches (immutable,
 * named by content); one short transaction for the manifest and the small result; then compare
 * the stored rows with the original in batches. A mismatch puts the original JSON back. A row that
 * changed while it was being prepared is left for the next run; one a Live Sync changed while it
 * was being compared is taken as stored (the compare stops there).
 */
export async function moveRowAsync(
  db: DatabaseSync,
  id: string,
  store = new ModelStore(db),
  pause: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve)),
  batch = 200,
): Promise<MoveOutcome> {
  const started = performance.now();
  const read = () =>
    db
      .prepare(
        'SELECT projectId, state, result, octet_length(result) AS size FROM workspace_requests WHERE id=?',
      )
      .get(id) as
      | { projectId: string; state: string; result: string | null; size: number | null }
      | undefined;
  const row = read();
  if (!row || !row.result) return { id, moved: false, reason: 'NO_RESULT' };
  if (row.state === 'queued' || row.state === 'running')
    return { id, moved: false, reason: 'BUSY' };
  const original = row.result;
  const bytes = original.length;
  const result = JSON.parse(original) as Record<string, unknown>;
  if (result.modelStore || !Array.isArray(result.scene))
    return { id, moved: false, reason: 'NOT_A_MODEL' };
  const { objects, scene, definitions, ...rest } = result;
  const model = { objects, scene, definitions } as StoredModel;
  if (model.objects === undefined) delete model.objects;
  if (model.definitions === undefined) delete model.definitions;
  const source = rest.sourceDocument as { revision?: unknown } | undefined;
  let prepared;
  try {
    await pause();
    prepared = await store.prepareAsync(model, pause, batch);
  } catch (error) {
    return { id, moved: false, reason: errorCode(error) };
  }
  const all = [...prepared.versions, ...prepared.defs.map(([, version]) => version)];
  let versions = 0;
  for (let at = 0; at < all.length; at += batch) {
    versions += store.insertVersions(row.projectId, all.slice(at, at + batch));
    await pause();
  }
  const unused = () =>
    store.sweep(
      row.projectId,
      all.map((version) => version.id),
    );
  const now = db
    .prepare('SELECT state, octet_length(result) AS size FROM workspace_requests WHERE id=?')
    .get(id) as { state: string; size: number | null } | undefined;
  if (!now || now.state !== row.state || now.size !== row.size) {
    unused();
    return { id, moved: false, reason: 'CHANGED' };
  }
  db.exec('SAVEPOINT model_move');
  let revision: number;
  try {
    revision = store.storePrepared(row.projectId, id, prepared, {
      documentRevision: typeof source?.revision === 'number' ? source.revision : null,
      versionsInserted: true,
    }).revision;
    db.prepare('UPDATE workspace_requests SET result=? WHERE id=?').run(
      JSON.stringify({ ...rest, modelStore: 'manifest' }),
      id,
    );
    db.exec('RELEASE model_move');
  } catch (error) {
    db.exec('ROLLBACK TO model_move; RELEASE model_move');
    unused();
    return { id, moved: false, reason: errorCode(error) };
  }
  // Compare in batches: each stored key in order against the original in its stored form.
  const sceneOf = new Map<string, unknown>();
  for (const item of model.scene) sceneOf.set(String(keyOf(item)), item);
  const objectOf = new Map<string, unknown>();
  for (const item of model.objects ?? []) objectOf.set(String(keyOf(item)), item);
  const view = store.view(row.projectId, id)!;
  const keys = view.keys();
  let same =
    keys.length === prepared.order.length && keys.every((key, at) => key === prepared.order[at]);
  for (let at = 0; same && at < keys.length; at += batch) {
    if (store.header(row.projectId, id)?.revision !== revision) break;
    for (const key of keys.slice(at, at + batch)) {
      const stored = sceneOf.has(key) ? view.scene(key) : undefined;
      if (
        !equal(view.object(key), objectOf.get(key)) ||
        (sceneOf.has(key) && !equal(stored, storedItem(sceneOf.get(key))))
      ) {
        same = false;
        break;
      }
    }
    await pause();
  }
  if (same && model.definitions && store.header(row.projectId, id)?.revision === revision)
    for (const [key, value] of Object.entries(model.definitions))
      if (!equal(view.definition(key), storedItem(value))) same = false;
  if (!same) {
    // Back to the original JSON; versions only this manifest used go with it.
    store.tx(() => {
      db.prepare('DELETE FROM sync_manifests WHERE requestId=?').run(id);
      db.prepare('UPDATE workspace_requests SET result=? WHERE id=?').run(original, id);
      unused();
    });
    return { id, moved: false, reason: mismatch().code };
  }
  return { id, moved: true, bytes, versions, ms: Math.round(performance.now() - started) };
}

/** Request rows that still hold a scene array as JSON (one scan). */
export function pendingRows(db: DatabaseSync): string[] {
  return db
    .prepare(
      // A large result is matched by text (parsing hundreds of MB of JSON here would hold the
      // engine); `moveRow` checks each one properly and leaves a false match as it is.
      `SELECT id FROM workspace_requests WHERE result IS NOT NULL AND state NOT IN ('queued','running')
        AND CASE WHEN octet_length(result) < 65536 THEN json_type(result,'$.scene')='array'
          ELSE instr(result,'"scene":[')>0 AND instr(result,'"modelStore"')=0 END ORDER BY rowid`,
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
    const outcome = await moveRowAsync(db, id, store, pause);
    if (outcome.moved) {
      summary.moved++;
      summary.bytes += outcome.bytes;
      options.log?.('model-move', {
        request: id,
        bytes: outcome.bytes,
        versions: outcome.versions,
        ms: outcome.ms,
      });
    } else if (['BUSY', 'NOT_A_MODEL', 'NO_RESULT', 'CHANGED'].includes(outcome.reason))
      summary.skipped++;
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

/**
 * The engine's storage upkeep after its address opens (ARCH-01 §5 「기존 결과 옮기기」·「정리」):
 * versions no manifest uses are deleted, rows stored as JSON are moved one at a time, then each
 * project keeps its newest Syncs (`retain`), and once nothing is waiting or running the file is
 * compacted (VACUUM). `stopped()` ends it between rows; what is left continues on the next start.
 */
export async function maintainModels(
  db: DatabaseSync,
  options: {
    log?: Log;
    stopped?: () => boolean;
    /** True while no request is queued or running and no Sync is being written. */
    idle?: () => boolean;
    /** Milliseconds between VACUUM attempts while the engine is busy. */
    retryMs?: number;
    pause?: () => Promise<void>;
  } = {},
) {
  const stopped = options.stopped ?? (() => false);
  const store = new ModelStore(db);
  const projects = () =>
    db
      .prepare('SELECT id FROM projects')
      .all()
      .map((row) => String(row.id));
  let swept = 0;
  for (const id of projects()) swept += store.sweep(id);
  if (swept) options.log?.('model-sweep', { versions: swept });
  const moved = await moveRows(db, { log: options.log, stop: stopped, pause: options.pause });
  if (moved.moved || moved.failed) options.log?.('model-move-done', moved);
  if (stopped()) return { swept, moved, retained: 0, vacuumed: false };
  let retained = 0;
  for (const id of projects()) {
    if (stopped()) break;
    try {
      const kept = store.retain(id);
      retained += kept.manifests;
      if (kept.manifests) options.log?.('model-retain', { project: id, ...kept });
    } catch (error) {
      options.log?.('model-retain-failed', { project: id, code: errorCode(error) });
    }
    await (options.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve))))();
  }
  let vacuumed = false;
  // Space freed by moving or pruning goes back to the disk when the engine is idle.
  if (moved.moved || retained) {
    const idle = options.idle ?? (() => true);
    const retry = options.retryMs ?? 60_000;
    for (let attempt = 0; attempt < 60 && !stopped(); attempt++) {
      const started = performance.now();
      vacuumed = vacuumWhenIdle(db, idle);
      if (vacuumed) {
        options.log?.('model-vacuum', { ms: Math.round(performance.now() - started) });
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, retry).unref());
    }
  }
  return { swept, moved, retained, vacuumed };
}

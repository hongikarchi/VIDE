import type { Store } from '../core/store.ts';
import type { Workspace } from '../core/workspace.ts';
import type { Records } from '../core/records.ts';
import {
  buildObjectRecordIndex,
  objectEntries,
  objectRecords,
  type IndexedRequest,
  type ObjectRecordIndex,
  type ObjectRecordsResult,
} from '../core/object-record-index.ts';
import { latestSyncIds, syncObjectLayer } from './parts-status.ts';

/**
 * '이 객체의 기록' (SPEC-17.5, ARCH-01 §5 「프로젝트 기록」 `GET …/objects/:o/records?linkId=`,
 * PLAN-53 T-324). The object → request index is built from the stored requests' change lists when
 * asked and kept 15 s per project (no table); the object's layer comes from its file's latest Sync,
 * or else from the last change report that named it.
 */
export interface ObjectRecordsDeps {
  store: Store;
  workspace: Workspace;
  records: Records;
  /** Clock in ms (tests). */
  now?: () => number;
}

const KEEP_MS = 15_000;
const cache = new WeakMap<Store, Map<string, { at: number; index: ObjectRecordIndex }>>();

const json = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

/** The requests' change lists, without their models (Syncs are left out in SQL). */
function indexedRequests(store: Store, projectId: string): IndexedRequest[] {
  return store
    .db(projectId)
    .prepare(
      `SELECT id, json_extract(input,'$.source') AS source, json_extract(input,'$.linkId') AS linkId,
         json_extract(result,'$.changes') AS changes, json_extract(result,'$.executions') AS executions
         FROM workspace_requests
         WHERE projectId=? AND result IS NOT NULL AND json_valid(result) AND json_valid(input)
           AND (json_extract(input,'$.source') IS NULL OR json_extract(input,'$.source')<>'document')
           AND id NOT IN (SELECT requestId FROM sync_manifests WHERE projectId=?)
         ORDER BY rowid`,
    )
    .all(projectId, projectId)
    .map((row) => ({
      id: String(row.id),
      input: {
        ...(row.source !== null ? { source: row.source } : {}),
        ...(row.linkId !== null ? { linkId: row.linkId } : {}),
      },
      result: { changes: json(row.changes), executions: json(row.executions) },
    }));
}

/** The project's object → request index, read again after 15 s or when `fresh`. */
export function objectRecordIndexOf(
  deps: Pick<ObjectRecordsDeps, 'store' | 'now'>,
  projectId: string,
  fresh = false,
): ObjectRecordIndex {
  const now = deps.now?.() ?? Date.now();
  let kept = cache.get(deps.store);
  if (!kept) cache.set(deps.store, (kept = new Map()));
  const hit = kept.get(projectId);
  if (hit && !fresh && now - hit.at < KEEP_MS) return hit.index;
  const index = buildObjectRecordIndex(indexedRequests(deps.store, projectId));
  kept.set(projectId, { at: now, index });
  return index;
}

export function objectRecordsOf(deps: ObjectRecordsDeps) {
  return async (
    projectId: string,
    objectId: string,
    linkId?: string,
  ): Promise<ObjectRecordsResult> => {
    const index = objectRecordIndexOf(deps, projectId);
    const entries = objectEntries(index, objectId, linkId);
    // The object's layer: its file's latest Sync (the named file, the files that changed it, then
    // any file), else the last change report that carried one.
    const syncs = latestSyncIds(deps.store, projectId);
    const files = linkId
      ? [linkId]
      : [
          ...new Set([
            ...entries.flatMap((entry) => (entry.linkId ? [entry.linkId] : [])),
            ...syncs.keys(),
          ]),
        ];
    let objectLayer: string | undefined;
    for (const file of files) {
      const syncId = syncs.get(file);
      if (!syncId) continue;
      objectLayer = syncObjectLayer(deps.workspace, projectId, syncId, objectId);
      if (objectLayer) break;
    }
    objectLayer ??= entries
      .flatMap((entry) => entry.requests)
      .map((ref) => ref.layer)
      .filter(Boolean)
      .at(-1);
    return objectRecords({
      index,
      objectId,
      ...(linkId ? { linkId } : {}),
      records: deps.records.list(projectId).records,
      parts: deps.records.parts(projectId),
      ...(objectLayer ? { objectLayer } : {}),
    });
  };
}

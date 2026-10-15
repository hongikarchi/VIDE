import type { PartRow, RecordRow } from '../contracts/records.ts';

/**
 * 객체에서 기록으로 (SPEC-17.5, SPEC-03.8, ARCH-01 §5 「프로젝트 기록」 `GET …/objects/:o/records`,
 * PLAN-53 T-324): object id → the requests that added, changed or removed it, read from each
 * request's `result.changes` and `result.executions[].changes`. Pure: the server reads the rows and
 * keeps the index a few seconds. Undone requests stay in the index, marked `undone`; document Syncs
 * (`input.source === 'document'`) are not changes and are left out. The same id in two linked files
 * is two entries, told apart by the file's `linkId` (ADR-027).
 */
export type ObjectChangeKind = 'added' | 'modified' | 'removed';

/** The part of a stored request the index reads (a `StoredWork` fits). */
export interface IndexedRequest {
  id: string;
  input: { source?: unknown; linkId?: unknown; [key: string]: unknown };
  result: { changes?: unknown; executions?: unknown; [key: string]: unknown } | null;
}

/** One request that touched an object. */
export interface ObjectRequestRef {
  requestId: string;
  kinds: ObjectChangeKind[];
  /** Every execution through which this request touched the object was undone. */
  undone: boolean;
  /** The object's layer as the change report gave it (Rhino reports carry it). */
  layer?: string;
}

export interface ObjectRecordEntry {
  id: string;
  /** The linked file (ADR-027); absent when the request names none. */
  linkId?: string;
  requestIds: string[];
  kinds: ObjectChangeKind[];
  /** Every request that touched the object was undone. */
  undone: boolean;
  requests: ObjectRequestRef[];
}

/** Keyed by `indexKey(linkId, id)`. */
export type ObjectRecordIndex = Map<string, ObjectRecordEntry>;

export const indexKey = (linkId: string | undefined, id: string) => `${linkId ?? ''}\u0000${id}`;

const KINDS: readonly ObjectChangeKind[] = ['added', 'modified', 'removed'];
/** Change list names: model changes say `modified`, a host execute's report says `changed`. */
const LISTS: Record<string, ObjectChangeKind> = {
  added: 'added',
  modified: 'modified',
  changed: 'modified',
  removed: 'removed',
};

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** An item of a change list: an id string, or `{id}` / `{nativeId, layer}` (host reports). */
function itemOf(value: unknown): { id: string; layer?: string } | undefined {
  if (typeof value === 'string') return value ? { id: value } : undefined;
  const item = record(value);
  const id = text(item.id) ?? text(item.nativeId) ?? text(item.handle);
  if (!id) return undefined;
  const layer = text(item.layer) ?? text(item.layerName);
  return layer ? { id, layer } : { id };
}

function* changedItems(changes: unknown) {
  const lists = record(changes);
  for (const [name, kind] of Object.entries(LISTS)) {
    const list = lists[name];
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      const item = itemOf(value);
      if (item) yield { ...item, kind };
    }
  }
}

export function buildObjectRecordIndex(rows: Iterable<IndexedRequest>): ObjectRecordIndex {
  const index: ObjectRecordIndex = new Map();
  // Per object and request: kinds, layer, and whether each contributing execution was undone.
  const touch = (
    linkId: string | undefined,
    requestId: string,
    item: { id: string; layer?: string; kind: ObjectChangeKind },
    undone: boolean,
  ) => {
    const key = indexKey(linkId, item.id);
    let entry = index.get(key);
    if (!entry) {
      entry = {
        id: item.id,
        ...(linkId ? { linkId } : {}),
        requestIds: [],
        kinds: [],
        undone: true,
        requests: [],
      };
      index.set(key, entry);
    }
    let ref = entry.requests.find((one) => one.requestId === requestId);
    if (!ref) {
      ref = { requestId, kinds: [], undone: true };
      entry.requests.push(ref);
      entry.requestIds.push(requestId);
    }
    if (!ref.kinds.includes(item.kind)) ref.kinds.push(item.kind);
    if (!entry.kinds.includes(item.kind)) entry.kinds.push(item.kind);
    if (item.layer) ref.layer = item.layer;
    ref.undone &&= undone;
  };
  for (const row of rows) {
    if (row.input?.source === 'document' || !row.result) continue;
    const inputLink = text(row.input.linkId);
    const executions = Array.isArray(row.result.executions)
      ? row.result.executions.map(record)
      : [];
    const allUndone = executions.length > 0 && executions.every((one) => one.state === 'undone');
    for (const execution of executions) {
      const linkId = text(record(execution.file).linkId) ?? inputLink;
      for (const item of changedItems(execution.changes))
        touch(linkId, row.id, item, execution.state === 'undone');
    }
    // The request's own change list: its file is the request's link, or the one file all its
    // executions ran in.
    const files = new Set(executions.map((one) => text(record(one.file).linkId)).filter(Boolean));
    const linkId = inputLink ?? (files.size === 1 ? [...files][0] : undefined);
    for (const item of changedItems(row.result.changes)) touch(linkId, row.id, item, allUndone);
  }
  for (const entry of index.values()) {
    entry.undone = entry.requests.every((ref) => ref.undone);
    entry.kinds.sort((a, b) => KINDS.indexOf(a) - KINDS.indexOf(b));
  }
  return index;
}

/** The entries of an object: one file's (`linkId`), or every file's when none is named. */
export function objectEntries(
  index: ObjectRecordIndex,
  objectId: string,
  linkId?: string,
): ObjectRecordEntry[] {
  if (linkId) {
    const entry = index.get(indexKey(linkId, objectId));
    // A request that named no file may still have touched it; only when nothing names this file.
    const loose = index.get(indexKey(undefined, objectId));
    return entry ? [entry] : loose ? [loose] : [];
  }
  return [...index.values()].filter((entry) => entry.id === objectId);
}

export interface ObjectRecordsInput {
  index: ObjectRecordIndex;
  objectId: string;
  linkId?: string;
  records: readonly RecordRow[];
  parts: readonly PartRow[];
  /** The object's layer in its file (latest Sync, or the last change report). */
  objectLayer?: string;
}

export interface ObjectRecordsResult {
  records: RecordRow[];
  via: { requestIds: string[]; partIds: string[] };
}

const order = (a: RecordRow, b: RecordRow) =>
  a.date.localeCompare(b.date) ||
  (a.time ?? '').localeCompare(b.time ?? '') ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.id.localeCompare(b.id);

/**
 * '이 객체의 기록': records pointing at a request that changed the object, and records of the
 * parts whose mapping reaches it (its layer, or its id in an object group), by date. Records a
 * person set aside (`dropped`) are not shown.
 */
export function objectRecords(input: ObjectRecordsInput): ObjectRecordsResult {
  const { objectId, linkId, objectLayer } = input;
  const requestIds = [
    ...new Set(objectEntries(input.index, objectId, linkId).flatMap((entry) => entry.requestIds)),
  ];
  const sameFile = (mappingLink: string) => !linkId || mappingLink === linkId;
  const partIds = input.parts
    .filter((part) =>
      part.mapping.some(
        (mapping) =>
          (mapping.kind === 'layer' &&
            objectLayer !== undefined &&
            mapping.layer === objectLayer &&
            sameFile(mapping.linkId)) ||
          (mapping.kind === 'objects' &&
            mapping.ids.includes(objectId) &&
            sameFile(mapping.linkId)),
      ),
    )
    .map((part) => part.id);
  const requests = new Set(requestIds);
  const parts = new Set(partIds);
  const records = input.records
    .filter(
      (row) =>
        row.state !== 'dropped' &&
        ((row.attachments.requestId !== undefined && requests.has(row.attachments.requestId)) ||
          row.parts.some((part) => parts.has(part))),
    )
    .sort(order);
  return { records, via: { requestIds, partIds } };
}

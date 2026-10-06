// Display geometry of request results stored per object (PLAN-27 1단계, ARCH-01 §5 「Sync 표시 형상의
// 객체 단위 저장(T-083)」). An object version (one `objects[]` row and the `scene[]` item of the same
// key, or one block definition) is stored once per project under its content fingerprint; a
// manifest lists, per request, which version each key shows. A full Sync of an unchanged document
// writes only manifest rows; a Live Sync writes the changed versions and their rows.
//
// Pure storage: takes the engine's DatabaseSync, never touches `workspace_requests` except the
// small result fields named in a patch and the `modelStore` marker. Every write runs in one
// SAVEPOINT, so it is atomic on its own and nests inside a caller's transaction.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  decodeItem,
  encodeItem,
  joinGeometry,
  type EncodedItem,
} from '../contracts/geometry-transfer.ts';

type Item = Record<string, unknown>;
/** The display part of a result: what moves out of `workspace_requests.result`. */
export type StoredModel = {
  objects?: Item[];
  scene: unknown[];
  definitions?: Record<string, unknown>;
};
/** A Live Sync change page (same shape as `applyDisplayDelta`'s delta). */
export type ModelDelta = {
  objects: Item[];
  scene: Item[];
  removed: string[];
  definitions?: Record<string, unknown>;
};
type VersionMeta = { object?: Item; scene?: unknown } | { definition: unknown };
type Version = {
  id: string;
  kind: Kind;
  meta: VersionMeta;
  text: string;
  geometry: Uint8Array | null;
};
type Kind = 'object' | 'definition';
/** One encoded, fingerprinted object or definition (see `ModelStore.prepare`). */
export type PreparedVersion = Version;
/** A model encoded and fingerprinted, ready to store (`ModelStore.prepare`). */
export type PreparedModel = {
  order: string[];
  versions: Version[];
  defs: (readonly [string, Version])[];
  hasObjects: boolean;
  hasDefinitions: boolean;
};

/** Removed-key records older than this many manifest revisions are dropped (ARCH-01 §5). */
export const REMOVED_HISTORY = 100;
/** Sync manifests kept per document besides referenced ones (2026-10-02 사용자 결정). */
export const KEEP_SYNCS = 20;

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

/** JSON with object keys sorted, so equal content gives equal text whatever the key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Item)
      .filter(([, v]) => v !== undefined && typeof v !== 'function')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Content fingerprint of an object version: SHA-256 of kind, key-sorted meta and geometry bytes. */
export function versionId(kind: Kind, meta: unknown, geometry: Uint8Array | null): string {
  const hash = createHash('sha256');
  hash.update(kind).update('\0').update(canonicalJson(meta)).update('\0');
  if (geometry) hash.update(geometry);
  return hash.digest('hex');
}

/** The key a delta uses for an item (as `applyDisplayDelta`): native ID, else ID. */
const keyOf = (item: unknown): string | undefined => {
  if (!item || typeof item !== 'object') return undefined;
  const { nativeId, id } = item as Item;
  const key = nativeId ?? id;
  return typeof key === 'string' ? key : undefined;
};

/**
 * One order holding the object order and the scene order: object keys keep their positions and
 * scene-only keys sit between them. Duplicate keys or a scene order that contradicts the object
 * order cannot be rebuilt from one position per key, so such a result stays JSON.
 */
function sequence(objectKeys: string[], sceneKeys: string[]): string[] {
  const at = new Map<string, number>();
  objectKeys.forEach((key, index) => {
    if (at.has(key)) fail('MODEL_STORE_UNSUPPORTED');
    at.set(key, index);
  });
  const seen = new Set<string>();
  const out: string[] = [];
  let next = 0;
  for (const key of sceneKeys) {
    if (seen.has(key)) fail('MODEL_STORE_UNSUPPORTED');
    seen.add(key);
    const index = at.get(key);
    if (index === undefined) {
      out.push(key);
      continue;
    }
    if (index < next) fail('MODEL_STORE_UNSUPPORTED');
    for (; next <= index; next++) out.push(objectKeys[next]);
  }
  for (; next < objectKeys.length; next++) out.push(objectKeys[next]);
  return out;
}

const parseMeta = (text: string) => JSON.parse(text) as VersionMeta & Item;
const bytesOf = (value: unknown): Uint8Array | null =>
  value instanceof Uint8Array ? value : value ? new Uint8Array(value as ArrayBuffer) : null;

function objectVersion(object: Item | undefined, encoded: EncodedItem | undefined): Version {
  const meta: VersionMeta = {
    ...(object !== undefined ? { object } : {}),
    ...(encoded ? { scene: encoded.meta } : {}),
  };
  const geometry = encoded?.geometry ?? null;
  return {
    id: versionId('object', meta, geometry),
    kind: 'object',
    meta,
    text: JSON.stringify(meta),
    geometry,
  };
}
function definitionVersion(definition: unknown): Version {
  const encoded = encodeItem(definition);
  const meta = { definition: encoded.meta };
  return {
    id: versionId('definition', meta, encoded.geometry),
    kind: 'definition',
    meta,
    text: JSON.stringify(meta),
    geometry: encoded.geometry,
  };
}

type Header = {
  requestId: string;
  projectId: string;
  parentId: string | null;
  documentRevision: number | null;
  revision: number;
  objectCount: number | null;
  definitionCount: number | null;
  updatedAt: string;
};
export type DeltaSince =
  | { requestId: string; revision: number; full: true }
  | {
      requestId: string;
      revision: number;
      since: number;
      full?: false;
      objects: Item[];
      scene: EncodedItem[];
      definitions: [string, EncodedItem][];
      removed: string[];
    };

/** Lazy reads of one stored model: nothing is decoded until asked for. */
export class ModelView {
  readonly requestId: string;
  readonly revision: number;
  private store: ModelStore;
  private projectId: string;
  private objectCount: number | null;
  constructor(store: ModelStore, projectId: string, header: Header) {
    this.store = store;
    this.projectId = projectId;
    this.objectCount = header.objectCount;
    this.requestId = header.requestId;
    this.revision = header.revision;
  }
  /** Object keys in display order. */
  keys(): string[] {
    return this.store.db
      .prepare(
        "SELECT key FROM sync_manifest_items WHERE requestId=? AND kind='object' ORDER BY position",
      )
      .all(this.requestId)
      .map((row) => String(row.key));
  }
  private row(kind: Kind, key: string) {
    const row = this.store.db
      .prepare(
        `SELECT v.meta, v.geometry FROM sync_manifest_items i JOIN object_versions v
          ON v.projectId=i.projectId AND v.id=i.versionId WHERE i.requestId=? AND i.kind=? AND i.key=?`,
      )
      .get(this.requestId, kind, key);
    return row ? { meta: parseMeta(String(row.meta)), geometry: bytesOf(row.geometry) } : undefined;
  }
  /** The `objects[]` row of a key. */
  object(key: string): Item | undefined {
    return (this.row('object', key)?.meta as { object?: Item } | undefined)?.object;
  }
  /** The decoded `scene[]` item of a key. */
  scene(key: string): unknown {
    const row = this.row('object', key);
    const scene = (row?.meta as { scene?: unknown } | undefined)?.scene;
    return scene === undefined ? undefined : decodeItem(scene, row!.geometry);
  }
  definition(id: string): unknown {
    const row = this.row('definition', id);
    return row
      ? decodeItem((row.meta as { definition: unknown }).definition, row.geometry)
      : undefined;
  }
  /** `objects[]` rows (meta only, no geometry), all or the given keys, in display order. */
  rows(keys?: string[]): Item[] {
    const wanted = keys ? new Set(keys) : undefined;
    const out: Item[] = [];
    for (const row of this.store.db
      .prepare(
        `SELECT i.key, v.meta FROM sync_manifest_items i JOIN object_versions v
          ON v.projectId=i.projectId AND v.id=i.versionId
          WHERE i.requestId=? AND i.kind='object' ORDER BY i.position`,
      )
      .iterate(this.requestId)) {
      if (wanted && !wanted.has(String(row.key))) continue;
      const object = (parseMeta(String(row.meta)) as { object?: Item }).object;
      if (object) out.push(object);
    }
    return out;
  }
  /** One page of the object rows in display order (T-127 `/objects?offset=&limit=`). */
  rowsPage(offset: number, limit: number): Item[] {
    const out: Item[] = [];
    for (const row of this.store.db
      .prepare(
        `SELECT v.meta FROM sync_manifest_items i JOIN object_versions v
          ON v.projectId=i.projectId AND v.id=i.versionId
          WHERE i.requestId=? AND i.kind='object' ORDER BY i.position LIMIT ? OFFSET ?`,
      )
      .iterate(this.requestId, limit, offset)) {
      const object = (parseMeta(String(row.meta)) as { object?: Item }).object;
      if (object) out.push(object);
    }
    return out;
  }
  /**
   * `scene[]` items without their coordinate arrays (meta only: ids, layer, measurements, block),
   * in display order. For readers that never draw: layer counts, samples, measured values.
   */
  sceneMeta(): Item[] {
    const out: Item[] = [];
    for (const row of this.store.db
      .prepare(
        `SELECT v.meta FROM sync_manifest_items i JOIN object_versions v
          ON v.projectId=i.projectId AND v.id=i.versionId
          WHERE i.requestId=? AND i.kind='object' ORDER BY i.position`,
      )
      .iterate(this.requestId)) {
      const scene = (parseMeta(String(row.meta)) as { scene?: Item }).scene;
      if (scene && typeof scene === 'object')
        out.push(Object.fromEntries(Object.entries(scene).filter(([, v]) => v !== '$bin')));
    }
    return out;
  }
  /** How many objects the result lists (its `objects` rows; scene items without them). */
  count(): number {
    if (this.objectCount !== null) return this.objectCount;
    return Number(
      this.store.db
        .prepare(
          "SELECT count(*) AS n FROM sync_manifest_items WHERE requestId=? AND kind='object'",
        )
        .get(this.requestId)!.n,
    );
  }
  /**
   * Object rows and scene meta (no coordinate arrays) of the given object ids, or of the first
   * `limit` objects in display order (T-123: an AI turn reads what it sends, not the model). An id
   * is looked up as a manifest key first (`nativeId ?? id`), then among the rows' own ids.
   * `limit: Infinity` reads every object (still without coordinates).
   */
  entries(options: { ids?: readonly string[]; limit?: number }): { object?: Item; scene?: Item }[] {
    const db = this.store.db;
    const shape = (text: string) => {
      const meta = parseMeta(text) as { object?: Item; scene?: Item };
      const scene =
        meta.scene && typeof meta.scene === 'object'
          ? Object.fromEntries(Object.entries(meta.scene).filter(([, v]) => v !== '$bin'))
          : undefined;
      return { ...(meta.object ? { object: meta.object } : {}), ...(scene ? { scene } : {}) };
    };
    const join = `FROM sync_manifest_items i JOIN object_versions v
      ON v.projectId=i.projectId AND v.id=i.versionId WHERE i.requestId=? AND i.kind='object'`;
    if (!options.ids)
      return db
        .prepare(`SELECT v.meta ${join} ORDER BY i.position LIMIT ?`)
        .all(
          this.requestId,
          options.limit === Infinity ? -1 : Math.max(0, Math.floor(options.limit ?? 0)),
        )
        .map((row) => shape(String(row.meta)));
    const one = db.prepare(`SELECT v.meta ${join} AND i.key=?`);
    const found = new Map<string, ReturnType<typeof shape>>();
    // An object row and its scene item under different keys (a scene item without `nativeId`)
    // are completed by one scan of the manifest.
    const incomplete = new Set<string>();
    for (const id of new Set(options.ids)) {
      const row = one.get(this.requestId, id);
      const entry = row ? shape(String(row.meta)) : {};
      found.set(id, entry);
      if (!entry.object || !entry.scene) incomplete.add(id);
    }
    if (incomplete.size)
      for (const row of db.prepare(`SELECT v.meta ${join}`).iterate(this.requestId)) {
        const entry = shape(String(row.meta));
        const id = String(entry.object?.id ?? entry.scene?.id ?? '');
        if (!incomplete.has(id)) continue;
        const known = found.get(id)!;
        known.object ??= entry.object;
        known.scene ??= entry.scene;
        if (known.object && known.scene) {
          incomplete.delete(id);
          if (!incomplete.size) break;
        }
      }
    for (const [id, entry] of found) if (!entry.object && !entry.scene) found.delete(id);
    return options.ids.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
  }
  /** VGT1 of the request (`root` is the stored request with its small result). */
  geometry(root: Record<string, unknown>): Uint8Array {
    return this.store.geometry(this.projectId, this.requestId, root);
  }
}

export class ModelStore {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  /** Runs `write` in one SAVEPOINT (nests inside a caller's transaction). */
  tx<T>(write: () => T): T {
    const name = `model_store_${this.depth++}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const value = write();
      this.db.exec(`RELEASE ${name}`);
      return value;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    } finally {
      this.depth--;
    }
  }
  header(projectId: string, requestId: string): Header | undefined {
    const row = this.db
      .prepare('SELECT * FROM sync_manifests WHERE requestId=? AND projectId=?')
      .get(requestId, projectId);
    return row as Header | undefined;
  }
  private insertVersion(projectId: string, version: Version): number {
    const size = version.text.length + (version.geometry?.byteLength ?? 0);
    return Number(
      this.db
        .prepare('INSERT OR IGNORE INTO object_versions VALUES(?,?,?,?,?,?)')
        .run(projectId, version.id, version.kind, version.text, version.geometry, size).changes,
    );
  }
  private count(requestId: string, kind: Kind) {
    return Number(
      this.db
        .prepare('SELECT count(*) AS n FROM sync_manifest_items WHERE requestId=? AND kind=?')
        .get(requestId, kind)!.n,
    );
  }

  /** Checks a model's keys and order (MODEL_STORE_UNSUPPORTED when it cannot be stored). */
  private shape(model: StoredModel) {
    if (!Array.isArray(model.scene)) fail('MODEL_STORE_UNSUPPORTED');
    if (model.objects !== undefined && !Array.isArray(model.objects))
      fail('MODEL_STORE_UNSUPPORTED');
    const definitions =
      model.definitions && typeof model.definitions === 'object' ? model.definitions : undefined;
    const objects = new Map<string, Item>();
    const objectKeys: string[] = [];
    for (const object of model.objects ?? []) {
      const key = keyOf(object) ?? fail('MODEL_STORE_UNSUPPORTED');
      objects.set(key, object);
      objectKeys.push(key);
    }
    const scene = new Map<string, unknown>();
    const sceneKeys: string[] = [];
    for (const item of model.scene) {
      const key = keyOf(item) ?? fail('MODEL_STORE_UNSUPPORTED');
      scene.set(key, item);
      sceneKeys.push(key);
    }
    const order = sequence(objectKeys, sceneKeys);
    const version = (key: string) =>
      objectVersion(objects.get(key), scene.has(key) ? encodeItem(scene.get(key)) : undefined);
    return { order, version, definitions, hasObjects: model.objects !== undefined };
  }
  private prepared(shape: ReturnType<ModelStore['shape']>, versions: Version[]): PreparedModel {
    return {
      order: shape.order,
      versions,
      defs: Object.entries(shape.definitions ?? {}).map(
        ([key, value]) => [key, definitionVersion(value)] as const,
      ),
      hasObjects: shape.hasObjects,
      hasDefinitions: !!shape.definitions,
    };
  }
  /** Encodes and fingerprints every object and definition of a model (no database access). */
  prepare(model: StoredModel): PreparedModel {
    const shape = this.shape(model);
    return this.prepared(shape, shape.order.map(shape.version));
  }
  /** `prepare` in batches, letting the event loop run between them (moving large rows). */
  async prepareAsync(model: StoredModel, pause: () => Promise<void>, batch = 500) {
    const shape = this.shape(model);
    const versions: Version[] = [];
    for (let at = 0; at < shape.order.length; at += batch) {
      for (const key of shape.order.slice(at, at + batch)) versions.push(shape.version(key));
      await pause();
    }
    return this.prepared(shape, versions);
  }
  /**
   * Inserts versions ahead of their manifest (they are immutable and named by content, so this
   * needs no transaction with it; a version no manifest ends up using is swept). Returns how many
   * were new.
   */
  insertVersions(projectId: string, versions: readonly PreparedVersion[]) {
    return this.tx(() => {
      let written = 0;
      for (const version of versions) written += this.insertVersion(projectId, version);
      return written;
    });
  }

  /**
   * Stores the display part of a result as the manifest of `requestId` (the request row must
   * exist). Storing again over an existing manifest raises its revision and marks only the keys
   * whose version changed, so `deltaSince` serves it too. Throws MODEL_STORE_UNSUPPORTED for a
   * model that cannot be rebuilt from one position per key (the caller keeps it as JSON).
   */
  store(
    projectId: string,
    requestId: string,
    model: StoredModel,
    options: { parentId?: string | null; documentRevision?: number | null } = {},
  ) {
    return this.storePrepared(projectId, requestId, this.prepare(model), options);
  }
  /**
   * `store` of a model already prepared (`prepare`, `prepareAsync`). `versionsInserted`: its
   * versions were inserted ahead (`insertVersions`), so only the manifest is written.
   */
  storePrepared(
    projectId: string,
    requestId: string,
    prepared: PreparedModel,
    options: {
      parentId?: string | null;
      documentRevision?: number | null;
      versionsInserted?: boolean;
    } = {},
  ) {
    const { order, versions, defs } = prepared;
    return this.tx(() => {
      const old = this.header(projectId, requestId);
      const revision = (old?.revision ?? 0) + 1;
      const previous = new Map<string, { versionId: string; revision: number }>();
      if (old)
        for (const row of this.db
          .prepare('SELECT kind,key,versionId,revision FROM sync_manifest_items WHERE requestId=?')
          .iterate(requestId))
          previous.set(`${row.kind}|${row.key}`, {
            versionId: String(row.versionId),
            revision: Number(row.revision),
          });
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO sync_manifests VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(requestId) DO UPDATE SET
            parentId=excluded.parentId, documentRevision=excluded.documentRevision,
            revision=excluded.revision, objectCount=excluded.objectCount,
            definitionCount=excluded.definitionCount, updatedAt=excluded.updatedAt`,
        )
        .run(
          requestId,
          projectId,
          options.parentId ?? old?.parentId ?? null,
          options.documentRevision ?? null,
          revision,
          prepared.hasObjects ? order.length : null,
          prepared.hasDefinitions ? defs.length : null,
          now,
        );
      this.db.prepare('DELETE FROM sync_manifest_items WHERE requestId=?').run(requestId);
      const insert = this.db.prepare('INSERT INTO sync_manifest_items VALUES(?,?,?,?,?,?,?)');
      const unremove = this.db.prepare(
        'DELETE FROM sync_manifest_removed WHERE requestId=? AND kind=? AND key=?',
      );
      let written = 0,
        bytes = 0;
      const put = (kind: Kind, key: string, position: number, version: Version) => {
        const added = options.versionsInserted ? 0 : this.insertVersion(projectId, version);
        written += added;
        if (added) bytes += version.text.length + (version.geometry?.byteLength ?? 0);
        const before = previous.get(`${kind}|${key}`);
        previous.delete(`${kind}|${key}`);
        const same = before?.versionId === version.id;
        insert.run(
          requestId,
          projectId,
          kind,
          key,
          position,
          version.id,
          same ? before!.revision : revision,
        );
        if (old && !before) unremove.run(requestId, kind, key);
        if (before && !same) candidates.add(before.versionId);
      };
      const candidates = new Set<string>();
      order.forEach((key, position) => put('object', key, position, versions[position]));
      defs.forEach(([key, version], position) => put('definition', key, position, version));
      const removed = this.db.prepare(
        'INSERT OR REPLACE INTO sync_manifest_removed VALUES(?,?,?,?)',
      );
      for (const [id, before] of previous) {
        const [kind, ...rest] = id.split('|');
        removed.run(requestId, kind, rest.join('|'), revision);
        candidates.add(before.versionId);
      }
      const swept = this.sweep(projectId, [...candidates]);
      return { revision, versions: written, bytes, items: order.length + defs.length, swept };
    });
  }

  /**
   * Applies a Live Sync change page to the manifest in place, as `applyDisplayDelta` would to the
   * model: changed keys get their new version (a page that brings only the object row or only the
   * scene item keeps the other part's stored version bytes), new keys are appended, removed keys
   * leave and are recorded. `patch` sets small top-level result fields (sourceDocument, layers,
   * displayCoverage) in SQL. No stored geometry is read or decoded.
   */
  applyDelta(projectId: string, requestId: string, delta: ModelDelta, patch: Item = {}) {
    const header = this.header(projectId, requestId) ?? fail('NOT_FOUND');
    const changedObjects = new Map<string, Item>();
    const objectOrder: string[] = [];
    for (const object of delta.objects ?? []) {
      const key = keyOf(object) ?? fail('MODEL_STORE_UNSUPPORTED');
      if (!changedObjects.has(key)) objectOrder.push(key);
      changedObjects.set(key, object);
    }
    const changedScene = new Map<string, EncodedItem>();
    const sceneOrder: string[] = [];
    for (const item of delta.scene ?? []) {
      const key = keyOf(item) ?? fail('MODEL_STORE_UNSUPPORTED');
      if (!changedScene.has(key)) sceneOrder.push(key);
      changedScene.set(key, encodeItem(item));
    }
    for (const key of Object.keys(patch)) if (!/^[A-Za-z0-9_]+$/.test(key)) fail('INVALID_INPUT');
    return this.tx(() => {
      const revision = header.revision + 1;
      const candidates = new Set<string>();
      let changed = 0,
        removedCount = 0,
        written = 0;
      const find = this.db.prepare(
        'SELECT versionId, position FROM sync_manifest_items WHERE requestId=? AND kind=? AND key=?',
      );
      const removeRecord = this.db.prepare(
        'INSERT OR REPLACE INTO sync_manifest_removed VALUES(?,?,?,?)',
      );
      const drop = this.db.prepare(
        'DELETE FROM sync_manifest_items WHERE requestId=? AND kind=? AND key=?',
      );
      for (const key of new Set(delta.removed ?? [])) {
        const row = find.get(requestId, 'object', key);
        if (!row) continue;
        drop.run(requestId, 'object', key);
        removeRecord.run(requestId, 'object', key, revision);
        candidates.add(String(row.versionId));
        removedCount++;
      }
      const versionMeta = this.db.prepare(
        'SELECT meta, geometry FROM object_versions WHERE projectId=? AND id=?',
      );
      const setVersion = this.db.prepare(
        'UPDATE sync_manifest_items SET versionId=?, revision=? WHERE requestId=? AND kind=? AND key=?',
      );
      const insert = this.db.prepare('INSERT INTO sync_manifest_items VALUES(?,?,?,?,?,?,?)');
      const unremove = this.db.prepare(
        'DELETE FROM sync_manifest_removed WHERE requestId=? AND kind=? AND key=?',
      );
      const fresh: string[] = [];
      const freshScene: string[] = [];
      for (const key of new Set([...objectOrder, ...sceneOrder])) {
        const row = find.get(requestId, 'object', key);
        if (!row) {
          if (changedObjects.has(key)) fresh.push(key);
          else freshScene.push(key);
          continue;
        }
        const object = changedObjects.get(key);
        const scene = changedScene.get(key);
        let version: Version;
        if (object && scene) version = objectVersion(object, scene);
        else {
          // One part changed: the other keeps its stored meta and geometry bytes as they are.
          const stored = versionMeta.get(projectId, String(row.versionId))!;
          const meta = parseMeta(String(stored.meta)) as { object?: Item; scene?: unknown };
          version = object
            ? objectVersion(
                object,
                meta.scene === undefined
                  ? undefined
                  : { meta: meta.scene, geometry: bytesOf(stored.geometry) },
              )
            : objectVersion(meta.object, scene);
        }
        if (version.id === String(row.versionId)) continue;
        written += this.insertVersion(projectId, version);
        setVersion.run(version.id, revision, requestId, 'object', key);
        candidates.add(String(row.versionId));
        changed++;
      }
      // New keys go after the last position, objects' order with scene-only keys between them.
      const sceneOnlyOrder = sceneOrder.filter(
        (key) => fresh.includes(key) || freshScene.includes(key),
      );
      let position = Number(
        this.db
          .prepare(
            "SELECT coalesce(max(position), -1) AS p FROM sync_manifest_items WHERE requestId=? AND kind='object'",
          )
          .get(requestId)!.p,
      );
      for (const key of sequence(fresh, sceneOnlyOrder)) {
        const scene = changedScene.get(key);
        const version = objectVersion(changedObjects.get(key), scene);
        written += this.insertVersion(projectId, version);
        insert.run(requestId, projectId, 'object', key, ++position, version.id, revision);
        unremove.run(requestId, 'object', key);
        changed++;
      }
      let definitionPosition = Number(
        this.db
          .prepare(
            "SELECT coalesce(max(position), -1) AS p FROM sync_manifest_items WHERE requestId=? AND kind='definition'",
          )
          .get(requestId)!.p,
      );
      for (const [key, value] of Object.entries(delta.definitions ?? {})) {
        const version = definitionVersion(value);
        const row = find.get(requestId, 'definition', key);
        if (row && String(row.versionId) === version.id) continue;
        written += this.insertVersion(projectId, version);
        if (row) {
          setVersion.run(version.id, revision, requestId, 'definition', key);
          candidates.add(String(row.versionId));
        } else {
          insert.run(
            requestId,
            projectId,
            'definition',
            key,
            ++definitionPosition,
            version.id,
            revision,
          );
          unremove.run(requestId, 'definition', key);
        }
        changed++;
      }
      const moved = changed + removedCount > 0;
      this.db
        .prepare(
          `UPDATE sync_manifests SET revision=?, objectCount=?, definitionCount=?, updatedAt=?
            WHERE requestId=?`,
        )
        .run(
          moved ? revision : header.revision,
          header.objectCount === null ? null : this.count(requestId, 'object'),
          header.definitionCount === null && !delta.definitions
            ? null
            : this.count(requestId, 'definition'),
          new Date().toISOString(),
          requestId,
        );
      if (moved)
        this.db
          .prepare('DELETE FROM sync_manifest_removed WHERE requestId=? AND revision<=?')
          .run(requestId, revision - REMOVED_HISTORY - 1);
      for (const [key, value] of Object.entries(patch))
        this.db
          .prepare(
            `UPDATE workspace_requests SET result=json_set(result, '$.${key}', json(?)) WHERE id=? AND projectId=?`,
          )
          .run(JSON.stringify(value ?? null), requestId, projectId);
      const swept = this.sweep(projectId, [...candidates]);
      return {
        revision: moved ? revision : header.revision,
        changed,
        removed: removedCount,
        versions: written,
        swept,
      };
    });
  }

  /**
   * A new manifest for `toId` (its request row must exist) with the rows of `fromId`: versions are
   * shared, revisions are inherited and `parentId` is `fromId`. Used when a referenced Sync must
   * not change and a Live Sync continues on a copy.
   */
  copyManifest(projectId: string, fromId: string, toId: string) {
    const from = this.header(projectId, fromId) ?? fail('NOT_FOUND');
    return this.tx(() => {
      this.db
        .prepare('INSERT INTO sync_manifests VALUES(?,?,?,?,?,?,?,?)')
        .run(
          toId,
          projectId,
          fromId,
          from.documentRevision,
          from.revision,
          from.objectCount,
          from.definitionCount,
          new Date().toISOString(),
        );
      this.db
        .prepare(
          `INSERT INTO sync_manifest_items SELECT ?, projectId, kind, key, position, versionId, revision
            FROM sync_manifest_items WHERE requestId=?`,
        )
        .run(toId, fromId);
      this.db
        .prepare(
          'INSERT INTO sync_manifest_removed SELECT ?, kind, key, revision FROM sync_manifest_removed WHERE requestId=?',
        )
        .run(toId, fromId);
      return { revision: from.revision };
    });
  }

  /** The whole display part as it was stored (`objects`, decoded `scene`, `definitions`). */
  load(projectId: string, requestId: string): StoredModel | undefined {
    const header = this.header(projectId, requestId);
    if (!header) return undefined;
    const objects: Item[] = [];
    const scene: unknown[] = [];
    const definitions: Record<string, unknown> = {};
    for (const row of this.db
      .prepare(
        `SELECT i.kind, i.key, v.meta, v.geometry FROM sync_manifest_items i JOIN object_versions v
          ON v.projectId=i.projectId AND v.id=i.versionId WHERE i.requestId=? ORDER BY i.kind, i.position`,
      )
      .iterate(requestId)) {
      const meta = parseMeta(String(row.meta)) as Item;
      const geometry = bytesOf(row.geometry);
      if (row.kind === 'definition')
        definitions[String(row.key)] = decodeItem(meta.definition, geometry);
      else {
        if (meta.object !== undefined) objects.push(meta.object as Item);
        if (meta.scene !== undefined) scene.push(decodeItem(meta.scene, geometry));
      }
    }
    return {
      ...(header.objectCount === null ? {} : { objects }),
      scene,
      ...(header.definitionCount === null ? {} : { definitions }),
    };
  }

  view(projectId: string, requestId: string): ModelView | undefined {
    const header = this.header(projectId, requestId);
    return header ? new ModelView(this, projectId, header) : undefined;
  }

  /** Stored items as encoded parts, in display order, without decoding coordinates. */
  private encoded(requestId: string, minRevision = -1) {
    const objects: Item[] = [];
    const scene: EncodedItem[] = [];
    const definitions: [string, EncodedItem][] = [];
    for (const row of this.db
      .prepare(
        `SELECT i.kind, i.key, v.meta, v.geometry FROM sync_manifest_items i JOIN object_versions v
          ON v.projectId=i.projectId AND v.id=i.versionId
          WHERE i.requestId=? AND i.revision>? ORDER BY i.kind, i.position`,
      )
      .iterate(requestId, minRevision)) {
      const meta = parseMeta(String(row.meta)) as Item;
      const geometry = bytesOf(row.geometry);
      if (row.kind === 'definition')
        definitions.push([String(row.key), { meta: meta.definition, geometry }]);
      else {
        if (meta.object !== undefined) objects.push(meta.object as Item);
        if (meta.scene !== undefined) scene.push({ meta: meta.scene, geometry });
      }
    }
    return { objects, scene, definitions };
  }

  /**
   * VGT1 of a request from its stored parts: `root` is the request with its small result; the
   * stored `objects`, `scene` and `definitions` are put into `root.result` and only the `$bin`
   * offsets are shifted (no coordinate is decoded or encoded again).
   */
  geometry(projectId: string, requestId: string, root: Record<string, unknown>): Uint8Array {
    const header = this.header(projectId, requestId) ?? fail('NOT_FOUND');
    const { objects, scene, definitions } = this.encoded(requestId);
    const result: Item = { ...((root.result as Item | null) ?? {}) };
    if (header.objectCount !== null) result.objects = objects;
    return joinGeometry(
      { ...root, result },
      { scene, ...(header.definitionCount === null ? {} : { definitions }) },
    );
  }

  /**
   * Changes since a manifest revision (T-084 notifications): rows whose revision is greater than
   * `since`, keys removed since then, and the current revision. `base` is the request the caller
   * holds; when it is this manifest's parent the inherited revisions continue. Anything else, a
   * `since` ahead of the manifest or older than the kept removal records, answers `full: true`.
   */
  deltaSince(projectId: string, requestId: string, since: number, base?: string): DeltaSince {
    const header = this.header(projectId, requestId) ?? fail('NOT_FOUND');
    const full = { requestId, revision: header.revision, full: true as const };
    if (base && base !== requestId && base !== header.parentId) return full;
    if (!Number.isInteger(since) || since < 0 || since > header.revision) return full;
    if (since < header.revision - REMOVED_HISTORY) return full;
    const { objects, scene, definitions } = this.encoded(requestId, since);
    const removed = this.db
      .prepare(
        "SELECT key FROM sync_manifest_removed WHERE requestId=? AND kind='object' AND revision>? ORDER BY revision, key",
      )
      .all(requestId, since)
      .map((row) => String(row.key));
    return { requestId, revision: header.revision, since, objects, scene, definitions, removed };
  }

  /** A delta as one VGT1 container: `{requestId, revision, since, objects, scene, definitions, removed}`. */
  static deltaGeometry(delta: Exclude<DeltaSince, { full: true }>): Uint8Array {
    const { scene, definitions, ...rest } = delta;
    return joinGeometry({ ...rest, scene: [], definitions: {} }, { scene, definitions }, 'root');
  }

  /**
   * Deletes object versions no manifest row points at: the given candidates (after a write) or
   * all of the project's (engine start, after a purge). Returns how many were deleted.
   */
  sweep(projectId: string, candidates?: string[]): number {
    const orphan = `DELETE FROM object_versions WHERE projectId=? AND {match} AND NOT EXISTS(
      SELECT 1 FROM sync_manifest_items i WHERE i.projectId=object_versions.projectId
        AND i.versionId=object_versions.id)`;
    if (!candidates)
      return Number(this.db.prepare(orphan.replace('{match}', '1')).run(projectId).changes);
    const one = this.db.prepare(orphan.replace('{match}', 'id=?'));
    let deleted = 0;
    for (const id of new Set(candidates)) deleted += Number(one.run(projectId, id).changes);
    return deleted;
  }

  /**
   * Retention (2026-10-02 사용자 결정, ARCH-01 §5 「정리」): per document keep the newest
   * `keep` Sync manifests and every Sync something still points at (another request's input or
   * basis, a pin, a review, note, comparison, publication, shared feedback, jig read/bake, ledger
   * item). Other Sync manifests are deleted, their request results marked `modelStore: 'pruned'`,
   * then versions no manifest uses. Requests that are not document Syncs keep their manifests.
   */
  retain(projectId: string, keep = KEEP_SYNCS) {
    const syncs = this.db
      .prepare(
        `SELECT m.requestId AS id, w.state, w.input, w.createdAt FROM sync_manifests m
          JOIN workspace_requests w ON w.id=m.requestId
          WHERE m.projectId=? AND json_extract(w.input,'$.source')='document'
          ORDER BY w.createdAt DESC, w.rowid DESC`,
      )
      .all(projectId) as { id: string; state: string; input: string; createdAt: string }[];
    const groups = new Map<string, number>();
    const stale: string[] = [];
    for (const sync of syncs) {
      const input = JSON.parse(sync.input) as Item;
      const source = (input.sourceDocument ?? {}) as Item;
      const document =
        typeof input.linkId === 'string'
          ? `link:${input.linkId}`
          : `doc:${String(input.host ?? '')}|${String(source.instance ?? '')}|${String(source.documentId ?? '')}`;
      const seen = (groups.get(document) ?? 0) + 1;
      groups.set(document, seen);
      if (seen > keep && !['queued', 'running'].includes(sync.state)) stale.push(sync.id);
    }
    if (!stale.length) return { manifests: 0, versions: 0 };
    const referenced = this.references(projectId, stale);
    const doomed = stale.filter((id) => !referenced.has(id));
    return this.tx(() => {
      const candidates: string[] = [];
      const versions = this.db.prepare(
        'SELECT versionId FROM sync_manifest_items WHERE requestId=?',
      );
      for (const id of doomed) {
        for (const row of versions.iterate(id)) candidates.push(String(row.versionId));
        this.db.prepare('DELETE FROM sync_manifests WHERE requestId=?').run(id);
        this.db
          .prepare(
            `UPDATE workspace_requests SET result=json_set(result,'$.modelStore','pruned')
              WHERE id=? AND result IS NOT NULL`,
          )
          .run(id);
      }
      return { manifests: doomed.length, versions: this.sweep(projectId, candidates) };
    });
  }

  /**
   * Which of `ids` something other than their own request row points at: another request, a
   * review, a publication, shared feedback, a jig read or bake, a conversation's ledger or targets.
   * Pruning keeps these, and a Live Sync copies rather than edits them in place.
   */
  references(projectId: string, ids: string[]): Set<string> {
    const found = new Set<string>();
    const texts: { owner?: string; text: string }[] = [];
    for (const row of this.db
      .prepare(
        "SELECT id, input, json_extract(result,'$.baseRequestId') AS base FROM workspace_requests WHERE projectId=?",
      )
      .iterate(projectId)) {
      texts.push({ owner: String(row.id), text: String(row.input) });
      if (typeof row.base === 'string' && row.base !== row.id) found.add(row.base);
    }
    const direct = [
      'SELECT requestId AS id, payload AS text FROM review_snapshots WHERE projectId=?',
      'SELECT requestId AS id, NULL AS text FROM review_notes WHERE projectId=?',
      'SELECT requestId AS id, NULL AS text FROM publication_exports WHERE projectId=?',
      'SELECT requestId AS id, NULL AS text FROM shared_feedback WHERE projectId=?',
      `SELECT b.requestId AS id, b.items AS text FROM jig_bakes b JOIN jig_instances j ON j.id=b.instanceId
        WHERE j.projectId=?`,
      `SELECT NULL AS id, r.ref AS text FROM jig_reads r JOIN jig_instances j ON j.id=r.instanceId
        WHERE j.projectId=?`,
      `SELECT l.requestId AS id, l.body AS text FROM ledger_items l JOIN conversations c ON c.id=l.conversationId
        WHERE c.projectId=?`,
      'SELECT NULL AS id, targets AS text FROM conversations WHERE projectId=?',
    ];
    for (const sql of direct)
      for (const row of this.db.prepare(sql).iterate(projectId)) {
        if (typeof row.id === 'string') found.add(row.id);
        if (typeof row.text === 'string') texts.push({ text: row.text });
      }
    for (const id of ids) {
      if (found.has(id)) continue;
      if (texts.some((entry) => entry.owner !== id && entry.text.includes(id))) found.add(id);
    }
    return found;
  }
}

import type { Store } from '../core/store.ts';
import type { Workspace } from '../core/workspace.ts';
import type { Records } from '../core/records.ts';
import type { PartBreak, PartStatus } from '../contracts/records.ts';

/**
 * 부위 매핑 끊김 (SPEC-17 부위 사전·SPEC-17.7, ARCH-01 §5 「프로젝트 기록」 `GET …/parts/status`,
 * PLAN-53 T-325): each part's mapping is checked against the linked files' latest Sync layer lists
 * at read time; nothing is stored. A link with no Sync yet (closed since it was linked) cannot be
 * checked: that mapping is `unknown`, never broken (SPEC-17.7 '연결이 닫혀 있어 표시 못 함').
 */
export type { PartBreak, PartStatus };

export interface PartsStatusDeps {
  store: Store;
  workspace: Workspace;
  records: Records;
}

const decodeLayer = (value: unknown) => {
  if (typeof value !== 'string' || !value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
};
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/** Each link's latest succeeded document Sync, by link id. */
export function latestSyncIds(store: Store, projectId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of store
    .db(projectId)
    .prepare(
      `SELECT id, json_extract(input,'$.linkId') AS linkId FROM workspace_requests
        WHERE projectId=? AND state='succeeded' AND json_valid(input)
          AND json_extract(input,'$.source')='document'
          AND json_extract(input,'$.linkId') IS NOT NULL
        ORDER BY rowid`,
    )
    .iterate(projectId))
    out.set(String(row.linkId), String(row.id));
  return out;
}

/** Layer names of a Sync: counted from its manifest, or from an inline (older) stored model. */
export function syncLayers(workspace: Workspace, projectId: string, syncId: string): Set<string> {
  const view = workspace.model(projectId, syncId);
  if (view) return new Set(view.layerCounts().map((row) => decodeLayer(row.layer64)));
  const scene = (workspace.get(projectId, syncId).result as { scene?: unknown } | null)?.scene;
  const layers = new Set<string>();
  if (Array.isArray(scene))
    for (const item of scene)
      if (item && typeof item === 'object') layers.add(decodeLayer((item as Item).layer64));
  return layers;
}

type Item = Record<string, unknown>;
const layerOfItem = (item: Item | undefined) =>
  item
    ? (text(item.layer) ?? text(item.layerName) ?? (decodeLayer(item.layer64) || undefined))
    : undefined;

/** One object's layer in a Sync (its object row or scene item), if the Sync lists it. */
export function syncObjectLayer(
  workspace: Workspace,
  projectId: string,
  syncId: string,
  objectId: string,
): string | undefined {
  const view = workspace.model(projectId, syncId);
  if (view) {
    const entry = view.entries({ ids: [objectId] })[0];
    return entry ? (layerOfItem(entry.scene) ?? layerOfItem(entry.object)) : undefined;
  }
  const result = workspace.get(projectId, syncId).result as Item | null;
  const find = (list: unknown) =>
    Array.isArray(list)
      ? (list as Item[]).find(
          (item) => item && (item.id === objectId || item.nativeId === objectId),
        )
      : undefined;
  return layerOfItem(find(result?.scene)) ?? layerOfItem(find(result?.objects));
}

export function partsStatusOf(deps: PartsStatusDeps) {
  return async (projectId: string): Promise<{ parts: PartStatus[] }> => {
    const parts = deps.records.parts(projectId);
    const db = deps.store.db(projectId);
    const links = new Set(
      db
        .prepare('SELECT id FROM document_links WHERE projectId=?')
        .all(projectId)
        .map((row) => String(row.id)),
    );
    const syncs = latestSyncIds(deps.store, projectId);
    const layers = new Map<string, Set<string>>();
    const layersOf = (linkId: string) => {
      let known = layers.get(linkId);
      if (!known)
        layers.set(linkId, (known = syncLayers(deps.workspace, projectId, syncs.get(linkId)!)));
      return known;
    };
    const instance = db.prepare('SELECT 1 FROM jig_instances WHERE projectId=? AND id=?');
    return {
      parts: parts.map((part) => {
        const status: PartStatus = { partId: part.id, broken: [], reasons: [] };
        const unknown: number[] = [];
        part.mapping.forEach((mapping, index) => {
          let reason: PartBreak | undefined;
          if (mapping.kind === 'jig-output') {
            if (!instance.get(projectId, mapping.instanceId)) reason = 'instance-missing';
          } else if (!links.has(mapping.linkId)) reason = 'link-missing';
          else if (!syncs.has(mapping.linkId)) unknown.push(index);
          else if (mapping.kind === 'layer') {
            if (!layersOf(mapping.linkId).has(mapping.layer)) reason = 'layer-missing';
          }
          if (reason) {
            status.broken.push(index);
            status.reasons.push(reason);
          }
        });
        if (status.reasons[0]) status.reason = status.reasons[0];
        if (unknown.length) {
          status.unknown = true;
          status.unknownIndexes = unknown;
        }
        return status;
      }),
    };
  };
}

// 부위별 모델 묶음 (PLAN-53 T-333, ARCH-01 §5 「부위별 모델 묶음」, Design SCR-46): the objects the
// viewport already draws, grouped by the 부위 사전's mappings, and what the time cursor makes of them
// (켜짐 · 흐림 · 그 밖), plus the display-only offsets of [분리]. Pure: no DOM, no three.js, no
// server — it reads only the shown objects' `{id, sourceId, documentKey, layerName}` (the `lazy`
// reader rule: no Sync list, no ModelStore, no coordinates).
import { dayNumber, recordChains } from './records-chart.ts';
import type { PartRow, RecordRow } from '../contracts/records.ts';

/** A shown object as the viewport list holds it (src/ui/model.ts `objects[]`). */
export interface SceneObject {
  /** The shown id (`<linkId>::<id>` when several files are drawn). */
  id: string;
  /** The file's own id. */
  sourceId?: unknown;
  /** The linked file (`result:<id>` for a result that belongs to no file). */
  documentKey?: unknown;
  /** The decoded full layer path. */
  layerName?: unknown;
}
export interface SceneBundle {
  partId: string;
  grp: string | null;
  /** Shown ids, in the order the mappings reached them. */
  objectIds: string[];
  /** Mapping indexes not turned into objects: a jig output, or a file not drawn now. */
  unresolved: number[];
}
export interface RecordsScene {
  bundles: SceneBundle[];
  /** Shown objects in no bundle (그 밖), results of no file included. */
  unmapped: string[];
  /** Every shown id, in list order. */
  ids: string[];
  /** The parts each bundled object is in (part order). */
  partsOf: Map<string, string[]>;
}
export type PartLevel = 'on' | 'dim';

/** Display factors (Design SCR-46 「구현 기준」): 켜짐 · 흐림 · 그 밖. */
export const LEVEL_ON = 1;
export const LEVEL_DIM = 0.25;
export const LEVEL_OTHER = 0.12;
/** How far [분리] moves each further group, in model widths. */
export const SEPARATION = 1.2;

const linkOf = (object: SceneObject) =>
  typeof object.documentKey === 'string' && !object.documentKey.startsWith('result:')
    ? object.documentKey
    : undefined;
const sourceOf = (object: SceneObject) =>
  typeof object.sourceId === 'string' ? object.sourceId : object.id;
export const layerKey = (linkId: string, layer: string) => `${linkId}\u0000${layer}`;

/** `<linkId>\u0000<full layer path>` → shown ids, in one pass over the shown objects. */
export function layerIndexOf(objects: readonly SceneObject[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const object of objects) {
    const link = linkOf(object);
    if (!link || typeof object.layerName !== 'string') continue;
    const key = layerKey(link, object.layerName);
    const list = index.get(key);
    if (list) list.push(object.id);
    else index.set(key, [object.id]);
  }
  return index;
}

/**
 * Each part's objects: a `layer` mapping takes the objects of the same file whose layer path is
 * exactly that layer (sub-layers are not included), an `objects` mapping those of the same file
 * whose own id is listed. A `jig-output` mapping and a mapping whose file is not drawn stay
 * `unresolved`. An object can be in several bundles.
 */
export function bundleParts(input: {
  parts: readonly PartRow[];
  objects: readonly SceneObject[];
  layerIndex?: ReadonlyMap<string, readonly string[]>;
}): RecordsScene {
  const layerIndex = input.layerIndex ?? layerIndexOf(input.objects);
  const shownLinks = new Set<string>();
  for (const object of input.objects) {
    const link = linkOf(object);
    if (link) shownLinks.add(link);
  }
  // (linkId, own id) → shown ids, built only when some part lists objects.
  let bySource: Map<string, string[]> | undefined;
  const sourceIndex = () => {
    if (bySource) return bySource;
    bySource = new Map();
    for (const object of input.objects) {
      const link = linkOf(object);
      if (!link) continue;
      const key = layerKey(link, sourceOf(object));
      const list = bySource.get(key);
      if (list) list.push(object.id);
      else bySource.set(key, [object.id]);
    }
    return bySource;
  };
  const partsOf = new Map<string, string[]>();
  const bundles: SceneBundle[] = input.parts.map((part) => {
    const ids = new Set<string>();
    const unresolved: number[] = [];
    part.mapping.forEach((mapping, index) => {
      if (mapping.kind === 'jig-output' || !shownLinks.has(mapping.linkId)) {
        unresolved.push(index);
        return;
      }
      if (mapping.kind === 'layer') {
        for (const id of layerIndex.get(layerKey(mapping.linkId, mapping.layer)) ?? []) ids.add(id);
        return;
      }
      const index2 = sourceIndex();
      for (const own of mapping.ids)
        for (const id of index2.get(layerKey(mapping.linkId, own)) ?? []) ids.add(id);
    });
    for (const id of ids) {
      const list = partsOf.get(id);
      if (list) list.push(part.id);
      else partsOf.set(id, [part.id]);
    }
    return {
      partId: part.id,
      grp: part.grp?.trim() || null,
      objectIds: [...ids],
      unresolved,
    };
  });
  const ids = input.objects.map((object) => object.id);
  return { bundles, unmapped: ids.filter((id) => !partsOf.has(id)), ids, partsOf };
}

/** The records the model and the band show: 남김 and not replaced by a correction. */
export const sceneRecords = (records: readonly RecordRow[]) =>
  records.filter((record) => record.state === 'kept' && !record.supersededBy);

/**
 * The parts lit at the cursor (a day number): those with a shown record on or before it. [전부
 * 보기] lights every part; an episode lights only its parts whatever the cursor.
 */
export function partLevels(
  scene: Pick<RecordsScene, 'bundles'>,
  records: readonly RecordRow[],
  cursorDay: number,
  options: { episode?: ReadonlySet<string>; all?: boolean } = {},
): Map<string, PartLevel> {
  const levels = new Map<string, PartLevel>();
  if (options.all || options.episode) {
    for (const bundle of scene.bundles)
      levels.set(bundle.partId, options.all || options.episode!.has(bundle.partId) ? 'on' : 'dim');
    return levels;
  }
  const lit = new Set<string>();
  for (const record of records)
    if (record.state === 'kept' && !record.supersededBy && dayNumber(record.date) <= cursorDay)
      for (const part of record.parts) lit.add(part);
  for (const bundle of scene.bundles)
    levels.set(bundle.partId, lit.has(bundle.partId) ? 'on' : 'dim');
  return levels;
}

/** Each shown object's factor: its brightest part's level, 그 밖 for objects in no part. */
export function objectLevels(
  scene: Pick<RecordsScene, 'bundles' | 'unmapped'>,
  levels: ReadonlyMap<string, PartLevel>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of scene.unmapped) out[id] = LEVEL_OTHER;
  for (const bundle of scene.bundles) {
    const value = levels.get(bundle.partId) === 'on' ? LEVEL_ON : LEVEL_DIM;
    for (const id of bundle.objectIds) if (!(out[id]! >= value)) out[id] = value;
  }
  return out;
}

/** The part groups in [분리] order: '신설' first (in place), then by name. */
export function sceneGroups(scene: Pick<RecordsScene, 'bundles'>): string[] {
  const names = [...new Set(scene.bundles.flatMap((bundle) => (bundle.grp ? [bundle.grp] : [])))];
  return names.sort((a, b) => (a === '신설' ? -1 : b === '신설' ? 1 : a.localeCompare(b, 'ko')));
}

/**
 * [분리] (display only): the k-th group's objects move k × 1.2 model widths along x. An object in
 * two groups follows the group of its first part; parts with no group and 그 밖 stay in place.
 */
export function separationVectors(
  scene: Pick<RecordsScene, 'bundles'>,
  bounds: { min: readonly number[]; max: readonly number[] },
): Record<string, [number, number, number]> {
  const order = sceneGroups(scene);
  const width = Math.max(1e-6, (bounds.max[0] ?? 0) - (bounds.min[0] ?? 0));
  const out: Record<string, [number, number, number]> = {};
  const placed = new Set<string>();
  for (const bundle of scene.bundles) {
    if (!bundle.grp) continue;
    const k = order.indexOf(bundle.grp);
    for (const id of bundle.objectIds) {
      if (placed.has(id)) continue;
      placed.add(id);
      if (k > 0) out[id] = [k * width * SEPARATION, 0, 0];
    }
  }
  return out;
}

export interface SceneEpisode {
  /** `chapter:<name>` or `chain:<root record id>`. */
  id: string;
  kind: 'chapter' | 'chain';
  /** The chip text: the chapter, or '이야기 · ' and the root record's first 12 characters. */
  name: string;
  /** Its records in date order. */
  recordIds: string[];
  partIds: string[];
}

const byDate = (a: RecordRow, b: RecordRow) =>
  a.date.localeCompare(b.date) ||
  (a.time ?? '').localeCompare(b.time ?? '') ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.id.localeCompare(b.id);

/**
 * Episodes (records carry no episode field): chapters first (by name), then the chains of joined
 * records (by their first record's date). Only shown records with a part count.
 */
export function sceneEpisodes(records: readonly RecordRow[]): SceneEpisode[] {
  const shown = sceneRecords(records)
    .filter((record) => record.parts.length)
    .sort(byDate);
  const byId = new Map(shown.map((record) => [record.id, record]));
  const make = (id: string, kind: SceneEpisode['kind'], name: string, rows: RecordRow[]) => ({
    id,
    kind,
    name,
    recordIds: rows.map((row) => row.id),
    partIds: [...new Set(rows.flatMap((row) => row.parts))],
  });
  const chapters = new Map<string, RecordRow[]>();
  for (const record of shown)
    if (record.chapter) {
      const list = chapters.get(record.chapter);
      if (list) list.push(record);
      else chapters.set(record.chapter, [record]);
    }
  const out: SceneEpisode[] = [...chapters.keys()]
    .sort((a, b) => a.localeCompare(b, 'ko'))
    .map((name) => make(`chapter:${name}`, 'chapter', name, chapters.get(name)!));
  for (const chain of recordChains(shown)) {
    const rows = chain.ids
      .map((id) => byId.get(id)!)
      .filter(Boolean)
      .sort(byDate);
    const root = byId.get(chain.root);
    if (!root || rows.length < 2) continue;
    const first = (root.text.split('\n')[0] ?? '').trim();
    out.push(
      make(
        `chain:${chain.root}`,
        'chain',
        `이야기 · ${first.length > 12 ? `${first.slice(0, 12)}…` : first}`,
        rows,
      ),
    );
  }
  return out;
}

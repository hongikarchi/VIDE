import { sceneRepresentation, type DisplayGeometry } from './scene-representation.ts';

interface Keyed {
  id: string;
  nativeId?: string;
}
type SceneItem = Keyed & DisplayGeometry & { block?: { definition: string }; oversized?: boolean };
/**
 * The omission type of an object larger than one host reply: it is drawn as its bounding box, and
 * the coverage notice lists it with the types not shown in full (ADR-031 7).
 */
export const OVERSIZED_TYPE_SUFFIX = ' (16 MB 초과 · 상자로 표시)';
/** The omission type of a block whose nested blocks are shown only in part (`partial` definition). */
export const PARTIAL_BLOCK_TYPE_SUFFIX = ' (중첩 블록 일부 생략)';
/** Shared block definition display (definition space); only its content matters here. */
interface DefinitionItem {
  vertices: ArrayLike<number>;
  segments: ArrayLike<number>;
  texts: unknown[];
  partial?: boolean;
}
export interface DisplayDelta<O extends Keyed, S extends SceneItem, D = DefinitionItem> {
  objects: O[];
  scene: S[];
  /** Native IDs no longer shown (deleted, hidden or filtered). */
  removed: string[];
  /** Block definitions used by changed instances. */
  definitions?: Record<string, D>;
}

const key = (item: Keyed) => item.nativeId ?? item.id;
const shown = (definition?: DefinitionItem) =>
  !!definition &&
  (definition.vertices.length > 0 || definition.segments.length > 0 || definition.texts.length > 0);

/** Shown vs omitted scene items; omitted ones are counted per native type. */
export function displayCoverage(scene: SceneItem[], definitions?: Record<string, DefinitionItem>) {
  const omittedTypes: Record<string, number> = {};
  let omitted = 0;
  for (const item of scene) {
    const definition = item.block ? definitions?.[item.block.definition] : undefined;
    const visible = item.block
      ? item.valid !== false && shown(definition)
      : !!sceneRepresentation(item);
    // Marked partial even when nothing of it is left (the read's expansion budget ran out).
    const partial = item.valid !== false && definition?.partial === true;
    if (!visible || item.oversized || partial) {
      omitted++;
      const type = item.oversized
        ? `${item.nativeType}${OVERSIZED_TYPE_SUFFIX}`
        : partial
          ? `${item.nativeType}${PARTIAL_BLOCK_TYPE_SUFFIX}`
          : item.valid === false
            ? `${item.nativeType} (invalid)`
            : String(item.nativeType);
      omittedTypes[type] = (omittedTypes[type] ?? 0) + 1;
    }
  }
  return { total: scene.length, displayed: scene.length - omitted, omitted, omittedTypes };
}

/**
 * Applies changed/removed objects to a display model by native ID. Unchanged items keep their
 * position and identity; new items are appended in delta order. Definitions are replaced by ID.
 */
export function applyDisplayDelta<O extends Keyed, S extends SceneItem, D = DefinitionItem>(
  model: { objects: O[]; scene: S[]; definitions?: Record<string, D> },
  delta: DisplayDelta<O, S, D>,
) {
  const removed = new Set(delta.removed);
  const merge = <T extends Keyed>(current: T[], changed: T[]) => {
    const pending = new Map(changed.map((item) => [key(item), item]));
    const next: T[] = [];
    for (const item of current) {
      const id = key(item);
      if (removed.has(id)) continue;
      const replacement = pending.get(id);
      if (replacement) pending.delete(id);
      next.push(replacement ?? item);
    }
    next.push(...pending.values());
    return next;
  };
  const definitions =
    model.definitions || delta.definitions
      ? { ...model.definitions, ...delta.definitions }
      : undefined;
  return {
    objects: merge(model.objects, delta.objects),
    scene: merge(model.scene, delta.scene),
    ...(definitions ? { definitions } : {}),
  };
}

type Coverage = ReturnType<typeof displayCoverage>;
/**
 * `displayCoverage` after a change page, from the counts before it: `before` are the stored items
 * of the changed and removed keys, `after` the page's items (PLAN-27 1단계: a Live Sync never
 * decodes the whole model). `definitionOf` gives the definition a block instance shows after the
 * page. Undefined when the counts before are unknown; the caller then counts the whole model.
 */
export function coverageAfter(
  previous: Partial<Coverage> | undefined,
  before: SceneItem[],
  after: SceneItem[],
  definitionOf: (id: string) => DefinitionItem | undefined,
): Coverage | undefined {
  if (
    !previous ||
    typeof previous.total !== 'number' ||
    typeof previous.omitted !== 'number' ||
    !previous.omittedTypes
  )
    return undefined;
  const definitions = new Proxy({} as Record<string, DefinitionItem>, {
    get: (_target, id) => (typeof id === 'string' ? definitionOf(id) : undefined),
  });
  const gone = displayCoverage(before, definitions);
  const come = displayCoverage(after, definitions);
  const omittedTypes: Record<string, number> = { ...previous.omittedTypes };
  for (const [type, count] of Object.entries(gone.omittedTypes))
    omittedTypes[type] = (omittedTypes[type] ?? 0) - count;
  for (const [type, count] of Object.entries(come.omittedTypes))
    omittedTypes[type] = (omittedTypes[type] ?? 0) + count;
  for (const [type, count] of Object.entries(omittedTypes))
    if (count <= 0) delete omittedTypes[type];
  const total = previous.total - gone.total + come.total;
  const omitted = previous.omitted - gone.omitted + come.omitted;
  if (total < 0 || omitted < 0) return undefined;
  return { total, displayed: total - omitted, omitted, omittedTypes };
}

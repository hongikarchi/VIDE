import { sceneRepresentation, type DisplayGeometry } from './scene-representation.ts';

interface Keyed {
  id: string;
  nativeId?: string;
}
type SceneItem = Keyed & DisplayGeometry & { block?: { definition: string } };
/** Shared block definition display (definition space); only its content matters here. */
interface DefinitionItem {
  vertices: number[];
  segments: number[];
  texts: unknown[];
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
    const visible = item.block
      ? item.valid !== false && shown(definitions?.[item.block.definition])
      : !!sceneRepresentation(item);
    if (!visible) {
      omitted++;
      const type = item.valid === false ? `${item.nativeType} (invalid)` : String(item.nativeType);
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

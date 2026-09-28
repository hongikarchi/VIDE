import { sceneRepresentation, type DisplayGeometry } from './scene-representation.ts';

interface Keyed {
  id: string;
  nativeId?: string;
}
type SceneItem = Keyed & DisplayGeometry;
export interface DisplayDelta<O extends Keyed, S extends SceneItem> {
  objects: O[];
  scene: S[];
  /** Native IDs no longer shown (deleted, hidden or filtered). */
  removed: string[];
}

const key = (item: Keyed) => item.nativeId ?? item.id;

/** Shown vs omitted scene items; omitted ones are counted per native type. */
export function displayCoverage(scene: SceneItem[]) {
  const omittedTypes: Record<string, number> = {};
  let omitted = 0;
  for (const item of scene)
    if (!sceneRepresentation(item)) {
      omitted++;
      const type = item.valid === false ? `${item.nativeType} (invalid)` : String(item.nativeType);
      omittedTypes[type] = (omittedTypes[type] ?? 0) + 1;
    }
  return { total: scene.length, displayed: scene.length - omitted, omitted, omittedTypes };
}

/**
 * Applies changed/removed objects to a display model by native ID. Unchanged items keep their
 * position and identity; new items are appended in delta order.
 */
export function applyDisplayDelta<O extends Keyed, S extends SceneItem>(
  model: { objects: O[]; scene: S[] },
  delta: DisplayDelta<O, S>,
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
  return { objects: merge(model.objects, delta.objects), scene: merge(model.scene, delta.scene) };
}

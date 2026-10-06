// Scene items of a result for readers that validate them (review, report, quantities, comparison,
// publication). A result read lazily (`Workspace.lazy`, T-129) holds its scene as a `StoredList`:
// each item is checked with the same item schema as it is read, one at a time, instead of the
// whole array at once.
import { z } from 'zod';
import { workspaceResultSchema } from '../contracts/workspace-result.ts';
import { StoredList } from './model-store.ts';
import type { Workspace } from './workspace.ts';
import type { StoredWork } from '../contracts/stored-work.ts';

const sceneArraySchema = workspaceResultSchema.shape.scene.unwrap();
export const sceneItemSchema = sceneArraySchema.element;
export type SceneItem = z.infer<typeof sceneItemSchema>;
/** A parsed scene array, or a stored list whose items are parsed as they are read. */
export const sceneListSchema = z.union([
  sceneArraySchema,
  z.custom<StoredList>((value) => value instanceof StoredList),
]);
export type SceneList = z.infer<typeof sceneListSchema>;

/**
 * Items of a scene list: an array as it is, a stored list parsed item by item. `id` keeps only the
 * items whose id it accepts; a stored item it refuses is neither parsed nor decoded.
 */
export function sceneItems<T = SceneItem>(
  list: readonly T[] | StoredList,
  id?: (id: unknown) => boolean,
): Iterable<T> {
  if (!(list instanceof StoredList))
    return id ? list.filter((item) => id((item as { id?: unknown }).id)) : (list as Iterable<T>);
  return (function* () {
    for (const raw of list) if (!id || id(raw.id)) yield sceneItemSchema.parse(raw) as T;
  })();
}

/**
 * A request for the review, report, comparison, quantity and publication readers: the stored
 * model read lazily (`Workspace.lazy`), with its object rows (meta only, no coordinates) as an
 * array. The rows are shared with `Workspace.summary` and read-only.
 */
export function lazyCandidate(workspace: Workspace, projectId: string, id: string): StoredWork {
  const work = workspace.lazy(projectId, id);
  const result = work.result as Record<string, unknown> | null;
  if (!(result?.objects instanceof StoredList)) return work;
  return { ...work, result: { ...result, objects: [...result.objects] } as StoredWork['result'] };
}

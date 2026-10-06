import { candidateSchema } from './reviews.ts';
import type { Workspace } from './workspace.ts';
import type { Comparison } from '../contracts/comparison.ts';
import type { z } from 'zod';
type Candidate = z.infer<typeof candidateSchema>;
import { DomainError } from './store.ts';
import { quantities } from './quantities.ts';
import { modelChangesSchema } from '../contracts/model-changes.ts';
import { createHash } from 'node:crypto';
import { sceneItems, type SceneItem } from './scene-items.ts';
function representation(
  object: Candidate['result']['objects'][number] | undefined,
  scene: SceneItem | undefined,
) {
  const { nativeId, ...attributes } = object ?? {};
  const { nativeId: ignored, ...geometry } = scene ?? {};
  return JSON.stringify({ attributes, geometry: scene ? geometry : null });
}
/**
 * The representation of each object id (its first object row and first scene item, as `find`
 * gave them), as a hash: one pass over the scene, one item at a time (T-129). Equal hashes are
 * equal representations.
 */
function representations(candidate: Candidate) {
  const objects = new Map<string, Candidate['result']['objects'][number]>();
  for (const object of candidate.result.objects)
    if (!objects.has(object.id)) objects.set(object.id, object);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const out = new Map<string, string>();
  for (const item of sceneItems(candidate.result.scene))
    if (!out.has(item.id)) out.set(item.id, hash(representation(objects.get(item.id), item)));
  return (id: string) => out.get(id) ?? hash(representation(objects.get(id), undefined));
}
export function compareCandidates(beforeValue: unknown, afterValue: unknown, related: boolean) {
  const before = candidateSchema.parse(beforeValue),
    after = candidateSchema.parse(afterValue);
  if (!before.result?.hostExecuted || !after.result?.hostExecuted)
    throw new DomainError('NOT_FOUND');
  const compatible = related && (before.result.host || 'rhino') === (after.result.host || 'rhino');
  const nativeChanges =
    compatible && after.result.executionMode === 'sdk' && after.result.baseRequestId === before.id
      ? modelChangesSchema.safeParse(after.result.changes).data
      : undefined;
  const nativeModified = new Set(nativeChanges?.modified.map((change) => change.id));
  const left = quantities(before),
    right = quantities(after),
    rows: (Comparison['rows'][number] & { before: unknown; after: unknown })[] = [];
  const ids = new Set([...left.rows.map((r) => r.id), ...right.rows.map((r) => r.id)]);
  const beforeOf = compatible ? representations(before) : undefined,
    afterOf = compatible ? representations(after) : undefined;
  for (const id of ids) {
    const a = left.rows.find((r) => r.id === id),
      b = right.rows.find((r) => r.id === id);
    const status: Comparison['rows'][number]['status'] = !compatible
      ? 'incomparable'
      : !a
        ? 'added'
        : !b
          ? 'removed'
          : nativeModified.has(id)
            ? 'changed'
            : beforeOf!(id) === afterOf!(id)
              ? 'unchanged'
              : 'changed';
    const delta: Comparison['rows'][number]['delta'] = { length: null, area: null, volume: null };
    for (const metric of ['length', 'area', 'volume'] as const)
      delta[metric] =
        compatible && a && b && a[metric] !== null && b[metric] !== null
          ? b[metric] - a[metric]
          : null;
    rows.push({
      id,
      name: b?.name || a?.name || id,
      status,
      before: a || null,
      after: b || null,
      delta,
    });
  }
  return {
    before: before.id,
    after: after.id,
    compatible,
    reason: compatible ? null : '기준 관계 또는 동일 호스트를 확인할 수 없습니다.',
    rows,
  };
}
export function relatedCandidates(
  workspace: Workspace,
  projectId: string,
  before: { id: string },
  after: { id: string },
) {
  const ancestors = (initial: string) => {
    let id: string | null | undefined = initial;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      // Only the chain's ids: the request's small result, never its model (T-129).
      const item = workspace.brief(projectId, id);
      id = item.result?.baseRequestId || item.input?.baseRequestId;
    }
    return seen;
  };
  return ancestors(before.id).has(after.id) || ancestors(after.id).has(before.id);
}

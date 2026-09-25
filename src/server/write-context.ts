import type { ModelChanges } from '../contracts/model-changes.ts';
import { queryPage } from './query-page.ts';

/** A summary failure must not turn a verified write into an instruction to replay it. */
export function writeSnapshot(raw: unknown, revision: number) {
  try {
    return queryPage(raw, {}, revision);
  } catch (error) {
    if (
      !(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'QUERY_RESULT_TOO_LARGE'
      )
    )
      throw error;
    return {
      ok: true,
      revision,
      objectsOmitted: true,
      reason: 'QUERY_RESULT_TOO_LARGE',
      instruction:
        'The write was verified. Do not replay it. Query specific objectIds for required data; an individual oversized object may still exceed the query limit.',
    };
  }
}

export function writeChanges(changes: ModelChanges | undefined) {
  if (!changes) return undefined;
  return {
    added: changes.added.slice(0, 50),
    removed: changes.removed.slice(0, 50),
    modified: changes.modified.slice(0, 50),
    counts: {
      added: changes.added.length,
      removed: changes.removed.length,
      modified: changes.modified.length,
    },
    complete:
      changes.added.length <= 50 && changes.removed.length <= 50 && changes.modified.length <= 50,
  };
}

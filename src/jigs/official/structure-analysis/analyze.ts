// analyzeSummary (PLAN-23 T-052, SPEC-06.3): analyse a model off the engine thread and return the
// summary. Preview results are labelled '미확정 미리보기' and are never stored by this library.

import type { StructureModelInput } from '../../../contracts/structure-model.ts';
import type { MemberMap } from './frame-plan.ts';
import type { AnalyzeOptions, AnalyzeOutcome } from './run.ts';
import { submitAnalysis } from './worker.ts';

export type { AnalyzeOptions, AnalyzeOutcome } from './run.ts';

/**
 * Analyse in the worker thread. Requests sharing `options.key` supersede each other while queued
 * (the superseded promise rejects with code `STRUCTURE_SUPERSEDED`). Rejects with
 * `STRUCTURE_CORE_MISSING` when the core is not built.
 */
export function analyzeSummary(
  model: StructureModelInput,
  map: MemberMap | undefined,
  options: AnalyzeOptions,
): Promise<AnalyzeOutcome> {
  return submitAnalysis<AnalyzeOutcome>(options.key ?? '', { input: model, map, options });
}

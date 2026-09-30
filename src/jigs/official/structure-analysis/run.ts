// The synchronous analysis pipeline: checks → mechanism pre-check → (stability probe) → core → failure causes → summary.
// Runs inside the worker thread (worker-entry.ts); tests call it directly. No I/O.

import { createHash } from 'node:crypto';
import {
  structureModelSchema,
  type StructureModel,
  type StructureModelInput,
  type StructureResult,
  type StructureSummary,
} from '../../../contracts/structure-model.ts';
import { loadCore, modelHash } from '../../structure/core.ts';
import type { DraftIssue } from '../../structure/input.ts';
import { distributeAreaLoads, type LedgerRow } from '../../structure/loads.ts';
import {
  checkModelStatic,
  classifyFailures,
  probeIssues,
  stabilityProbe,
} from '../../structure/review.ts';
import { memberMapFrom } from './frame-model.ts';
import { mechanismIssues } from './mechanism.ts';
import type { MemberMap } from './frame-plan.ts';
import { emptySummary, summarize } from './summary.ts';

export interface AnalyzeOptions {
  /** preview = 미확정 미리보기 (never stored); confirmed = the user confirmed this model. */
  mode: 'confirmed' | 'preview';
  /** Requests with the same key supersede each other while queued; also scopes the geometry cache. */
  key?: string;
  /**
   * Stability probe with unit loads (SPEC-06.2): 'geometry-changed' runs it when nodes, members,
   * supports or restraints differ from the last run for this key. Default: confirmed mode only.
   */
  stability?: boolean | 'geometry-changed';
  assumptions?: string[];
  issues?: DraftIssue[];
  /** 'full' also returns the complete core result (bigger; the confirmed path stores it). */
  detail?: 'summary' | 'full';
}

export interface AnalyzeOutcome {
  summary: StructureSummary;
  /** With `detail: 'full'`: the core result, the parsed model and the area-load ledger. */
  result?: StructureResult;
  model?: StructureModel;
  ledger?: LedgerRow[];
}

/** Hash of what decides stability: nodes, supports, members, releases and restraints. */
export function geometryHash(model: StructureModel): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        nodes: model.nodes.map((n) => [n.id, n.xyz_m, n.support ?? null]),
        members: model.members.map((m) => [m.id, m.i, m.j, m.kind, m.releases ?? null]),
        restraint: model.analysis.lateralRestraint ?? null,
      }),
    )
    .digest('hex');
}

/** Core call without re-validating the input (already parsed) or the output (our own core). */
function analyzeParsed(model: StructureModel, hash: string): StructureResult {
  return JSON.parse(loadCore().analyze(JSON.stringify(model), hash)) as StructureResult;
}

export function runAnalysis(
  input: StructureModelInput,
  map: MemberMap | undefined,
  options: AnalyzeOptions,
  geometryCache: Map<string, string> = new Map(),
): AnalyzeOutcome {
  const started = performance.now();
  const base = { mode: options.mode, assumptions: options.assumptions };
  const checked = checkModelStatic(input);
  const issues = [...(options.issues ?? []), ...checked.issues];
  if (!checked.model || issues.some((i) => i.level === 'error'))
    return {
      summary: emptySummary('invalid', { ...base, issues, ms: performance.now() - started }),
    };
  const model = checked.model;
  const hash = modelHash(model);
  // Joint patterns that are certainly mechanisms stop here with their nodes and cause.
  const mechanisms = mechanismIssues(model);
  issues.push(...mechanisms);
  if (mechanisms.some((i) => i.level === 'error'))
    return {
      summary: emptySummary('unstable', {
        ...base,
        model,
        modelHash: hash,
        issues,
        ms: performance.now() - started,
      }),
    };
  const memberMap = map ?? memberMapFrom(model);
  const key = options.key ?? '';
  const stability =
    options.stability ?? (options.mode === 'confirmed' ? 'geometry-changed' : false);
  let probe = stability === true;
  if (stability === 'geometry-changed') {
    const current = geometryHash(model);
    probe = geometryCache.get(key) !== current;
    if (probe) geometryCache.set(key, current);
  }
  if (probe) {
    const probed = probeIssues(
      analyzeParsed(structureModelSchema.parse(stabilityProbe(model)), hash),
    );
    issues.push(...probed);
    if (probed.some((i) => i.level === 'error')) {
      geometryCache.delete(key);
      return {
        summary: emptySummary('unstable', {
          ...base,
          model,
          modelHash: hash,
          issues,
          ms: performance.now() - started,
        }),
      };
    }
  }
  const distributed = distributeAreaLoads(model);
  const raw = analyzeParsed(distributed.model, hash);
  const result = raw.status === 'ok' ? classifyFailures(model, raw, distributed.ledger) : raw;
  const summary = summarize(model, memberMap, result, {
    ...base,
    issues,
    ms: performance.now() - started,
  });
  return options.detail === 'full'
    ? { summary, result, model, ledger: distributed.ledger }
    : { summary };
}

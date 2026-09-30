// S-06 frame jig ⑧-2 해석 (PLAN-23 T-053 drawn mode, SPEC-06.3·.11 10): the model of step 'model'
// analysed off the engine thread by vide/structure-analysis `analyzeSummary`. The step itself
// only ever produces the preview (labelled '미확정 미리보기', never stored as confirmed); the
// action `confirmAnalysis` — pressed by a person — runs the same model in confirmed mode (with
// the stability probe) and stores `{ result, at, modelHash }` in the output. A confirmation is
// carried to later runs only while the model hash is the same; otherwise it is reported stale.
//
// The analysis needs the native core in a worker thread; the jig child process is started with
// worker and addon permission and read access to the core folder (ARCH-03 §6.4), and the engine
// runner or `deps.analyze` work too. When the analysis cannot run, the output says so instead
// of throwing.

import type { StructureSummary } from '../../../../src/contracts/structure-model.ts';
import {
  analyzeSummary,
  LABELS,
  type AnalyzeOptions,
  type AnalyzeOutcome,
  type MemberMap,
} from '../../../../src/jigs/official/structure-analysis/index.ts';
import type { StructureModelInput } from '../../../../src/contracts/structure-model.ts';
import type { ModelOutput } from './model.ts';

export interface AnalysisConfirmed {
  result: StructureSummary;
  /** ISO time the person confirmed. */
  at: string;
  modelHash: string;
}
export interface AnalysisOutput {
  schema: 'vide.s06.analysis/1';
  /** Label of `preview`: always '미확정 미리보기'. */
  label: string;
  modelHash: string;
  /** Summary of the preview run; null when the analysis could not run (see `error`). */
  preview: StructureSummary | null;
  assumptions: string[];
  confirmed?: AnalysisConfirmed;
  /** A confirmation of an earlier model (hash differs): shown, never used as the result. */
  staleConfirmed?: { at: string; modelHash: string };
  error?: { code: string; message: string };
  summary: {
    status: string;
    members: number;
    confirmed: boolean;
    maxRatio: number | null;
    ms: number | null;
    /** Steel weight of the shown result (t); null when nothing was analysed. */
    steel_t: number | null;
  };
  /** Panel rows of the shown result (confirmed when present, else the preview). */
  rows: MemberVerdictRow[];
  /** '참고 처짐' rows: reference deflection beside, never inside, the verdict. */
  deflections: DeflectionRowOut[];
}
export interface MemberVerdictRow {
  key: string;
  judgement: string;
  ratio: number | null;
  clause: string;
}
export interface DeflectionRowOut {
  key: string;
  deflection_mm: number;
  limit_mm: number | null;
  ratio: number | null;
}

const JUDGEMENT: Record<string, string> = {
  ok: '통과',
  warn: '주의',
  ng: '초과',
  na: '미완',
  err: '오류',
};
/** Ratios the checks could not bound (e.g. a slenderness limit, reported as the largest number) show as this. */
export const RATIO_SHOWN_MAX = 999;
const r3 = (v: number) => Number(Math.min(v, RATIO_SHOWN_MAX).toFixed(3));
function rowsOf(summary: StructureSummary | null) {
  const rows: MemberVerdictRow[] = [];
  const deflections: DeflectionRowOut[] = [];
  if (!summary || !Array.isArray(summary.members)) return { rows, deflections };
  for (const [key, status, ratio, clause, defl, limit] of summary.members) {
    rows.push({
      key,
      judgement: JUDGEMENT[summary.statusCodes?.[status] ?? ''] ?? String(status),
      ratio: ratio === null ? null : r3(ratio),
      clause: clause === null ? '' : (summary.clauses?.[clause] ?? ''),
    });
    if (defl !== null)
      deflections.push({
        key,
        deflection_mm: Number(defl.toFixed(1)),
        limit_mm: limit === null ? null : Number(limit.toFixed(1)),
        ratio: limit ? r3(defl / limit) : null,
      });
  }
  rows.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1) || a.key.localeCompare(b.key));
  deflections.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1) || a.key.localeCompare(b.key));
  return { rows, deflections };
}

export interface AnalysisInputs {
  steps: { model: ModelOutput; analysis?: AnalysisOutput | null };
}
export interface AnalysisParams {
  /** Stability probe on preview runs: when geometry changed (default) or never. */
  stability: 'geometry-changed' | false;
  /** Fixed time for `at` (tests, replays); default now. */
  now?: string;
}
export const DEFAULT_ANALYSIS_PARAMS: AnalysisParams = { stability: 'geometry-changed' };

export type Analyzer = (
  model: StructureModelInput,
  map: MemberMap | undefined,
  options: AnalyzeOptions,
) => Promise<AnalyzeOutcome>;
export interface AnalysisDeps {
  analyze?: Analyzer;
}

const KEY = 's06-frame:analysis';

async function run(
  model: ModelOutput,
  mode: 'preview' | 'confirmed',
  stability: AnalyzeOptions['stability'],
  deps: AnalysisDeps,
): Promise<{ summary: StructureSummary | null; error?: { code: string; message: string } }> {
  const analyze = deps.analyze ?? analyzeSummary;
  try {
    const out = await analyze(model.model, model.map, {
      mode,
      key: KEY,
      stability,
      assumptions: model.assumptions,
      issues: model.issues.map((i) => ({
        level: i.level,
        code: i.code,
        message: i.message,
        ...(i.members ? { members: i.members } : {}),
      })),
    });
    return { summary: out.summary };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      summary: null,
      error: { code: e?.code ?? 'STRUCTURE_ANALYSIS', message: String(e?.message ?? error) },
    };
  }
}

function output(
  model: ModelOutput,
  preview: StructureSummary | null,
  error: { code: string; message: string } | undefined,
  confirmed: AnalysisConfirmed | undefined,
  stale: AnalysisOutput['staleConfirmed'],
): AnalysisOutput {
  const shown = confirmed?.result ?? preview;
  return {
    schema: 'vide.s06.analysis/1',
    label: LABELS.preview,
    modelHash: model.modelHash,
    preview,
    assumptions: model.assumptions,
    ...(confirmed ? { confirmed } : {}),
    ...(stale ? { staleConfirmed: stale } : {}),
    ...(error ? { error } : {}),
    summary: {
      status: shown?.status ?? 'unavailable',
      members: Object.keys(model.map?.physical ?? {}).length,
      confirmed: !!confirmed,
      maxRatio:
        shown && shown.status === 'ok' && shown.maxRatio !== null ? r3(shown.maxRatio) : null,
      ms: typeof shown?.ms === 'number' ? Math.round(shown.ms) : null,
      steel_t: shown && shown.status === 'ok' ? Number(shown.steel_t.toFixed(2)) : null,
    },
    ...rowsOf(shown ?? null),
  };
}

/** Step 'analysis': the preview of the current model; an earlier confirmation of the same model stays. */
export async function analysis(
  inputs: AnalysisInputs,
  params: Partial<AnalysisParams> = {},
  _overrides: unknown[] = [],
  deps: AnalysisDeps = {},
): Promise<AnalysisOutput> {
  const p = { ...DEFAULT_ANALYSIS_PARAMS, ...params };
  const model = inputs.steps.model;
  const prior = inputs.steps.analysis?.confirmed;
  const keep = prior && prior.modelHash === model.modelHash ? prior : undefined;
  const stale =
    prior && !keep
      ? { at: prior.at, modelHash: prior.modelHash }
      : !prior && inputs.steps.analysis?.staleConfirmed
        ? inputs.steps.analysis.staleConfirmed
        : undefined;
  const { summary, error } = await run(model, 'preview', p.stability, deps);
  // Never label a preview as confirmed, whatever the analyser returned.
  const preview = summary ? { ...summary, mode: 'preview' as const, label: LABELS.preview } : null;
  return output(model, preview, error, keep, stale);
}

/** Action 'confirmAnalysis' (T2, a person presses [해석 확정]): confirmed run stored in the output. */
export async function confirmAnalysis(
  inputs: AnalysisInputs,
  params: Partial<AnalysisParams> = {},
  _overrides: unknown[] = [],
  deps: AnalysisDeps = {},
): Promise<AnalysisOutput> {
  const p = { ...DEFAULT_ANALYSIS_PARAMS, ...params };
  const model = inputs.steps.model;
  const preview =
    inputs.steps.analysis?.modelHash === model.modelHash
      ? (inputs.steps.analysis?.preview ?? null)
      : null;
  const { summary, error } = await run(model, 'confirmed', true, deps);
  if (!summary || summary.status !== 'ok' || model.issues.some((i) => i.level === 'error'))
    return output(
      model,
      preview ?? (summary ? { ...summary, mode: 'preview', label: LABELS.preview } : null),
      error ?? {
        code: 'ANALYSIS_NOT_CONFIRMABLE',
        message: `확정할 수 없음: 해석 상태 ${summary?.status ?? '없음'}`,
      },
      undefined,
      undefined,
    );
  const confirmed: AnalysisConfirmed = {
    result: summary,
    at: p.now ?? new Date().toISOString(),
    modelHash: model.modelHash,
  };
  return output(model, preview, undefined, confirmed, undefined);
}

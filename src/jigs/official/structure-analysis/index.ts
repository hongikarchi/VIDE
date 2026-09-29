// Official library `vide/structure-analysis` (J-09, ADR-019, PLAN-23 T-052): model assembly with
// design lengths on the physical member, curve segmentation, summary and preview analysis in a
// worker thread, reference deflection, and the structure gates. The generic structure jig and the
// S-06 frame jig both call this; the Rust core and its contract stay as ARCH-02 defines them.

export const library = { id: 'vide/structure-analysis', version: '0.1.0' } as const;

export { buildFrameModel, memberMapFrom, DEFAULT_COMBOS } from './frame-model.ts';
export type { FrameBuild } from './frame-model.ts';
export type {
  EndCondition,
  FrameColumn,
  FrameCombo,
  FrameLineLoad,
  FrameMember,
  FramePlan,
  LoadCase,
  MemberMap,
  PlanRole,
} from './frame-plan.ts';
export { PLAN_ROLE_TO_MODEL } from './frame-plan.ts';
export { segmentCurve, isCurved, cleanPolyline, chordSag } from './segment.ts';
export type { SegmentOptions } from './segment.ts';
export { designForBeam, designForColumn } from './design-length.ts';
export type {
  BeamDesignInput,
  ColumnDesignInput,
  DesignValues,
  MemberDesign,
} from './design-length.ts';
export { sectionArea_mm2, unitWeight_kNpm } from './section-props.ts';
export { referenceDeflection, nodeChain } from './deflection.ts';
export type { DeflectionOptions, DeflectionRow } from './deflection.ts';
export {
  summarize,
  emptySummary,
  designIncomplete,
  DISCLAIMER,
  LABELS,
  LIBRARY_UNCHECKED,
  MARGIN_NAME,
} from './summary.ts';
export type { SummarizeOptions } from './summary.ts';
export { runAnalysis, geometryHash } from './run.ts';
export { analyzeSummary } from './analyze.ts';
export type { AnalyzeOptions, AnalyzeOutcome } from './analyze.ts';
export { analysisWorkerStats, closeAnalysisWorker, submitAnalysis } from './worker.ts';
export { comboEcho, uncheckedListed, analysisConfirmed } from './gates.ts';
export type { GateResult } from './gates.ts';
export type { Vec3 } from './geometry.ts';

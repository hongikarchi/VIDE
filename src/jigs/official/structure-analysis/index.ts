// Official library `vide/structure-analysis` (J-09, ADR-019, PLAN-23 T-052·T-054): model assembly
// with design lengths on the physical member, curve segmentation, summary and preview analysis in a
// worker thread, reference deflection, section sizing over KS H, stable marks, the schedule with
// its CSV, and the structure gates. The generic structure jig and the S-06 frame jig both call
// this; the Rust core and its contract stay as ARCH-02 defines them.

export const library = { id: 'vide/structure-analysis', version: '0.2.0' } as const;

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
export {
  hProps,
  sectionArea_mm2,
  sectionProps,
  unitWeight_kNpm,
  STEEL_DENSITY_KGPM3,
} from './section-props.ts';
export type { SectionProperties } from './section-props.ts';
export { memberGeometry, curveTolerance } from './curvature.ts';
export type { MemberGeometry } from './curvature.ts';
export {
  sizeGroups,
  ksCandidates,
  spanBand,
  DEFAULT_DEPTH_MAX_MM,
  DEFAULT_SPAN_BANDS_M,
  SIZING_NOTE,
} from './sizing.ts';
export type {
  SizingAnalyze,
  SizingCandidate,
  SizingGroup,
  SizingOptions,
  SizingResult,
  SizingRole,
} from './sizing.ts';
export { stableMarks, membersByMark, DEFAULT_MARK_PREFIXES, MARK_PREFIX_NOTE } from './marks.ts';
export type { MarkCorrespondence, MarkOptions, MarkResult, MarkRule } from './marks.ts';
export { schedule, toCsv, SCHEDULE_CSV_HEADER, STATUS_LABEL, TAG_LABEL } from './schedule.ts';
export type { ScheduleOptions } from './schedule.ts';
export { csvCell, csvText } from './csv.ts';
export type { CsvCell } from './csv.ts';
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
export {
  comboEcho,
  uncheckedListed,
  analysisConfirmed,
  markUnique,
  scheduleComplete,
} from './gates.ts';
export type { GateResult } from './gates.ts';
export type { Vec3 } from './geometry.ts';

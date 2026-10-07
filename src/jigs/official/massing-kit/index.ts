// Official library `vide/massing-kit` (SPEC-12.7~12.9, PLAN-45 T-209·T-210, ARCH-03 §2.3): the
// closed rule list of the 규모검토 jigs — 규제 조건 items, boundary segments, 2D 제한선과 가능 영역,
// 3D 가능 외피와 그 점검 — and the `vide/buildable-mass` steps that call them. Pure TypeScript
// without node: imports; the solid booleans are `vide/geometry-kit` (`solid.ts`). No legal value is
// written here: every number a rule uses is a 규제 조건 item with its source (SPEC-12.7 5·6).

export const library = { id: 'vide/massing-kit', version: '0.1.0' } as const;

export {
  CHOICE_LABELS,
  PARAM_ITEMS,
  REGULATION_ITEMS,
  RULES,
  emptyItem,
  isUnconfirmed,
  itemOf,
  mergeRegulations,
  numberOf,
  regulationsFromParams,
  ruleOf,
} from './rules.ts';
export type {
  Applies,
  ItemStatus,
  Origin,
  RegulationBasis,
  RegulationGroup,
  RegulationId,
  RegulationItem,
  RuleDef,
  RuleId,
} from './rules.ts';
export { regulationsFromLegal } from './legal-adapter.ts';
export type { LegalAdapterResult } from './legal-adapter.ts';
export { boundarySegments, edgesOf, roadWidthAt, siteRing } from './boundary-segments.ts';
export type { BoundarySegment, ContactEdge, Corner, SegmentKind } from './boundary-segments.ts';
export {
  ARC_SIDES,
  buildableArea,
  capsuleRing,
  cutterRing,
  cutterSolid,
  northSweep,
  slabRegions,
  sunSlopeSolid,
  sunWallSolid,
} from './setback.ts';
export type { Buildable, Cutter, PlanRegion, SunDatum, SunRule } from './setback.ts';
export { ENVELOPE_TITLES, envelopes } from './envelope.ts';
export type { Envelope, EnvelopeInput, EnvelopeKind, EnvelopeSet } from './envelope.ts';
export { bakeFaces, envelopeCheck } from './solid-check.ts';
export type { BakeFaces, EnvelopeCheck } from './solid-check.ts';
export {
  ENVELOPE_NOTE,
  STUDY_NOTE,
  buildableStep,
  envelopeStep,
  limitStep,
  linesOf,
  planStep,
  regulationStep,
  siteStep,
} from './steps.ts';

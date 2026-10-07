// Official library `vide/massing-kit` (SPEC-12.7~12.9, PLAN-45 T-209·T-210, ARCH-03 §2.3): the
// closed rule list of the 규모검토 jigs — 규제 조건 items, boundary segments, 2D 제한선과 가능 영역,
// 3D 가능 외피와 그 점검 — and the `vide/buildable-mass` steps that call them. Pure TypeScript
// without node: imports; the solid booleans are `vide/geometry-kit` (`solid.ts`). No legal value is
// written here: every number a rule uses is a 규제 조건 item with its source (SPEC-12.7 5·6).

export const library = { id: 'vide/massing-kit', version: '0.3.1' } as const;

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
  regulationsFromOverrides,
  regulationsFromParams,
  withOverrides,
  itemsOf,
  listOf,
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
  StepOverride,
} from './rules.ts';
export { LEGAL_KEYS, regulationsFromLegal } from './legal-adapter.ts';
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
// T-211·T-212: floors, alternatives, 공개공지, 용도 배분, 주차·조경.
export {
  basementRegions,
  floorFits,
  floorLevels,
  floorRegions,
  intersectRegions,
  meshSolid,
  regionSolid,
  regionsArea,
  subtractRegions,
  trimRegions,
  unionArea,
  unionRegions,
} from './floors.ts';
export type { FloorDef } from './floors.ts';
export {
  ALTERNATIVE_MAX,
  TRIM_TITLES,
  alternativeRow,
  exclusionsOf,
  farTargets,
  makeAlternatives,
  trimToCap,
} from './alternatives.ts';
export type {
  AltFloor,
  Alternative,
  AlternativeKind,
  AlternativeRow,
  FloorShape,
  TrimMethod,
} from './alternatives.ts';
export { openSpaceCandidates, openSpaceRequirement, pickCandidate } from './open-space.ts';
export type { OpenSpaceCandidate, OpenSpaceRequirement } from './open-space.ts';
export { acceptUseDraft, allocateUses, useTable } from './use-mix.ts';
export type { FloorUse, UseShare, UseTotal } from './use-mix.ts';
export { PARKING_TYPE_TITLES, entryZone, legalParking, parkingTypes } from './parking.ts';
export type { LegalParking, ParkingType, ParkingTypeRow } from './parking.ts';
export { landscapeAreas } from './landscape.ts';
export {
  alternativesStep,
  applyUseDraft,
  chosenStep,
  floorsStep,
  openSpaceStep,
  parkingStep,
  useMixStep,
} from './mass-steps.ts';
export type { AlternativesOutput, FloorsOutput } from './mass-steps.ts';
export { handoffStep } from './handoff.ts';
export type { ChosenHandoff, HandoffFloor } from './handoff.ts';

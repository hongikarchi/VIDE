// Official library `vide/paneling-kit` (SPEC-16, PLAN-49, ARCH-03 §2.3): the 패널링 computations on
// a sampled Rhino face. Stage 1 (T-252): bicubic sample interpolation and arc-length tables
// (sample.ts), the 2D domain by the three ways to measure (domain.ts), the patterns — four first,
// hexagon and Voronoi (T-260) — (patterns.ts), a person's tile (tile.ts) and attractor openings
// (opening.ts), cutting by the face and its trim loops with lattice vertex keys (clip.ts) and the
// layout with boundary rules, numbering and sizes (layout.ts) → `PanelLayout`. Stage 2 (T-254):
// joint reduction on the surface, closed plates, sizes, stock and joint lines (members.ts) →
// `MemberSet`. Stage 3 (T-256) is optimize.ts with flatness, classify, typing, connections,
// unroll and schedule. Pure TypeScript without node: imports; shapes from `src/contracts/paneling.ts`.

export const library = { id: 'vide/paneling-kit', version: '0.1.0' } as const;

export { faceSampler, isoTable, sampleIsoLengths, samplePoint } from './sample.ts';
export type { FaceSampler } from './sample.ts';
export { buildDomain } from './domain.ts';
export type { Domain, UVHit } from './domain.ts';
export { estimateCells, jitterOf, patternCells } from './patterns.ts';
export type { Cell, CellSet, PatternName, PatternOptions } from './patterns.ts';
export { OFF_TARGET, layoutPanels, offTarget } from './layout.ts';
export type { LayoutExtras, LayoutOutcome } from './layout.ts';
// T-260 (SPEC-16.13): the person's tile placed in tangent frames, attractor openings.
export { placeTile, tileFromCurves } from './tile.ts';
export type { TileDraft, TilePiece, TileSet } from './tile.ts';
export {
  addOpenings,
  attractorDistance,
  attractorsFromCurves,
  attractorsHash,
  openingRatio,
  surfaceArea,
} from './opening.ts';
export type { Attractor, OpeningSettings } from './opening.ts';
export {
  RECOMMENDED_MEMBERS,
  RECOMMENDED_OPTIMIZE,
  RECOMMENDED_OPENING,
  RECOMMENDED_PREVIEW,
  RECOMMENDED_VORONOI,
  memberSettingsFromParams,
  previewSettingsFromParams,
  resolveMemberSettings,
  resolveOptimizeSettings,
  resolvePreviewSettings,
  settingValues,
  withPatternExtras,
} from './settings.ts';
export { bestFitPlane } from './vec.ts';
export type { Plane, Vec2, Vec3 } from './vec.ts';
export { canonical, fingerprint, sha256Hex } from './hash.ts';
export {
  JOINT_UNEVEN_MIN,
  THICKNESS_CURVATURE_LIMIT,
  buildMembers,
  layoutFingerprint,
  overStockOf,
} from './members.ts';
export type { MembersOptions, MembersOutcome } from './members.ts';
export { membersStep, optimizeStep, previewStep } from './steps.ts';
// Stage 3 (T-256): flatness and planarization, curvature classes, types, nodes and joints, cut
// outlines and the schedule tables → `PanelTyping`.
export { optimizePanels } from './optimize.ts';
export type { OptimizeInput, OptimizeOutcome } from './optimize.ts';
export { measurePlate, planarGaps, planarize } from './flatness.ts';
export type { PlateGeometry } from './flatness.ts';
export { CLASS_LABELS, curvatureClass } from './classify.ts';
export type { CurvatureClass } from './classify.ts';
export { deviation, groupShapes, makeShape, mirrorShape } from './typing.ts';
export type { Grouping, Shape, ShapeInput } from './typing.ts';
export { connections } from './connections.ts';
export { patternAxis, plateFrame, unrollPlate } from './unroll.ts';
export { comparePanels, scheduleCsv, scheduleRows, sortedPanels } from './schedule.ts';
export type { ScheduleRow, ScheduleTable } from './schedule.ts';
export { optimizeSettingsFromParams } from './settings.ts';
// [타입 만들기] (T-257): block definitions per type, placements per panel, the cut sheet.
export { CUT_GAP, cutSheet, fitOutline, placePoint, typePlacements } from './place.ts';
export type {
  CutOutline,
  PanelPlacement,
  PlacementFailure,
  PlacementInput,
  TypeBlock,
  TypePlacements,
} from './place.ts';

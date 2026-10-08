// Official library `vide/paneling-kit` (SPEC-16, PLAN-49, ARCH-03 §2.3): the 패널링 computations on
// a sampled Rhino face. Stage 1 (T-252): bicubic sample interpolation and arc-length tables
// (sample.ts), the 2D domain by the three ways to measure (domain.ts), the four first patterns
// (patterns.ts), cutting by the face and its trim loops with lattice vertex keys (clip.ts) and the
// layout with boundary rules, numbering and sizes (layout.ts) → `PanelLayout`. Stage 2 (T-254):
// joint reduction on the surface, closed plates, sizes, stock and joint lines (members.ts) →
// `MemberSet`. Stage 3 joins in T-256. Pure TypeScript without node: imports; shapes from `src/contracts/paneling.ts`.

export const library = { id: 'vide/paneling-kit', version: '0.1.0' } as const;

export { faceSampler, isoTable, sampleIsoLengths, samplePoint } from './sample.ts';
export type { FaceSampler } from './sample.ts';
export { buildDomain } from './domain.ts';
export type { Domain, UVHit } from './domain.ts';
export { estimateCells, patternCells } from './patterns.ts';
export type { Cell, CellSet, PatternName } from './patterns.ts';
export { OFF_TARGET, layoutPanels, offTarget } from './layout.ts';
export type { LayoutOutcome } from './layout.ts';
export {
  RECOMMENDED_MEMBERS,
  RECOMMENDED_OPTIMIZE,
  RECOMMENDED_PREVIEW,
  memberSettingsFromParams,
  previewSettingsFromParams,
  resolveMemberSettings,
  resolveOptimizeSettings,
  resolvePreviewSettings,
  settingValues,
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
export { membersStep, previewStep } from './steps.ts';

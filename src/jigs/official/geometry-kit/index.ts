// Official library `vide/geometry-kit` (ADR-020 결정 8, ARCH-03): general plan geometry shared by
// structure jigs. Pure TypeScript without node: imports, so the engine can call it as a `library`
// step and a step-runner bundle can carry a copy. Project-specific rules do not belong here.

export const library = { id: 'vide/geometry-kit', version: '0.1.0' } as const;

export {
  GeometryError,
  assertFinite,
  convexHull,
  counterClockwise,
  cross,
  minAreaRect,
  orientation,
  planLength,
  pointInPolygon,
  polygonArea,
  requirePolygon,
  ring,
  segmentDistance,
  signedArea,
  validatePolygon,
} from './plan.ts';
export type { Check, GeometryErrorCode, PlanPoint, Polygon, Rect, Vec2, Vec3 } from './plan.ts';
export { clipConvex, overlapArea, separation, signedDistance } from './separation.ts';
export type { Separation } from './separation.ts';
export { bandFromMesh, blockFootprints, transformPoints } from './footprint.ts';
export type {
  BlockDefinition,
  BlockFootprint,
  FootprintMode,
  FootprintOptions,
  Transform4,
} from './footprint.ts';
export { splitAtSupports } from './split.ts';
export type { CurvePiece, SplitOptions, SplitResult, Station } from './split.ts';

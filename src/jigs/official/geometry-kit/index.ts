// Official library `vide/geometry-kit` (ADR-020 결정 8, ARCH-03): general plan geometry shared by
// structure jigs. Pure TypeScript without node: imports, so the engine can call it as a `library`
// step and a step-runner bundle can carry a copy (with `delaunator` and `@kninnug/constrainautor`,
// its only dependencies). Project-specific rules do not belong here.

export const library = { id: 'vide/geometry-kit', version: '0.2.2' } as const;

export {
  GeometryError,
  assertFinite,
  convexHull,
  counterClockwise,
  cross,
  extent,
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
export {
  boundaryDistance,
  clipLineConvex,
  insetPolygon,
  lineCircle,
  lineCrossings,
  longestEdge,
  minkowskiSum,
  negate,
  pointInRegion,
  rayHits,
  segmentsCross,
} from './polygon.ts';
export type { Region } from './polygon.ts';
export { cellPolygon, triangulate, triangulateRegion } from './triangulate.ts';
export type {
  DiagonalRule,
  RemovedReason,
  TriCell,
  TriEdge,
  TriangulateOptions,
  Triangulation,
} from './triangulate.ts';
export { outlineFromMesh } from './outline.ts';
export type { MeshOutline, OutlineOptions } from './outline.ts';
export { allowedWindows, inWindows } from './window.ts';
export type { WindowLine, WindowOptions, Windows } from './window.ts';
export { cantileverBeams, cellInfill } from './infill.ts';
export type {
  CantileverArm,
  CantileverOptions,
  Cantilevers,
  Infill,
  InfillBeam,
  InfillOptions,
} from './infill.ts';
export { arcPoint, arcThrough, fitArc, segmentArc, segmentPolyline, verticalArc } from './arc.ts';
export type { Arc, ArcFit, SegmentOptions } from './arc.ts';
export * from './faces.ts';
export {
  SHORT_EDGE,
  SOLID_EPS,
  checkSolid,
  earClip,
  facesVolume,
  loftSolid,
  mergeCoplanar,
  planeOf,
  prismSolid,
  reversedMesh,
  sectionArea,
  solidIntersect,
  solidPolygon,
  solidSubtract,
  solidUnion,
  solidUnionAll,
  solidVolume,
  weldSolid,
} from './solid.ts';
export type { MergedFace, Plane, Solid, SolidCheck, SolidMesh, SolidPolygon } from './solid.ts';

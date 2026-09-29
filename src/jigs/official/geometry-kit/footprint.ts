// Plan footprints from Sync display data (PLAN-23 T-042). A block instance is a shared definition
// ({ vertices, indices, segments } flat xyz in definition space) placed by the row-major 4×4
// `block.transform`; the definition is moved into the world first, so the instance's own rotation
// is kept and never replaced by an axis-aligned bounding box.

import {
  GeometryError,
  assertFinite,
  convexHull,
  minAreaRect,
  requirePolygon,
  type Polygon,
  type Rect,
} from './plan.ts';

/** Sync block definition (display meshes and wires, metres). Other keys (hash, texts) are ignored. */
export interface BlockDefinition {
  vertices?: ArrayLike<number>;
  indices?: ArrayLike<number>;
  /** Line segments as flat xyz pairs (curves, CAD lines, open-cut outlines). */
  segments?: ArrayLike<number>;
}

/** Row-major 4×4 as in Sync `block.transform`: world = M · [x, y, z, 1]. */
export type Transform4 = ArrayLike<number>;

/**
 * - `solid`: every mesh vertex (the whole block seen from above)
 * - `base`: mesh vertices in the lowest z band (the footing slab under a stub or pedestal)
 * - `outline`: segment end points (e.g. an open-cut outline drawn as curves)
 */
export type FootprintMode = 'solid' | 'base' | 'outline';

export interface FootprintOptions {
  /** `base` only: height of the lowest band that counts (m, default 0.35). */
  baseBand?: number;
}

export interface BlockFootprint {
  mode: FootprintMode;
  /** Minimum-area rectangle of the chosen points (rotated with the block). */
  rect: Rect;
  /** Plan convex hull of the same points, counter-clockwise. */
  hull: Polygon;
  /** World z range of the points used. */
  z: [number, number];
  /** Number of points used. */
  points: number;
}

/** Flat xyz points moved by a row-major 4×4 transform. Non-finite input throws `no-nan`. */
export function transformPoints(flat: ArrayLike<number>, transform?: Transform4): Float64Array {
  if (flat.length % 3 !== 0)
    throw new GeometryError('no-nan', `coordinate count ${flat.length} is not a multiple of 3`);
  assertFinite(flat, 'coordinates');
  const out = new Float64Array(flat.length);
  if (!transform) {
    for (let i = 0; i < flat.length; i++) out[i] = flat[i];
    return out;
  }
  if (transform.length !== 16)
    throw new GeometryError('no-nan', `transform has ${transform.length} numbers, not 16`);
  assertFinite(transform, 'transform');
  const m = transform;
  const affine = m[12] === 0 && m[13] === 0 && m[14] === 0 && m[15] === 1;
  for (let i = 0; i < flat.length; i += 3) {
    const x = flat[i],
      y = flat[i + 1],
      z = flat[i + 2];
    let w = 1;
    if (!affine) {
      w = m[12] * x + m[13] * y + m[14] * z + m[15];
      if (!(Math.abs(w) > 1e-12))
        throw new GeometryError('no-nan', 'transform maps a point to infinity');
    }
    out[i] = (m[0] * x + m[1] * y + m[2] * z + m[3]) / w;
    out[i + 1] = (m[4] * x + m[5] * y + m[6] * z + m[7]) / w;
    out[i + 2] = (m[8] * x + m[9] * y + m[10] * z + m[11]) / w;
  }
  return out;
}

function planHull(world: Float64Array, keep?: (z: number) => boolean) {
  const points: [number, number][] = [];
  let zMin = Infinity,
    zMax = -Infinity;
  for (let i = 0; i < world.length; i += 3) {
    const z = world[i + 2];
    if (keep && !keep(z)) continue;
    points.push([world[i], world[i + 1]]);
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  return { hull: convexHull(points), z: [zMin, zMax] as [number, number], count: points.length };
}

/**
 * Plan footprint of one block instance. An empty definition, or points that do not enclose an
 * area in plan, throw `polygon-valid`; NaN coordinates or a bad transform throw `no-nan`.
 */
export function blockFootprints(
  definition: BlockDefinition,
  transform: Transform4,
  mode: FootprintMode = 'solid',
  options: FootprintOptions = {},
): BlockFootprint {
  if (!definition || typeof definition !== 'object')
    throw new GeometryError('polygon-valid', 'block definition is missing');
  const source = mode === 'outline' ? definition.segments : definition.vertices;
  if (!source || source.length === 0)
    throw new GeometryError(
      'polygon-valid',
      mode === 'outline' ? 'block definition has no segments' : 'block definition has no mesh',
    );
  const world = transformPoints(source, transform);
  let keep: ((z: number) => boolean) | undefined;
  if (mode === 'base') {
    const band = options.baseBand ?? 0.35;
    if (!Number.isFinite(band) || band < 0)
      throw new GeometryError('no-nan', `base band ${String(band)} is not a length`);
    let lowest = Infinity;
    for (let i = 2; i < world.length; i += 3) if (world[i] < lowest) lowest = world[i];
    keep = (z) => z <= lowest + band;
  }
  const { hull, z, count } = planHull(world, keep);
  if (hull.length < 3)
    throw new GeometryError('polygon-valid', `${mode} footprint does not enclose an area`);
  return { mode, rect: minAreaRect(hull), hull, z, points: count };
}

/** Plan convex hull of a mesh (e.g. a Brep render mesh of an underground beam), counter-clockwise. */
export function bandFromMesh(vertices: ArrayLike<number>, transform?: Transform4): Polygon {
  if (!vertices || vertices.length === 0) throw new GeometryError('polygon-valid', 'mesh is empty');
  const { hull } = planHull(transformPoints(vertices, transform));
  return requirePolygon(hull, 'mesh footprint');
}

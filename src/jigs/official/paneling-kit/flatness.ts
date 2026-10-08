// 3단계 평면도와 평면화 (SPEC-16.7 1·2, PLAN-49 T-256): the stage-2 plate of one panel on the
// reference surface, its check points (vertices, edge middles, centre — all on the surface; an edge's
// middle is at half its arc length and the centre is the surface point nearest the mean of the
// others, so neither depends on the face's parameterization), the
// best-fit plane through them (centroid + the covariance's smallest eigenvector, oriented to the
// reference normal) and the flatness = the largest check-point distance to that plane. Planarizing
// ('best-fit') projects the plate vertices perpendicularly onto that plane — a straight-edged flat
// plate — for every panel, also those already within the tolerance (the cut outline needs it).
//
// The two reports per plate:
//   offSurface — the largest distance of a flat-plate vertex from the reference surface, measured
//                along the surface normal at that vertex (the plate moves only slightly off it).
//   planarGap  — the gap planarizing opened against the neighbours that share a vertex key
//                (SPEC-16.5 5): the largest |dA − dB| over shared keys, where d = flat vertex −
//                surface vertex. With no joint the two surface vertices coincide and this is the
//                distance between the two plate vertices, exactly SPEC-16.7 2 ①; with a joint it
//                leaves out the joint width the plates were meant to keep.

import type { FaceSampler } from './sample.ts';
import {
  bestFitPlane,
  dot3,
  scale3,
  sub3,
  add3,
  len3,
  type Plane,
  type Vec2,
  type Vec3,
} from './vec.ts';

export interface PlateGeometry {
  /** Plate outline in UV (the member's joint-reduced outline), counter-clockwise from the reference normal. */
  uv: Vec2[];
  /** The outline's vertices on the surface. */
  surf: Vec3[];
  /** Midpoints of the outline edges on the surface (the UV midpoint mapped). */
  mids: Vec3[];
  /** Centre on the surface (the UV centroid mapped). */
  centre: Vec3;
  /** UV of every check point: vertices, then midpoints, then the centre. */
  checkUV: Vec2[];
  /** Reference normal at the centre (the face normal, reversed when `direction.flip`). */
  refNormal: Vec3;
  /** Best-fit plane of the check points; its normal points to the reference normal's side. */
  plane: Plane;
  /** Max check-point distance to the plane, metres. */
  flatness: number;
}

/** Subdivisions of an edge when finding its middle by arc length. */
const EDGE_STEPS = 8;

/**
 * The middle of a straight UV edge on the surface: the point at half its arc length (a polyline of
 * `EDGE_STEPS` pieces), so it does not depend on how the face is parameterized.
 */
function edgeMiddle(sampler: FaceSampler, a: Vec2, b: Vec2): Vec2 {
  const lengths = [0];
  let prev = sampler.point(a[0], a[1]);
  for (let k = 1; k <= EDGE_STEPS; k++) {
    const t = k / EDGE_STEPS;
    const q = sampler.point(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
    lengths.push(lengths[k - 1] + len3(sub3(q, prev)));
    prev = q;
  }
  const half = lengths[EDGE_STEPS] / 2;
  let k = 1;
  while (k < EDGE_STEPS && lengths[k] < half) k++;
  const span = lengths[k] - lengths[k - 1];
  const t = (k - 1 + (span > 0 ? (half - lengths[k - 1]) / span : 0.5)) / EDGE_STEPS;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * The panel's middle on the surface: the surface point nearest the mean of the vertices and edge
 * middles (Gauss–Newton from the UV centroid), again free of the parameterization.
 */
function panelMiddle(sampler: FaceSampler, uv: readonly Vec2[], pts: readonly Vec3[]): Vec2 {
  let target: Vec3 = [0, 0, 0];
  for (const p of pts) target = add3(target, p);
  target = scale3(target, 1 / pts.length);
  let u = 0,
    v = 0;
  for (const p of uv) {
    u += p[0];
    v += p[1];
  }
  u /= uv.length;
  v /= uv.length;
  const hu = (sampler.u1 - sampler.u0) * 1e-6,
    hv = (sampler.v1 - sampler.v0) * 1e-6;
  for (let it = 0; it < 4; it++) {
    const p = sampler.point(u, v);
    const pu = scale3(sub3(sampler.point(u + hu, v), sampler.point(u - hu, v)), 1 / (2 * hu));
    const pv = scale3(sub3(sampler.point(u, v + hv), sampler.point(u, v - hv)), 1 / (2 * hv));
    const r = sub3(target, p);
    const a = dot3(pu, pu),
      b = dot3(pu, pv),
      c = dot3(pv, pv);
    const det = a * c - b * b;
    if (!(Math.abs(det) > 1e-300)) break;
    const ru = dot3(pu, r),
      rv = dot3(pv, r);
    const du = (c * ru - b * rv) / det,
      dv = (a * rv - b * ru) / det;
    u += du;
    v += dv;
    if (Math.abs(du) <= hu && Math.abs(dv) <= hv) break;
  }
  return [u, v];
}

/** The plate of one panel measured on the surface (SPEC-16.7 1). */
export function measurePlate(
  sampler: FaceSampler,
  uv: readonly Vec2[],
  flip: number,
): PlateGeometry {
  const n = uv.length;
  const surf = uv.map(([u, v]) => sampler.point(u, v));
  const midUV: Vec2[] = [];
  for (let i = 0; i < n; i++) midUV.push(edgeMiddle(sampler, uv[i], uv[(i + 1) % n]));
  const mids = midUV.map(([u, v]) => sampler.point(u, v));
  const cUV = panelMiddle(sampler, uv, [...surf, ...mids]);
  const centre = sampler.point(cUV[0], cUV[1]);
  const refNormal = scale3(sampler.normal(cUV[0], cUV[1]), flip);
  const fit = bestFitPlane([...surf, ...mids, centre]);
  const normal = dot3(fit.normal, refNormal) < 0 ? scale3(fit.normal, -1) : fit.normal;
  const plane: Plane = { origin: fit.origin, normal };
  let flatness = 0;
  for (const p of [...surf, ...mids, centre])
    flatness = Math.max(flatness, Math.abs(dot3(sub3(p, plane.origin), normal)));
  return {
    uv: uv.map((p) => [p[0], p[1]] as Vec2),
    surf,
    mids,
    centre,
    checkUV: [...uv.map((p) => [p[0], p[1]] as Vec2), ...midUV, cUV],
    refNormal,
    plane,
    flatness,
  };
}

/** Perpendicular projection of a point onto a plane. */
export function projectToPlane(p: Vec3, plane: Plane): Vec3 {
  return sub3(p, scale3(plane.normal, dot3(sub3(p, plane.origin), plane.normal)));
}

/** The flat plate: every vertex projected onto the best-fit plane (SPEC-16.7 2 'best-fit'). */
export function planarize(plate: PlateGeometry): Vec3[] {
  return plate.surf.map((p) => projectToPlane(p, plate.plane));
}

/** Max distance of the flat-plate vertices from the reference surface (along its normal there). */
export function offSurface(
  sampler: FaceSampler,
  plate: PlateGeometry,
  flat: readonly Vec3[],
  flip: number,
): number {
  let worst = 0;
  for (let i = 0; i < flat.length; i++) {
    const [u, v] = plate.uv[i];
    const n = scale3(sampler.normal(u, v), flip);
    worst = Math.max(worst, Math.abs(dot3(sub3(flat[i], plate.surf[i]), n)));
  }
  return worst;
}

/** One plate vertex for the neighbour test: which panel, its key and how far planarizing moved it. */
export interface KeyedMove {
  panel: number;
  key: string;
  move: Vec3;
}

/**
 * planarGap per panel index: the largest |dA − dB| over the vertex keys a panel shares with other
 * panels (0 when it shares none). `moves` lists every flat-plate vertex with its key.
 */
export function planarGaps(moves: readonly KeyedMove[], panelCount: number): number[] {
  const byKey = new Map<string, KeyedMove[]>();
  for (const m of moves) {
    const list = byKey.get(m.key);
    if (list) list.push(m);
    else byKey.set(m.key, [m]);
  }
  const out = new Array<number>(panelCount).fill(0);
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++) {
        if (list[a].panel === list[b].panel) continue;
        const gap = len3(sub3(list[a].move, list[b].move));
        if (gap > out[list[a].panel]) out[list[a].panel] = gap;
        if (gap > out[list[b].panel]) out[list[b].panel] = gap;
      }
  }
  return out;
}

/** Area of a planar polygon in 3D (half the norm of the vector area). */
export function polygonArea3(ring: readonly Vec3[]): number {
  let s: Vec3 = [0, 0, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    s = add3(s, [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
  }
  return len3(s) / 2;
}

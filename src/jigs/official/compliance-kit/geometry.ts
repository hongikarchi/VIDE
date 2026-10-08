// 법규 체크의 형상 도움 함수 (SPEC-15.7, PLAN-48 T-238): the contract's triangle meshes as
// `vide/geometry-kit` solids, the part of a solid above a 기준 지반, the plan projection, and the
// pieces a boolean leaves after the geometric tolerances of SPEC-15.7 4 (0.001 ㎥, 1 mm). General
// geometry only — no legal value lives here. Pure TypeScript without node: imports.

import { signedArea, type Polygon, type Vec2, type Vec3 } from '../geometry-kit/plan.ts';
import {
  checkSolid,
  mergeCoplanar,
  prismSolid,
  sectionArea,
  solidIntersect,
  solidPolygon,
  solidSubtract,
  weldSolid,
  type Solid,
} from '../geometry-kit/solid.ts';
import type { Mesh } from '../../../contracts/compliance.ts';
import type { PlanRegion } from '../massing-kit/setback.ts';

/** Pieces at or below this volume (㎥) are numerical noise (SPEC-15.7 4). */
export const PIECE_VOLUME = 0.001;
/** Pieces at or below this thickness (m) are numerical noise (SPEC-15.7 4, SPEC-12.8 3). */
export const PIECE_THICKNESS = 0.001;
/** Heights closer than this (m) are one level (SPEC-15.3 4). */
export const LEVEL_TOL = 0.01;

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossV = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Signed volume of a polygon soup by the divergence theorem (no weld needed). */
export function polysVolume(s: Solid): number {
  if (!s.length) return 0;
  const o = s[0].v[0];
  let v = 0;
  for (const p of s) {
    const a = sub(p.v[0], o);
    for (let i = 1; i + 1 < p.v.length; i++)
      v += dot(a, crossV(sub(p.v[i], o), sub(p.v[i + 1], o))) / 6;
  }
  return v;
}

/** Surface area of a polygon soup. */
export function polysArea(s: Solid): number {
  let area = 0;
  for (const p of s)
    for (let i = 1; i + 1 < p.v.length; i++) {
      const c = crossV(sub(p.v[i], p.v[0]), sub(p.v[i + 1], p.v[0]));
      area += Math.hypot(c[0], c[1], c[2]) / 2;
    }
  return area;
}

export function boxOf(s: Solid): Box3 {
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of s)
    for (const v of p.v)
      for (let k = 0; k < 3; k++) {
        if (v[k] < min[k]) min[k] = v[k];
        if (v[k] > max[k]) max[k] = v[k];
      }
  return { min, max };
}

export interface PreparedSolid {
  solid: Solid;
  /** True when the welded mesh passes the closed-solid check (SPEC-12.9 4). */
  ok: boolean;
  reasons: string[];
  volume: number;
  box: Box3;
}

/**
 * A contract mesh as an outward solid: degenerate triangles dropped, flipped when the signed volume
 * is negative, then welded and checked. A mesh that fails the check is never used in a boolean.
 */
export function prepareMesh(m: Mesh): PreparedSolid {
  const v: Vec3[] = [];
  for (let i = 0; i + 2 < m.v.length; i += 3) v.push([m.v[i], m.v[i + 1], m.v[i + 2]]);
  let solid: Solid = [];
  for (let i = 0; i + 2 < m.f.length; i += 3) {
    const tri = [v[m.f[i]], v[m.f[i + 1]], v[m.f[i + 2]]];
    const c = crossV(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    if (!(Math.hypot(c[0], c[1], c[2]) > 1e-12)) continue;
    solid.push(solidPolygon(tri));
  }
  if (polysVolume(solid) < 0) solid = solid.map((p) => solidPolygon([...p.v].reverse()));
  let ok = false;
  let reasons: string[] = ['면 없음'];
  if (solid.length) {
    try {
      const check = checkSolid(weldSolid(solid));
      ok = check.ok;
      reasons = check.reasons;
    } catch (error) {
      reasons = [(error as Error).message];
    }
  }
  return { solid, ok, reasons, volume: polysVolume(solid), box: boxOf(solid) };
}

/** A solid moved vertically by dz. */
export const shiftSolid = (s: Solid, dz: number): Solid =>
  dz === 0 ? s : s.map((p) => solidPolygon(p.v.map((q): Vec3 => [q[0], q[1], q[2] + dz])));

/** A plan rectangle around a box with a margin. */
export function planBox(b: Box3, pad = 1): Polygon {
  return [
    [b.min[0] - pad, b.min[1] - pad],
    [b.max[0] + pad, b.min[1] - pad],
    [b.max[0] + pad, b.max[1] + pad],
    [b.min[0] - pad, b.max[1] + pad],
  ];
}

/** The part of a solid at or above z (whole when it lies above, empty when below). */
export function sliceAbove(p: PreparedSolid, z: number): Solid {
  if (p.box.min[2] >= z - 1e-9) return p.solid;
  if (p.box.max[2] <= z + 1e-9) return [];
  return solidIntersect(p.solid, prismSolid(planBox(p.box), z, p.box.max[2] + 1));
}

/** Area of the horizontal section of a closed solid half-way up (a one-floor solid). */
export function midSectionArea(p: PreparedSolid): number {
  return Math.abs(sectionArea(weldSolid(p.solid), (p.box.min[2] + p.box.max[2]) / 2));
}

/** Upward faces of a solid as plan regions (their union is the plan projection). */
export function projectionRegions(s: Solid): PlanRegion[] {
  const up = s.filter((p) => p.plane.n[2] > 1e-9);
  if (!up.length) return [];
  const toRegion = (ring: Vec3[], holes: Vec3[][] = []): PlanRegion => {
    const outer = ring.map((q): Vec2 => [q[0], q[1]]);
    return {
      outer: signedArea(outer) < 0 ? [...outer].reverse() : outer,
      holes: holes.map((h) => {
        const r = h.map((q): Vec2 => [q[0], q[1]]);
        return signedArea(r) > 0 ? [...r].reverse() : r;
      }),
    };
  };
  try {
    return mergeCoplanar(weldSolid(up)).map((face) => toRegion(face[0], face.slice(1)));
  } catch {
    return up.map((p) => toRegion(p.v));
  }
}

export interface Piece {
  solid: Solid;
  volume: number;
  box: Box3;
}

/**
 * A boolean result kept as a piece only above the tolerances. `max` is the volume the piece cannot
 * exceed (the object's own); a larger or clearly negative volume means the boolean failed.
 */
export function pieceOf(s: Solid, max: number): Piece | null | 'failed' {
  if (!s.length) return null;
  const volume = polysVolume(s);
  if (
    !Number.isFinite(volume) ||
    volume < -PIECE_VOLUME ||
    volume > max * (1 + 1e-6) + PIECE_VOLUME
  )
    return 'failed';
  if (volume <= PIECE_VOLUME) return null;
  const box = boxOf(s);
  const area = polysArea(s);
  const thickness = Math.min(
    box.max[0] - box.min[0],
    box.max[1] - box.min[1],
    box.max[2] - box.min[2],
    area > 0 ? (2 * volume) / area : 0,
  );
  if (thickness <= PIECE_THICKNESS) return null;
  return { solid: s, volume, box };
}

export type BooleanOp = 'intersect' | 'subtract';
export function booleanPiece(
  a: Solid,
  b: Solid,
  op: BooleanOp,
  max: number,
): Piece | null | 'failed' {
  try {
    return pieceOf(op === 'intersect' ? solidIntersect(a, b) : solidSubtract(a, b), max);
  } catch {
    return 'failed';
  }
}

/** A solid as the contract mesh (fan triangles of its convex polygons). */
export function solidMesh(s: Solid): Mesh {
  const v: number[] = [];
  const f: number[] = [];
  for (const p of s) {
    const base = v.length / 3;
    for (const q of p.v) v.push(q[0], q[1], q[2]);
    for (let i = 1; i + 1 < p.v.length; i++) f.push(base, base + i, base + i + 1);
  }
  return { v, f };
}

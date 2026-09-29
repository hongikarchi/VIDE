// Plan outline of a mesh's top face (RESEARCH-10 §9 경계·면, PLAN-23 T-050 `outlineFromMesh`):
// Sync sends Breps as render meshes only, so a slab's outline (with its voids) is read from the
// triangles that face up. Their unshared edges are the boundary; chained, they give one
// counter-clockwise outer ring per face and a clockwise ring per hole. Concave outlines are kept as
// they are, unlike the convex hull of `bandFromMesh`.

import {
  GeometryError,
  pointInPolygon,
  ring,
  signedArea,
  type Polygon,
  type Vec2,
} from './plan.ts';
import { transformPoints, type Transform4 } from './footprint.ts';

export interface OutlineOptions {
  /** Row-major 4×4 applied to the vertices first (a block instance). */
  transform?: Transform4;
  /** A triangle counts as top face when its unit normal's z exceeds this (default 0.7 ≈ 45°). */
  minNormalZ?: number;
  /** Vertices closer than this are one vertex (m, default 1e-6). */
  weld?: number;
  /** Ring vertices within this distance of the chord through their neighbours are dropped (m). */
  simplify?: number;
}

export interface MeshOutline {
  /** Counter-clockwise outer ring. */
  outer: Polygon;
  /** Voids inside `outer`, clockwise as chained (use `ring`/`counterClockwise` to rewind). */
  holes: Polygon[];
  /** Plan area of the outer ring less the holes (m²). */
  area: number;
  /** World z range of the ring vertices. */
  z: [number, number];
}

function lengthOption(value: number | undefined, fallback: number, what: string) {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || v < 0) throw new GeometryError('no-nan', `${what} ${String(value)}`);
  return v;
}

/**
 * Outlines of the top faces of a triangle mesh (flat xyz `vertices`, triangle `indices`), largest
 * first. A mesh without an upward face, or whose boundary does not close, throws `polygon-valid`.
 */
export function outlineFromMesh(
  vertices: ArrayLike<number>,
  indices: ArrayLike<number>,
  options: OutlineOptions = {},
): MeshOutline[] {
  if (!vertices || vertices.length === 0) throw new GeometryError('polygon-valid', 'mesh is empty');
  if (!indices || indices.length === 0 || indices.length % 3 !== 0)
    throw new GeometryError('polygon-valid', `mesh has ${indices?.length ?? 0} indices`);
  const minNormalZ = options.minNormalZ ?? 0.7;
  if (!Number.isFinite(minNormalZ)) throw new GeometryError('no-nan', 'minNormalZ');
  const weld = lengthOption(options.weld, 1e-6, 'weld');
  const simplify = lengthOption(options.simplify, 1e-6, 'simplify');
  const world = transformPoints(vertices, options.transform);
  const count = world.length / 3;

  // Weld by position so that faces sharing a seam share vertices.
  const welded = new Int32Array(count);
  const positions: [number, number, number][] = [];
  const byKey = new Map<string, number>();
  const quantum = weld > 0 ? weld : 1e-9;
  for (let i = 0; i < count; i++) {
    const x = world[3 * i],
      y = world[3 * i + 1],
      z = world[3 * i + 2];
    const k = `${Math.round(x / quantum)},${Math.round(y / quantum)},${Math.round(z / quantum)}`;
    let id = byKey.get(k);
    if (id === undefined) {
      id = positions.length;
      positions.push([x, y, z]);
      byKey.set(k, id);
    }
    welded[i] = id;
  }

  // Directed edges of upward triangles; an edge without its reverse is on the boundary.
  const directed = new Map<string, [number, number]>();
  let faces = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = welded[indices[i]],
      b = welded[indices[i + 1]],
      c = welded[indices[i + 2]];
    if (a === undefined || b === undefined || c === undefined)
      throw new GeometryError('polygon-valid', `triangle ${i / 3} points outside the vertex list`);
    if (a === b || b === c || a === c) continue;
    const [ax, ay, az] = positions[a],
      [bx, by, bz] = positions[b],
      [cx, cy, cz] = positions[c];
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az,
      vx = cx - ax,
      vy = cy - ay,
      vz = cz - az;
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 0) || nz / length <= minNormalZ) continue;
    faces++;
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const reverse = `${q}-${p}`;
      if (directed.has(reverse)) directed.delete(reverse);
      else directed.set(`${p}-${q}`, [p, q]);
    }
  }
  if (!faces) throw new GeometryError('polygon-valid', 'mesh has no upward face');

  // Chain boundary edges into loops; at a pinch vertex take the smallest next vertex.
  const outgoing = new Map<number, number[]>();
  for (const [p, q] of directed.values()) outgoing.set(p, [...(outgoing.get(p) ?? []), q]);
  for (const list of outgoing.values()) list.sort((a, b) => a - b);
  const starts = [...outgoing.keys()].sort((a, b) => a - b);
  const loops: number[][] = [];
  for (const start of starts) {
    if (!outgoing.get(start)?.length) continue;
    const loop = [start];
    let at = start;
    for (let guard = 0; guard <= directed.size; guard++) {
      const nexts = outgoing.get(at);
      if (!nexts?.length) throw new GeometryError('polygon-valid', 'mesh boundary does not close');
      const to = nexts.shift()!;
      if (to === start) break;
      loop.push(to);
      at = to;
      if (guard === directed.size)
        throw new GeometryError('polygon-valid', 'mesh boundary does not close');
    }
    loops.push(loop);
  }

  const simplified = loops.map((loop) => {
    const pts = ring(loop.map((v) => positions[v]));
    if (simplify <= 0 || pts.length < 4) return { ring: pts, z: zRange(loop, positions) };
    const keep: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = keep.length ? keep[keep.length - 1] : pts[(i + pts.length - 1) % pts.length];
      const next = pts[(i + 1) % pts.length];
      if (chordDistance(pts[i], prev, next) > simplify) keep.push(pts[i]);
    }
    // The first kept point may itself lie on the chord between its neighbours.
    if (keep.length > 3 && chordDistance(keep[0], keep[keep.length - 1], keep[1]) <= simplify)
      keep.shift();
    return { ring: keep, z: zRange(loop, positions) };
  });

  const outers: MeshOutline[] = [];
  const holes: { ring: Polygon; z: [number, number] }[] = [];
  for (const { ring: pts, z } of simplified) {
    if (pts.length < 3) continue;
    const area = signedArea(pts);
    if (area > 0) outers.push({ outer: pts, holes: [], area, z });
    else if (area < 0) holes.push({ ring: pts, z });
  }
  if (!outers.length) throw new GeometryError('polygon-valid', 'mesh top face has no area');
  outers.sort((p, q) => q.area - p.area);
  for (const hole of holes) {
    // The smallest outer containing the hole owns it.
    let owner: MeshOutline | undefined;
    for (const outer of outers) if (pointInPolygon(hole.ring[0], outer.outer, 0)) owner = outer;
    if (!owner) continue;
    owner.holes.push(hole.ring);
    owner.area -= Math.abs(signedArea(hole.ring));
    owner.z = [Math.min(owner.z[0], hole.z[0]), Math.max(owner.z[1], hole.z[1])];
  }
  return outers;
}

function zRange(loop: number[], positions: [number, number, number][]): [number, number] {
  let min = Infinity,
    max = -Infinity;
  for (const v of loop) {
    const z = positions[v][2];
    if (z < min) min = z;
    if (z > max) max = z;
  }
  return [min, max];
}

function chordDistance(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / length;
}

// Planar-graph faces (PLAN-23 T-053, SPEC-06.11 6): the closed cells a drawn line network makes in
// plan. Segments are first split where they cross, touch (T-junction) or overlap, endpoints within
// the tolerance are merged, dangling edges are pruned, and the faces are traced on the half-edge
// graph. Bounded faces come back counter-clockwise with the islands inside them as clockwise holes;
// the unbounded outer face is left out. Each edge keeps the tags of the segments it came from, so a
// cell knows which girders (or slab / void edges) bound it.

import {
  GeometryError,
  assertPoints,
  pointInPolygon,
  signedArea,
  type PlanPoint,
  type Polygon,
  type Vec2,
} from './plan.ts';
import { lineCrossings } from './polygon.ts';

export interface FaceSegment {
  a: PlanPoint;
  b: PlanPoint;
  /** Carried to every edge cut from this segment (e.g. a girder id). */
  tag?: string;
}

export interface FaceOptions {
  /** Endpoints and crossings closer than this merge (m, default 1e-6). */
  tol?: number;
  /** Remove edges that end in nothing (default true). */
  pruneDangling?: boolean;
  /** Faces smaller than this are dropped as slivers (m², default tol²·10). */
  minArea?: number;
}

export interface PlanarFace {
  /** Counter-clockwise outer ring (vertex i → i + 1 is edge i). */
  outer: Polygon;
  /** Clockwise rings of the islands inside the face. */
  holes: Polygon[];
  /** Tags of each outer edge, aligned with `outer`. */
  outerTags: string[][];
  /** Tags of each hole edge. */
  holeTags: string[][][];
  /** Every tag on the face's boundary, sorted. */
  tags: string[];
  /** Outer area less the holes (m²). */
  area: number;
}

export interface PlanarFaces {
  faces: PlanarFace[];
  /** Merged graph vertices. */
  vertices: Vec2[];
  /** Graph edges after splitting and merging (vertex indices, tags). */
  edges: { a: number; b: number; tags: string[] }[];
  /** Edges removed because they ended in nothing. */
  pruned: number;
}

/** Parameters (0…1 on a–b) where segment c–d meets a–b, including touches and overlap ends. */
function meetings(a: Vec2, b: Vec2, c: Vec2, d: Vec2, tol: number): number[] {
  const rx = b[0] - a[0],
    ry = b[1] - a[1];
  const sx = d[0] - c[0],
    sy = d[1] - c[1];
  const len2 = rx * rx + ry * ry;
  const len = Math.sqrt(len2);
  if (!(len > 0)) return [];
  const out: number[] = [];
  const project = (p: Vec2) => {
    const t = ((p[0] - a[0]) * rx + (p[1] - a[1]) * ry) / len2;
    if (t < -tol / len || t > 1 + tol / len) return;
    const qx = a[0] + t * rx - p[0],
      qy = a[1] + t * ry - p[1];
    if (Math.hypot(qx, qy) <= tol) out.push(Math.min(1, Math.max(0, t)));
  };
  // Endpoints of c–d on a–b (T-junctions, overlap ends) and of a–b on c–d are handled from both
  // sides because every pair is visited both ways.
  project(c);
  project(d);
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) > 1e-12 * len * Math.hypot(sx, sy)) {
    const qpx = c[0] - a[0],
      qpy = c[1] - a[1];
    const t = (qpx * sy - qpy * sx) / denom;
    const u = (qpx * ry - qpy * rx) / denom;
    const slen = Math.hypot(sx, sy);
    if (t > -tol / len && t < 1 + tol / len && u > -tol / slen && u < 1 + tol / slen)
      out.push(Math.min(1, Math.max(0, t)));
  }
  return out;
}

class VertexGrid {
  readonly points: Vec2[] = [];
  private readonly cells = new Map<string, number[]>();
  private readonly tol: number;
  private readonly size: number;
  constructor(tol: number) {
    this.tol = tol;
    this.size = Math.max(tol, 1e-9) * 4;
  }
  private key(i: number, j: number) {
    return `${i},${j}`;
  }
  add(p: Vec2): number {
    const ci = Math.floor(p[0] / this.size),
      cj = Math.floor(p[1] / this.size);
    let best = -1,
      bestD = Infinity;
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (const k of this.cells.get(this.key(ci + di, cj + dj)) ?? []) {
          const q = this.points[k];
          const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
          if (d <= this.tol && d < bestD) {
            best = k;
            bestD = d;
          }
        }
    if (best >= 0) return best;
    const index = this.points.length;
    this.points.push([p[0], p[1]]);
    const key = this.key(ci, cj);
    const list = this.cells.get(key);
    if (list) list.push(index);
    else this.cells.set(key, [index]);
    return index;
  }
}

/** Bounded faces of the plan graph the segments make (see the file comment). */
export function planarFaces(
  segments: readonly FaceSegment[],
  options: FaceOptions = {},
): PlanarFaces {
  if (!Array.isArray(segments)) throw new GeometryError('polygon-valid', 'segments is not a list');
  const tol = options.tol ?? 1e-6;
  if (!Number.isFinite(tol) || tol < 0) throw new GeometryError('no-nan', `tol ${String(tol)}`);
  const minArea = options.minArea ?? Math.max(tol * tol * 10, 1e-12);
  const segs = segments.map((s, i) => {
    assertPoints([s?.a, s?.b], `segments[${i}]`);
    return { a: [s.a[0], s.a[1]] as Vec2, b: [s.b[0], s.b[1]] as Vec2, tag: s.tag };
  });

  // 1. Split every segment where others meet it.
  const grid = new VertexGrid(tol);
  const edgeMap = new Map<string, { a: number; b: number; tags: Set<string> }>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const ts = [0, 1];
    for (let j = 0; j < segs.length; j++) {
      if (j === i) continue;
      ts.push(...meetings(s.a, s.b, segs[j].a, segs[j].b, tol));
    }
    ts.sort((x, y) => x - y);
    const at = (t: number): Vec2 => [
      s.a[0] + t * (s.b[0] - s.a[0]),
      s.a[1] + t * (s.b[1] - s.a[1]),
    ];
    let prev = grid.add(at(ts[0]));
    for (let k = 1; k < ts.length; k++) {
      const next = grid.add(at(ts[k]));
      if (next === prev) continue;
      const key = prev < next ? `${prev}:${next}` : `${next}:${prev}`;
      let edge = edgeMap.get(key);
      if (!edge) {
        edge = { a: Math.min(prev, next), b: Math.max(prev, next), tags: new Set() };
        edgeMap.set(key, edge);
      }
      if (s.tag !== undefined) edge.tags.add(s.tag);
      prev = next;
    }
  }
  const vertices = grid.points;

  // 2. Prune dangling edges.
  const alive = new Map(edgeMap);
  const degree = new Array<number>(vertices.length).fill(0);
  for (const e of alive.values()) {
    degree[e.a]++;
    degree[e.b]++;
  }
  let pruned = 0;
  if (options.pruneDangling ?? true) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [key, e] of alive) {
        if (degree[e.a] <= 1 || degree[e.b] <= 1) {
          alive.delete(key);
          degree[e.a]--;
          degree[e.b]--;
          pruned++;
          changed = true;
        }
      }
    }
  }

  // 3. Half-edge walk: next of u→v is v→w with w the neighbour just clockwise of u around v, so
  //    each face lies on the left; bounded faces come out counter-clockwise.
  const neighbours: number[][] = vertices.map(() => []);
  const tagsOf = new Map<string, string[]>();
  for (const e of alive.values()) {
    neighbours[e.a].push(e.b);
    neighbours[e.b].push(e.a);
    const tags = [...e.tags].sort();
    tagsOf.set(`${e.a}:${e.b}`, tags);
    tagsOf.set(`${e.b}:${e.a}`, tags);
  }
  const angle = (from: number, to: number) =>
    Math.atan2(vertices[to][1] - vertices[from][1], vertices[to][0] - vertices[from][0]);
  for (let v = 0; v < neighbours.length; v++)
    neighbours[v].sort((x, y) => angle(v, x) - angle(v, y));
  const visited = new Set<string>();
  const cycles: { ring: number[]; area: number }[] = [];
  for (const e of alive.values())
    for (const [u0, v0] of [
      [e.a, e.b],
      [e.b, e.a],
    ]) {
      if (visited.has(`${u0}:${v0}`)) continue;
      const ring: number[] = [];
      let u = u0,
        v = v0;
      for (let guard = 0; guard <= 2 * alive.size + 2; guard++) {
        visited.add(`${u}:${v}`);
        ring.push(u);
        const around = neighbours[v];
        const k = around.indexOf(u);
        const w = around[(k - 1 + around.length) % around.length];
        u = v;
        v = w;
        if (u === u0 && v === v0) break;
      }
      cycles.push({ ring, area: signedArea(ring.map((i) => vertices[i])) });
    }

  // 4. Bounded faces, and the outer boundary of every island as a hole of the smallest face around it.
  const toPolygon = (ring: number[]): Polygon => ring.map((i): Vec2 => [...vertices[i]] as Vec2);
  const edgeTags = (ring: number[]) =>
    ring.map((i, k) => tagsOf.get(`${i}:${ring[(k + 1) % ring.length]}`) ?? []);
  const bounded = cycles.filter((c) => c.area > minArea);
  const faces: PlanarFace[] = bounded.map((c) => ({
    outer: toPolygon(c.ring),
    holes: [],
    outerTags: edgeTags(c.ring),
    holeTags: [],
    tags: [],
    area: c.area,
  }));
  for (const c of cycles) {
    if (c.area > minArea || c.ring.length < 3 || Math.abs(c.area) <= minArea) continue;
    const probe = vertices[c.ring[0]];
    let host = -1;
    for (let f = 0; f < faces.length; f++) {
      if (faces[f].outer.some((p) => p[0] === probe[0] && p[1] === probe[1])) continue;
      if (!pointInPolygon(probe, faces[f].outer, 0)) continue;
      if (host < 0 || bounded[f].area < bounded[host].area) host = f;
    }
    if (host < 0) continue;
    faces[host].holes.push(toPolygon(c.ring));
    faces[host].holeTags.push(edgeTags(c.ring));
    faces[host].area -= Math.abs(c.area);
  }
  for (const face of faces)
    face.tags = [...new Set([...face.outerTags.flat(), ...face.holeTags.flat().flat()])].sort();

  return {
    faces,
    vertices,
    edges: [...alive.values()].map((e) => ({ a: e.a, b: e.b, tags: [...e.tags].sort() })),
    pruned,
  };
}

/**
 * A point well inside a face (outer ring less holes): the middle of the widest run of a few scan
 * lines between vertex heights. Works for concave faces, where the centroid can fall outside.
 */
export function interiorPoint(
  outer: readonly PlanPoint[],
  holes: readonly (readonly PlanPoint[])[] = [],
): Vec2 {
  assertPoints(outer, 'outer');
  const ys = [...new Set([...outer, ...holes.flat()].map((p) => p[1]))].sort((a, b) => a - b);
  let best: Vec2 | null = null,
    bestWidth = -Infinity;
  for (let i = 0; i + 1 < ys.length; i++) {
    if (!(ys[i + 1] - ys[i] > 1e-12)) continue;
    const y = (ys[i] + ys[i + 1]) / 2;
    const ts = [outer, ...holes].flatMap((ring) => lineCrossings([0, y], [1, 0], ring));
    ts.sort((a, b) => a - b);
    for (let k = 0; k + 1 < ts.length; k += 2) {
      const width = ts[k + 1] - ts[k];
      if (width > bestWidth) {
        bestWidth = width;
        best = [(ts[k] + ts[k + 1]) / 2, y];
      }
    }
  }
  if (!best) throw new GeometryError('polygon-valid', 'face has no interior');
  return best;
}

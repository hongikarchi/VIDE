// Planar-polygon solids (PLAN-45 T-210, SPIKE-2026-10-07-envelope 결론 4): boolean union,
// difference and intersection by BSP trees (the constructive-solid-geometry algorithm popularised
// by csg.js, Evan Wallace, MIT; written again in TypeScript for metre coordinates), the weld that
// repairs the T-junctions BSP leaves, the closed-solid check (closed, manifold, one shell, Euler 2,
// outward = positive signed volume, no degenerate polygon, shortest edge), horizontal sections and
// the merge of coplanar polygons into faces with holes that `vide.bake.brep-faces@1` makes in Rhino.
// Every output polygon is an exact planar piece of an input plane, so an envelope made of planes
// needs no sampling. General geometry only: no rule of any law lives here.
//
// Coordinates must be local (a few hundred metres around a site origin): EPS is absolute (1e-7 m).

import { GeometryError, signedArea, type Polygon, type Vec2, type Vec3 } from './plan.ts';
import { regionTriangles } from './triangulate.ts';

export interface Plane {
  n: Vec3;
  w: number;
}
export interface SolidPolygon {
  v: Vec3[];
  plane: Plane;
}
/** A closed solid as a list of outward-facing planar convex polygons. */
export type Solid = SolidPolygon[];

/** BSP plane tolerance (m). */
export const SOLID_EPS = 1e-7;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Newell normal (not normalised; half its length is the polygon's area). */
function newellOf(points: readonly Vec3[]): Vec3 {
  let nx = 0,
    ny = 0,
    nz = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      q = points[(i + 1) % points.length];
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  return [nx, ny, nz];
}

/** Plane of a planar polygon by Newell's method (robust for collinear leading vertices). */
export function planeOf(v: readonly Vec3[]): Plane {
  const [nx, ny, nz] = newellOf(v);
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 0)) throw new GeometryError('polygon-valid', 'degenerate polygon');
  const n: Vec3 = [nx / l, ny / l, nz / l];
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const p of v) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  return { n, w: dot(n, [cx / v.length, cy / v.length, cz / v.length]) };
}

export const solidPolygon = (v: Vec3[], plane?: Plane): SolidPolygon => ({
  v,
  plane: plane ?? planeOf(v),
});
const flip = (p: SolidPolygon): SolidPolygon => ({
  v: [...p.v].reverse(),
  plane: { n: [-p.plane.n[0], -p.plane.n[1], -p.plane.n[2]], w: -p.plane.w },
});

const COPLANAR = 0,
  FRONT = 1,
  BACK = 2,
  SPANNING = 3;

function split(
  plane: Plane,
  p: SolidPolygon,
  cf: SolidPolygon[],
  cb: SolidPolygon[],
  front: SolidPolygon[],
  back: SolidPolygon[],
) {
  let type = 0;
  const types: number[] = [];
  for (const v of p.v) {
    const t = dot(plane.n, v) - plane.w;
    const ty = t < -SOLID_EPS ? BACK : t > SOLID_EPS ? FRONT : COPLANAR;
    type |= ty;
    types.push(ty);
  }
  if (type === COPLANAR) (dot(plane.n, p.plane.n) > 0 ? cf : cb).push(p);
  else if (type === FRONT) front.push(p);
  else if (type === BACK) back.push(p);
  else {
    const f: Vec3[] = [],
      b: Vec3[] = [];
    for (let i = 0; i < p.v.length; i++) {
      const j = (i + 1) % p.v.length;
      const ti = types[i],
        tj = types[j],
        vi = p.v[i],
        vj = p.v[j];
      if (ti !== BACK) f.push(vi);
      if (ti !== FRONT) b.push(vi);
      if ((ti | tj) === SPANNING) {
        const t = (plane.w - dot(plane.n, vi)) / dot(plane.n, sub(vj, vi));
        const v = lerp(vi, vj, t);
        f.push(v);
        b.push([v[0], v[1], v[2]]);
      }
    }
    if (f.length >= 3) front.push({ v: f, plane: p.plane });
    if (b.length >= 3) back.push({ v: b, plane: p.plane });
  }
}

class BspNode {
  plane: Plane | null = null;
  front: BspNode | null = null;
  back: BspNode | null = null;
  polys: SolidPolygon[] = [];
  constructor(polys?: SolidPolygon[]) {
    if (polys) this.build(polys);
  }
  // Iterative walks: deep trees otherwise risk the call stack on large envelopes.
  invert() {
    const stack: BspNode[] = [this];
    while (stack.length) {
      const n = stack.pop()!;
      n.polys = n.polys.map(flip);
      if (n.plane) n.plane = { n: [-n.plane.n[0], -n.plane.n[1], -n.plane.n[2]], w: -n.plane.w };
      const t = n.front;
      n.front = n.back;
      n.back = t;
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
  }
  clipPolygons(polys: SolidPolygon[]): SolidPolygon[] {
    if (!this.plane) return polys.slice();
    let front: SolidPolygon[] = [],
      back: SolidPolygon[] = [];
    for (const p of polys) split(this.plane, p, front, back, front, back);
    if (this.front) front = this.front.clipPolygons(front);
    back = this.back ? this.back.clipPolygons(back) : [];
    return front.concat(back);
  }
  clipTo(bsp: BspNode) {
    const stack: BspNode[] = [this];
    while (stack.length) {
      const n = stack.pop()!;
      n.polys = bsp.clipPolygons(n.polys);
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
  }
  all(): SolidPolygon[] {
    const out: SolidPolygon[] = [];
    const stack: BspNode[] = [this];
    while (stack.length) {
      const n = stack.pop()!;
      out.push(...n.polys);
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
    return out;
  }
  build(polys: SolidPolygon[]) {
    const work: [BspNode, SolidPolygon[]][] = [[this, polys]];
    while (work.length) {
      const [n, ps] = work.pop()!;
      if (!ps.length) continue;
      if (!n.plane) n.plane = ps[0].plane;
      const front: SolidPolygon[] = [],
        back: SolidPolygon[] = [];
      for (const p of ps) split(n.plane, p, n.polys, n.polys, front, back);
      if (front.length) work.push([(n.front ??= new BspNode()), front]);
      if (back.length) work.push([(n.back ??= new BspNode()), back]);
    }
  }
}

export function solidUnion(a: Solid, b: Solid): Solid {
  if (!a.length) return b.slice();
  if (!b.length) return a.slice();
  const A = new BspNode(a),
    B = new BspNode(b);
  A.clipTo(B);
  B.clipTo(A);
  B.invert();
  B.clipTo(A);
  B.invert();
  A.build(B.all());
  return A.all();
}
export function solidSubtract(a: Solid, b: Solid): Solid {
  if (!a.length || !b.length) return a.slice();
  const A = new BspNode(a),
    B = new BspNode(b);
  A.invert();
  A.clipTo(B);
  B.clipTo(A);
  B.invert();
  B.clipTo(A);
  B.invert();
  A.build(B.all());
  A.invert();
  return A.all();
}
export function solidIntersect(a: Solid, b: Solid): Solid {
  if (!a.length || !b.length) return [];
  const A = new BspNode(a),
    B = new BspNode(b);
  A.invert();
  B.clipTo(A);
  B.invert();
  A.clipTo(B);
  B.clipTo(A);
  A.build(B.all());
  A.invert();
  return A.all();
}
export const solidUnionAll = (solids: readonly Solid[]): Solid =>
  solids.reduce<Solid>((acc, s) => solidUnion(acc, s), []);

// ── Construction ────────────────────────────────────────────────────────────────────────────────

const ccwRing = (r: Polygon): Polygon => (signedArea(r) < 0 ? [...r].reverse() : r);

/**
 * Ear clipping of a simple counter-clockwise ring (no holes) into convex pieces. Vertices on a
 * straight run (a section cut leaves dozens on one line, a read-back ring is off by 1e-5) cannot
 * be ear tips and block the clipping, so the ring is clipped without them and each is put back on
 * the boundary edge it lies on: the pieces keep every ring vertex (no T-junction with the walls)
 * and stay convex (T-214, a real lot's floor section).
 */
export function earClip(ring: Polygon): Polygon[] {
  const n = ring.length;
  const straight = (i: number) => {
    const a = ring[(i + n - 1) % n],
      b = ring[i],
      c = ring[(i + 1) % n];
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      vx = c[0] - b[0],
      vy = c[1] - b[1];
    const lu = Math.hypot(ux, uy),
      lv = Math.hypot(vx, vy);
    if (lu === 0 || lv === 0) return true;
    return Math.abs(ux * vy - uy * vx) <= 1e-10 * lu * lv && ux * vx + uy * vy > 0;
  };
  const kept = ring.map((_, i) => i).filter((i) => !straight(i));
  if (kept.length === n || kept.length < 3) return earClipCore(ring);
  const pieces = earClipCore(kept.map((i) => ring[i]));
  const at = new Map(kept.map((i, k) => [i, k]));
  const indexOf = new Map<Vec2, number>(kept.map((i) => [ring[i], i]));
  return pieces.map((piece) => {
    const out: Vec2[] = [];
    piece.forEach((p, k) => {
      const u = indexOf.get(p)!,
        v = indexOf.get(piece[(k + 1) % piece.length])!;
      out.push(p);
      // A boundary edge of the kept ring: put back the straight-run vertices between u and v.
      if ((at.get(u)! + 1) % kept.length === at.get(v))
        for (let j = (u + 1) % n; j !== v; j = (j + 1) % n) out.push(ring[j]);
    });
    return out;
  });
}

function earClipCore(ring: Polygon): Polygon[] {
  const idx = ring.map((_, i) => i);
  const out: Polygon[] = [];
  const cr = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  while (idx.length > 3) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length],
        i1 = idx[k],
        i2 = idx[(k + 1) % idx.length];
      const a = ring[i0],
        b = ring[i1],
        c = ring[i2];
      if (cr(a, b, c) <= 1e-12) continue;
      let inside = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        const p = ring[j];
        if (cr(a, b, p) >= 0 && cr(b, c, p) >= 0 && cr(c, a, p) >= 0) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      out.push([a, b, c]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut)
      throw new GeometryError('polygon-valid', 'ring cannot be triangulated (crosses itself?)');
  }
  out.push(idx.map((i) => ring[i]));
  return out;
}

const isConvex = (r: Polygon) => {
  for (let i = 0; i < r.length; i++) {
    const o = r[i],
      a = r[(i + 1) % r.length],
      b = r[(i + 2) % r.length];
    if ((a[0] - o[0]) * (b[1] - a[1]) - (a[1] - o[1]) * (b[0] - a[0]) < -1e-12) return false;
  }
  return true;
};

/** Closed prism of a simple plan ring between z0 and z1 (outward polygons). */
export function prismSolid(ring: Polygon, z0: number, z1: number): Solid {
  if (!(z1 > z0)) throw new GeometryError('polygon-valid', 'prism height must be positive');
  const r = ccwRing(ring);
  const caps = isConvex(r) ? [r] : earClip(r);
  const out: Solid = [];
  for (const c of caps) {
    out.push(solidPolygon(c.map(([x, y]): Vec3 => [x, y, z1])));
    out.push(solidPolygon([...c].reverse().map(([x, y]): Vec3 => [x, y, z0])));
  }
  for (let i = 0; i < r.length; i++) {
    const p = r[i],
      q = r[(i + 1) % r.length];
    out.push(
      solidPolygon([
        [p[0], p[1], z0],
        [q[0], q[1], z0],
        [q[0], q[1], z1],
        [p[0], p[1], z1],
      ]),
    );
  }
  return out;
}

/** Points closer than this (m) are one vertex of a cleaned ring (10 × SOLID_EPS: the weld). */
const RING_MERGE = 1e-6;

/**
 * A plan ring without repeated points (closer than RING_MERGE), straight-run vertices (turn below
 * 1e-10 rad, as `earClip`) or zero-width spikes, so its triangulation has no zero-area triangle.
 */
export function cleanRing(ring: Polygon): Polygon {
  let r: Polygon = [];
  for (const p of ring) {
    const q = r[r.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > RING_MERGE) r.push([p[0], p[1]]);
  }
  while (
    r.length > 1 &&
    Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) <= RING_MERGE
  )
    r.pop();
  for (let changed = true; changed && r.length > 3; ) {
    changed = false;
    const n = r.length;
    const keep = r.filter((b, i) => {
      const a = r[(i + n - 1) % n],
        c = r[(i + 1) % n];
      const ux = b[0] - a[0],
        uy = b[1] - a[1],
        vx = c[0] - b[0],
        vy = c[1] - b[1];
      // A straight-run vertex, or the tip of a zero-width spike (the ring turns back on itself).
      return !(Math.abs(ux * vy - uy * vx) <= 1e-10 * Math.hypot(ux, uy) * Math.hypot(vx, vy));
    });
    if (keep.length < n && keep.length >= 3) {
      r = keep;
      changed = true;
    }
  }
  return r;
}

/**
 * Closed prism of a plan region (outer ring less holes) between z0 and z1, built directly: the caps
 * are a constrained triangulation of the ring vertices and every ring edge gives one wall quad, so
 * every edge is shared by exactly two polygons by construction — no boolean, no weld repair
 * (T-214 F-6: the 돌출 외피 of a real lot whose capsule booleans left open edges).
 */
export function regionPrismSolid(
  outer: Polygon,
  holes: readonly Polygon[],
  z0: number,
  z1: number,
  /** Caps from the constrained triangulation even without holes (ear clipping can overlap). */
  triangulated = false,
): Solid {
  if (!(z1 > z0)) throw new GeometryError('polygon-valid', 'prism height must be positive');
  const o = ccwRing(cleanRing(outer));
  const hs = holes.map((h) => {
    const c = cleanRing(h);
    return signedArea(c) > 0 ? [...c].reverse() : c;
  });
  if (o.length < 3 || hs.some((h) => h.length < 3))
    throw new GeometryError('polygon-valid', 'region ring has fewer than 3 points');
  const out: Solid = [];
  // Without holes: one convex cap or ear-clipped convex pieces (fewer, larger polygons for later
  // booleans); with holes, when ear clipping stops, or when asked, the constrained triangulation.
  let caps: Polygon[];
  try {
    caps = hs.length || triangulated ? regionTriangles(o, hs) : isConvex(o) ? [o] : earClip(o);
  } catch {
    caps = regionTriangles(o, hs);
  }
  for (const t of caps) {
    out.push(solidPolygon(t.map(([x, y]): Vec3 => [x, y, z1])));
    out.push(solidPolygon([...t].reverse().map(([x, y]): Vec3 => [x, y, z0])));
  }
  for (const r of [o, ...hs])
    for (let i = 0; i < r.length; i++) {
      const p = r[i],
        q = r[(i + 1) % r.length];
      out.push(
        solidPolygon([
          [p[0], p[1], z0],
          [q[0], q[1], z0],
          [q[0], q[1], z1],
          [p[0], p[1], z1],
        ]),
      );
    }
  return out;
}

/**
 * Closed solid between two convex plan rings at z0 and z1 whose corresponding edges are parallel
 * (a frustum of a capsule or a parallelogram): every side is an exact planar quad.
 */
export function loftSolid(lower: Polygon, z0: number, upper: Polygon, z1: number): Solid {
  if (lower.length !== upper.length || lower.length < 3 || !(z1 > z0))
    throw new GeometryError('polygon-valid', 'loft rings must correspond');
  const flipBoth = signedArea(lower) < 0;
  const lo = flipBoth ? [...lower].reverse() : lower,
    hi = flipBoth ? [...upper].reverse() : upper;
  const out: Solid = [
    solidPolygon(hi.map(([x, y]): Vec3 => [x, y, z1])),
    solidPolygon([...lo].reverse().map(([x, y]): Vec3 => [x, y, z0])),
  ];
  for (let i = 0; i < lo.length; i++) {
    const j = (i + 1) % lo.length;
    out.push(
      solidPolygon([
        [lo[i][0], lo[i][1], z0],
        [lo[j][0], lo[j][1], z0],
        [hi[j][0], hi[j][1], z1],
        [hi[i][0], hi[i][1], z1],
      ]),
    );
  }
  return out;
}

// ── Mesh, weld and check ────────────────────────────────────────────────────────────────────────

export interface SolidMesh {
  v: Vec3[];
  /** Planar convex polygons as vertex indices, counter-clockwise seen from outside. */
  f: number[][];
}

export interface SolidCheck {
  ok: boolean;
  reasons: string[];
  /** Notes that do not fail the check (e.g. edges shorter than Rhino likes). */
  warnings: string[];
  vertices: number;
  polygons: number;
  /** Maximal coplanar edge-connected polygon groups = faces of the merged polysurface. */
  planarFaces: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  shells: number;
  euler: number;
  /** Signed volume (m³): negative for an inside-out solid. */
  volume: number;
  area: number;
  /** Largest distance of a vertex from its polygon's plane (m). */
  planarity: number;
  degenerate: number;
  /** Shortest edge between two different merged faces (m). */
  shortestEdge: number;
}

/** Edges shorter than this are reported (Rhino joins at 1e-5 m; SPIKE 결론 3). */
export const SHORT_EDGE = 1e-4;

const gridKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

function dedupeLoop(loop: number[]) {
  const out: number[] = [];
  for (const i of loop) if (out[out.length - 1] !== i) out.push(i);
  while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}
const loopArea = (v: Vec3[], loop: number[]) => Math.hypot(...newellOf(loop.map((i) => v[i]))) / 2;

/**
 * Weld polygon corners within `tol` (m) and insert every welded vertex lying on a polygon edge
 * (T-junction repair). `tol` must not exceed SOLID_EPS: a coarser weld merges distinct corners of
 * tiny facets (spike stress site: 1e-6 opened 3 edges).
 */
export function weldSolid(polys: Solid, tol = SOLID_EPS): SolidMesh {
  const v: Vec3[] = [];
  const grid = new Map<string, number[]>();
  const id = (p: Vec3) => {
    const gx = Math.round(p[0] / tol),
      gy = Math.round(p[1] / tol),
      gz = Math.round(p[2] / tol);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const i of grid.get(gridKey(gx + dx, gy + dy, gz + dz)) ?? [])
            if (Math.hypot(v[i][0] - p[0], v[i][1] - p[1], v[i][2] - p[2]) <= tol) return i;
    v.push([p[0], p[1], p[2]]);
    const k = gridKey(gx, gy, gz);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(v.length - 1);
    return v.length - 1;
  };
  let f = polys.map((p) => dedupeLoop(p.v.map(id))).filter((loop) => loop.length >= 3);

  const cell = 1;
  const buckets = new Map<string, number[]>();
  v.forEach((p, i) => {
    const k = gridKey(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell));
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
  });
  const near = (a: Vec3, b: Vec3) => {
    const out: number[] = [];
    const lo = [0, 1, 2].map((i) => Math.floor((Math.min(a[i], b[i]) - tol) / cell));
    const hi = [0, 1, 2].map((i) => Math.floor((Math.max(a[i], b[i]) + tol) / cell));
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) out.push(...(buckets.get(gridKey(x, y, z)) ?? []));
    return out;
  };
  const tTol = tol * 10;
  f = f.map((loop) => {
    const out: number[] = [];
    for (let e = 0; e < loop.length; e++) {
      const i = loop[e],
        j = loop[(e + 1) % loop.length];
      out.push(i);
      const a = v[i],
        d = sub(v[j], a);
      const L2 = dot(d, d);
      const mids: [number, number][] = [];
      for (const k of near(a, v[j])) {
        if (k === i || k === j) continue;
        const t = dot(sub(v[k], a), d) / L2;
        if (t <= 0 || t >= 1) continue;
        const q: Vec3 = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
        if (Math.hypot(q[0] - v[k][0], q[1] - v[k][1], q[2] - v[k][2]) <= tTol) mids.push([t, k]);
      }
      mids.sort((x, y) => x[0] - y[0]);
      for (const [, k] of mids) out.push(k);
    }
    return dedupeLoop(out);
  });
  return { v, f: f.filter((loop) => loop.length >= 3 && loopArea(v, loop) > tol * tol) };
}

/** Plane key of a loop for coplanar grouping (normal and offset rounded to 1e-5). */
function planeKey(m: SolidMesh, loop: number[]) {
  const n = newellOf(loop.map((i) => m.v[i]));
  const l = Math.hypot(...n);
  const u: Vec3 = [n[0] / l, n[1] / l, n[2] / l];
  const w = dot(u, m.v[loop[0]]);
  return [u[0], u[1], u[2], w].map((x) => Math.round(x * 1e5) + 0).join(',');
}

/** Coplanar edge-connected groups of polygons: the merged faces (group index per polygon). */
function coplanarGroups(m: SolidMesh): number[] {
  const N = m.v.length;
  const keys = m.f.map((loop) => planeKey(m, loop));
  const gp = m.f.map((_, i) => i);
  const find = (i: number): number => (gp[i] === i ? i : (gp[i] = find(gp[i])));
  const edgeFaces = new Map<number, number[]>();
  m.f.forEach((loop, fi) => {
    for (let e = 0; e < loop.length; e++) {
      const a = loop[e],
        b = loop[(e + 1) % loop.length];
      const k = Math.min(a, b) * N + Math.max(a, b);
      (edgeFaces.get(k) ?? edgeFaces.set(k, []).get(k)!).push(fi);
    }
  });
  for (const fs of edgeFaces.values())
    for (let i = 1; i < fs.length; i++)
      if (keys[fs[i]] === keys[fs[0]]) gp[find(fs[i])] = find(fs[0]);
  return m.f.map((_, i) => find(i));
}

function centre(v: readonly Vec3[]): Vec3 {
  const lo: Vec3 = [Infinity, Infinity, Infinity],
    hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of v)
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], p[i]);
      hi[i] = Math.max(hi[i], p[i]);
    }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
}

/**
 * The closed-solid check (SPEC-12.9 4): every directed edge used once and its reverse once
 * (closed, manifold, consistently oriented), one shell, Euler characteristic 2, no degenerate
 * polygon and a positive signed volume. An inside-out solid is closed but has a negative volume,
 * so closedness alone never passes it (RESEARCH-04 J-04).
 */
export function checkSolid(m: SolidMesh): SolidCheck {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const N = m.v.length;
  const directed = new Map<number, number>();
  for (const loop of m.f)
    for (let e = 0; e < loop.length; e++) {
      const k = loop[e] * N + loop[(e + 1) % loop.length];
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  let boundary = 0,
    nonManifold = 0;
  for (const [k, c] of directed) {
    const i = Math.floor(k / N),
      j = k % N;
    const r = directed.get(j * N + i) ?? 0;
    if (c > 1 || r > 1) nonManifold++;
    else if (r === 0) boundary++;
  }
  const parent = m.f.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map<number, number>();
  m.f.forEach((loop, fi) => {
    for (let e = 0; e < loop.length; e++) {
      const a = loop[e],
        b = loop[(e + 1) % loop.length];
      const k = Math.min(a, b) * N + Math.max(a, b);
      const o = owner.get(k);
      if (o === undefined) owner.set(k, fi);
      else parent[find(fi)] = find(o);
    }
  });
  const shells = m.f.length ? new Set(m.f.map((_, i) => find(i))).size : 0;
  const used = new Set(m.f.flat());
  const euler = used.size - owner.size + m.f.length;
  const groups = coplanarGroups(m);
  const planarFaces = new Set(groups).size;

  // Shortest edge between two merged faces (edges inside a merged face disappear in Rhino).
  let shortestEdge = Infinity;
  const edgeGroups = new Map<number, Set<number>>();
  m.f.forEach((loop, fi) => {
    for (let e = 0; e < loop.length; e++) {
      const a = loop[e],
        b = loop[(e + 1) % loop.length];
      const k = Math.min(a, b) * N + Math.max(a, b);
      (edgeGroups.get(k) ?? edgeGroups.set(k, new Set()).get(k)!).add(groups[fi]);
    }
  });
  for (const [k, gs] of edgeGroups) {
    if (gs.size < 2) continue;
    const a = m.v[Math.floor(k / N)],
      b = m.v[k % N];
    shortestEdge = Math.min(shortestEdge, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  }

  const c = centre(m.v);
  let volume = 0,
    area = 0,
    planarity = 0,
    degenerate = 0;
  for (const loop of m.f) {
    const p0 = sub(m.v[loop[0]], c);
    for (let i = 1; i + 1 < loop.length; i++)
      volume += dot(p0, crossV(sub(m.v[loop[i]], c), sub(m.v[loop[i + 1]], c))) / 6;
    const n = newellOf(loop.map((i) => m.v[i]));
    const l = Math.hypot(...n);
    area += l / 2;
    if (!(l > 1e-12)) {
      degenerate++;
      continue;
    }
    const u: Vec3 = [n[0] / l, n[1] / l, n[2] / l];
    const w = dot(u, m.v[loop[0]]);
    for (const i of loop) planarity = Math.max(planarity, Math.abs(dot(u, m.v[i]) - w));
  }
  if (!m.f.length) reasons.push('면 없음');
  if (boundary) reasons.push(`열린 변 ${boundary}`);
  if (nonManifold) reasons.push(`비다양체 변 ${nonManifold}`);
  if (m.f.length && shells !== 1) reasons.push(`껍질 ${shells}개`);
  if (m.f.length && euler !== 2 * shells) reasons.push(`오일러 지표 ${euler}`);
  if (degenerate) reasons.push(`퇴화 다각형 ${degenerate}`);
  if (!(volume > 0)) reasons.push(`부피 ${volume.toFixed(6)} (뒤집힘 또는 0)`);
  if (shortestEdge < SHORT_EDGE)
    warnings.push(`${SHORT_EDGE} m보다 짧은 변 (${shortestEdge.toExponential(2)} m)`);
  return {
    ok: reasons.length === 0,
    reasons,
    warnings,
    vertices: used.size,
    polygons: m.f.length,
    planarFaces,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    shells,
    euler,
    volume,
    area,
    planarity,
    degenerate,
    shortestEdge: Number.isFinite(shortestEdge) ? shortestEdge : 0,
  };
}

/** Signed volume of a solid (welded first). */
export const solidVolume = (s: Solid) => (s.length ? checkSolid(weldSolid(s)).volume : 0);

/**
 * Area of the horizontal section at height z (m²). Each polygon crossing the plane gives one
 * segment oriented so the outward normal is on its right; the shoelace sum of those segments is
 * the section area (positive for a closed outward solid).
 */
export function sectionArea(m: SolidMesh, z: number) {
  let s = 0;
  for (const loop of m.f) {
    const pts: Vec3[] = [];
    for (let e = 0; e < loop.length; e++) {
      const a = m.v[loop[e]],
        b = m.v[loop[(e + 1) % loop.length]];
      const da = a[2] - z,
        db = b[2] - z;
      if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) {
        const t = da / (da - db);
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z]);
      }
    }
    if (pts.length !== 2) continue;
    const n = newellOf(loop.map((i) => m.v[i]));
    let [p, q] = pts;
    const dir: Vec3 = [-n[1], n[0], 0];
    if ((q[0] - p[0]) * dir[0] + (q[1] - p[1]) * dir[1] < 0) [p, q] = [q, p];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

export const reversedMesh = (m: SolidMesh): SolidMesh => ({
  v: m.v,
  f: m.f.map((l) => [...l].reverse()),
});

// ── Coplanar merge ──────────────────────────────────────────────────────────────────────────────

/** A merged planar face: the outer ring counter-clockwise seen from outside, holes the other way. */
export type MergedFace = Vec3[][];

/**
 * Coplanar edge-connected polygons merged into faces with holes (SPIKE 결론 5: the engine merges,
 * Rhino's MergeCoplanarFaces is never called). Every vertex is kept — T-junction points included —
 * so the edges of neighbouring faces still match one to one when Rhino joins them. Throws when a
 * group's boundary does not close into loops.
 */
export function mergeCoplanar(m: SolidMesh): MergedFace[] {
  const N = m.v.length;
  const groups = coplanarGroups(m);
  const byGroup = new Map<number, number[]>();
  groups.forEach((g, fi) => (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(fi));
  const out: MergedFace[] = [];
  for (const members of byGroup.values()) {
    if (members.length === 1) {
      out.push([m.f[members[0]].map((i) => m.v[i])]);
      continue;
    }
    // Directed edges of the group; an edge whose reverse is in the group is inside the face.
    const inGroup = new Set<number>();
    for (const fi of members) {
      const loop = m.f[fi];
      for (let e = 0; e < loop.length; e++) inGroup.add(loop[e] * N + loop[(e + 1) % loop.length]);
    }
    const outgoing = new Map<number, number[]>();
    let count = 0;
    for (const k of inGroup) {
      const a = Math.floor(k / N),
        b = k % N;
      if (inGroup.has(b * N + a)) continue;
      (outgoing.get(a) ?? outgoing.set(a, []).get(a)!).push(b);
      count++;
    }
    // A 2D frame of the plane, x × y = normal, to pick turns at a vertex shared by two loops.
    const normal = newellOf(m.f[members[0]].map((i) => m.v[i]));
    const nl = Math.hypot(...normal);
    const nz: Vec3 = [normal[0] / nl, normal[1] / nl, normal[2] / nl];
    const helper: Vec3 = Math.abs(nz[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const ex0 = crossV(helper, nz);
    const exl = Math.hypot(...ex0);
    const ex: Vec3 = [ex0[0] / exl, ex0[1] / exl, ex0[2] / exl];
    const ey = crossV(nz, ex);
    const to2 = (p: Vec3): [number, number] => [dot(p, ex), dot(p, ey)];
    const used = new Set<number>();
    const loops: number[][] = [];
    for (const [start, ends] of outgoing)
      for (const first of ends) {
        if (used.has(start * N + first)) continue;
        const loop = [start];
        let prev = start,
          cur = first;
        used.add(start * N + first);
        for (let guard = 0; cur !== start; guard++) {
          if (guard > count)
            throw new GeometryError('polygon-valid', 'face boundary does not close');
          loop.push(cur);
          const options = (outgoing.get(cur) ?? []).filter((n) => !used.has(cur * N + n));
          if (!options.length) throw new GeometryError('polygon-valid', 'face boundary is open');
          let next = options[0];
          if (options.length > 1) {
            // Interior on the left: take the first edge clockwise from the way back.
            const [cx, cy] = to2(m.v[cur]);
            const [px, py] = to2(m.v[prev]);
            const back = Math.atan2(py - cy, px - cx);
            let best = Infinity;
            for (const n of options) {
              const [qx, qy] = to2(m.v[n]);
              let turn = back - Math.atan2(qy - cy, qx - cx);
              while (turn <= 0) turn += 2 * Math.PI;
              if (turn < best) {
                best = turn;
                next = n;
              }
            }
          }
          used.add(cur * N + next);
          prev = cur;
          cur = next;
        }
        loops.push(loop);
      }
    // Outer loops wind with the normal (positive area in the frame); holes go to the outer loop
    // that contains them.
    const area2 = (loop: number[]) => signedArea(loop.map((i) => to2(m.v[i])));
    const outers = loops.filter((l) => area2(l) > 0);
    const holes = loops.filter((l) => area2(l) <= 0);
    const faces = outers.map((l) => [l]);
    for (const h of holes) {
      const p = to2(m.v[h[0]]);
      const host =
        faces.find((f) =>
          containsPoint(
            f[0].map((i) => to2(m.v[i])),
            p,
            h,
            f[0],
          ),
        ) ?? faces[0];
      if (!host) throw new GeometryError('polygon-valid', 'hole without an outer loop');
      host.push(h);
    }
    for (const f of faces) out.push(f.map((l) => l.map((i) => m.v[i])));
  }
  return out;
}

/** Point-in-ring for a hole's first vertex (a shared vertex counts as inside). */
function containsPoint(
  ring2: [number, number][],
  p: [number, number],
  hole: number[],
  outer: number[],
) {
  if (outer.includes(hole[0])) return true;
  let inside = false;
  for (let i = 0, j = ring2.length - 1; i < ring2.length; j = i++) {
    const [xi, yi] = ring2[i],
      [xj, yj] = ring2[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** Signed volume of merged faces as wound (what the Rhino template checks before joining). */
export function facesVolume(faces: readonly MergedFace[]) {
  if (!faces.length) return 0;
  const o = faces[0][0][0];
  let sum = 0;
  for (const face of faces)
    for (const ring of face)
      for (let k = 1; k + 1 < ring.length; k++)
        sum += dot(sub(ring[0], o), crossV(sub(ring[k], o), sub(ring[k + 1], o)));
  return sum / 6;
}

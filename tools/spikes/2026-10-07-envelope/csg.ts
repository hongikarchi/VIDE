// T-204 spike: planar-polygon solid booleans by BSP trees (the constructive-solid-geometry
// algorithm popularised by csg.js, Evan Wallace, MIT; written again here in TypeScript for VIDE's
// metre coordinates). Every output face stays an exact planar polygon of an input plane, so an
// envelope made of planes (extrusions, sky-exposure slopes) needs no sampling. Output polygons carry
// T-junctions; `mesh.ts` welds and repairs them before the closed-solid checks.
//
// Coordinates must be local (a few hundred metres around a site origin): EPS is absolute.

export type V3 = [number, number, number];
export interface Plane {
  n: V3;
  w: number;
}
export interface Poly {
  v: V3[];
  plane: Plane;
}

export const EPS = 1e-7;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Plane of a planar polygon by Newell's method (robust for collinear leading vertices). */
export function planeOf(v: V3[]): Plane {
  let nx = 0,
    ny = 0,
    nz = 0,
    cx = 0,
    cy = 0,
    cz = 0;
  for (let i = 0; i < v.length; i++) {
    const p = v[i],
      q = v[(i + 1) % v.length];
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 0)) throw new Error('degenerate polygon');
  const n: V3 = [nx / l, ny / l, nz / l];
  return { n, w: dot(n, [cx / v.length, cy / v.length, cz / v.length]) };
}

export const poly = (v: V3[], plane?: Plane): Poly => ({ v, plane: plane ?? planeOf(v) });
const flip = (p: Poly): Poly => ({
  v: [...p.v].reverse(),
  plane: { n: [-p.plane.n[0], -p.plane.n[1], -p.plane.n[2]], w: -p.plane.w },
});

const COPLANAR = 0,
  FRONT = 1,
  BACK = 2,
  SPANNING = 3;

function split(plane: Plane, p: Poly, cf: Poly[], cb: Poly[], front: Poly[], back: Poly[]) {
  let type = 0;
  const types: number[] = [];
  for (const v of p.v) {
    const t = dot(plane.n, v) - plane.w;
    const ty = t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
    type |= ty;
    types.push(ty);
  }
  if (type === COPLANAR) (dot(plane.n, p.plane.n) > 0 ? cf : cb).push(p);
  else if (type === FRONT) front.push(p);
  else if (type === BACK) back.push(p);
  else {
    const f: V3[] = [],
      b: V3[] = [];
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

class Node {
  plane: Plane | null = null;
  front: Node | null = null;
  back: Node | null = null;
  polys: Poly[] = [];
  constructor(polys?: Poly[]) {
    if (polys) this.build(polys);
  }
  invert() {
    // Iterative: deep trees otherwise risk the call stack on large envelopes.
    const stack: Node[] = [this];
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
  clipPolygons(polys: Poly[]): Poly[] {
    if (!this.plane) return polys.slice();
    let front: Poly[] = [],
      back: Poly[] = [];
    for (const p of polys) split(this.plane, p, front, back, front, back);
    if (this.front) front = this.front.clipPolygons(front);
    back = this.back ? this.back.clipPolygons(back) : [];
    return front.concat(back);
  }
  clipTo(bsp: Node) {
    const stack: Node[] = [this];
    while (stack.length) {
      const n = stack.pop()!;
      n.polys = bsp.clipPolygons(n.polys);
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
  }
  all(): Poly[] {
    const out: Poly[] = [];
    const stack: Node[] = [this];
    while (stack.length) {
      const n = stack.pop()!;
      out.push(...n.polys);
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
    return out;
  }
  build(polys: Poly[]) {
    const work: [Node, Poly[]][] = [[this, polys]];
    while (work.length) {
      const [n, ps] = work.pop()!;
      if (!ps.length) continue;
      if (!n.plane) n.plane = ps[0].plane;
      const front: Poly[] = [],
        back: Poly[] = [];
      for (const p of ps) split(n.plane, p, n.polys, n.polys, front, back);
      if (front.length) work.push([(n.front ??= new Node()), front]);
      if (back.length) work.push([(n.back ??= new Node()), back]);
    }
  }
}

/** A closed solid as a list of outward-facing planar convex polygons. */
export type Solid = Poly[];

export function union(a: Solid, b: Solid): Solid {
  const A = new Node(a),
    B = new Node(b);
  A.clipTo(B);
  B.clipTo(A);
  B.invert();
  B.clipTo(A);
  B.invert();
  A.build(B.all());
  return A.all();
}
export function subtract(a: Solid, b: Solid): Solid {
  const A = new Node(a),
    B = new Node(b);
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
export function intersect(a: Solid, b: Solid): Solid {
  const A = new Node(a),
    B = new Node(b);
  A.invert();
  B.clipTo(A);
  B.invert();
  A.clipTo(B);
  B.clipTo(A);
  A.build(B.all());
  A.invert();
  return A.all();
}
export const unionAll = (solids: Solid[]): Solid =>
  solids.reduce((acc, s) => (acc.length ? union(acc, s) : s), [] as Solid);

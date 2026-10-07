// T-204 spike: BSP output → welded polygon mesh with T-junctions repaired, then the closed-solid
// gate SPEC-12.9 asks for: every directed edge used once and its reverse once (closed, manifold,
// consistently oriented), one shell, Euler characteristic 2 per shell, and positive signed volume
// (outward faces). RESEARCH-04 J-04: a solid that passed "closed" while inside-out — the volume sign
// is what catches it, so the gate never stops at closedness.
import type { Poly, V3 } from './csg.ts';

export interface Mesh {
  v: V3[];
  /** Planar convex polygons as vertex indices, counter-clockwise seen from outside. */
  f: number[][];
}

export interface SolidCheck {
  ok: boolean;
  reasons: string[];
  vertices: number;
  polygons: number;
  /** Maximal coplanar edge-connected polygon groups = faces of the merged polysurface. */
  planarFaces: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  shells: number;
  euler: number;
  volume: number;
  area: number;
  /** Largest distance of a vertex from its polygon's plane (m). */
  planarity: number;
  /** Polygons whose corners collapsed onto a line or point (zero normal). */
  degenerate: number;
}

const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Weld polygon corners within `tol` (m) and insert every welded vertex lying on a polygon edge.
 * `tol` must not exceed the BSP plane tolerance (csg.ts EPS = 1e-7 m): a coarser weld merges distinct
 * corners of tiny facets (64-gon stress site: 1e-6 opened 3 edges, 1e-7 and 1e-8 stayed closed).
 */
export function weld(polys: Poly[], tol = 1e-7): Mesh {
  const v: V3[] = [];
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const id = (p: V3) => {
    const gx = Math.round(p[0] / tol),
      gy = Math.round(p[1] / tol),
      gz = Math.round(p[2] / tol);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const i of grid.get(key(gx + dx, gy + dy, gz + dz)) ?? [])
            if (Math.hypot(v[i][0] - p[0], v[i][1] - p[1], v[i][2] - p[2]) <= tol) return i;
    v.push([p[0], p[1], p[2]]);
    const k = key(gx, gy, gz);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(v.length - 1);
    return v.length - 1;
  };
  let f = polys.map((p) => dedupe(p.v.map(id)));
  f = f.filter((loop) => loop.length >= 3);

  // T-junctions: a vertex of one polygon lying inside an edge of its neighbour. A coarse grid
  // (cell 1 m) limits the candidates per edge.
  const cell = 1;
  const buckets = new Map<string, number[]>();
  v.forEach((p, i) => {
    const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell));
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
  });
  const near = (a: V3, b: V3) => {
    const out: number[] = [];
    const lo = [0, 1, 2].map((i) => Math.floor((Math.min(a[i], b[i]) - tol) / cell));
    const hi = [0, 1, 2].map((i) => Math.floor((Math.max(a[i], b[i]) + tol) / cell));
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) out.push(...(buckets.get(key(x, y, z)) ?? []));
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
        b = v[j],
        d = sub(b, a);
      const L2 = dot(d, d);
      const mids: [number, number][] = [];
      for (const k of near(a, b)) {
        if (k === i || k === j) continue;
        const t = dot(sub(v[k], a), d) / L2;
        if (t <= 0 || t >= 1) continue;
        const q: V3 = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
        if (Math.hypot(q[0] - v[k][0], q[1] - v[k][1], q[2] - v[k][2]) <= tTol) mids.push([t, k]);
      }
      mids.sort((x, y) => x[0] - y[0]);
      for (const [, k] of mids) out.push(k);
    }
    return dedupe(out);
  });
  return { v, f: f.filter((loop) => loop.length >= 3 && polyArea(v, loop) > tol * tol) };
}

function dedupe(loop: number[]) {
  const out: number[] = [];
  for (const i of loop) if (out[out.length - 1] !== i) out.push(i);
  while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

function newell(v: V3[], loop: number[]): V3 {
  let nx = 0,
    ny = 0,
    nz = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = v[loop[i]],
      q = v[loop[(i + 1) % loop.length]];
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  return [nx / 2, ny / 2, nz / 2];
}
const polyArea = (v: V3[], loop: number[]) => Math.hypot(...newell(v, loop));

export function check(m: Mesh): SolidCheck {
  const reasons: string[] = [];
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
  // Shells: polygons connected through shared (undirected) edges.
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
  const shells = new Set(m.f.map((_, i) => find(i))).size;
  const used = new Set(m.f.flat());
  const euler = used.size - owner.size + m.f.length;

  // Coplanar groups (merged faces): same plane key and a shared edge.
  const planeKey = (loop: number[]) => {
    const n = newell(m.v, loop);
    const l = Math.hypot(...n);
    const u: V3 = [n[0] / l, n[1] / l, n[2] / l];
    const w = dot(u, m.v[loop[0]]);
    return [u[0], u[1], u[2], w].map((x) => Math.round(x * 1e5)).join(',');
  };
  const keys = m.f.map(planeKey);
  const gp = m.f.map((_, i) => i);
  const gfind = (i: number): number => (gp[i] === i ? i : (gp[i] = gfind(gp[i])));
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
      if (keys[fs[i]] === keys[fs[0]]) gp[gfind(fs[i])] = gfind(fs[0]);
  const planarFaces = new Set(m.f.map((_, i) => gfind(i))).size;

  // Signed volume about the bounding-box centre (keeps magnitudes small).
  const c = centre(m.v);
  let volume = 0,
    area = 0,
    planarity = 0,
    degenerate = 0;
  for (const loop of m.f) {
    const p0 = sub(m.v[loop[0]], c);
    for (let i = 1; i + 1 < loop.length; i++)
      volume += dot(p0, cross(sub(m.v[loop[i]], c), sub(m.v[loop[i + 1]], c))) / 6;
    const n = newell(m.v, loop);
    const l = Math.hypot(...n);
    area += l;
    if (!(l > 1e-12)) {
      degenerate++;
      continue;
    }
    const u: V3 = [n[0] / l, n[1] / l, n[2] / l];
    const w = dot(u, m.v[loop[0]]);
    for (const i of loop) planarity = Math.max(planarity, Math.abs(dot(u, m.v[i]) - w));
  }
  if (boundary) reasons.push(`열린 변 ${boundary}`);
  if (nonManifold) reasons.push(`비다양체 변 ${nonManifold}`);
  if (shells !== 1) reasons.push(`껍질 ${shells}개`);
  if (euler !== 2 * shells) reasons.push(`오일러 지표 ${euler}`);
  if (degenerate) reasons.push(`퇴화 다각형 ${degenerate}`);
  if (!(volume > 0)) reasons.push(`부피 ${volume.toFixed(6)} (뒤집힘 또는 0)`);
  return {
    ok: reasons.length === 0,
    reasons,
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
  };
}

export function centre(v: readonly V3[]): V3 {
  const lo: V3 = [Infinity, Infinity, Infinity],
    hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of v)
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], p[i]);
      hi[i] = Math.max(hi[i], p[i]);
    }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
}

/**
 * Area of the horizontal section at height z (m²). Each face crossing the plane gives one segment,
 * oriented so the outward face normal is on its right; the shoelace sum of those segments is the
 * section area (a closed, outward solid gives a positive value).
 */
export function sectionArea(m: Mesh, z: number) {
  let s = 0;
  for (const loop of m.f) {
    const pts: V3[] = [];
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
    const n = newell(m.v, loop);
    let [p, q] = pts;
    // Section boundary runs counter-clockwise: direction = ez × n.
    const dir: V3 = [-n[1], n[0], 0];
    if ((q[0] - p[0]) * dir[0] + (q[1] - p[1]) * dir[1] < 0) [p, q] = [q, p];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

/** Mesh moved by `d` (m). */
export const moved = (m: Mesh, d: V3): Mesh => ({
  v: m.v.map((p): V3 => [p[0] + d[0], p[1] + d[1], p[2] + d[2]]),
  f: m.f,
});
export const reversed = (m: Mesh): Mesh => ({ v: m.v, f: m.f.map((l) => [...l].reverse()) });

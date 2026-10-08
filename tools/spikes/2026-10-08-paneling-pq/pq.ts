// SPIKE T-259 (PLAN-49, SPEC-16.7 2): whole-net planar-quad (PQ) optimization prototype. Not product
// code — measures whether moving all panel vertices together reaches flat panels in useful time.
//
// Unknowns: one 3D point per lattice vertex key (SPEC-16.5 5), so neighbours share a vertex by
// construction. Each iteration is one local/global step:
//   local  — per panel, the best-fit plane of its current vertices (planarity); per vertex, the
//            closest point on the sampled surface (closeness, Gauss-Newton on the face's UV from
//            the previous UV); per interior vertex, the mean of its edge neighbours (fairness).
//   global — every vertex moves to the minimiser of its weighted quadratic terms with the planes,
//            closest points and neighbour means held fixed (a 3×3 solve per vertex, block Jacobi),
//            with over-relaxation ω. Mode 'planes' (default) uses the squared distance to each
//            panel plane (sliding along it is free); mode 'points' the squared distance to the
//            vertex's projection on it (ShapeUp-style).
// Stops when every panel's vertices lie within `tol` of their best-fit plane, when the worst panel
// improves by less than 0.5 % over 200 iterations (stalled), or at `maxIter` / `budgetMs`. Vertices
// on the face's domain boundary keep their parameter across that side (they slide along it).
// Trim-loop vertices are not held on the trim curve (spike limitation).

import type { PanelLayout } from '../../../src/contracts/paneling.ts';
import type { FaceSampler } from '../../../src/jigs/official/paneling-kit/sample.ts';
import { bestFitPlane } from '../../../src/jigs/official/paneling-kit/vec.ts';

export interface PqOptions {
  /** Planarity target (m): max vertex distance to the panel's best-fit plane. */
  tol: number;
  wPlanar?: number;
  wClose?: number;
  wFair?: number;
  omega?: number;
  maxIter?: number;
  budgetMs?: number;
  mode?: 'planes' | 'points';
}

export interface PqResult {
  converged: boolean;
  /** Stopped because the worst panel improved by less than 0.5 % over 200 iterations. */
  stalled: boolean;
  iterations: number;
  ms: number;
  msPerIteration: number;
  vertices: number;
  panels: number;
  /** Max over panels of the vertex distance to the best-fit plane (m), before and after. */
  planarityStart: number;
  planarityEnd: number;
  /** Mean over panels after, and the share of panels still over `tol`. */
  planarityMean: number;
  panelsOverTol: number;
  /** After projecting each panel onto its plane: max distance between copies of a shared vertex (m). */
  planarGap: number;
  /** Max / mean vertex distance from the surface (m), and the share of vertices over `tol`. */
  offSurfaceMax: number;
  offSurfaceMean: number;
  offSurfaceOverTol: number;
  /** Max vertex move from its starting point (m). */
  moveMax: number;
  /** Worst-panel planarity after 10, 50, 100, 200, 500, 1000… iterations (m). */
  history: Array<[number, number]>;
}

type V3 = [number, number, number];

/** Solve the symmetric 3×3 system of vertex `i` (Cramer). */
function solve3(A: Float64Array, b: Float64Array, i: number): V3 {
  const a = A[6 * i],
    ab = A[6 * i + 1],
    ac = A[6 * i + 2],
    d = A[6 * i + 3],
    e = A[6 * i + 4],
    f = A[6 * i + 5];
  const r0 = b[3 * i],
    r1 = b[3 * i + 1],
    r2 = b[3 * i + 2];
  const c00 = d * f - e * e,
    c01 = ac * e - ab * f,
    c02 = ab * e - ac * d;
  const det = a * c00 + ab * c01 + ac * c02;
  const c11 = a * f - ac * ac,
    c12 = ab * ac - a * e,
    c22 = a * d - ab * ab;
  return [
    (c00 * r0 + c01 * r1 + c02 * r2) / det,
    (c01 * r0 + c11 * r1 + c12 * r2) / det,
    (c02 * r0 + c12 * r1 + c22 * r2) / det,
  ];
}

export function optimizePq(sampler: FaceSampler, layout: PanelLayout, o: PqOptions): PqResult {
  const wP = o.wPlanar ?? 1;
  const wC = o.wClose ?? 0.1;
  const wF = o.wFair ?? 0.01;
  const omega = o.omega ?? 1.5;
  const mode = o.mode ?? 'planes';
  const maxIter = o.maxIter ?? 5000;
  const budget = o.budgetMs ?? 60000;
  const { u0, u1, v0, v1 } = sampler;
  const eu = (u1 - u0) * 1e-6,
    ev = (v1 - v0) * 1e-6;

  // Vertices by key; panels as index lists.
  const index = new Map<string, number>();
  const X: number[] = [];
  const UV: number[] = [];
  const faces: number[][] = [];
  for (const p of layout.panels) {
    if (p.failure) continue;
    const f: number[] = [];
    p.vertexKeys.forEach((key, k) => {
      let i = index.get(key);
      if (i === undefined) {
        i = X.length / 3;
        index.set(key, i);
        X.push(...p.corners[k]);
        UV.push(...p.uv[k]);
      }
      if (!f.includes(i)) f.push(i);
    });
    if (f.length >= 3) faces.push(f);
  }
  const n = X.length / 3;
  const X0 = X.slice();
  // Domain sides each vertex is held on (bit 1 u0, 2 u1, 4 v0, 8 v1) and edge neighbours.
  const held = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const u = UV[2 * i],
      v = UV[2 * i + 1];
    held[i] =
      (Math.abs(u - u0) < eu ? 1 : 0) |
      (Math.abs(u - u1) < eu ? 2 : 0) |
      (Math.abs(v - v0) < ev ? 4 : 0) |
      (Math.abs(v - v1) < ev ? 8 : 0);
  }
  const nb: Set<number>[] = Array.from({ length: n }, () => new Set());
  const faceCount = new Uint16Array(n);
  for (const f of faces)
    f.forEach((a, k) => {
      const b = f[(k + 1) % f.length];
      nb[a].add(b);
      nb[b].add(a);
      faceCount[a]++;
    });
  const interior = Array.from({ length: n }, (_, i) => faceCount[i] >= 4 && held[i] === 0);

  const pointsOf = (f: number[]) => f.map((i) => [X[3 * i], X[3 * i + 1], X[3 * i + 2]] as V3);
  const planarity = () => {
    let worst = 0,
      sum = 0,
      over = 0;
    for (const f of faces) {
      const pts = pointsOf(f);
      const { origin: c, normal: m } = bestFitPlane(pts);
      let w = 0;
      for (const q of pts)
        w = Math.max(
          w,
          Math.abs((q[0] - c[0]) * m[0] + (q[1] - c[1]) * m[1] + (q[2] - c[2]) * m[2]),
        );
      worst = Math.max(worst, w);
      sum += w;
      if (w > o.tol) over++;
    }
    return { worst, mean: sum / faces.length, over: over / faces.length };
  };
  // Closest point on the surface from the previous UV: two Gauss-Newton steps.
  const closest = (i: number): V3 => {
    let u = UV[2 * i],
      v = UV[2 * i + 1];
    const x: V3 = [X[3 * i], X[3 * i + 1], X[3 * i + 2]];
    let p = sampler.point(u, v);
    for (let step = 0; step < 2; step++) {
      const ua = Math.min(u + (u1 - u0) * 1e-5, u1),
        ub = Math.max(u - (u1 - u0) * 1e-5, u0);
      const va = Math.min(v + (v1 - v0) * 1e-5, v1),
        vb = Math.max(v - (v1 - v0) * 1e-5, v0);
      const a = sampler.point(ua, v),
        b = sampler.point(ub, v);
      const c = sampler.point(u, va),
        d = sampler.point(u, vb);
      const su = [0, 1, 2].map((k) => (a[k] - b[k]) / (ua - ub));
      const sv = [0, 1, 2].map((k) => (c[k] - d[k]) / (va - vb));
      const r = [x[0] - p[0], x[1] - p[1], x[2] - p[2]];
      const g11 = su[0] * su[0] + su[1] * su[1] + su[2] * su[2];
      const g12 = su[0] * sv[0] + su[1] * sv[1] + su[2] * sv[2];
      const g22 = sv[0] * sv[0] + sv[1] * sv[1] + sv[2] * sv[2];
      const b1 = su[0] * r[0] + su[1] * r[1] + su[2] * r[2];
      const b2 = sv[0] * r[0] + sv[1] * r[1] + sv[2] * r[2];
      const det = g11 * g22 - g12 * g12;
      if (!(Math.abs(det) > 1e-30)) break;
      let du = (g22 * b1 - g12 * b2) / det,
        dv = (g11 * b2 - g12 * b1) / det;
      if (held[i] & 3) du = 0;
      if (held[i] & 12) dv = 0;
      u = Math.min(u1, Math.max(u0, u + du));
      v = Math.min(v1, Math.max(v0, v + dv));
      p = sampler.point(u, v);
    }
    UV[2 * i] = u;
    UV[2 * i + 1] = v;
    return p as V3;
  };

  // Per vertex the normal equations A x = acc of its quadratic terms (A symmetric 3×3, 6 values).
  const A = new Float64Array(6 * n);
  const acc = new Float64Array(3 * n);
  const addIso = (i: number, w: number) => {
    A[6 * i] += w;
    A[6 * i + 3] += w;
    A[6 * i + 5] += w;
  };

  const history: Array<[number, number]> = [];
  const marks = new Set([10, 50, 100, 200, 500, 1000, 2000, 5000, 10000]);
  const start = planarity();
  const t0 = performance.now();
  let it = 0,
    current = start.worst,
    converged = current <= o.tol,
    stalled = false,
    checkpoint = current;
  while (!converged && !stalled && it < maxIter && performance.now() - t0 < budget) {
    it++;
    A.fill(0);
    acc.fill(0);
    for (const f of faces) {
      const pts = pointsOf(f);
      const { origin: c, normal: m } = bestFitPlane(pts);
      const dPlane = c[0] * m[0] + c[1] * m[1] + c[2] * m[2];
      for (let k = 0; k < f.length; k++) {
        const i = f[k];
        if (mode === 'planes') {
          A[6 * i] += wP * m[0] * m[0];
          A[6 * i + 1] += wP * m[0] * m[1];
          A[6 * i + 2] += wP * m[0] * m[2];
          A[6 * i + 3] += wP * m[1] * m[1];
          A[6 * i + 4] += wP * m[1] * m[2];
          A[6 * i + 5] += wP * m[2] * m[2];
          acc[3 * i] += wP * dPlane * m[0];
          acc[3 * i + 1] += wP * dPlane * m[1];
          acc[3 * i + 2] += wP * dPlane * m[2];
        } else {
          const q = pts[k];
          const d = q[0] * m[0] + q[1] * m[1] + q[2] * m[2] - dPlane;
          addIso(i, wP);
          acc[3 * i] += wP * (q[0] - d * m[0]);
          acc[3 * i + 1] += wP * (q[1] - d * m[1]);
          acc[3 * i + 2] += wP * (q[2] - d * m[2]);
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const p = closest(i);
      addIso(i, wC);
      acc[3 * i] += wC * p[0];
      acc[3 * i + 1] += wC * p[1];
      acc[3 * i + 2] += wC * p[2];
      if (wF > 0 && interior[i]) {
        let mx = 0,
          my = 0,
          mz = 0;
        for (const j of nb[i]) {
          mx += X[3 * j];
          my += X[3 * j + 1];
          mz += X[3 * j + 2];
        }
        const k = nb[i].size;
        addIso(i, wF);
        acc[3 * i] += (wF * mx) / k;
        acc[3 * i + 1] += (wF * my) / k;
        acc[3 * i + 2] += (wF * mz) / k;
      }
    }
    for (let i = 0; i < n; i++) {
      const x = solve3(A, acc, i);
      for (let k = 0; k < 3; k++) X[3 * i + k] += omega * (x[k] - X[3 * i + k]);
    }
    if (it % 10 === 0 || marks.has(it)) {
      current = planarity().worst;
      if (marks.has(it)) history.push([it, current]);
      converged = current <= o.tol;
    }
    if (it % 200 === 0) {
      stalled = checkpoint - current < 0.005 * checkpoint;
      checkpoint = current;
    }
  }
  const end = planarity();
  converged = end.worst <= o.tol;
  const ms = performance.now() - t0;

  // Report: planar gap after per-panel projection, distance from the surface, total move.
  const copies = new Map<number, V3[]>();
  for (const f of faces) {
    const pts = pointsOf(f);
    const { origin: c, normal: m } = bestFitPlane(pts);
    f.forEach((i, k) => {
      const q = pts[k];
      const d = (q[0] - c[0]) * m[0] + (q[1] - c[1]) * m[1] + (q[2] - c[2]) * m[2];
      const list = copies.get(i) ?? [];
      list.push([q[0] - d * m[0], q[1] - d * m[1], q[2] - d * m[2]]);
      copies.set(i, list);
    });
  }
  let planarGap = 0;
  for (const list of copies.values())
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++)
        planarGap = Math.max(
          planarGap,
          Math.hypot(list[a][0] - list[b][0], list[a][1] - list[b][1], list[a][2] - list[b][2]),
        );
  let offMax = 0,
    offSum = 0,
    over = 0,
    moveMax = 0;
  for (let i = 0; i < n; i++) {
    const p = closest(i);
    const d = Math.hypot(X[3 * i] - p[0], X[3 * i + 1] - p[1], X[3 * i + 2] - p[2]);
    offMax = Math.max(offMax, d);
    offSum += d;
    if (d > o.tol) over++;
    moveMax = Math.max(
      moveMax,
      Math.hypot(X[3 * i] - X0[3 * i], X[3 * i + 1] - X0[3 * i + 1], X[3 * i + 2] - X0[3 * i + 2]),
    );
  }
  return {
    converged,
    stalled: stalled && !converged,
    iterations: it,
    ms,
    msPerIteration: it ? ms / it : 0,
    vertices: n,
    panels: faces.length,
    planarityStart: start.worst,
    planarityEnd: end.worst,
    planarityMean: end.mean,
    panelsOverTol: end.over,
    planarGap,
    offSurfaceMax: offMax,
    offSurfaceMean: offSum / n,
    offSurfaceOverTol: over / n,
    moveMax,
    history,
  };
}

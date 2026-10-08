// 기준 면 표본의 보간 (SPEC-16.3 4, PLAN-49 T-252, SPIKE-2026-10-08-paneling §6): positions, normals
// and curvatures between the samples of one face come from a bicubic Catmull-Rom interpolation of
// the equal-parameter grid. A closed (periodic) direction wraps — its last sample is the first one —
// and an open edge uses the quadratic ghost point `3P₀ − 3P₁ + P₂`; bilinear interpolation is not
// used (κ·h²/8 exceeds 3 mm on large faces). Parameters past the domain end of a closed direction
// wrap by the period; past an open end they extrapolate the end span.
//
// Also here: arc-length tables along isocurves (SPEC-16.5 1 '면 위 길이' — polyline length along the
// sample grid) used by the 2D domain.

import type { SurfaceFaceSample } from '../../../contracts/paneling.ts';
import type { Vec3 } from './vec.ts';

export interface FaceSampler {
  readonly face: SurfaceFaceSample;
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
  /** Position on the surface (world metres). */
  point(u: number, v: number): Vec3;
  /** Unit normal (the face's own orientation, `OrientationIsReversed` applied by the reader). */
  normal(u: number, v: number): Vec3;
  /** Signed principal curvatures [k1, k2] (1/m). */
  curvature(u: number, v: number): [number, number];
}

/** Catmull-Rom weights for t in [0, 1] (extrapolates outside). */
function weights(t: number, out: Float64Array) {
  const t2 = t * t,
    t3 = t2 * t;
  out[0] = (-t3 + 2 * t2 - t) / 2;
  out[1] = (3 * t3 - 5 * t2 + 2) / 2;
  out[2] = (-3 * t3 + 4 * t2 + t) / 2;
  out[3] = (t3 - t2) / 2;
}

interface Axis {
  n: number;
  closed: boolean;
  start: number;
  span: number;
}

/** Index-space position: the span index i (0 ≤ i ≤ n−2) and the local parameter t. */
function locate(axis: Axis, p: number): [number, number] {
  const cells = axis.n - 1;
  let x = ((p - axis.start) / axis.span) * cells;
  if (axis.closed) {
    x = ((x % cells) + cells) % cells;
    const i = Math.min(Math.floor(x), cells - 1);
    return [i, x - i];
  }
  const i = Math.max(0, Math.min(cells - 1, Math.floor(x)));
  return [i, x - i];
}

/** Bicubic interpolation of one channel of `dim` values per sample. */
function makeChannel(
  values: readonly number[],
  dim: number,
  ua: Axis,
  va: Axis,
): (u: number, v: number, out: number[]) => void {
  const nu = ua.n,
    nv = va.n;
  const get = (i: number, j: number, c: number): number => {
    // Wrap a closed direction; ghost an open one (quadratic extrapolation from three samples, or
    // linear when only two exist).
    if (ua.closed) i = ((i % (nu - 1)) + (nu - 1)) % (nu - 1);
    else if (i < 0)
      return nu >= 3
        ? 3 * get(0, j, c) - 3 * get(1, j, c) + get(2, j, c)
        : 2 * get(0, j, c) - get(1, j, c);
    else if (i > nu - 1)
      return nu >= 3
        ? 3 * get(nu - 1, j, c) - 3 * get(nu - 2, j, c) + get(nu - 3, j, c)
        : 2 * get(nu - 1, j, c) - get(nu - 2, j, c);
    if (va.closed) j = ((j % (nv - 1)) + (nv - 1)) % (nv - 1);
    else if (j < 0)
      return nv >= 3
        ? 3 * get(i, 0, c) - 3 * get(i, 1, c) + get(i, 2, c)
        : 2 * get(i, 0, c) - get(i, 1, c);
    else if (j > nv - 1)
      return nv >= 3
        ? 3 * get(i, nv - 1, c) - 3 * get(i, nv - 2, c) + get(i, nv - 3, c)
        : 2 * get(i, nv - 1, c) - get(i, nv - 2, c);
    return values[(j * nu + i) * dim + c];
  };
  const wu = new Float64Array(4),
    wv = new Float64Array(4);
  return (u, v, out) => {
    const [i, tu] = locate(ua, u);
    const [j, tv] = locate(va, v);
    weights(tu, wu);
    weights(tv, wv);
    const interior = !ua.closed && !va.closed && i >= 1 && i <= nu - 3 && j >= 1 && j <= nv - 3;
    for (let c = 0; c < dim; c++) {
      let s = 0;
      for (let b = 0; b < 4; b++) {
        let row = 0;
        const jj = j - 1 + b;
        if (interior) {
          const base = (jj * nu + i - 1) * dim + c;
          row =
            wu[0] * values[base] +
            wu[1] * values[base + dim] +
            wu[2] * values[base + 2 * dim] +
            wu[3] * values[base + 3 * dim];
        } else for (let a = 0; a < 4; a++) row += wu[a] * get(i - 1 + a, jj, c);
        s += wv[b] * row;
      }
      out[c] = s;
    }
  };
}

/** The interpolating sampler of one face sample. */
export function faceSampler(face: SurfaceFaceSample): FaceSampler {
  const ua: Axis = {
    n: face.nu,
    closed: face.closedU,
    start: face.domainU[0],
    span: face.domainU[1] - face.domainU[0],
  };
  const va: Axis = {
    n: face.nv,
    closed: face.closedV,
    start: face.domainV[0],
    span: face.domainV[1] - face.domainV[0],
  };
  const pos = makeChannel(face.points, 3, ua, va);
  const nrm = makeChannel(face.normals, 3, ua, va);
  const cur = makeChannel(face.curvatures, 2, ua, va);
  const buf = [0, 0, 0];
  return {
    face,
    u0: face.domainU[0],
    u1: face.domainU[1],
    v0: face.domainV[0],
    v1: face.domainV[1],
    point(u, v) {
      pos(u, v, buf);
      return [buf[0], buf[1], buf[2]];
    },
    normal(u, v) {
      nrm(u, v, buf);
      const l = Math.hypot(buf[0], buf[1], buf[2]) || 1;
      return [buf[0] / l, buf[1] / l, buf[2] / l];
    },
    curvature(u, v) {
      cur(u, v, buf);
      return [buf[0], buf[1]];
    },
  };
}

/** Sample position by grid index (no interpolation). */
export function samplePoint(face: SurfaceFaceSample, i: number, j: number): Vec3 {
  const k = (j * face.nu + i) * 3;
  return [face.points[k], face.points[k + 1], face.points[k + 2]];
}

/**
 * Cumulative polyline length along an isocurve: `dir` 'u' runs along U at the fixed `other` (= v),
 * 'v' along V at fixed u. The polyline passes through the interpolated points at the sample
 * parameters of that direction (on a sample row these are the samples themselves). Returns the
 * parameters (ascending) and the cumulative lengths from the domain start.
 */
export function isoTable(
  sampler: FaceSampler,
  dir: 'u' | 'v',
  other: number,
): { params: number[]; lengths: number[] } {
  const face = sampler.face;
  const n = dir === 'u' ? face.nu : face.nv;
  const [a0, a1] = dir === 'u' ? face.domainU : face.domainV;
  const params: number[] = [];
  const lengths: number[] = [];
  let prev: Vec3 | null = null;
  let total = 0;
  for (let k = 0; k < n; k++) {
    const p = a0 + ((a1 - a0) * k) / (n - 1);
    const q = dir === 'u' ? sampler.point(p, other) : sampler.point(other, p);
    if (prev) total += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
    params.push(p);
    lengths.push(total);
    prev = q;
  }
  return { params, lengths };
}

/** Polyline length of every sample row (dir 'u', one per j) or column (dir 'v', one per i). */
export function sampleIsoLengths(face: SurfaceFaceSample, dir: 'u' | 'v'): number[] {
  const out: number[] = [];
  const count = dir === 'u' ? face.nv : face.nu;
  const n = dir === 'u' ? face.nu : face.nv;
  for (let m = 0; m < count; m++) {
    let total = 0;
    for (let k = 1; k < n; k++) {
      const a = dir === 'u' ? samplePoint(face, k - 1, m) : samplePoint(face, m, k - 1);
      const b = dir === 'u' ? samplePoint(face, k, m) : samplePoint(face, m, k);
      total += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    }
    out.push(total);
  }
  return out;
}

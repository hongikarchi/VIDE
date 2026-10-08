// 2D 영역 (SPEC-16.5 1): where the pattern cells of one face are laid out. The pattern axis
// (`direction.axis`) picks which parameter s follows (U or V); t follows the other. (s, t) = (0, 0)
// is the start corner and both grow away from it. Three ways to measure (SPEC-16.2 '크기를 재는 법'):
//
//   arc-length — s(u), t(v) are cumulative arc lengths along the two reference isocurves through the
//                start corner (or through the parameter middle when that one is a pole or shorter
//                than half the longest isocurve of its direction), measured as polylines on the
//                sample grid. A closed direction rounds its cell count (≥ 3, even for the staggered,
//                diamond and triangle patterns) and stretches the module to the period.
//   parameter  — n = round(L / size) equal parameter steps of the reference length L; no cut end.
//   projected  — a w × h grid on a projection plane (plan XY or the best vertical plane of the
//                samples), shot along the plane normal onto the sampled surface. Several hits mean
//                the face folds over that direction: the hit nearest the plane is used and the
//                panel fails `folded-projection`.
//
// The arc-length and parameter domains are separable (s depends on one parameter only), so the trim
// loops map to (s, t) point by point and the face's own rectangle is [0, S] × [0, T].

import type { PreviewSettings, SurfaceFaceSample } from '../../../contracts/paneling.ts';
import {
  faceSampler,
  isoTable,
  sampleIsoLengths,
  samplePoint,
  type FaceSampler,
} from './sample.ts';
import { cross3, dot3, len3, norm3, sub3, type Vec2, type Vec3 } from './vec.ts';

export interface UVHit {
  uv: Vec2;
  /** More than one surface point projects here (projected grid only). */
  folded: boolean;
}

export interface Domain {
  faceIndex: number;
  sampler: FaceSampler;
  kind: 'separable' | 'projected';
  axis: 'u' | 'v';
  /** Ranges of the region in (s, t). Separable: [0, S] × [0, T]. */
  sRange: Vec2;
  tRange: Vec2;
  /** Periodic directions of (s, t): cells are not cut there and wrap past the seam. */
  closedS: boolean;
  closedT: boolean;
  /** Cell size in (s, t). */
  cell: Vec2;
  /** Module actually used, the target of '목표와 다름' (a closed direction stretches it to the period). */
  module: Vec2;
  /** Clip the cells by the rectangle sRange × tRange (the non-closed directions). */
  rect: boolean;
  /** Region loops in (s, t): the outer loop first (when `hasOuter`), then the holes. */
  loops: Vec2[][];
  hasOuter: boolean;
  /** (s, t) → face parameters; null when nothing on the surface maps there. */
  toUV(s: number, t: number): UVHit | null;
  /** Pattern-axis direction (unit, 3D) at a point of the face. */
  axisDir(s: number, t: number): Vec3;
  /** The collapsed side a parameter point lies on, if any ('uMin', …). */
  poleOf(uv: Vec2): string | null;
  /** Header notes: reference isocurve moved, module stretched, … */
  notes: string[];
  /** Sample spacing coarser than half the module (SPEC-16.3 2). */
  coarse: boolean;
}

/** One separable direction: param ↔ distance from the start end. */
interface DirMap {
  length: number;
  toParam(s: number): number;
  toS(param: number): number;
  spacing: number;
}

const EVEN_PATTERNS = new Set(['staggered', 'diamond', 'triangle']);

function directionMap(
  sampler: FaceSampler,
  dir: 'u' | 'v',
  startAtMin: boolean,
  otherStart: number,
  otherMid: number,
  closed: boolean,
  measure: 'arc-length' | 'parameter',
  size: number,
  pattern: string,
  notes: string[],
  label: string,
  repeat = 1,
): DirMap & { module: number } {
  const face = sampler.face;
  const [a0, a1] = dir === 'u' ? face.domainU : face.domainV;
  const period = a1 - a0;
  let table = isoTable(sampler, dir, otherStart);
  let ref = table.lengths[table.lengths.length - 1];
  const longest = Math.max(...sampleIsoLengths(face, dir));
  if (!(ref > 1e-9) || ref < longest / 2) {
    table = isoTable(sampler, dir, otherMid);
    ref = table.lengths[table.lengths.length - 1];
    notes.push(
      `${label} 기준 이소커브를 매개변수 가운데로 옮겨 잼(시작 모서리 쪽이 극점이거나 짧음)`,
    );
  }
  const sign = startAtMin ? 1 : -1;
  const startParam = startAtMin ? a0 : a1;
  const spacing = ref / (table.params.length - 1);
  // Hexagon rows repeat every 3h/4 and alternate (SPEC-16.13 1): `repeat` 0.75, an even count ≥ 4.
  const step = size * repeat;
  const roundCount = (count: number) => {
    let n = Math.max(closed ? (repeat !== 1 ? 4 : 3) : 1, Math.round(count));
    if (closed && (EVEN_PATTERNS.has(pattern) || repeat !== 1) && n % 2) n += 1;
    return n;
  };

  if (measure === 'parameter') {
    const n = roundCount(ref / step);
    const S = n * step;
    const module = closed ? ref / (n * repeat) : size;
    if (closed && Math.abs(module - size) > 1e-9)
      notes.push(`${label} 닫힌 방향이라 크기를 둘레에 맞춤: ${(module * 1000).toFixed(1)} mm`);
    return {
      length: S,
      module,
      spacing,
      toParam: (s) => startParam + (sign * s * period) / S,
      toS: (p) => ((p - startParam) * sign * S) / period,
    };
  }

  // Arc length: cumulative table from the domain start; distance from the start end.
  const { params, lengths } = table;
  const total = ref;
  const cumOf = (p: number): number => {
    const x = ((p - a0) / period) * (params.length - 1);
    const i = Math.max(0, Math.min(params.length - 2, Math.floor(x)));
    return lengths[i] + (lengths[i + 1] - lengths[i]) * (x - i);
  };
  const paramOfCum = (c: number): number => {
    let lo = 0,
      hi = lengths.length - 1;
    if (c <= 0) {
      const d = lengths[1] - lengths[0] || 1;
      return params[0] + ((params[1] - params[0]) * c) / d;
    }
    if (c >= total) {
      const d = lengths[hi] - lengths[hi - 1] || 1;
      return params[hi] + ((params[hi] - params[hi - 1]) * (c - total)) / d;
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lengths[mid] <= c) lo = mid;
      else hi = mid;
    }
    const d = lengths[hi] - lengths[lo] || 1;
    return params[lo] + ((params[hi] - params[lo]) * (c - lengths[lo])) / d;
  };
  let module = size;
  if (closed) {
    const n = roundCount(total / step);
    module = total / (n * repeat);
    if (Math.abs(module - size) > 1e-9)
      notes.push(`${label} 닫힌 방향이라 크기를 둘레에 맞춤: ${(module * 1000).toFixed(1)} mm`);
  }
  const toParam = (s: number): number => {
    if (closed) {
      const k = Math.floor(s / total);
      const r = s - k * total;
      const c = startAtMin ? r : total - r;
      return paramOfCum(c) + sign * k * period;
    }
    return paramOfCum(startAtMin ? s : total - s);
  };
  const toS = (p: number): number => (startAtMin ? cumOf(p) : total - cumOf(p));
  return { length: total, module, spacing, toParam, toS };
}

function poleTest(face: SurfaceFaceSample) {
  const su = (face.domainU[1] - face.domainU[0]) * 1e-9;
  const sv = (face.domainV[1] - face.domainV[0]) * 1e-9;
  return (uv: Vec2): string | null => {
    const s = face.singular;
    if (s.uMin && Math.abs(uv[0] - face.domainU[0]) <= su) return 'uMin';
    if (s.uMax && Math.abs(uv[0] - face.domainU[1]) <= su) return 'uMax';
    if (s.vMin && Math.abs(uv[1] - face.domainV[0]) <= sv) return 'vMin';
    if (s.vMax && Math.abs(uv[1] - face.domainV[1]) <= sv) return 'vMax';
    return null;
  };
}

/** The face's trim loops (or none) as uv polylines, outer first. */
function uvLoops(face: SurfaceFaceSample): Vec2[][] {
  return face.trimLoops.map((loop) => loop.map((p) => [p[0], p[1]] as Vec2));
}

/** Build the 2D domain of one face for the stage-1 settings. */
export function buildDomain(face: SurfaceFaceSample, settings: PreviewSettings): Domain {
  const sampler = faceSampler(face);
  const { axis, startCorner } = settings.direction.value;
  const [uEnd, vEnd] = startCorner.split('-') as ['min' | 'max', 'min' | 'max'];
  const [w, h] = settings.size.value;
  const pattern = settings.pattern.value;
  const measure = settings.measure.value;
  const startU = uEnd === 'min' ? face.domainU[0] : face.domainU[1];
  const startV = vEnd === 'min' ? face.domainV[0] : face.domainV[1];
  const midU = (face.domainU[0] + face.domainU[1]) / 2;
  const midV = (face.domainV[0] + face.domainV[1]) / 2;
  const notes: string[] = [];
  const poleOf = poleTest(face);

  if (measure === 'projected')
    return projectedDomain(
      face,
      sampler,
      settings,
      [startU, startV],
      [uEnd === 'min', vEnd === 'min'],
      poleOf,
    );

  const sDir = axis;
  const tDir = axis === 'u' ? 'v' : 'u';
  const sMap = directionMap(
    sampler,
    sDir,
    (sDir === 'u' ? uEnd : vEnd) === 'min',
    sDir === 'u' ? startV : startU,
    sDir === 'u' ? midV : midU,
    sDir === 'u' ? face.closedU : face.closedV,
    measure,
    w,
    pattern,
    notes,
    '가로(패턴 축)',
  );
  const tMap = directionMap(
    sampler,
    tDir,
    (tDir === 'u' ? uEnd : vEnd) === 'min',
    tDir === 'u' ? startV : startU,
    tDir === 'u' ? midV : midU,
    tDir === 'u' ? face.closedU : face.closedV,
    measure,
    h,
    pattern,
    notes,
    '세로',
    pattern === 'hexagon' ? 0.75 : 1,
  );
  const closedS = sDir === 'u' ? face.closedU : face.closedV;
  const closedT = tDir === 'u' ? face.closedU : face.closedV;
  const toUV = (s: number, t: number): UVHit => {
    const a = sMap.toParam(s),
      b = tMap.toParam(t);
    return { uv: axis === 'u' ? [a, b] : [b, a], folded: false };
  };
  const toST = (uv: Vec2): Vec2 =>
    axis === 'u' ? [sMap.toS(uv[0]), tMap.toS(uv[1])] : [sMap.toS(uv[1]), tMap.toS(uv[0])];
  const loops = uvLoops(face).map((loop) => loop.map(toST));
  // A cell module in (s, t): arc length cells are `module`, parameter cells are `size`.
  const cellW = measure === 'parameter' ? w : sMap.module;
  const cellH = measure === 'parameter' ? h : tMap.module;
  const coarse = sMap.spacing > sMap.module / 2 || tMap.spacing > tMap.module / 2;
  const dS = cellW * 1e-3;
  return {
    faceIndex: face.faceIndex,
    sampler,
    kind: 'separable',
    axis,
    sRange: [0, sMap.length],
    tRange: [0, tMap.length],
    closedS,
    closedT,
    cell: [cellW, cellH],
    module: [sMap.module, tMap.module],
    rect: true,
    loops,
    hasOuter: loops.length > 0,
    toUV,
    axisDir(s, t) {
      const a = toUV(s + dS, t).uv,
        b = toUV(s - dS, t).uv;
      return norm3(sub3(sampler.point(a[0], a[1]), sampler.point(b[0], b[1])));
    },
    poleOf,
    notes,
    coarse,
  };
}

/** The projected grid (SPEC-16.5 1 '투영 격자'). */
function projectedDomain(
  face: SurfaceFaceSample,
  sampler: FaceSampler,
  settings: PreviewSettings,
  start: Vec2,
  startAtMin: [boolean, boolean],
  poleOf: (uv: Vec2) => string | null,
): Domain {
  const { axis } = settings.direction.value;
  const [w, h] = settings.size.value;
  const nu = face.nu,
    nv = face.nv;
  // Projection plane: e1, e2 in the plane, n its normal (the shooting direction).
  let e1: Vec3 = [1, 0, 0],
    e2: Vec3 = [0, 1, 0],
    n: Vec3 = [0, 0, 1];
  if (settings.projection.value === 'best-vertical') {
    let cx = 0,
      cy = 0;
    const count = nu * nv;
    for (let k = 0; k < count; k++) {
      cx += face.points[3 * k];
      cy += face.points[3 * k + 1];
    }
    cx /= count;
    cy /= count;
    let xx = 0,
      xy = 0,
      yy = 0;
    for (let k = 0; k < count; k++) {
      const x = face.points[3 * k] - cx,
        y = face.points[3 * k + 1] - cy;
      xx += x * x;
      xy += x * y;
      yy += y * y;
    }
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
    e1 = [Math.cos(angle), Math.sin(angle), 0];
    e2 = [0, 0, 1];
    n = cross3(e1, e2);
  }
  const origin = sampler.point(start[0], start[1]);
  // Pattern axis: the axis parameter's direction at the start corner, projected into the plane.
  const du = (face.domainU[1] - face.domainU[0]) * 1e-3;
  const dv = (face.domainV[1] - face.domainV[0]) * 1e-3;
  const stepU = startAtMin[0] ? du : -du;
  const stepV = startAtMin[1] ? dv : -dv;
  const towardU = sub3(sampler.point(start[0] + stepU, start[1]), origin);
  const towardV = sub3(sampler.point(start[0], start[1] + stepV), origin);
  const axisVec = axis === 'u' ? towardU : towardV;
  const otherVec = axis === 'u' ? towardV : towardU;
  let sx = dot3(axisVec, e1),
    sy = dot3(axisVec, e2);
  const sl = Math.hypot(sx, sy);
  if (sl < 1e-12) {
    sx = 1;
    sy = 0;
  } else {
    sx /= sl;
    sy /= sl;
  }
  let tx = -sy,
    ty = sx;
  if (dot3(otherVec, e1) * tx + dot3(otherVec, e2) * ty < 0) {
    tx = -tx;
    ty = -ty;
  }
  const S3: Vec3 = [sx * e1[0] + sy * e2[0], sx * e1[1] + sy * e2[1], sx * e1[2] + sy * e2[2]];
  const T3: Vec3 = [tx * e1[0] + ty * e2[0], tx * e1[1] + ty * e2[1], tx * e1[2] + ty * e2[2]];
  const stOf = (p: Vec3): Vec2 => {
    const d = sub3(p, origin);
    return [dot3(d, S3), dot3(d, T3)];
  };
  const heightOf = (p: Vec3) => dot3(sub3(p, origin), n);

  // Sample (s, t) and heights, and a bucket grid of the sample quads.
  const count = nu * nv;
  const ss = new Float64Array(count),
    ts = new Float64Array(count),
    hs = new Float64Array(count);
  let smin = Infinity,
    smax = -Infinity,
    tmin = Infinity,
    tmax = -Infinity;
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const k = j * nu + i;
      const p = samplePoint(face, i, j);
      const [s, t] = stOf(p);
      ss[k] = s;
      ts[k] = t;
      hs[k] = heightOf(p);
      if (s < smin) smin = s;
      if (s > smax) smax = s;
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
    }
  const quads = (nu - 1) * (nv - 1);
  const B = Math.max(1, Math.ceil(Math.sqrt(quads)));
  const bw = (smax - smin) / B || 1,
    bh = (tmax - tmin) / B || 1;
  const buckets: number[][] = Array.from({ length: B * B }, () => []);
  const bucketOf = (s: number, t: number): [number, number] => [
    Math.max(0, Math.min(B - 1, Math.floor((s - smin) / bw))),
    Math.max(0, Math.min(B - 1, Math.floor((t - tmin) / bh))),
  ];
  for (let j = 0; j < nv - 1; j++)
    for (let i = 0; i < nu - 1; i++) {
      const ks = [j * nu + i, j * nu + i + 1, (j + 1) * nu + i + 1, (j + 1) * nu + i];
      const qs = ks.map((k) => ss[k]),
        qt = ks.map((k) => ts[k]);
      const [b0, c0] = bucketOf(Math.min(...qs), Math.min(...qt));
      const [b1, c1] = bucketOf(Math.max(...qs), Math.max(...qt));
      for (let c = c0; c <= c1; c++)
        for (let b = b0; b <= b1; b++) buckets[c * B + b].push(j * (nu - 1) + i);
    }
  const uStep = (face.domainU[1] - face.domainU[0]) / (nu - 1);
  const vStep = (face.domainV[1] - face.domainV[0]) / (nv - 1);

  /** Inverse bilinear of (s, t) in quad q; returns local (a, b) or null. */
  const inQuad = (q: number, s: number, t: number): [number, number] | null => {
    const i = q % (nu - 1),
      j = Math.floor(q / (nu - 1));
    const k00 = j * nu + i,
      k10 = k00 + 1,
      k01 = k00 + nu,
      k11 = k01 + 1;
    // Newton on the bilinear map from the quad centre.
    let a = 0.5,
      b = 0.5;
    for (let it = 0; it < 8; it++) {
      const fs =
        (1 - a) * (1 - b) * ss[k00] +
        a * (1 - b) * ss[k10] +
        a * b * ss[k11] +
        (1 - a) * b * ss[k01] -
        s;
      const ft =
        (1 - a) * (1 - b) * ts[k00] +
        a * (1 - b) * ts[k10] +
        a * b * ts[k11] +
        (1 - a) * b * ts[k01] -
        t;
      const dsa = (1 - b) * (ss[k10] - ss[k00]) + b * (ss[k11] - ss[k01]);
      const dsb = (1 - a) * (ss[k01] - ss[k00]) + a * (ss[k11] - ss[k10]);
      const dta = (1 - b) * (ts[k10] - ts[k00]) + b * (ts[k11] - ts[k01]);
      const dtb = (1 - a) * (ts[k01] - ts[k00]) + a * (ts[k11] - ts[k10]);
      const det = dsa * dtb - dsb * dta;
      if (Math.abs(det) < 1e-300) return null;
      const da = (fs * dtb - ft * dsb) / det,
        db = (dsa * ft - dta * fs) / det;
      a -= da;
      b -= db;
      if (Math.abs(da) + Math.abs(db) < 1e-12) break;
    }
    const e = 1e-9;
    return a >= -e && a <= 1 + e && b >= -e && b <= 1 + e ? [a, b] : null;
  };

  const toUV = (s: number, t: number): UVHit | null => {
    const [b, c] = bucketOf(s, t);
    if (s < smin - bw || s > smax + bw || t < tmin - bh || t > tmax + bh) return null;
    const hits: { gi: number; gj: number; uv: Vec2; height: number }[] = [];
    for (const q of buckets[c * B + b]) {
      const local = inQuad(q, s, t);
      if (!local) continue;
      const i = q % (nu - 1),
        j = Math.floor(q / (nu - 1));
      const k00 = j * nu + i;
      const [a, bb] = local;
      const height =
        (1 - a) * (1 - bb) * hs[k00] +
        a * (1 - bb) * hs[k00 + 1] +
        a * bb * hs[k00 + nu + 1] +
        (1 - a) * bb * hs[k00 + nu];
      hits.push({
        gi: i + a,
        gj: j + bb,
        uv: [face.domainU[0] + (i + a) * uStep, face.domainV[0] + (j + bb) * vStep],
        height,
      });
    }
    if (!hits.length) return null;
    // Distinct sheets: hits more than 1.5 sample steps apart (the seam of a closed direction wraps).
    const gap = (x: number, y: number, period: number, closed: boolean) => {
      const d = Math.abs(x - y);
      return closed ? Math.min(d, period - d) : d;
    };
    const sheets: (typeof hits)[number][] = [];
    for (const hit of hits)
      if (
        !sheets.some(
          (o) =>
            gap(o.gi, hit.gi, nu - 1, face.closedU) <= 1.5 &&
            gap(o.gj, hit.gj, nv - 1, face.closedV) <= 1.5,
        )
      )
        sheets.push(hit);
    sheets.sort((x, y) => Math.abs(x.height) - Math.abs(y.height));
    const best = sheets[0];
    // Refine on the bicubic surface (two Newton steps on the projected position).
    let [u, v] = best.uv;
    for (let it = 0; it < 3; it++) {
      const p = stOf(sampler.point(u, v));
      const pu = stOf(sampler.point(u + uStep * 1e-3, v));
      const pv = stOf(sampler.point(u, v + vStep * 1e-3));
      const a11 = (pu[0] - p[0]) / (uStep * 1e-3),
        a21 = (pu[1] - p[1]) / (uStep * 1e-3);
      const a12 = (pv[0] - p[0]) / (vStep * 1e-3),
        a22 = (pv[1] - p[1]) / (vStep * 1e-3);
      const det = a11 * a22 - a12 * a21;
      if (Math.abs(det) < 1e-300) break;
      const rs = p[0] - s,
        rt = p[1] - t;
      const nu2 = u - (rs * a22 - a12 * rt) / det;
      const nv2 = v - (a11 * rt - a21 * rs) / det;
      if (Math.abs(nu2 - u) > uStep * 2 || Math.abs(nv2 - v) > vStep * 2) break;
      u = nu2;
      v = nv2;
    }
    if (!face.closedU) u = Math.min(face.domainU[1], Math.max(face.domainU[0], u));
    if (!face.closedV) v = Math.min(face.domainV[1], Math.max(face.domainV[0], v));
    return { uv: [u, v], folded: sheets.length > 1 };
  };

  // Region: the projected trim loops, or the projected boundary of the sample grid.
  let loops: Vec2[][];
  if (face.trimLoops.length)
    loops = face.trimLoops.map((loop) => loop.map((p) => stOf(sampler.point(p[0], p[1]))));
  else {
    const ring: Vec2[] = [];
    const push = (i: number, j: number) => {
      const k = j * nu + i;
      const p: Vec2 = [ss[k], ts[k]];
      const last = ring[ring.length - 1];
      if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-12) ring.push(p);
    };
    for (let i = 0; i < nu; i++) push(i, 0);
    for (let j = 1; j < nv; j++) push(nu - 1, j);
    for (let i = nu - 2; i >= 0; i--) push(i, nv - 1);
    for (let j = nv - 2; j > 0; j--) push(0, j);
    loops = [ring];
  }
  let lsmin = Infinity,
    lsmax = -Infinity,
    ltmin = Infinity,
    ltmax = -Infinity;
  for (const p of loops[0]) {
    lsmin = Math.min(lsmin, p[0]);
    lsmax = Math.max(lsmax, p[0]);
    ltmin = Math.min(ltmin, p[1]);
    ltmax = Math.max(ltmax, p[1]);
  }
  // Spacing: the mean distance between neighbouring samples.
  let spacing = 0,
    pairs = 0;
  for (let j = 0; j < nv; j += Math.max(1, Math.floor(nv / 8)))
    for (let i = 0; i + 1 < nu; i++) {
      spacing += len3(sub3(samplePoint(face, i + 1, j), samplePoint(face, i, j)));
      pairs++;
    }
  for (let i = 0; i < nu; i += Math.max(1, Math.floor(nu / 8)))
    for (let j = 0; j + 1 < nv; j++) {
      spacing += len3(sub3(samplePoint(face, i, j + 1), samplePoint(face, i, j)));
      pairs++;
    }
  spacing /= Math.max(1, pairs);
  return {
    faceIndex: face.faceIndex,
    sampler,
    kind: 'projected',
    axis,
    sRange: [lsmin, lsmax],
    tRange: [ltmin, ltmax],
    closedS: false,
    closedT: false,
    cell: [w, h],
    module: [w, h],
    rect: false,
    loops,
    hasOuter: true,
    toUV,
    axisDir: () => S3,
    poleOf,
    notes: [],
    coarse: spacing > Math.min(w, h) / 2,
  };
}

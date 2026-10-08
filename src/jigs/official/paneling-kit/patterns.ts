// 패턴 셀 (SPEC-16.2 패턴(1차)): the cells of the four first patterns in the 2D domain (s, t), each
// counter-clockwise in (s, t) with an integer lattice index per vertex. The lattice keys
// (SPEC-16.5 5) come from these indices, so neighbouring cells share their vertices by key:
//
//   grid       w × h rectangles; vertex (I, J) at (I·w, J·h).
//   staggered  rows of w × h bricks, even rows (counted from 1) pushed w/2 along the pattern axis;
//              vertex (I, J) at (I·w/2, J·h). A brick keeps the T-junction points of the rows
//              above and below on its long edges (six vertices), so neighbours share edges.
//   diamond    diagonals w (along the axis) and h; vertices are the grid's corners and cell
//              centres; vertex (I, J) at (I·w/2, J·h/2), a diamond centred at (I, J) with I + J odd.
//   triangle   each grid cell split by the diagonal from its start-corner-side vertex to the
//              opposite one: `a` is the half along the pattern axis from that vertex, `b` the other.
//   hexagon    (SPEC-16.13 1) pointy hexagons w wide (between the two side edges) and h tall, rows
//              3h/4 apart, even rows pushed w/2; vertex (I, J) at (I·w/2, J·h/4), so neighbours
//              share vertices by lattice key like the four above.
//   voronoi    (SPEC-16.13 2) one seed per w × h cell, moved from the cell centre by a
//              deterministic pseudo-random share (jitter) of the half cell; each cell is the seed's
//              Voronoi polygon (bisectors with every seed within twice the cell reach, whatever w : h
//              and jitter). Its vertices are named by the seeds equidistant from them (`vertices`),
//              so the neighbours share them too.
//
// Raw rows and columns may start below 1 (the first staggered / diamond row reaches past the start
// corner); the layout renumbers them so the smallest becomes 1 (SPEC-16.5 2).

import type { Vec2 } from './vec.ts';

export type PatternName =
  | 'grid'
  | 'staggered'
  | 'diamond'
  | 'triangle'
  | 'hexagon'
  | 'voronoi'
  | 'tile';

export interface Cell {
  /** Raw row (across the axis) and column (along it), before renumbering. */
  r: number;
  c: number;
  /** '' or the triangle half `a`/`b`; a tile piece's `t<n>` (SPEC-16.13 3). */
  sub: string;
  /** Vertices in (s, t), counter-clockwise. */
  st: Vec2[];
  /** Lattice index per vertex (unwrapped). */
  lat: [number, number][];
}

export interface CellSet {
  cells: Cell[];
  /** Lattice unit lengths: vertex (I, J) sits at (I·unit[0], J·unit[1]). */
  unit: Vec2;
  /** Lattice period of a closed direction (indices wrap modulo it), else null. */
  wrap: [number | null, number | null];
  /** Named vertices (Voronoi): a cell's `lat` is `[index, 0]` into this list and its key is the
   *  name (already wrapped), not a lattice position. */
  vertices?: { name: string; at: Vec2 }[];
}

export interface PatternOptions {
  /** Voronoi: share of the half cell a seed may move (0..1) and the seed number. */
  jitter?: number;
  seed?: number;
}

interface Range {
  lo: number;
  hi: number;
  closed: boolean;
}

/** Integer index range k with [k·step + off, (k+1)·step + off] overlapping (lo, hi) by more than eps. */
function indexRange(range: Range, step: number, off: number, span = 1): [number, number] {
  const eps = step * 1e-7;
  if (range.closed) {
    // Cells starting in [lo, hi): the domain is a whole number of steps.
    const n = Math.round((range.hi - range.lo) / step);
    const k0 = Math.ceil((range.lo - off) / step - 1e-9);
    return [k0, k0 + n - 1];
  }
  const k0 = Math.floor((range.lo - off + eps) / step) - (span - 1);
  const k1 = Math.ceil((range.hi - off - eps) / step) - 1;
  return [k0, k1];
}

/** The pattern's cells covering the ranges (estimate first with `estimateCells`). */
export function patternCells(
  pattern: PatternName,
  cell: Vec2,
  sRange: Vec2,
  tRange: Vec2,
  closedS: boolean,
  closedT: boolean,
  options: PatternOptions = {},
): CellSet {
  const [w, h] = cell;
  const S: Range = { lo: sRange[0], hi: sRange[1], closed: closedS };
  const T: Range = { lo: tRange[0], hi: tRange[1], closed: closedT };
  const nS = Math.round((sRange[1] - sRange[0]) / w);
  const nT = Math.round((tRange[1] - tRange[0]) / h);
  const cells: Cell[] = [];

  if (pattern === 'hexagon') return hexagonCells(w, h, S, T, nS, closedS, closedT);
  if (pattern === 'voronoi')
    return voronoiCells(w, h, S, T, [nS, nT], options.jitter ?? 0.5, options.seed ?? 1);

  // A person's tile is placed per grid cell (tile.ts); the grid gives the cells.
  if (pattern === 'grid' || pattern === 'triangle' || pattern === 'tile') {
    const [r0, r1] = indexRange(T, h, 0);
    const [c0, c1] = indexRange(S, w, 0);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const lat: [number, number][] = [
          [c, r],
          [c + 1, r],
          [c + 1, r + 1],
          [c, r + 1],
        ];
        const at = (k: number): Vec2 => [lat[k][0] * w, lat[k][1] * h];
        if (pattern === 'grid') cells.push({ r, c, sub: '', st: [0, 1, 2, 3].map(at), lat });
        else {
          cells.push({ r, c, sub: 'a', st: [0, 1, 2].map(at), lat: [lat[0], lat[1], lat[2]] });
          cells.push({ r, c, sub: 'b', st: [0, 2, 3].map(at), lat: [lat[0], lat[2], lat[3]] });
        }
      }
    return {
      cells,
      unit: [w, h],
      wrap: [closedS ? nS : null, closedT ? nT : null],
    };
  }

  if (pattern === 'staggered') {
    const half = w / 2;
    const [r0, r1] = indexRange(T, h, 0);
    for (let r = r0; r <= r1; r++) {
      const o = ((r % 2) + 2) % 2; // raw row r is row r+1 counted from 1: even rows shift
      const [c0, c1] = indexRange(S, w, o * half);
      for (let c = c0; c <= c1; c++) {
        const I = 2 * c + o;
        const lat: [number, number][] = [
          [I, r],
          [I + 1, r],
          [I + 2, r],
          [I + 2, r + 1],
          [I + 1, r + 1],
          [I, r + 1],
        ];
        cells.push({ r, c, sub: '', st: lat.map(([i, j]) => [i * half, j * h] as Vec2), lat });
      }
    }
    return {
      cells,
      unit: [half, h],
      wrap: [closedS ? 2 * nS : null, closedT ? nT : null],
    };
  }

  // Diamond: centres (I, J) with I + J odd, spanning one lattice step each way.
  const hw = w / 2,
    hh = h / 2;
  // A closed direction takes the centres in [lo, hi) once per period.
  const [J0, J1] = closedT ? [0, 2 * nT - 1] : indexRange(T, hh, -hh, 2);
  const [I0, I1] = closedS ? [0, 2 * nS - 1] : indexRange(S, hw, -hw, 2);
  for (let J = J0; J <= J1; J++) {
    const parity = ((J % 2) + 2) % 2;
    for (let I = I0; I <= I1; I++) {
      if ((((I + J) % 2) + 2) % 2 !== 1) continue;
      const lat: [number, number][] = [
        [I, J - 1],
        [I + 1, J],
        [I, J + 1],
        [I - 1, J],
      ];
      cells.push({
        r: J,
        c: parity ? I / 2 : (I - 1) / 2,
        sub: '',
        st: lat.map(([i, j]) => [i * hw, j * hh] as Vec2),
        lat,
      });
    }
  }
  return {
    cells,
    unit: [hw, hh],
    wrap: [closedS ? 2 * nS : null, closedT ? 2 * nT : null],
  };
}

/** Hexagons: rows 3h/4 apart (raw row r spans J = 3r … 3r + 4), even rows (r odd) pushed w/2. */
function hexagonCells(
  w: number,
  h: number,
  S: Range,
  T: Range,
  nS: number,
  closedS: boolean,
  closedT: boolean,
): CellSet {
  const half = w / 2,
    q = h / 4,
    step = (3 * h) / 4;
  const nT = Math.round((T.hi - T.lo) / step);
  const cells: Cell[] = [];
  const [r0, r1] = indexRange(T, step, 0, 2);
  for (let r = r0; r <= r1; r++) {
    const o = ((r % 2) + 2) % 2;
    const [c0, c1] = indexRange(S, w, o * half);
    for (let c = c0; c <= c1; c++) {
      const I = 2 * c + 1 + o,
        J = 3 * r;
      const lat: [number, number][] = [
        [I, J],
        [I + 1, J + 1],
        [I + 1, J + 3],
        [I, J + 4],
        [I - 1, J + 3],
        [I - 1, J + 1],
      ];
      cells.push({ r, c, sub: '', st: lat.map(([i, j]) => [i * half, j * q] as Vec2), lat });
    }
  }
  return { cells, unit: [half, q], wrap: [closedS ? 2 * nS : null, closedT ? 3 * nT : null] };
}

/** Deterministic pseudo-random pair in [−1, 1]² for a (wrapped) seed cell. */
export function jitterOf(i: number, j: number, seed: number): Vec2 {
  const mix = (x: number) => {
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return (x ^ (x >>> 16)) >>> 0;
  };
  const a = mix(Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(seed + 1, 83492791));
  const b = mix(a ^ 0x85ebca6b);
  return [(a / 4294967295) * 2 - 1, (b / 4294967295) * 2 - 1];
}

/** Voronoi cells of one jittered seed per w × h cell (SPEC-16.13 2). */
function voronoiCells(
  w: number,
  h: number,
  S: Range,
  T: Range,
  [nS, nT]: [number, number],
  jitter: number,
  seed: number,
): CellSet {
  const wrapI = (i: number) => (S.closed ? ((i % nS) + nS) % nS : i);
  const wrapJ = (j: number) => (T.closed ? ((j % nT) + nT) % nT : j);
  const seedAt = (i: number, j: number): Vec2 => {
    const [jx, jy] = jitterOf(wrapI(i), wrapJ(j), seed);
    return [(i + 0.5) * w + (jx * jitter * w) / 2, (j + 0.5) * h + (jy * jitter * h) / 2];
  };
  const eps = Math.max(w, h) * 1e-9;
  const nameEps = Math.max(w, h) * 1e-7;
  // Every point lies in some w × h cell whose seed is at most `reach` away (the seed sits within
  // ±jitter/2 of its cell centre), so a seed's cell lies within `reach` of it and only seeds within
  // 2·reach can bound it. The window, the starting box and the seeds past an open edge follow
  // from that, for any w : h and jitter (a fixed ±2 window missed real neighbours of long cells
  // and the cells overlapped).
  const j01 = Math.min(Math.max(jitter, 0), 1);
  const reach = Math.hypot(((1 + j01) / 2) * w, ((1 + j01) / 2) * h) * 1.001;
  const di = Math.ceil((2 * reach) / w) + 1,
    dj = Math.ceil((2 * reach) / h) + 1;
  const range = (R: Range, step: number, n: number): [number, number] => {
    if (R.closed) {
      const k0 = Math.round(R.lo / step);
      return [k0, k0 + n - 1];
    }
    const margin = Math.ceil(reach / step);
    return [Math.floor(R.lo / step) - margin, Math.ceil(R.hi / step) + margin - 1];
  };
  const [i0, i1] = range(S, w, nS);
  const [j0, j1] = range(T, h, nT);
  const names = new Map<string, number>();
  const vertices: { name: string; at: Vec2 }[] = [];
  const cells: Cell[] = [];
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const P = seedAt(i, j);
      const near: { id: string; at: Vec2 }[] = [];
      for (let b = -dj; b <= dj; b++)
        for (let a = -di; a <= di; a++) {
          const at = seedAt(i + a, j + b);
          if (Math.hypot(at[0] - P[0], at[1] - P[1]) > 2 * reach) continue;
          near.push({ id: `${wrapI(i + a)}.${wrapJ(j + b)}`, at });
        }
      // A box around the seed holding its whole cell, then the side nearer to it of every bisector.
      let poly: Vec2[] = [
        [P[0] - reach, P[1] - reach],
        [P[0] + reach, P[1] - reach],
        [P[0] + reach, P[1] + reach],
        [P[0] - reach, P[1] + reach],
      ];
      for (const q of near) {
        const dx = q.at[0] - P[0],
          dy = q.at[1] - P[1];
        if (dx * dx + dy * dy < eps * eps) continue; // the seed itself
        const mx = (P[0] + q.at[0]) / 2,
          my = (P[1] + q.at[1]) / 2;
        const side = (p: Vec2) => (p[0] - mx) * dx + (p[1] - my) * dy; // ≤ 0: nearer to P
        const out: Vec2[] = [];
        for (let k = 0; k < poly.length; k++) {
          const a = poly[k],
            b = poly[(k + 1) % poly.length];
          const sa = side(a),
            sb = side(b);
          if (sa <= 0) out.push(a);
          if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
            const lam = sa / (sa - sb);
            out.push([a[0] + lam * (b[0] - a[0]), a[1] + lam * (b[1] - a[1])]);
          }
        }
        poly = out;
        if (poly.length < 3) break;
      }
      // One point where several bisectors meet (four seeds on a circle) may come out twice.
      const clean: Vec2[] = [];
      const far = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) > nameEps;
      for (const p of poly) if (!clean.length || far(clean[clean.length - 1], p)) clean.push(p);
      while (clean.length > 1 && !far(clean[0], clean[clean.length - 1])) clean.pop();
      if (clean.length < 3) continue;
      // Every cell uses the first computed position of a named vertex (moved by whole periods in
      // a closed direction), so both cells of an edge cut it at the very same parameter.
      const periodS = S.closed ? nS * w : 0,
        periodT = T.closed ? nT * h : 0;
      const lat = clean.map((p, k): [number, number] => {
        const d0 = Math.hypot(p[0] - P[0], p[1] - P[1]);
        const ids = near
          .filter((q) => Math.abs(Math.hypot(p[0] - q.at[0], p[1] - q.at[1]) - d0) <= nameEps)
          .map((q) => q.id);
        const name =
          ids.length >= 3
            ? [...new Set(ids)].sort().join('/')
            : `${wrapI(i)}.${wrapJ(j)}@${p[0].toFixed(9)},${p[1].toFixed(9)}`;
        let index = names.get(name);
        if (index === undefined) {
          index = vertices.length;
          names.set(name, index);
          vertices.push({ name, at: p });
        } else {
          const at = vertices[index].at;
          const ks = periodS ? Math.round((p[0] - at[0]) / periodS) : 0;
          const kt = periodT ? Math.round((p[1] - at[1]) / periodT) : 0;
          clean[k] = [at[0] + ks * periodS, at[1] + kt * periodT];
        }
        return [index, 0];
      });
      cells.push({ r: j, c: i, sub: '', st: clean, lat });
    }
  return { cells, unit: [w, h], wrap: [null, null], vertices };
}

/** Rough cell count over the ranges, to refuse a layout past the panel cap before building it. */
export function estimateCells(pattern: PatternName, cell: Vec2, sRange: Vec2, tRange: Vec2) {
  const cols = Math.ceil((sRange[1] - sRange[0]) / cell[0]) + 1;
  const rows = Math.ceil((tRange[1] - tRange[0]) / cell[1]) + 1;
  const per =
    pattern === 'hexagon' ? 4 / 3 : pattern === 'diamond' || pattern === 'triangle' ? 2 : 1;
  return Math.ceil(cols * rows * per);
}

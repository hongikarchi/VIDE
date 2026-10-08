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
//
// Raw rows and columns may start below 1 (the first staggered / diamond row reaches past the start
// corner); the layout renumbers them so the smallest becomes 1 (SPEC-16.5 2).

import type { Vec2 } from './vec.ts';

export type PatternName = 'grid' | 'staggered' | 'diamond' | 'triangle';

export interface Cell {
  /** Raw row (across the axis) and column (along it), before renumbering. */
  r: number;
  c: number;
  sub: '' | 'a' | 'b';
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
): CellSet {
  const [w, h] = cell;
  const S: Range = { lo: sRange[0], hi: sRange[1], closed: closedS };
  const T: Range = { lo: tRange[0], hi: tRange[1], closed: closedT };
  const nS = Math.round((sRange[1] - sRange[0]) / w);
  const nT = Math.round((tRange[1] - tRange[0]) / h);
  const cells: Cell[] = [];

  if (pattern === 'grid' || pattern === 'triangle') {
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

/** Rough cell count over the ranges, to refuse a layout past the panel cap before building it. */
export function estimateCells(pattern: PatternName, cell: Vec2, sRange: Vec2, tRange: Vec2) {
  const cols = Math.ceil((sRange[1] - sRange[0]) / cell[0]) + 1;
  const rows = Math.ceil((tRange[1] - tRange[0]) / cell[1]) + 1;
  return cols * rows * (pattern === 'grid' || pattern === 'staggered' ? 1 : 2);
}

// Layout search of the S-06 frame jig ② (PLAN-23 T-051, SPEC-06.11 1, RESEARCH-10 §14.4 ②):
// where can new column lines go in the (u, v) frame of the existing footings so that every girder,
// diagonals included, stays within the span limit, and the pile caps stay clear of the existing
// footings, the basin's beams and the open cuts as far as the lexicographic objective allows.
//
// Every candidate line is a line of the frame; `allowedWindows` gives, per line, the intervals a
// cap (or open cut, or column) must avoid — an interference is a real footprint pair, and a cap
// beside a footing in one direction only is clear (grid-4m-bay). A 1-D dynamic programme chooses
// the line positions with the span kept as a hard constraint and the objective vector compared
// lexicographically (cap → basin → open cut → column count by default); the orthogonal grid
// alternates the two directions, the staggered grid places rows offset by half a pitch. The
// result is deterministic: the same site and settings give the same lines and keys.

import {
  allowedWindows,
  boundaryDistance,
  lineCrossings,
  pointInPolygon,
  pointInRegion,
  type Polygon,
  type Vec2,
} from '../../../../src/jigs/official/geometry-kit/index.ts';

/** Candidate line positions lie on this pitch (m) in the frame, so a jittered site keeps them. */
export const STEP = 0.25;
const PHASE_STEP = 0.5;
const PITCH_STEP = 1.0;
const EPS = 1e-9;

export type ObjectiveKey = 'cap' | 'basin' | 'openCut' | 'columns';
export const DEFAULT_ORDER: readonly ObjectiveKey[] = ['cap', 'basin', 'openCut', 'columns'];
export const OBJECTIVE_TITLE: Record<ObjectiveKey, string> = {
  cap: '파일캡↔기존 기초',
  basin: '파일캡↔유수지 보',
  openCut: '오픈컷↔기존 기초',
  columns: '기둥 수',
};

/** The site in the frame's local (u, v) metres. Obstacles are convex. */
export interface SearchSite {
  region: { outer: Polygon; holes: Polygon[] };
  forbidden: Polygon[];
  existing: Polygon[];
  basin: Polygon[];
}
export interface SearchOptions {
  spanMax: number;
  /** `all`: diagonals count too (a·b cells need √(a² + b²) ≤ spanMax); `orthogonal`: line spacing only. */
  spanRule: 'all' | 'orthogonal';
  capSize: number;
  openCutSize: number;
  clearance: number;
  /** Column to slab edge (m) at least, and slab edge past the last line (m) at most. */
  edgeMin: number;
  edgeMax: number;
  minSpacing: number;
  order: readonly ObjectiveKey[];
}

export interface Objective {
  spanOver: number;
  spanExcess: number;
  cap: number;
  basin: number;
  openCut: number;
  columns: number;
}
export interface LayoutPoint {
  key: string;
  local: Vec2;
  /** Names of the lines through the point (staggered rows have only one). */
  lineU?: string;
  lineV?: string;
  cap: number;
  basin: number;
  openCut: number;
}
export interface LayoutSpan {
  key: string;
  from: string;
  to: string;
  kind: 'u' | 'v' | 'diagonal' | 'row' | 'stagger';
  length: number;
}
export interface LayoutLine {
  name: string;
  /** Constant coordinate: `u` lines are constant in u (they run along v), `v` lines the reverse. */
  axis: 'u' | 'v';
  at: number;
}
export interface Layout {
  pattern: 'orthogonal' | 'staggered';
  lines: LayoutLine[];
  points: LayoutPoint[];
  spans: LayoutSpan[];
  objective: Objective;
  /** [spanOver, spanExcess, edge, …order] — the vector the alternatives are compared by. */
  vector: number[];
  /** The slab edge past the outermost columns is beyond `edgeMax`: listed, not hidden. */
  edgeRelaxed: boolean;
  /** Staggered only: row pitch and half offset. */
  pitch?: number;
}

const square = (size: number): Polygon => {
  const h = size / 2;
  return [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ];
};
export const lineName = (axis: 'u' | 'v', index: number) =>
  axis === 'u' ? `N${index + 1}` : `N${letters(index)}`;
export function letters(index: number): string {
  let n = index,
    out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function bounds(ring: readonly Vec2[]) {
  let uMin = Infinity,
    uMax = -Infinity,
    vMin = Infinity,
    vMax = -Infinity;
  for (const p of ring) {
    if (p[0] < uMin) uMin = p[0];
    if (p[0] > uMax) uMax = p[0];
    if (p[1] < vMin) vMin = p[1];
    if (p[1] > vMax) vMax = p[1];
  }
  return { uMin, uMax, vMin, vMax };
}
/** Candidate positions on the STEP pitch inside [lo, hi]. */
export function candidates(lo: number, hi: number, step = STEP): number[] {
  const out: number[] = [];
  const first = Math.ceil((lo - EPS) / step) * step;
  for (let t = first; t <= hi + EPS; t += step) out.push(Number(t.toFixed(6)));
  return out;
}
const evenly = (lo: number, hi: number, maxSpacing: number) => {
  const n = Math.max(1, Math.ceil((hi - lo) / maxSpacing - EPS));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(lo + ((hi - lo) * i) / n);
  return out;
};

/** Blocked intervals of one line for the three checks, and the count of blocks at a parameter. */
interface Profile {
  cap: [number, number][];
  basin: [number, number][];
  openCut: [number, number][];
}
const countAt = (intervals: readonly [number, number][], t: number) => {
  let n = 0;
  for (const [lo, hi] of intervals) if (t >= lo - EPS && t <= hi + EPS) n++;
  return n;
};

export class Search {
  readonly site: SearchSite;
  readonly options: SearchOptions;
  readonly box: { uMin: number; uMax: number; vMin: number; vMax: number };
  private readonly cap: Polygon;
  private readonly cut: Polygon;
  private readonly profiles = new Map<string, Profile>();
  private readonly placeableCache = new Map<string, boolean>();

  constructor(site: SearchSite, options: SearchOptions) {
    this.site = site;
    this.options = options;
    this.box = bounds(site.region.outer);
    this.cap = square(options.capSize);
    this.cut = square(options.openCutSize);
  }

  /** Blocked intervals along a line of constant `axis` coordinate `at`. */
  profile(axis: 'u' | 'v', at: number): Profile {
    const key = `${axis}:${at.toFixed(4)}`;
    let profile = this.profiles.get(key);
    if (profile) return profile;
    const { box } = this;
    const line =
      axis === 'u'
        ? {
            origin: [at, 0] as Vec2,
            direction: [0, 1] as Vec2,
            from: box.vMin - 1,
            to: box.vMax + 1,
          }
        : {
            origin: [0, at] as Vec2,
            direction: [1, 0] as Vec2,
            from: box.uMin - 1,
            to: box.uMax + 1,
          };
    const blocked = (shape: Polygon, obstacles: readonly Polygon[], clearance: number) =>
      allowedWindows(line, shape, obstacles, { clearance }).blocked.map((b) => b.interval);
    profile = {
      cap: blocked(this.cap, this.site.existing, this.options.clearance),
      basin: blocked(this.cap, this.site.basin, 0),
      openCut: blocked(this.cut, this.site.existing, 0),
    };
    this.profiles.set(key, profile);
    return profile;
  }

  /** Inside the slab (not in a void), `edgeMin` from its edge, outside every forbidden zone. */
  placeable(u: number, v: number): boolean {
    const key = `${u.toFixed(4)},${v.toFixed(4)}`;
    const known = this.placeableCache.get(key);
    if (known !== undefined) return known;
    const p: Vec2 = [u, v];
    let ok =
      pointInRegion(p, this.site.region, 0) &&
      boundaryDistance(p, this.site.region.outer) >= this.options.edgeMin - EPS;
    if (ok) for (const zone of this.site.forbidden) if (pointInPolygon(p, zone, 0)) ok = false;
    this.placeableCache.set(key, ok);
    return ok;
  }

  /** Penalties of a column at (u, v): the line profile of either family gives the same counts. */
  penalty(u: number, v: number): { cap: number; basin: number; openCut: number } {
    const profile = this.profile('v', v);
    return {
      cap: countAt(profile.cap, u),
      basin: countAt(profile.basin, u),
      openCut: countAt(profile.openCut, u),
    };
  }

  /** Cost vector (in `order`) of a line at `at` with columns at the crossings `across`; null = no column. */
  lineCost(axis: 'u' | 'v', at: number, across: readonly number[]): number[] | null {
    const profile = this.profile(axis, at);
    let cap = 0,
      basin = 0,
      openCut = 0,
      columns = 0;
    for (const t of across) {
      const [u, v] = axis === 'u' ? [at, t] : [t, at];
      if (!this.placeable(u, v)) continue;
      columns++;
      cap += countAt(profile.cap, t);
      basin += countAt(profile.basin, t);
      openCut += countAt(profile.openCut, t);
    }
    if (!columns) return null;
    const values = { cap, basin, openCut, columns };
    return this.options.order.map((k) => values[k]);
  }
}

const lexLess = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0,
      y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
};
const addVec = (a: readonly number[], b: readonly number[]) => a.map((x, i) => x + (b[i] ?? 0));

/**
 * Line positions among `cands` (ascending) minimising the summed cost vector: consecutive lines
 * between `minSpacing` and `dMax` apart, the first and last within `edgeMax` of the range ends.
 * Null when no set of lines satisfies the constraints. Ties keep the earlier candidate.
 */
export function chooseLines(
  cands: readonly number[],
  costs: readonly (number[] | null)[],
  range: readonly [number, number],
  limits: { dMax: number; edgeMax: number; minSpacing: number },
): { positions: number[]; total: number[] } | null {
  const n = cands.length;
  const best: (number[] | null)[] = new Array(n).fill(null);
  const prev: number[] = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const cost = costs[i];
    if (!cost) continue;
    if (cands[i] - range[0] <= limits.edgeMax + EPS) best[i] = cost;
    for (let j = i - 1; j >= 0; j--) {
      const d = cands[i] - cands[j];
      if (d > limits.dMax + EPS) break;
      if (d < limits.minSpacing - EPS || !best[j]) continue;
      const total = addVec(best[j]!, cost);
      if (!best[i] || lexLess(total, best[i]!)) {
        best[i] = total;
        prev[i] = j;
      }
    }
  }
  let end = -1;
  for (let i = 0; i < n; i++) {
    if (!best[i] || range[1] - cands[i] > limits.edgeMax + EPS) continue;
    if (end < 0 || lexLess(best[i]!, best[end]!)) end = i;
  }
  if (end < 0) return null;
  const positions: number[] = [];
  for (let i = end; i >= 0; i = prev[i]) positions.push(cands[i]);
  return { positions: positions.reverse(), total: best[end]! };
}

const maxGap = (positions: readonly number[]) => {
  let gap = 0;
  for (let i = 1; i < positions.length; i++) gap = Math.max(gap, positions[i] - positions[i - 1]);
  return gap;
};
/** Span first, then an uncovered slab edge (a structural fault too), then the given order. */
export const objectiveVector = (
  objective: Objective,
  edgeRelaxed: boolean,
  order: readonly ObjectiveKey[],
) => [
  objective.spanOver,
  Number(objective.spanExcess.toFixed(6)),
  edgeRelaxed ? 1 : 0,
  ...order.map((k) => objective[k]),
];
const spanKey = (from: string, to: string) =>
  `G:${from.replace(/^col:/, '')}>${to.replace(/^col:/, '')}`;

function judgeSpans(spans: LayoutSpan[], spanMax: number) {
  let over = 0,
    excess = 0;
  for (const span of spans)
    if (span.length > spanMax + 1e-6) {
      over++;
      excess += span.length - spanMax;
    }
  return { over, excess };
}
function finish(
  search: Search,
  pattern: Layout['pattern'],
  lines: LayoutLine[],
  points: LayoutPoint[],
  spans: LayoutSpan[],
  edgeRelaxed: boolean,
  pitch?: number,
): Layout {
  const judged = judgeSpans(spans, search.options.spanMax);
  const objective: Objective = {
    spanOver: judged.over,
    spanExcess: judged.excess,
    cap: points.reduce((s, p) => s + p.cap, 0),
    basin: points.reduce((s, p) => s + p.basin, 0),
    openCut: points.reduce((s, p) => s + p.openCut, 0),
    columns: points.length,
  };
  return {
    pattern,
    lines,
    points,
    spans,
    objective,
    vector: objectiveVector(objective, edgeRelaxed, search.options.order),
    edgeRelaxed,
    ...(pitch !== undefined ? { pitch } : {}),
  };
}
const distance = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The grid's implied girder network: neighbours along both families and one diagonal per cell. */
function orthogonalLayout(search: Search, U: number[], V: number[], edgeRelaxed: boolean): Layout {
  const lines: LayoutLine[] = [
    ...U.map((at, i) => ({ name: lineName('u', i), axis: 'u' as const, at })),
    ...V.map((at, j) => ({ name: lineName('v', j), axis: 'v' as const, at })),
  ];
  const grid = new Map<string, LayoutPoint>();
  const points: LayoutPoint[] = [];
  U.forEach((u, i) =>
    V.forEach((v, j) => {
      if (!search.placeable(u, v)) return;
      const point: LayoutPoint = {
        key: `col:${lineName('u', i)}-${lineName('v', j)}`,
        local: [u, v],
        lineU: lineName('u', i),
        lineV: lineName('v', j),
        ...search.penalty(u, v),
      };
      grid.set(`${i},${j}`, point);
      points.push(point);
    }),
  );
  const spans: LayoutSpan[] = [];
  const edge = (a: LayoutPoint, b: LayoutPoint, kind: LayoutSpan['kind']) =>
    spans.push({
      key: spanKey(a.key, b.key),
      from: a.key,
      to: b.key,
      kind,
      length: distance(a.local, b.local),
    });
  // Along v (constant u) and along u (constant v): the next placeable column on the line.
  for (let i = 0; i < U.length; i++) {
    let last: LayoutPoint | undefined;
    for (let j = 0; j < V.length; j++) {
      const p = grid.get(`${i},${j}`);
      if (!p) continue;
      if (last) edge(last, p, 'u');
      last = p;
    }
  }
  for (let j = 0; j < V.length; j++) {
    let last: LayoutPoint | undefined;
    for (let i = 0; i < U.length; i++) {
      const p = grid.get(`${i},${j}`);
      if (!p) continue;
      if (last) edge(last, p, 'v');
      last = p;
    }
  }
  // One diagonal per full cell: the shorter, a tie (≤ 0.05 m) the u+v one (RESEARCH-10 §14.4 ⑤).
  for (let i = 0; i + 1 < U.length; i++)
    for (let j = 0; j + 1 < V.length; j++) {
      const a = grid.get(`${i},${j}`),
        b = grid.get(`${i + 1},${j}`),
        c = grid.get(`${i + 1},${j + 1}`),
        d = grid.get(`${i},${j + 1}`);
      if (!a || !b || !c || !d) continue;
      const ac = distance(a.local, c.local),
        bd = distance(b.local, d.local);
      if (ac <= bd + 0.05) edge(a, c, 'diagonal');
      else edge(b, d, 'diagonal');
    }
  return finish(search, 'orthogonal', lines, points, spans, edgeRelaxed);
}

/**
 * Orthogonal grid: one family evenly spaced at first, then the two families alternately by the DP
 * (four passes), from several starting spacings and either family first; the best vector wins.
 */
export function orthogonal(search: Search): Layout | null {
  const { box, options } = search;
  const S = options.spanMax;
  const uCands = candidates(box.uMin + options.edgeMin, box.uMax - options.edgeMin);
  const vCands = candidates(box.vMin + options.edgeMin, box.vMax - options.edgeMin);
  if (!uCands.length || !vCands.length) return null;
  const across = (gap: number) =>
    options.spanRule === 'all' ? Math.sqrt(Math.max(S * S - gap * gap, 0)) : S;
  let best: Layout | null = null;
  const pass = (axis: 'u' | 'v', fixed: number[], relaxed: { edge: boolean }) => {
    const cands = axis === 'u' ? uCands : vCands;
    const range: [number, number] = axis === 'u' ? [box.uMin, box.uMax] : [box.vMin, box.vMax];
    const dMax = across(maxGap(fixed));
    const costs = cands.map((at) => search.lineCost(axis, at, fixed));
    const limits = { dMax, edgeMax: options.edgeMax, minSpacing: options.minSpacing };
    let chosen = chooseLines(cands, costs, range, limits);
    if (!chosen) {
      chosen = chooseLines(cands, costs, range, { ...limits, edgeMax: Infinity });
      if (chosen) relaxed.edge = true;
    }
    return chosen?.positions ?? null;
  };
  const base = options.spanRule === 'all' ? S / Math.SQRT2 : S;
  for (const first of ['u', 'v'] as const)
    for (const fraction of [1, 0.75, 0.5]) {
      const cands = first === 'u' ? vCands : uCands;
      const fixed = evenly(cands[0], cands[cands.length - 1], base * fraction);
      let U: number[] = first === 'u' ? [] : fixed;
      let V: number[] = first === 'u' ? fixed : [];
      const relaxed = { edge: false };
      for (let round = 0; round < 4; round++) {
        const axis: 'u' | 'v' = (round % 2 === 0) === (first === 'u') ? 'u' : 'v';
        const next = pass(axis, axis === 'u' ? V : U, relaxed);
        if (!next) break;
        if (axis === 'u') U = next;
        else V = next;
        if (!U.length || !V.length) continue;
        const layout = orthogonalLayout(search, U, V, relaxed.edge);
        if (!best || lexLess(layout.vector, best.vector)) best = layout;
      }
    }
  return best;
}

/** Staggered rows: rows are `v` lines, columns on each row at `pitch`, odd rows offset by half. */
export function staggered(search: Search): Layout | null {
  const { box, options } = search;
  const S = options.spanMax;
  const vCands = candidates(box.vMin + options.edgeMin, box.vMax - options.edgeMin);
  if (!vCands.length) return null;
  const uLo = box.uMin + options.edgeMin,
    uHi = box.uMax - options.edgeMin;
  const rowColumns = (pitch: number, phase: number) => {
    const out: number[] = [];
    const first = Math.ceil((uLo - phase - EPS) / pitch);
    for (let k = first; phase + k * pitch <= uHi + EPS; k++)
      out.push(Number((phase + k * pitch).toFixed(6)));
    return out;
  };
  // The slab's extent along a row; a row's columns must reach both ends within `edgeMax`.
  const extents = new Map<number, [number, number] | null>();
  const rowExtent = (v: number) => {
    let extent = extents.get(v);
    if (extent === undefined) {
      const hits = lineCrossings([0, v], [1, 0], search.site.region.outer);
      extent = hits.length >= 2 ? [hits[0], hits[hits.length - 1]] : null;
      extents.set(v, extent);
    }
    return extent;
  };
  const rowCost = (v: number, columns: number[], edgeMax: number) => {
    const extent = rowExtent(v);
    if (!extent) return null;
    const inside = columns.filter(
      (u) => u >= extent[0] - EPS && u <= extent[1] + EPS && search.placeable(u, v),
    );
    if (!inside.length) return null;
    if (
      inside[0] - extent[0] > edgeMax + EPS ||
      extent[1] - inside[inside.length - 1] > edgeMax + EPS
    )
      return null;
    return search.lineCost('v', v, columns);
  };
  interface Best {
    vector: number[];
    pitch: number;
    phase: number;
    rows: { at: number; parity: number }[];
    edgeRelaxed: boolean;
  }
  let best: Best | null = null;
  for (let pitch = S; pitch >= 2 * options.minSpacing - EPS; pitch -= PITCH_STEP) {
    const aMax =
      options.spanRule === 'all' ? Math.sqrt(Math.max(S * S - (pitch * pitch) / 4, 0)) : S;
    if (aMax < options.minSpacing) continue;
    for (let phase = 0; phase < pitch - EPS; phase += PHASE_STEP) {
      const even = rowColumns(pitch, phase),
        odd = rowColumns(pitch, phase + pitch / 2);
      const solve = (edgeMax: number) => {
        // Two costs per candidate row: the even and the odd phase, each covering its row.
        const costs = vCands.map((v) => [rowCost(v, even, edgeMax), rowCost(v, odd, edgeMax)]);
        const n = vCands.length;
        const dp: (number[] | null)[][] = vCands.map(() => [null, null]);
        const prev: number[][] = vCands.map(() => [-1, -1]);
        for (let i = 0; i < n; i++)
          for (const parity of [0, 1]) {
            const cost = costs[i][parity];
            if (!cost) continue;
            if (vCands[i] - box.vMin <= edgeMax + EPS) dp[i][parity] = cost;
            for (let j = i - 1; j >= 0; j--) {
              const d = vCands[i] - vCands[j];
              if (d > aMax + EPS) break;
              if (d < options.minSpacing - EPS || !dp[j][1 - parity]) continue;
              const total = addVec(dp[j][1 - parity]!, cost);
              if (!dp[i][parity] || lexLess(total, dp[i][parity]!)) {
                dp[i][parity] = total;
                prev[i][parity] = j;
              }
            }
          }
        let end: [number, number] | null = null;
        for (let i = 0; i < n; i++)
          for (const parity of [0, 1]) {
            if (!dp[i][parity] || box.vMax - vCands[i] > edgeMax + EPS) continue;
            if (!end || lexLess(dp[i][parity]!, dp[end[0]][end[1]]!)) end = [i, parity];
          }
        if (!end) return null;
        const rows: { at: number; parity: number }[] = [];
        for (let i = end[0], parity = end[1]; i >= 0; ) {
          rows.push({ at: vCands[i], parity });
          const j = prev[i][parity];
          i = j;
          parity = 1 - parity;
        }
        return { rows: rows.reverse(), total: dp[end[0]][end[1]]! };
      };
      let solved = solve(options.edgeMax);
      let edgeRelaxed = false;
      if (!solved) {
        solved = solve(Infinity);
        edgeRelaxed = true;
      }
      if (!solved) continue;
      // An uncovered edge ranks before the objective; column count last, so a coarser pitch wins ties.
      const vector = [edgeRelaxed ? 1 : 0, ...solved.total];
      if (!best || lexLess(vector, best.vector))
        best = { vector, pitch, phase, rows: solved.rows, edgeRelaxed };
    }
  }
  if (!best) return null;
  const lines: LayoutLine[] = best.rows.map((row, j) => ({
    name: lineName('v', j),
    axis: 'v',
    at: row.at,
  }));
  const rows: LayoutPoint[][] = best.rows.map((row, j) => {
    const phase = best.phase + (row.parity ? best.pitch / 2 : 0);
    const columns = rowColumns(best.pitch, phase).filter((u) => search.placeable(u, row.at));
    return columns.map((u, k) => ({
      key: `col:${lineName('v', j)}-${k + 1}`,
      local: [u, row.at] as Vec2,
      lineV: lineName('v', j),
      ...search.penalty(u, row.at),
    }));
  });
  const spans: LayoutSpan[] = [];
  const seen = new Set<string>();
  const edge = (a: LayoutPoint, b: LayoutPoint, kind: LayoutSpan['kind']) => {
    const key = spanKey(a.key, b.key);
    if (seen.has(key)) return;
    seen.add(key);
    spans.push({ key, from: a.key, to: b.key, kind, length: distance(a.local, b.local) });
  };
  rows.forEach((row, j) => {
    for (let k = 1; k < row.length; k++) edge(row[k - 1], row[k], 'row');
    const next = rows[j + 1];
    if (!next?.length) return;
    // To the next row: the nearest column on each side (the two legs of the triangle).
    for (const p of row) {
      let left: LayoutPoint | undefined, right: LayoutPoint | undefined;
      for (const q of next) {
        if (q.local[0] <= p.local[0] + EPS && (!left || q.local[0] > left.local[0])) left = q;
        if (q.local[0] >= p.local[0] - EPS && (!right || q.local[0] < right.local[0])) right = q;
      }
      if (left) edge(p, left, 'stagger');
      if (right && right !== left) edge(p, right, 'stagger');
    }
  });
  return finish(search, 'staggered', lines, rows.flat(), spans, best.edgeRelaxed, best.pitch);
}

/** The site with u and v exchanged, for a staggered grid whose rows run along v. */
export function swapSite(site: SearchSite): SearchSite {
  const swap = (ring: Polygon): Polygon => ring.map(([u, v]) => [v, u]);
  return {
    region: { outer: swap(site.region.outer), holes: site.region.holes.map(swap) },
    forbidden: site.forbidden.map(swap),
    existing: site.existing.map(swap),
    basin: site.basin.map(swap),
  };
}
/** A layout searched on the swapped site, mapped back: its rows are `u` lines. */
export function unswap(layout: Layout): Layout {
  const swapName = (name: string) =>
    name.replace(/^N([A-Z]+)$/, (_, s: string) => `N${lettersToIndex(s) + 1}`);
  const swapKey = (key: string) =>
    key.replace(
      /^col:N([A-Z]+)-(\d+)$/,
      (_, s: string, k: string) => `col:N${lettersToIndex(s) + 1}-${k}`,
    );
  return {
    ...layout,
    lines: layout.lines.map((line) => ({
      ...line,
      axis: line.axis === 'u' ? 'v' : 'u',
      name: swapName(line.name),
    })),
    points: layout.points.map((p) => ({
      ...p,
      key: swapKey(p.key),
      local: [p.local[1], p.local[0]],
      ...(p.lineV ? { lineU: swapName(p.lineV) } : {}),
      lineV: undefined,
    })),
    spans: layout.spans.map((s) => ({
      ...s,
      from: swapKey(s.from),
      to: swapKey(s.to),
      key: spanKey(swapKey(s.from), swapKey(s.to)),
    })),
  };
}
function lettersToIndex(text: string) {
  let n = 0;
  for (const ch of text) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export { lexLess };

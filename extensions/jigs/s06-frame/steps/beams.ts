// S-06 frame jig ⑦-2 작은보 (PLAN-23 T-053 drawn mode, SPEC-06.11 4·6): infill beams inside every
// cell (`cells` step) at a pitch no wider than `beamSpacing_m`, parallel to the cell's longest
// straight edge (or the u / v direction of the girder network), cut at the cell boundary and at
// voids, left out when shorter than the minimum; both ends are pinned on a girder, named by girder
// id and plan-length fraction t (the `t` of `girders`). Where the slab edge lies farther than
// `cantileverMax_m` from the nearest girder the edge strip needs cantilever beams (`edgeCantilevers`).
// A cantilever is the continuation of the nearest interior beam line (continuous through the girder,
// that beam end rigid: `rigidAt`); where no beam line within 45° of the outward direction ends on
// the girder within half a spacing, a back-span beam (`backspanOf`) in the adjacent cell carries it,
// running inward to the first beam or girder it meets. A beam cut by the slab edge or a void gets a
// back span across its root girder the same way, so no cantilever root is held by girder torsion
// alone. With `openingEdgeBeams` (default on) a beam cut by a void inside a cell lands on an opening
// edge beam (개구 둘레 보, `openings`) laid across the cut ends just outside the void, from the nearest
// beam or girder on one side to the next on the other; the cut beams are then carried on both ends
// and need no back span. Pure, JSON only.

import {
  lineCrossings,
  pointInRegion,
  segmentDistance,
  type Vec2,
  type Vec3,
} from '../../../../src/jigs/official/geometry-kit/index.ts';
import type { CellRow, CellsOutput } from './cells.ts';
import type { GirderRow, GirdersOutput } from './girders.ts';
import { dominantAngle, slabOf, type SiteInput } from './roles.ts';

export interface BeamsInputs {
  site: SiteInput;
  steps: { girders: Pick<GirdersOutput, 'girders'>; cells: Pick<CellsOutput, 'cells'> };
}
export interface BeamsParams {
  /** Maximum beam pitch (m, 2.0–3.0). */
  beamSpacing_m: number;
  /** Beams parallel to the longest straight cell edge, or to the network's u / v direction. */
  beamDirection: 'longest-edge' | 'u' | 'v';
  /** Deck cantilever limit from the nearest girder to the slab edge (m). */
  cantileverMax_m: number;
  /** Beams shorter than this are left out (m). */
  minLength_m: number;
  /** A beam end within this of a girder lands on it (m). */
  endTol_m: number;
  /** Beams cut by a void land on an opening edge beam across the cut ends (개구 둘레 보). */
  openingEdgeBeams: boolean;
}
export const DEFAULT_BEAMS_PARAMS: BeamsParams = {
  beamSpacing_m: 2.5,
  beamDirection: 'longest-edge',
  cantileverMax_m: 3.5,
  minLength_m: 0.5,
  endTol_m: 0.02,
  openingEdgeBeams: true,
};
export const BEAM_SPACING_RANGE: readonly [number, number] = [2.0, 3.0];

export interface BeamEnd {
  /** Girder the end sits on; null when the end is on the slab edge, a void edge or a beam. */
  girderId: string | null;
  /** Plan-length fraction along the girder (null with no girder). */
  t: number | null;
  /** What the end sits on when it is neither a girder nor a beam. */
  edge?: 'slab' | 'void';
  /** Beam the end sits on (a back span landing on an infill beam). */
  beamId?: string;
}
export interface BeamRow {
  id: string;
  cellId: string;
  points: Vec3[];
  from: BeamEnd;
  to: BeamEnd;
  length_m: number;
  /** Ends continuous through the girder with a cantilever on the same line: rigid, not pinned. */
  rigidAt?: ('from' | 'to')[];
  /** A back span (its `from` end at the root) of this cantilever or cut beam. */
  backspanOf?: string;
  /** An opening edge beam: the void (`V1`… in slab hole order) it frames; carries no cell strip. */
  opening?: string;
}
export interface EdgeCantileverRow {
  id: string;
  from: { girderId: string; t: number };
  /** From the girder out to the slab edge (top of steel z of the girder). */
  points: Vec3[];
  length_m: number;
  /** Distance from the slab-edge point to the nearest girder (m), over `cantileverMax_m`. */
  cantilever_m: number;
  /** The beam (interior or back span) this cantilever continues through the girder. */
  continues?: string;
  /**
   * Width of the edge strip this cantilever carries (m): half the distance to each neighbour on
   * the same girder edge, each half at most half a spacing; mirrored at the ends of the edge.
   */
  width_m: number;
}
/** An opening edge beam (also in `beams`) and the cut beams it carries. */
export interface OpeningRow {
  id: string;
  cellId: string;
  /** The void it frames (`V1`… in slab hole order). */
  void: string;
  points: Vec3[];
  length_m: number;
  carries: string[];
}
export interface BeamsOutput {
  schema: 'vide.s06.beams/1';
  params: BeamsParams;
  cells: CellRow[];
  beams: BeamRow[];
  edgeCantilevers: EdgeCantileverRow[];
  openings: OpeningRow[];
  summary: {
    cells: number;
    beams: number;
    spacingUsed_m: number;
    dropped: number;
    edgeCantilevers: number;
    /** Back-span beams added so cantilevers are not held by girder torsion alone. */
    backspans: number;
    /** Opening edge beams and the cut beams they carry. */
    openingBeams: number;
    resupported: number;
  };
  notes: string[];
}

const r4 = (value: number) => Number(value.toFixed(4));
const p3 = (p: readonly number[]): Vec3 => [r4(p[0]), r4(p[1]), r4(p[2])];

interface Hit {
  girder: GirderRow;
  distance: number;
  t: number;
  z: number;
}
/** Nearest girder to a plan point: distance, plan-length fraction, top-of-steel z there. */
function nearestGirder(p: readonly number[], girders: readonly GirderRow[]): Hit | null {
  let best: Hit | null = null;
  for (const g of girders) {
    const pts = g.points ?? [];
    let total = 0;
    for (let i = 1; i < pts.length; i++)
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    let walked = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1],
        b = pts[i];
      const dx = b[0] - a[0],
        dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      let s = len > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len) : 0;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const d = Math.hypot(p[0] - (a[0] + s * dx), p[1] - (a[1] + s * dy));
      if (!best || d < best.distance - 1e-12)
        best = {
          girder: g,
          distance: d,
          t: total > 0 ? (walked + s * len) / total : 0,
          z: a[2] + s * (b[2] - a[2]),
        };
      walked += len;
    }
  }
  return best;
}

/** Direction of the longest straight run of a ring (collinear edges joined). */
function longestRun(ring: readonly Vec2[]): Vec2 {
  const n = ring.length;
  const dir = (i: number): Vec2 => {
    const a = ring[i],
      b = ring[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return l > 0 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : [0, 0];
  };
  const len = (i: number) =>
    Math.hypot(ring[(i + 1) % n][0] - ring[i][0], ring[(i + 1) % n][1] - ring[i][1]);
  const same = (i: number, j: number) => {
    const u = dir(i),
      v = dir(j);
    return Math.abs(u[0] * v[1] - u[1] * v[0]) < 1e-6 && u[0] * v[0] + u[1] * v[1] > 0;
  };
  // Start at an edge that does not continue the previous one, so runs are not split at index 0.
  let start = 0;
  for (let i = 0; i < n; i++)
    if (!same((i - 1 + n) % n, i)) {
      start = i;
      break;
    }
  let best: Vec2 = dir(start),
    bestLength = -1,
    runLength = 0,
    runStart = start;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (k > 0 && !same((i - 1 + n) % n, i)) {
      runStart = i;
      runLength = 0;
    }
    runLength += len(i);
    if (runLength > bestLength + 1e-9) {
      bestLength = runLength;
      best = dir(runStart);
    }
  }
  return best;
}

export function beams(
  inputs: BeamsInputs,
  params: Partial<BeamsParams> & { cantileverMax?: number } = {},
): BeamsOutput {
  const { cantileverMax, ...rest } = params;
  const p = { ...DEFAULT_BEAMS_PARAMS, ...rest };
  // The jig's one cantilever setting (`cantileverMax`, also used by the proposed layout) applies.
  if (rest.cantileverMax_m === undefined && typeof cantileverMax === 'number')
    p.cantileverMax_m = cantileverMax;
  const notes: string[] = [];
  const [lo, hi] = BEAM_SPACING_RANGE;
  if (!(p.beamSpacing_m >= lo && p.beamSpacing_m <= hi)) {
    const clamped = Math.min(
      hi,
      Math.max(lo, Number.isFinite(p.beamSpacing_m) ? p.beamSpacing_m : 2.5),
    );
    notes.push(
      `작은보 간격 ${p.beamSpacing_m} m는 범위(${lo}–${hi} m) 밖이라 ${clamped} m로 씁니다.`,
    );
    p.beamSpacing_m = clamped;
  }
  const girders = inputs.steps?.girders?.girders ?? [];
  const cells = inputs.steps?.cells?.cells ?? [];
  const slab = slabOf(inputs.site?.slab, inputs.site?.voids).region;

  // u / v of the network: the dominant girder direction (folded to ±45°).
  let frameDeg = 0;
  if (p.beamDirection !== 'longest-edge') {
    const angles: number[] = [];
    for (const g of girders)
      for (let i = 1; i < (g.points?.length ?? 0); i++) {
        const a = g.points[i - 1],
          b = g.points[i];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6)
          angles.push((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI);
      }
    frameDeg = (dominantAngle(angles) ?? 0) + (p.beamDirection === 'v' ? 90 : 0);
  }

  const out: BeamRow[] = [];
  const frames = new Map<string, CellFrame>();
  let dropped = 0,
    spacingUsed = 0;
  for (const cell of cells) {
    const ring = cell.polygon;
    const holes = cell.holes ?? [];
    if (!ring || ring.length < 3) continue;
    const direction: Vec2 =
      p.beamDirection === 'longest-edge'
        ? longestRun(ring)
        : [Math.cos((frameDeg * Math.PI) / 180), Math.sin((frameDeg * Math.PI) / 180)];
    const normal: Vec2 = [-direction[1], direction[0]];
    const ox = ring[0][0],
      oy = ring[0][1];
    let low = Infinity,
      high = -Infinity;
    for (const q of ring) {
      const d = (q[0] - ox) * normal[0] + (q[1] - oy) * normal[1];
      if (d < low) low = d;
      if (d > high) high = d;
    }
    const width = high - low;
    const count = Math.max(1, Math.ceil(width / p.beamSpacing_m - 1e-9));
    const pitch = width / count;
    if (count > 1 && pitch > spacingUsed) spacingUsed = pitch;
    frames.set(cell.id, { direction, normal, origin: [ox, oy], pitch });
    const own = girders.filter((g) => cell.girderIds.includes(g.id));
    const endOf = (at: Vec2): { end: BeamEnd; z: number } => {
      const hit = nearestGirder(at, own.length ? own : girders) ?? nearestGirder(at, girders);
      if (hit && hit.distance <= p.endTol_m)
        return { end: { girderId: hit.girder.id, t: r4(hit.t) }, z: hit.z };
      const onVoid =
        slab?.holes.some((h) =>
          h.some((a, i) => segmentDistance(at, a, h[(i + 1) % h.length]) <= p.endTol_m),
        ) ?? false;
      return { end: { girderId: null, t: null, edge: onVoid ? 'void' : 'slab' }, z: hit?.z ?? 0 };
    };
    // Inside runs of the scan line at `offset` (t along `direction`, same for every offset).
    const runsAt = (offset: number): [number, number][] => {
      const origin: Vec2 = [ox + normal[0] * offset, oy + normal[1] * offset];
      const ts = [ring, ...holes].flatMap((r) => lineCrossings(origin, direction, r));
      ts.sort((a, b) => a - b);
      const runs: [number, number][] = [];
      for (let j = 0; j + 1 < ts.length; j += 2) runs.push([ts[j], ts[j + 1]]);
      return runs;
    };
    const across = (q: Vec2, offset: number) =>
      (q[0] - ox) * normal[0] + (q[1] - oy) * normal[1] - offset;
    let k = 0;
    for (let line = 1; line < count; line++) {
      const offset = low + line * pitch;
      const origin: Vec2 = [ox + normal[0] * offset, oy + normal[1] * offset];
      // A scan line lying on a boundary edge (a concave cell's notch girder on the pitch) would
      // run along that girder: keep only what is inside on both sides of the line.
      const onEdge = [ring, ...holes].some((r) =>
        r.some(
          (a, i) =>
            Math.abs(across(a, offset)) < 1e-7 &&
            Math.abs(across(r[(i + 1) % r.length], offset)) < 1e-7,
        ),
      );
      let runs = runsAt(offset);
      if (onEdge) {
        const below = runsAt(offset - 1e-6),
          above = runsAt(offset + 1e-6);
        runs = [];
        for (const [a0, a1] of below)
          for (const [b0, b1] of above) {
            const lo = Math.max(a0, b0),
              hi = Math.min(a1, b1);
            if (hi > lo) runs.push([lo, hi]);
          }
        runs.sort((a, b) => a[0] - b[0]);
      }
      const ts = runs.flat();
      for (let j = 0; j + 1 < ts.length; j += 2) {
        const length = ts[j + 1] - ts[j];
        if (length < p.minLength_m) {
          dropped++;
          continue;
        }
        const a: Vec2 = [origin[0] + ts[j] * direction[0], origin[1] + ts[j] * direction[1]];
        const b: Vec2 = [
          origin[0] + ts[j + 1] * direction[0],
          origin[1] + ts[j + 1] * direction[1],
        ];
        const from = endOf(a),
          to = endOf(b);
        k++;
        out.push({
          id: `${cell.id}-B${String(k).padStart(2, '0')}`,
          cellId: cell.id,
          points: [p3([a[0], a[1], from.z]), p3([b[0], b[1], to.z])],
          from: from.end,
          to: to.end,
          length_m: r4(length),
        });
      }
    }
  }
  if (dropped) notes.push(`${p.minLength_m} m보다 짧은 작은보 ${dropped}개는 두지 않았습니다.`);
  const openings =
    slab && p.openingEdgeBeams ? frameOpenings(girders, cells, slab, p, out, frames) : null;
  if (openings?.rows.length)
    notes.push(
      `보이드에서 잘린 작은보 ${openings.resupported}개를 개구 둘레 보 ${openings.rows.length}개에 걸었습니다.`,
    );
  if (openings?.left)
    notes.push(
      `보이드에서 잘린 작은보 끝 ${openings.left}곳은 개구 둘레 보를 둘 자리가 없어 내민 보로 둡니다.`,
    );
  const loose = out.reduce((s, b) => s + (b.from.edge ? 1 : 0) + (b.to.edge ? 1 : 0), 0);
  if (loose) notes.push(`작은보 끝 ${loose}곳이 거더가 아닌 슬래브 끝·보이드 둘레에 닿습니다.`);

  const framing = slab ? frameCantilevers(girders, cells, slab, p, out) : null;
  const edgeCantilevers = framing?.rows ?? [];
  if (edgeCantilevers.length)
    notes.push(
      `슬래브 끝이 거더에서 ${p.cantileverMax_m} m보다 먼 곳 ${edgeCantilevers.length}곳: 내민 보를 안쪽 작은보 줄에 이어 둡니다.`,
    );
  const backspans = out.filter((b) => b.backspanOf).length;
  if (backspans)
    notes.push(
      `내민 보 뿌리를 잡는 뒤쪽 보 ${backspans}개를 옆 칸에 더했습니다(거더에서 연속, 강접).`,
    );
  if (framing?.unheld)
    notes.push(
      `끝이 잘린 작은보 ${framing.unheld}개는 뿌리 거더 건너편에 칸이 없어 뒤쪽 보를 두지 못했습니다.`,
    );
  return {
    schema: 'vide.s06.beams/1',
    params: p,
    cells,
    beams: out,
    edgeCantilevers,
    openings: openings?.rows ?? [],
    summary: {
      cells: cells.length,
      beams: out.length,
      spacingUsed_m: r4(spacingUsed),
      dropped,
      edgeCantilevers: edgeCantilevers.length,
      backspans,
      openingBeams: openings?.rows.length ?? 0,
      resupported: openings?.resupported ?? 0,
    },
    notes,
  };
}

type Seg = { a: Vec3; b: Vec3; id: string };
const dot2 = (u: readonly number[], v: readonly number[]) => u[0] * v[0] + u[1] * v[1];
const unit2 = (a: readonly number[], b: readonly number[]): Vec2 | null => {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return l > 1e-9 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : null;
};
/** Ray origin + t·dir (dir a unit vector) crossing the line of ab: t and the fraction w on ab. */
function rayHit(origin: Vec2, dir: Vec2, a: readonly number[], b: readonly number[]) {
  const ex = b[0] - a[0],
    ey = b[1] - a[1];
  const den = dir[0] * ey - dir[1] * ex;
  if (Math.abs(den) < 1e-12) return null;
  const wx = a[0] - origin[0],
    wy = a[1] - origin[1];
  return { t: (wx * ey - wy * ex) / den, w: (wx * dir[1] - wy * dir[0]) / den };
}
/** Plan distance between segments pq and ab (0 when they cross). */
function segSegDistance(p: Vec2, q: Vec2, a: readonly number[], b: readonly number[]) {
  const d = unit2(p, q);
  if (d) {
    const hit = rayHit(p, d, a, b);
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (hit && hit.t >= 0 && hit.t <= l && hit.w >= 0 && hit.w <= 1) return 0;
  }
  const A: Vec2 = [a[0], a[1]],
    B: Vec2 = [b[0], b[1]];
  return Math.min(
    segmentDistance(p, A, B),
    segmentDistance(q, A, B),
    segmentDistance(A, p, q),
    segmentDistance(B, p, q),
  );
}

/** A continuation must lie within this angle of the outward direction (cos 45°). */
const CONTINUE_COS = Math.SQRT1_2;
/** A beam across the root girder continues a cut beam when within this angle of its line (cos 15°). */
const LINE_COS = Math.cos(Math.PI / 12);

/**
 * Edge cantilevers and the back spans that hold them. Stations along every outer girder edge (a
 * cell on one side only) at the beam pitch; a ray from each outward to the slab edge (or a void)
 * that meets no other girder first — and does not run along one — is an edge strip, listed when the
 * slab-edge point is farther than the limit from the nearest girder. Each such cantilever continues
 * the nearest interior beam ending on that girder within half a spacing (that beam end becomes
 * rigid); without one it goes out square from the girder with a back-span beam in the cell behind.
 * Beams cut by the slab edge or a void get a back span across their root girder too. A gap wider
 * than a spacing left between cantilevers of one edge gets square ones; each carries the strip
 * half-way to its neighbours (`width_m`). Adds the back spans to `beams` and marks `rigidAt` there.
 */
function frameCantilevers(
  girders: readonly GirderRow[],
  cells: readonly CellRow[],
  slab: { outer: Vec2[]; holes: Vec2[][] },
  p: BeamsParams,
  beams: BeamRow[],
): { rows: EdgeCantileverRow[]; unheld: number } {
  const cellAt = (q: Vec2) =>
    cells.find((c) => pointInRegion(q, { outer: c.polygon, holes: c.holes ?? [] }, 0));
  const inSlab = (q: Vec2) => pointInRegion(q, slab, 0);
  const segs: Seg[] = [];
  for (const g of girders)
    for (let i = 1; i < (g.points?.length ?? 0); i++)
      segs.push({ a: g.points[i - 1], b: g.points[i], id: g.id });
  const rings = [slab.outer, ...slab.holes];
  const tol = Math.max(p.endTol_m, 1e-3);
  // Infill beams with both ends on girders: the lines a cantilever or a back span may use.
  const infill = beams.filter((b) => b.from.girderId && b.to.girderId && !b.backspanOf);
  const counters = new Map<string, number>();
  const markRigid = (b: BeamRow, end: 'from' | 'to') => {
    const list = b.rigidAt ?? [];
    if (!list.includes(end)) list.push(end);
    b.rigidAt = list;
  };
  /** The ray from `origin` along `dir` runs within 5 cm of a girder between 0.5 m and length − 0.5 m. */
  const runsAlong = (origin: Vec2, dir: Vec2, length: number) => {
    if (!(length > 1)) return false;
    const a: Vec2 = [origin[0] + dir[0] * 0.5, origin[1] + dir[1] * 0.5];
    const b: Vec2 = [origin[0] + dir[0] * (length - 0.5), origin[1] + dir[1] * (length - 0.5)];
    return segs.some((o) => segSegDistance(a, b, o.a, o.b) < 0.05);
  };
  const endPoint = (b: BeamRow, end: 'from' | 'to') =>
    end === 'from' ? b.points[0] : b.points[b.points.length - 1];
  const otherPoint = (b: BeamRow, end: 'from' | 'to') =>
    end === 'from' ? b.points[b.points.length - 1] : b.points[0];

  /** Back span from `root` (on `girder`) along `dir` inside `cell` to the first infill beam or girder. */
  const addBackspan = (
    root: Vec3,
    girder: { id: string; t: number },
    dir: Vec2,
    cell: CellRow,
    of: string,
  ): BeamRow | null => {
    const origin: Vec2 = [root[0], root[1]];
    const exits = [cell.polygon, ...(cell.holes ?? [])]
      .flatMap((r) => lineCrossings(origin, dir, r))
      .filter((t) => t > tol)
      .sort((a, b) => a - b);
    let stop = exits[0];
    if (stop === undefined) return null;
    // A girder already running inward from the root (a corner station) is the back span.
    if (runsAlong(origin, dir, stop)) return null;
    let onBeam: { beam: BeamRow; w: number } | null = null;
    for (const b of infill) {
      if (b.cellId !== cell.id) continue;
      const hit = rayHit(origin, dir, b.points[0], b.points[b.points.length - 1]);
      if (!hit || hit.w < 0.01 || hit.w > 0.99 || hit.t < p.minLength_m || hit.t >= stop) continue;
      stop = hit.t;
      onBeam = { beam: b, w: hit.w };
    }
    if (stop < p.minLength_m) return null;
    const at: Vec2 = [origin[0] + dir[0] * stop, origin[1] + dir[1] * stop];
    let to: BeamEnd, z: number;
    if (onBeam) {
      const a = onBeam.beam.points[0],
        b = onBeam.beam.points[onBeam.beam.points.length - 1];
      to = { girderId: null, t: null, beamId: onBeam.beam.id };
      z = a[2] + onBeam.w * (b[2] - a[2]);
    } else {
      const hit = nearestGirder(at, girders);
      // The far end must sit on a girder: a back span ending at the slab edge holds nothing.
      if (!hit || hit.distance > tol) return null;
      to = { girderId: hit.girder.id, t: r4(hit.t) };
      z = hit.z;
    }
    const k = (counters.get(cell.id) ?? 0) + 1;
    counters.set(cell.id, k);
    const row: BeamRow = {
      id: `${cell.id}-R${String(k).padStart(2, '0')}`,
      cellId: cell.id,
      points: [p3(root), p3([at[0], at[1], z])],
      from: { girderId: girder.id, t: r4(girder.t) },
      to,
      length_m: r4(stop),
      rigidAt: ['from'],
      backspanOf: of,
    };
    beams.push(row);
    return row;
  };

  // 1. Beams cut by the slab edge or a void: continue them through the root girder.
  let unheld = 0;
  for (const b of beams.filter((x) => !infill.includes(x))) {
    const on: 'from' | 'to' | null = b.from.girderId
      ? b.to.girderId
        ? null
        : 'from'
      : b.to.girderId
        ? 'to'
        : null;
    if (!on || b.backspanOf) continue;
    // Only a free end (slab edge or void) is cut; an end on another beam is carried.
    if (!b[on === 'from' ? 'to' : 'from'].edge) continue;
    const root = endPoint(b, on);
    const dir = unit2(otherPoint(b, on), root);
    if (!dir) continue;
    const far = otherPoint(b, on);
    const cutLength = Math.hypot(far[0] - root[0], far[1] - root[1]);
    // The nearest beam line across the root girder (another cell's beam ending on that girder
    // within half a spacing, within 15° of this line): the cut beam's root moves onto that end and
    // the two run on continuously through the girder.
    const rootGirder = b[on].girderId!;
    let best: { beam: BeamRow; end: 'from' | 'to'; gap: number } | null = null;
    for (const o of infill) {
      if (o.cellId === b.cellId) continue;
      for (const e of ['from', 'to'] as const) {
        if (o[e].girderId !== rootGirder) continue;
        const end = endPoint(o, e);
        const v = unit2(end, otherPoint(o, e));
        const gap = Math.hypot(end[0] - root[0], end[1] - root[1]);
        if (!v || dot2(v, dir) < LINE_COS || gap > p.beamSpacing_m / 2 + 1e-9) continue;
        // Moving the root sideways skews the cut beam: at most 15° off its own line.
        const lateral = Math.abs(dir[0] * (end[1] - root[1]) - dir[1] * (end[0] - root[0]));
        if (lateral > Math.max(tol, cutLength * Math.tan(Math.PI / 12))) continue;
        if (!best || gap < best.gap) best = { beam: o, end: e, gap };
      }
    }
    if (best) {
      markRigid(best.beam, best.end);
      if (best.gap > 1e-6) {
        const end = endPoint(best.beam, best.end);
        const moved = p3([end[0], end[1], end[2]]);
        if (on === 'from') b.points[0] = moved;
        else b.points[b.points.length - 1] = moved;
        b[on] = { girderId: rootGirder, t: best.beam[best.end].t };
        b.length_m = r4(
          Math.hypot(b.points[1][0] - b.points[0][0], b.points[1][1] - b.points[0][1]),
        );
      }
      continue;
    }
    const beyond = cellAt([root[0] + dir[0] * 0.05, root[1] + dir[1] * 0.05]);
    if (!beyond || beyond.id === b.cellId) {
      unheld++;
      continue;
    }
    const girder = { id: rootGirder, t: b[on].t ?? 0 };
    if (!addBackspan(root, girder, dir, beyond, b.id)) unheld++;
  }

  // 2. Edge strips.
  const out: EdgeCantileverRow[] = [];
  const seen = new Set<string>();
  const probe = 0.05;
  /** Ray from `from` along `dir` to the slab edge; null when a girder frames it first. */
  const reachEdge = (from: Vec2, dir: Vec2, own: Seg) => {
    const hits = rings
      .flatMap((ring) => lineCrossings(from, dir, ring))
      .filter((t) => t > 1e-6)
      .sort((a, b) => a - b);
    const d = hits[0];
    if (d === undefined) return null;
    const end: Vec2 = [from[0] + dir[0] * d, from[1] + dir[1] * d];
    const crossed = segs.some((o) => {
      if (o === own) return false;
      const hit = rayHit(from, dir, o.a, o.b);
      return !!hit && hit.t > 1e-3 && hit.t < d - 1e-3 && hit.w >= 0 && hit.w <= 1;
    });
    // A ray running along another girder (a corner station) is that girder, not a strip.
    if (crossed || runsAlong(from, dir, d)) return null;
    let reach = Infinity;
    for (const o of segs) reach = Math.min(reach, segmentDistance(end, o.a, o.b));
    return { d, end, reach };
  };
  const nextId = () => `E${String(out.length + 1).padStart(2, '0')}`;
  type Ray = { d: number; end: Vec2; reach: number };
  const push = (girderId: string, t: number, root: Vec3, ray: Ray, continues?: string) => {
    const row: EdgeCantileverRow = {
      id: nextId(),
      from: { girderId, t: r4(t) },
      points: [p3(root), p3([ray.end[0], ray.end[1], root[2]])],
      length_m: r4(ray.d),
      cantilever_m: r4(ray.reach),
      ...(continues ? { continues } : {}),
      width_m: 0,
    };
    out.push(row);
    return row;
  };
  const half = p.beamSpacing_m / 2;
  for (const s of segs) {
    const dx = s.b[0] - s.a[0],
      dy = s.b[1] - s.a[1];
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) continue;
    const along: Vec2 = [dx / len, dy / len];
    const left: Vec2 = [-along[1], along[0]];
    const mid: Vec2 = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
    const side = (sign: number): Vec2 => [
      mid[0] + sign * left[0] * probe,
      mid[1] + sign * left[1] * probe,
    ];
    const lc = cellAt(side(1)),
      rc = cellAt(side(-1));
    if (!!lc === !!rc) continue;
    const inner = (lc ?? rc)!;
    const outward: Vec2 = lc ? [-left[0], -left[1]] : left;
    if (!inSlab(side(lc ? -1 : 1))) continue;
    const own = girders.filter((g) => g.id === s.id);
    // Interior beam ends on this girder edge whose line points outward (within 45°).
    const lines = infill.flatMap((b) =>
      (['from', 'to'] as const).flatMap((e) => {
        const end = endPoint(b, e);
        const v = unit2(otherPoint(b, e), end);
        if (b[e].girderId !== s.id || !v || dot2(v, outward) < CONTINUE_COS) return [];
        const plan: Vec2 = [end[0], end[1]];
        if (segmentDistance(plan, [s.a[0], s.a[1]], [s.b[0], s.b[1]]) > tol) return [];
        const at = dot2([end[0] - s.a[0], end[1] - s.a[1]], along);
        return [{ beam: b, end: e, point: end, dir: v, at }];
      }),
    );
    // Planned cantilevers of this edge by their station along it: a continued interior beam line
    // or a square one (with a back span); made in station order once the gaps are filled.
    type Planned =
      | { at: number; line: (typeof lines)[number]; ray: Ray }
      | { at: number; from: Vec2; ray: Ray };
    const planned: Planned[] = [];
    /** A square cantilever at `u·len` when the strip there needs one and nothing was put there. */
    const square = (u: number): { from: Vec2; ray: Ray } | null => {
      const from: Vec2 = [s.a[0] + u * dx, s.a[1] + u * dy];
      const key = `${Math.round(from[0] * 1000)},${Math.round(from[1] * 1000)},${Math.round(outward[0] * 1000)},${Math.round(outward[1] * 1000)}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const ray = reachEdge(from, outward, s);
      return ray && ray.reach > p.cantileverMax_m ? { from, ray } : null;
    };
    const count = Math.max(1, Math.ceil(len / p.beamSpacing_m - 1e-9));
    for (let i = 0; i <= count; i++) {
      const u = i / count;
      const station = square(u);
      if (!station) continue;
      // The nearest interior beam line within half a spacing carries the cantilever on.
      const near = lines
        .filter((l) => Math.abs(l.at - u * len) <= half + 1e-9)
        .sort((x, y) => Math.abs(x.at - u * len) - Math.abs(y.at - u * len));
      let done = false;
      for (const l of near) {
        const lineKey = `${l.beam.id}:${l.end}`;
        if (seen.has(lineKey)) {
          done = true;
          break;
        }
        const ray = reachEdge([l.point[0], l.point[1]], l.dir, s);
        // A skew line far longer than the square strip is not this strip's cantilever.
        if (!ray || ray.d > station.ray.d * 1.5 + 0.5) continue;
        seen.add(lineKey);
        planned.push({ at: l.at, line: l, ray });
        done = true;
        break;
      }
      if (!done) planned.push({ at: u * len, ...station });
    }
    // Snapping stations onto beam lines can open a gap wider than a spacing (e.g. where a girder,
    // not a beam, meets this edge): square cantilevers fill it, so no part of the strip is left
    // without one and none carries more than a spacing.
    const anchors = [0, ...planned.map((x) => x.at).sort((a, b) => a - b), len];
    for (let k = 1; k < anchors.length; k++) {
      const gap = anchors[k] - anchors[k - 1];
      if (!(gap > p.beamSpacing_m + 1e-6)) continue;
      const extra = Math.ceil(gap / p.beamSpacing_m - 1e-9) - 1;
      for (let j = 1; j <= extra; j++) {
        const at = anchors[k - 1] + (gap * j) / (extra + 1);
        const station = square(at / len);
        if (station) planned.push({ at, ...station });
      }
    }
    planned.sort((a, b) => a.at - b.at);
    const rows: EdgeCantileverRow[] = [];
    for (const x of planned) {
      if ('line' in x) {
        markRigid(x.line.beam, x.line.end);
        const t = nearestGirder(x.line.point, own)?.t ?? 0;
        rows.push(push(s.id, t, x.line.point, x.ray, x.line.beam.id));
        continue;
      }
      const hit = nearestGirder(x.from, own);
      const root: Vec3 = [x.from[0], x.from[1], hit?.z ?? s.a[2]];
      const t = hit?.t ?? 0;
      // The cell behind this station (a long girder edge can border several cells).
      const behind =
        cellAt([x.from[0] - outward[0] * probe, x.from[1] - outward[1] * probe]) ?? inner;
      const back = addBackspan(root, { id: s.id, t }, [-outward[0], -outward[1]], behind, nextId());
      rows.push(push(s.id, t, root, x.ray, back?.id));
    }
    // Strip widths: half the distance to each neighbour, at most half a spacing on each side.
    rows.forEach((row, k) => {
      const toPrev = k > 0 ? Math.min((planned[k].at - planned[k - 1].at) / 2, half) : undefined;
      const toNext =
        k < rows.length - 1 ? Math.min((planned[k + 1].at - planned[k].at) / 2, half) : undefined;
      row.width_m = r4((toPrev ?? toNext ?? half) + (toNext ?? toPrev ?? half));
    });
  }
  return { rows: out, unheld };
}

interface CellFrame {
  direction: Vec2;
  normal: Vec2;
  origin: Vec2;
  pitch: number;
}
/** An opening edge beam stands this far off the void edge, on the slab side (m). */
const OPENING_CLEAR = 0.01;
/** A void edge whose chain strays at most this far off its chord is framed along the chord (m). */
const CHORD_BEND = 0.1;

/**
 * Opening edge beams (개구 둘레 보). In each cell the beam ends cut by one void on one side, in runs
 * of neighbouring beam lines, get one edge beam across them: square to the beams, just outside the
 * void where it comes nearest the roots within the band up to the neighbouring beam lines, running
 * from the cut ends' middle each way to the first beam or girder it meets. Both of its ends must
 * sit on one; otherwise the cut beams stay free (`left`). The cut beams are shortened onto it
 * (`beamId` end); a beam whose other end is the slab edge stays as it is.
 */
function frameOpenings(
  girders: readonly GirderRow[],
  cells: readonly CellRow[],
  slab: { outer: Vec2[]; holes: Vec2[][] },
  p: BeamsParams,
  beams: BeamRow[],
  frames: ReadonlyMap<string, CellFrame>,
): { rows: OpeningRow[]; resupported: number; left: number } {
  const tol = Math.max(p.endTol_m, 1e-3);
  const onRing = (q: readonly number[], ring: readonly Vec2[]) =>
    ring.some((a, i) => segmentDistance([q[0], q[1]], a, ring[(i + 1) % ring.length]) <= tol);
  const rows: OpeningRow[] = [];
  let resupported = 0,
    left = 0;
  for (const cell of cells) {
    const frame = frames.get(cell.id);
    if (!frame) continue;
    const { direction, normal, origin } = frame;
    const S = (q: readonly number[]) =>
      (q[0] - origin[0]) * direction[0] + (q[1] - origin[1]) * direction[1];
    const N = (q: readonly number[]) =>
      (q[0] - origin[0]) * normal[0] + (q[1] - origin[1]) * normal[1];
    const at = (s: number, n: number): Vec2 => [
      origin[0] + direction[0] * s + normal[0] * n,
      origin[1] + direction[1] * s + normal[1] * n,
    ];
    const mine = beams.filter((b) => b.cellId === cell.id && !b.backspanOf && !b.opening);
    type Cut = {
      beam: BeamRow;
      end: 'from' | 'to';
      ring: number;
      sign: number;
      s: number;
      n: number;
      rootS: number;
    };
    const cuts: Cut[] = [];
    for (const beam of mine)
      for (const end of ['from', 'to'] as const) {
        if (beam[end].edge !== 'void') continue;
        // The other end must be carried (a girder) or be cut by a void too.
        if (beam[end === 'from' ? 'to' : 'from'].edge === 'slab') continue;
        const q = end === 'from' ? beam.points[0] : beam.points[beam.points.length - 1];
        const r = end === 'from' ? beam.points[beam.points.length - 1] : beam.points[0];
        const ring = slab.holes.findIndex((h) => onRing(q, h));
        if (ring < 0) continue;
        cuts.push({ beam, end, ring, sign: S(q) >= S(r) ? 1 : -1, s: S(q), n: N(q), rootS: S(r) });
      }
    const nextId = () =>
      `${cell.id}-H${String(rows.filter((r) => r.cellId === cell.id).length + 1).padStart(2, '0')}`;
    /** Moves the cut end onto the edge beam `id` at plan point q, height z. */
    const resupport = (c: Cut, q: readonly number[], z: number, id: string) => {
      const moved = p3([q[0], q[1], z]);
      if (c.end === 'from') c.beam.points[0] = moved;
      else c.beam.points[c.beam.points.length - 1] = moved;
      c.beam[c.end] = { girderId: null, t: null, beamId: id };
      const u = c.beam.points[0],
        v = c.beam.points[c.beam.points.length - 1];
      c.beam.length_m = r4(Math.hypot(v[0] - u[0], v[1] - u[1]));
    };
    // 1. A void edge of the cell that runs (nearly) straight from girder to girder: the edge beam
    // lies on its chord and the cut beams keep their line up to it.
    const ringPts = cell.polygon;
    const m = ringPts.length;
    const edgeOn = ringPts.map((a, i) => {
      const b = ringPts[(i + 1) % m];
      const h = slab.holes.findIndex(
        (r) => onRing(a, r) && onRing(b, r) && onRing([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], r),
      );
      return h;
    });
    const firstOff = edgeOn.findIndex((h) => h < 0);
    if (firstOff >= 0)
      for (let k = 1; k <= m; k++) {
        const i0 = (firstOff + k) % m;
        const hole = edgeOn[i0];
        if (hole < 0 || edgeOn[(i0 - 1 + m) % m] === hole) continue;
        const chain: Vec2[] = [ringPts[i0]];
        let i = i0;
        while (edgeOn[i] === hole && chain.length <= m) {
          i = (i + 1) % m;
          chain.push(ringPts[i]);
        }
        const A = chain[0],
          Z = chain[chain.length - 1];
        const chord = Math.hypot(Z[0] - A[0], Z[1] - A[1]);
        if (chord < p.minLength_m) continue;
        const bend = Math.max(...chain.map((q) => segmentDistance(q, A, Z)));
        const ga = nearestGirder(A, girders),
          gz = nearestGirder(Z, girders);
        if (bend > CHORD_BEND || !ga || !gz || ga.distance > tol || gz.distance > tol) continue;
        const onChain = (q: readonly number[]) =>
          chain.some((a, j) => j > 0 && segmentDistance([q[0], q[1]], chain[j - 1], a) <= tol);
        const id = nextId();
        const carried: string[] = [];
        for (const c of [...cuts]) {
          if (c.ring !== hole) continue;
          const q = c.end === 'from' ? c.beam.points[0] : c.beam.points[c.beam.points.length - 1];
          if (!onChain(q)) continue;
          const root =
            c.end === 'from' ? c.beam.points[c.beam.points.length - 1] : c.beam.points[0];
          const dir = unit2(root, q);
          const hit = dir && rayHit([root[0], root[1]], dir, A, Z);
          if (!hit || hit.w < -1e-9 || hit.w > 1 + 1e-9 || hit.t < p.minLength_m) continue;
          resupport(
            c,
            [root[0] + dir![0] * hit.t, root[1] + dir![1] * hit.t],
            ga.z + hit.w * (gz.z - ga.z),
            id,
          );
          cuts.splice(cuts.indexOf(c), 1);
          carried.push(c.beam.id);
        }
        if (!carried.length) continue;
        const points = [p3([A[0], A[1], ga.z]), p3([Z[0], Z[1], gz.z])];
        beams.push({
          id,
          cellId: cell.id,
          points: points.map((q) => [...q] as Vec3),
          from: { girderId: ga.girder.id, t: r4(ga.t) },
          to: { girderId: gz.girder.id, t: r4(gz.t) },
          length_m: r4(chord),
          opening: `V${hole + 1}`,
        });
        resupported += carried.length;
        rows.push({
          id,
          cellId: cell.id,
          void: `V${hole + 1}`,
          points,
          length_m: r4(chord),
          carries: carried,
        });
      }
    // 2. The other cut ends: an edge beam square to the beams, just outside the void.
    // Runs of neighbouring beam lines cut by the same void on the same side.
    const groups: Cut[][] = [];
    const keyed = new Map<string, Cut[]>();
    for (const c of cuts) {
      const key = `${c.ring}:${c.sign}`;
      keyed.set(key, [...(keyed.get(key) ?? []), c]);
    }
    for (const [, list] of [...keyed].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      list.sort((a, b) => a.n - b.n);
      let run: Cut[] = [];
      for (const c of list) {
        if (run.length && c.n - run[run.length - 1].n > frame.pitch * 1.5) {
          groups.push(run);
          run = [];
        }
        run.push(c);
      }
      if (run.length) groups.push(run);
    }
    /** Along-beam positions of the cell's edges on void `ring`, clipped to the band lo < n < hi. */
    const voidAlong = (ring: number, lo: number, hi: number) =>
      [cell.polygon, ...(cell.holes ?? [])].flatMap((r) =>
        r.flatMap((a, i) => {
          const b = r[(i + 1) % r.length];
          const h = slab.holes[ring];
          if (!onRing(a, h) || !onRing(b, h)) return [];
          const na = N(a),
            nb = N(b),
            sa = S(a),
            sb = S(b);
          const out: number[] = [];
          if (na > lo && na < hi) out.push(sa);
          if (nb > lo && nb < hi) out.push(sb);
          for (const edge of [lo, hi]) {
            const w = nb !== na ? (edge - na) / (nb - na) : -1;
            if (w > 0 && w < 1) out.push(sa + w * (sb - sa));
          }
          return out;
        }),
      );
    for (const group of groups) {
      const { ring, sign } = group[0];
      const lo = group[0].n - frame.pitch * (1 - 1e-6),
        hi = group[group.length - 1].n + frame.pitch * (1 - 1e-6);
      // Nearest the roots the void comes within the band (the cut ends and the cell's void edge).
      const ss = [...group.map((c) => c.s), ...voidAlong(ring, lo, hi)];
      const sH = (sign > 0 ? Math.min(...ss) : Math.max(...ss)) - sign * OPENING_CLEAR;
      let keep = group.filter((c) => sign * (sH - c.rootS) >= p.minLength_m);
      const start = keep.length ? at(sH, (keep[0].n + keep[keep.length - 1].n) / 2) : null;
      if (!start || !pointInRegion(start, { outer: cell.polygon, holes: cell.holes ?? [] }, 0)) {
        left += group.length;
        continue;
      }
      const mid = N(start);
      const hosts = mine.filter((b) => !keep.some((c) => c.beam === b));
      /** First beam or boundary along ±normal from the middle: the edge beam's end there. */
      const reach = (towards: number) => {
        const dir: Vec2 = [normal[0] * towards, normal[1] * towards];
        let best: { t: number; end: BeamEnd; z: number } | null = null;
        for (const b of hosts) {
          const u = b.points[0],
            v = b.points[b.points.length - 1];
          const hit = rayHit(start, dir, u, v);
          if (!hit || hit.t <= 1e-6 || hit.w < -1e-9 || hit.w > 1 + 1e-9) continue;
          if (!best || hit.t < best.t)
            best = {
              t: hit.t,
              end: { girderId: null, t: null, beamId: b.id },
              z: u[2] + hit.w * (v[2] - u[2]),
            };
        }
        const wall = [cell.polygon, ...(cell.holes ?? [])]
          .flatMap((r) => lineCrossings(start, dir, r))
          .filter((t) => t > 1e-6)
          .sort((x, y) => x - y)[0];
        if (wall !== undefined && (!best || wall < best.t - 1e-6)) {
          const q: Vec2 = [start[0] + dir[0] * wall, start[1] + dir[1] * wall];
          const g = nearestGirder(q, girders);
          best =
            g && g.distance <= tol
              ? { t: wall, end: { girderId: g.girder.id, t: r4(g.t) }, z: g.z }
              : null;
        }
        return best;
      };
      const a = reach(-1),
        b = reach(1);
      // Only the cut ends between the edge beam's ends are carried on it.
      keep = a && b ? keep.filter((c) => c.n > mid - a.t + tol && c.n < mid + b.t - tol) : [];
      left += group.length - keep.length;
      if (!a || !b || !keep.length) continue;
      const pa = at(sH, mid - a.t),
        pb = at(sH, mid + b.t);
      const id = nextId();
      const length = a.t + b.t;
      const zAt = (n: number) => a.z + ((n - (mid - a.t)) / length) * (b.z - a.z);
      const points = [p3([pa[0], pa[1], a.z]), p3([pb[0], pb[1], b.z])];
      beams.push({
        id,
        cellId: cell.id,
        points: points.map((q) => [...q] as Vec3),
        from: a.end,
        to: b.end,
        length_m: r4(length),
        opening: `V${ring + 1}`,
      });
      for (const c of keep) resupport(c, at(sH, c.n), zAt(c.n), id);
      resupported += keep.length;
      rows.push({
        id,
        cellId: cell.id,
        void: `V${ring + 1}`,
        points,
        length_m: r4(length),
        carries: keep.map((c) => c.beam.id),
      });
    }
  }
  return { rows, resupported, left };
}

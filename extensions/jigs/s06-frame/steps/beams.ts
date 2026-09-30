// S-06 frame jig ⑦-2 작은보 (PLAN-23 T-053 drawn mode, SPEC-06.11 4·6): infill beams inside every
// cell (`cells` step) at a pitch no wider than `beamSpacing_m`, parallel to the cell's longest
// straight edge (or the u / v direction of the girder network), cut at the cell boundary and at
// voids, left out when shorter than the minimum; both ends are pinned on a girder, named by girder
// id and plan-length fraction t (the `t` of `girders`). Where the slab edge lies farther than
// `cantileverMax_m` from the nearest girder the edge strip needs cantilever beams: those are listed
// (`edgeCantilevers`), not generated as members. Pure, JSON only.

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
}
export const DEFAULT_BEAMS_PARAMS: BeamsParams = {
  beamSpacing_m: 2.5,
  beamDirection: 'longest-edge',
  cantileverMax_m: 3.5,
  minLength_m: 0.5,
  endTol_m: 0.02,
};
export const BEAM_SPACING_RANGE: readonly [number, number] = [2.0, 3.0];

export interface BeamEnd {
  /** Girder the end sits on; null when the end is on the slab edge or a void edge. */
  girderId: string | null;
  /** Plan-length fraction along the girder (null with no girder). */
  t: number | null;
  /** What the end sits on when it is not a girder. */
  edge?: 'slab' | 'void';
}
export interface BeamRow {
  id: string;
  cellId: string;
  points: Vec3[];
  from: BeamEnd;
  to: BeamEnd;
  length_m: number;
}
export interface EdgeCantileverRow {
  id: string;
  from: { girderId: string; t: number };
  /** From the girder out to the slab edge (top of steel z of the girder). */
  points: Vec3[];
  length_m: number;
  /** Distance from the slab-edge point to the nearest girder (m), over `cantileverMax_m`. */
  cantilever_m: number;
}
export interface BeamsOutput {
  schema: 'vide.s06.beams/1';
  params: BeamsParams;
  cells: CellRow[];
  beams: BeamRow[];
  edgeCantilevers: EdgeCantileverRow[];
  summary: {
    cells: number;
    beams: number;
    spacingUsed_m: number;
    dropped: number;
    edgeCantilevers: number;
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
  let dropped = 0,
    spacingUsed = 0,
    loose = 0;
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
    const own = girders.filter((g) => cell.girderIds.includes(g.id));
    const endOf = (at: Vec2): { end: BeamEnd; z: number } => {
      const hit = nearestGirder(at, own.length ? own : girders) ?? nearestGirder(at, girders);
      if (hit && hit.distance <= p.endTol_m)
        return { end: { girderId: hit.girder.id, t: r4(hit.t) }, z: hit.z };
      loose++;
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
  if (loose) notes.push(`작은보 끝 ${loose}곳이 거더가 아닌 슬래브 끝·보이드 둘레에 닿습니다.`);

  const edgeCantilevers = slab ? cantilevers(girders, cells, slab, p) : [];
  if (edgeCantilevers.length)
    notes.push(
      `슬래브 끝이 거더에서 ${p.cantileverMax_m} m보다 먼 곳 ${edgeCantilevers.length}곳: 내민 보가 필요합니다.`,
    );
  return {
    schema: 'vide.s06.beams/1',
    params: p,
    cells,
    beams: out,
    edgeCantilevers,
    summary: {
      cells: cells.length,
      beams: out.length,
      spacingUsed_m: r4(spacingUsed),
      dropped,
      edgeCantilevers: edgeCantilevers.length,
    },
    notes,
  };
}

/**
 * Stations along every outer girder edge (a cell on one side only) at the beam pitch; a ray from
 * each outward to the slab edge (or a void) that meets no other girder first is an edge strip. It
 * is listed when the slab-edge point is farther than the limit from the nearest girder.
 */
function cantilevers(
  girders: readonly GirderRow[],
  cells: readonly CellRow[],
  slab: { outer: Vec2[]; holes: Vec2[][] },
  p: BeamsParams,
): EdgeCantileverRow[] {
  const inCell = (q: Vec2) =>
    cells.some((c) => pointInRegion(q, { outer: c.polygon, holes: c.holes ?? [] }, 0));
  const inSlab = (q: Vec2) => pointInRegion(q, slab, 0);
  const segs: { a: Vec3; b: Vec3; id: string }[] = [];
  for (const g of girders)
    for (let i = 1; i < (g.points?.length ?? 0); i++)
      segs.push({ a: g.points[i - 1], b: g.points[i], id: g.id });
  const rings = [slab.outer, ...slab.holes];
  const out: EdgeCantileverRow[] = [];
  const seen = new Set<string>();
  const probe = 0.05;
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
    const l = inCell(side(1)),
      r = inCell(side(-1));
    if (l === r) continue;
    const outward: Vec2 = l ? [-left[0], -left[1]] : left;
    if (!inSlab(side(l ? -1 : 1))) continue;
    const count = Math.max(1, Math.ceil(len / p.beamSpacing_m - 1e-9));
    for (let i = 0; i <= count; i++) {
      const u = i / count;
      const from: Vec2 = [s.a[0] + u * dx, s.a[1] + u * dy];
      const key = `${Math.round(from[0] * 1000)},${Math.round(from[1] * 1000)},${Math.round(outward[0] * 1000)},${Math.round(outward[1] * 1000)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hits = rings
        .flatMap((ring) => lineCrossings(from, outward, ring))
        .filter((t) => t > 1e-6)
        .sort((a, b) => a - b);
      const d = hits[0];
      if (d === undefined) continue;
      // Another girder crossed before the edge: the strip is framed there, not a cantilever.
      const blocked = segs.some((o) => {
        if (o === s) return false;
        const ex = o.b[0] - o.a[0],
          ey = o.b[1] - o.a[1];
        const den = outward[0] * ey - outward[1] * ex;
        if (Math.abs(den) < 1e-12) return false;
        const wx = o.a[0] - from[0],
          wy = o.a[1] - from[1];
        const t = (wx * ey - wy * ex) / den;
        const w = (wx * outward[1] - wy * outward[0]) / den;
        return t > 1e-3 && t < d - 1e-3 && w >= 0 && w <= 1;
      });
      if (blocked) continue;
      const end: Vec2 = [from[0] + outward[0] * d, from[1] + outward[1] * d];
      let reach = Infinity;
      for (const o of segs) reach = Math.min(reach, segmentDistance(end, o.a, o.b));
      if (!(reach > p.cantileverMax_m)) continue;
      const hit = nearestGirder(
        from,
        girders.filter((g) => g.id === s.id),
      );
      const z = hit?.z ?? s.a[2];
      out.push({
        id: `E${String(out.length + 1).padStart(2, '0')}`,
        from: { girderId: s.id, t: r4(hit?.t ?? 0) },
        points: [p3([from[0], from[1], z]), p3([end[0], end[1], z])],
        length_m: r4(d),
        cantilever_m: r4(reach),
      });
    }
  }
  return out;
}

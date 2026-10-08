// 사용자 타일 (SPEC-16.13 3, PLAN-49 T-260): the closed curves a person drew flat in Rhino, placed
// rigidly on the face once per grid cell. Per cell: the surface point P at the cell centre, the
// reference normal N, the pattern-axis tangent X (made perpendicular to N) and Y = N × X; a piece
// vertex (x, y) goes to P + x·X + y·Y and then to the nearest point of the surface (Gauss-Newton on
// the sample interpolation in (s, t)). So a piece keeps the drawn shape instead of following the
// distortion of the 2D domain. Pieces are not cut: one with a vertex or an edge middle outside the
// face or its trim is `dropped` whatever the boundary rule; one wholly outside is left out. Every
// piece has its own vertex keys (`<face>:u:<row>:<col>:<piece>:<n>`), so no edge is shared.

import type { CurveSet } from '../../../contracts/paneling.ts';
import type { Domain } from './domain.ts';
import { fingerprint } from './hash.ts';
import { patternCells, type Cell } from './patterns.ts';
import {
  area2,
  cross3,
  dot3,
  inRing,
  len3,
  norm3,
  scale3,
  sub3,
  type Vec2,
  type Vec3,
} from './vec.ts';

export interface TilePiece {
  /** Outline in metres around the tile's bounding-box centre, counter-clockwise seen from +Z. */
  pts: Vec2[];
}
export interface TileSet {
  pieces: TilePiece[];
  /** Bounding box of the drawing, metres. */
  size: Vec2;
  /** Fingerprint of the pieces (part of the layout's settings hash). */
  hash: string;
}

/** The tile from the read curves (SPEC-16.13 3 받기); throws with the reason when it is not one. */
export function tileFromCurves(set: CurveSet): TileSet {
  const loops: Vec2[][] = [];
  for (const item of set.items) {
    if (item.kind !== 'polyline' || !item.closed)
      throw new Error('타일 곡선이 아님 · 닫힌 곡선만 고르세요');
    if (!item.flatXY) throw new Error('타일 곡선이 아님 · 평면 XY와 평행하게 그린 곡선만 받습니다');
    const ring = item.points.map((p) => [p[0], p[1]] as Vec2);
    if (ring.length < 3 || Math.abs(area2(ring)) <= 1e-12)
      throw new Error('타일 곡선이 아님 · 넓이가 없는 곡선이 있습니다');
    if (selfCrossing(ring)) throw new Error('타일 곡선이 아님 · 자기 교차하는 곡선이 있습니다');
    loops.push(area2(ring) < 0 ? ring.slice().reverse() : ring);
  }
  if (!loops.length) throw new Error('타일이 없습니다 · Rhino에서 닫힌 곡선을 고르세요');
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const ring of loops)
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2;
  const centroid = (ring: Vec2[]) => [
    ring.reduce((a, p) => a + p[0], 0) / ring.length,
    ring.reduce((a, p) => a + p[1], 0) / ring.length,
  ];
  // Piece numbers: by the centroid's (y, x) in the drawing (SPEC-16.13 3 번호).
  const pieces = loops
    .map((ring) => ({ ring, c: centroid(ring) }))
    .sort((a, b) => a.c[1] - b.c[1] || a.c[0] - b.c[0])
    .map(({ ring }) => ({ pts: ring.map(([x, y]) => [x - cx, y - cy] as Vec2) }));
  const round = (v: number) => Math.round(v * 1e7) / 1e7;
  return {
    pieces,
    size: [x1 - x0, y1 - y0],
    hash: fingerprint(pieces.map((p) => p.pts.map(([x, y]) => [round(x), round(y)]))),
  };
}

function selfCrossing(ring: readonly Vec2[]): boolean {
  const n = ring.length;
  const orient = (a: Vec2, b: Vec2, c: Vec2) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a = ring[i],
        b = ring[(i + 1) % n],
        c = ring[j],
        d = ring[(j + 1) % n];
      const d1 = orient(a, b, c),
        d2 = orient(a, b, d),
        d3 = orient(c, d, a),
        d4 = orient(c, d, b);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  return false;
}

export interface TileDraft {
  cell: Cell;
  /** Outline in (s, t), counter-clockwise in (s, t). */
  st: Vec2[];
  keys: string[];
  /** Crosses the face boundary or trim (listed as `dropped`). */
  cut: boolean;
  failure: { code: 'dropped'; message: string } | null;
}

/** Is (s, t) inside the face region (rectangle of the non-closed directions, trim loops)? */
function insideRegion(domain: Domain, p: Vec2): boolean {
  const eps = Math.max(domain.cell[0], domain.cell[1]) * 1e-9;
  if (domain.rect) {
    if (!domain.closedS && (p[0] < domain.sRange[0] - eps || p[0] > domain.sRange[1] + eps))
      return false;
    if (!domain.closedT && (p[1] < domain.tRange[0] - eps || p[1] > domain.tRange[1] + eps))
      return false;
  }
  if (!domain.toUV(p[0], p[1])) return false;
  const loops = domain.loops;
  if (!loops.length) return true;
  // Closed directions: loops live in one period; test the point brought into it.
  const q: Vec2 = [p[0], p[1]];
  const period = (lo: number, hi: number, v: number) => {
    const w = hi - lo;
    return w > 0 ? lo + ((((v - lo) % w) + w) % w) : v;
  };
  if (domain.closedS) q[0] = period(domain.sRange[0], domain.sRange[1], q[0]);
  if (domain.closedT) q[1] = period(domain.tRange[0], domain.tRange[1], q[1]);
  const start = domain.hasOuter ? 1 : 0;
  if (domain.hasOuter && !inRing(q, loops[0])) return false;
  for (let k = start; k < loops.length; k++) if (inRing(q, loops[k])) return false;
  return true;
}

/** The surface point of (s, t), or null where nothing maps. */
function pointOf(domain: Domain, s: number, t: number): Vec3 | null {
  const hit = domain.toUV(s, t);
  return hit ? domain.sampler.point(hit.uv[0], hit.uv[1]) : null;
}

/** (s, t) of the surface point nearest to q, from a start (Gauss-Newton); null when it fails. */
function nearestST(domain: Domain, q: Vec3, start: Vec2, reach: number): Vec2 | null {
  const d = Math.max(domain.cell[0], domain.cell[1]) * 1e-4;
  let s = start[0],
    t = start[1];
  for (let it = 0; it < 16; it++) {
    const f = pointOf(domain, s, t),
      fs1 = pointOf(domain, s + d, t),
      fs0 = pointOf(domain, s - d, t),
      ft1 = pointOf(domain, s, t + d),
      ft0 = pointOf(domain, s, t - d);
    if (!f || !fs1 || !fs0 || !ft1 || !ft0) return null;
    const fs = scale3(sub3(fs1, fs0), 1 / (2 * d)),
      ft = scale3(sub3(ft1, ft0), 1 / (2 * d));
    const r = sub3(q, f);
    const a = dot3(fs, fs),
      b = dot3(fs, ft),
      c = dot3(ft, ft);
    const det = a * c - b * b;
    if (!(Math.abs(det) > 1e-30)) return null;
    let ds = (c * dot3(fs, r) - b * dot3(ft, r)) / det,
      dt = (a * dot3(ft, r) - b * dot3(fs, r)) / det;
    // Damp a step longer than the tile's reach (a far start on a strongly curved face).
    const step = Math.hypot(ds, dt);
    if (step > reach) {
      ds *= reach / step;
      dt *= reach / step;
    }
    s += ds;
    t += dt;
    if (Math.hypot(ds, dt) <= d * 1e-5) return [s, t];
  }
  const f = pointOf(domain, s, t);
  return f ? [s, t] : null;
}

/** The pieces of one face: one copy of the tile per grid cell, rigid in the cell's tangent frame. */
export function placeTile(domain: Domain, tile: TileSet, flip: number): TileDraft[] {
  const f = domain.faceIndex;
  const set = patternCells(
    'grid',
    domain.cell,
    domain.sRange,
    domain.tRange,
    domain.closedS,
    domain.closedT,
  );
  const reach = Math.max(domain.cell[0], domain.cell[1], tile.size[0], tile.size[1]);
  const many = tile.pieces.length > 1;
  const out: TileDraft[] = [];
  for (const cell of set.cells) {
    const sc = cell.st.reduce((a, p) => a + p[0], 0) / cell.st.length;
    const tc = cell.st.reduce((a, p) => a + p[1], 0) / cell.st.length;
    const hit = domain.toUV(sc, tc);
    if (!hit) continue;
    const P = domain.sampler.point(hit.uv[0], hit.uv[1]);
    const N = norm3(scale3(domain.sampler.normal(hit.uv[0], hit.uv[1]), flip));
    let X = domain.axisDir(sc, tc);
    X = sub3(X, scale3(N, dot3(X, N)));
    if (len3(X) < 1e-12) X = Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    X = norm3(sub3(X, scale3(N, dot3(X, N))));
    const Y = cross3(N, X);
    tile.pieces.forEach((piece, k) => {
      let failed = false;
      const st: Vec2[] = [];
      for (const [x, y] of piece.pts) {
        const q: Vec3 = [
          P[0] + x * X[0] + y * Y[0],
          P[1] + x * X[1] + y * Y[1],
          P[2] + x * X[2] + y * Y[2],
        ];
        const at = nearestST(domain, q, [sc, tc], reach);
        if (!at) {
          failed = true;
          break;
        }
        st.push(at);
      }
      if (failed || st.length < 3) return;
      const mids = st.map((a, i) => {
        const b = st[(i + 1) % st.length];
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Vec2;
      });
      const inside = [...st, ...mids].map((p) => insideRegion(domain, p));
      if (!inside.some(Boolean)) return;
      const cut = !inside.every(Boolean);
      const keys = piece.pts.map((_, n) => `${f}:u:${cell.r}:${cell.c}:${k + 1}:${n}`);
      if (area2(st) < 0) {
        st.reverse();
        keys.reverse();
      }
      out.push({
        cell: { ...cell, sub: many ? `t${k + 1}` : '' },
        st,
        keys,
        cut,
        failure: cut ? { code: 'dropped', message: '경계에 걸친 타일 조각 · 자르기는 후속' } : null,
      });
    });
  }
  return out;
}

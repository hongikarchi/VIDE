// Site boundary → segments by what lies across them (SPEC-12.8 2, PLAN-45 T-209
// `boundary-segments.ts`). Each site edge is split where a road or neighbouring parcel edge starts
// or stops running along it (collinear within the tolerance). A piece with a road only is `road`,
// with a neighbour only `adjacent`; a piece with both (overlap) or neither (gap) is `unknown` and
// stays '확인 필요' — no rule is put on it until a person says what it is.

import { requirePolygon, signedArea, type Polygon, type Vec2 } from '../geometry-kit/plan.ts';

export type SegmentKind = 'road' | 'adjacent' | 'unknown';

export interface BoundarySegment {
  /** `s<edge>` or `s<edge>.<piece>` (stable for the same boundary and contacts). */
  id: string;
  edge: number;
  a: Vec2;
  b: Vec2;
  kind: SegmentKind;
  status: '확인' | '확인 필요';
  note: string;
  /** Unit outward normal in plan. */
  normal: Vec2;
  length: number;
}

export interface Corner {
  id: string;
  at: Vec2;
  /** The segment ending here and the one starting here. */
  before: string;
  after: string;
  /** Interior angle (deg). */
  angleDeg: number;
}

/** A contact edge (road or neighbour boundary) in plan. */
export type ContactEdge = [Vec2, Vec2];

/** Edges of polylines (and of closed rings: last → first when `closed`). */
export function edgesOf(lines: readonly { points: Vec2[]; closed: boolean }[]): ContactEdge[] {
  const out: ContactEdge[] = [];
  for (const l of lines) {
    for (let i = 0; i + 1 < l.points.length; i++) out.push([l.points[i], l.points[i + 1]]);
    if (l.closed && l.points.length > 2) out.push([l.points[l.points.length - 1], l.points[0]]);
  }
  return out;
}

/** The site ring counter-clockwise, validated (closed, ≥ 3 points, area, no self-crossing). */
export function siteRing(points: readonly Vec2[]): Polygon {
  const r = requirePolygon(points, '대지 경계');
  return signedArea(r) < 0 ? [...r].reverse() : r;
}

function intervalsOn(a: Vec2, b: Vec2, edges: readonly ContactEdge[], tol: number) {
  const ux = b[0] - a[0],
    uy = b[1] - a[1];
  const L = Math.hypot(ux, uy);
  const out: [number, number][] = [];
  for (const [c, d] of edges) {
    const off = (p: Vec2) => Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux) / L;
    if (off(c) > tol || off(d) > tol) continue;
    const t = (p: Vec2) => ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / L;
    const s = Math.max(0, Math.min(t(c), t(d))),
      e = Math.min(L, Math.max(t(c), t(d)));
    if (e - s > tol) out.push([s, e]);
  }
  return out;
}

/**
 * Split the counter-clockwise site ring into contact segments. With no roads and no neighbours
 * given at all, every edge is `unknown`.
 */
export function boundarySegments(
  ring: Polygon,
  roads: readonly ContactEdge[],
  neighbours: readonly ContactEdge[],
  tol: number,
): { segments: BoundarySegment[]; corners: Corner[] } {
  const segments: BoundarySegment[] = [];
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u: Vec2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const normal: Vec2 = [u[1], -u[0]];
    const road = intervalsOn(a, b, roads, tol),
      adj = intervalsOn(a, b, neighbours, tol);
    const cuts = [0, L, ...road.flat(), ...adj.flat()].sort((x, y) => x - y);
    const stops: number[] = [];
    for (const c of cuts) if (!stops.length || c - stops[stops.length - 1] > tol) stops.push(c);
    stops[stops.length - 1] = L;
    if (stops[0] !== 0) stops.unshift(0);
    const pieces: { s: number; e: number; kind: SegmentKind; note: string }[] = [];
    for (let k = 0; k + 1 < stops.length; k++) {
      const s = stops[k],
        e = stops[k + 1];
      if (e - s <= tol && stops.length > 2) continue;
      const m = (s + e) / 2;
      const inRoad = road.some(([p, q]) => p <= m && m <= q),
        inAdj = adj.some(([p, q]) => p <= m && m <= q);
      const kind: SegmentKind =
        inRoad && !inAdj ? 'road' : inAdj && !inRoad ? 'adjacent' : 'unknown';
      const note =
        inRoad && inAdj
          ? '도로와 인접 대지가 겹침'
          : !inRoad && !inAdj
            ? '맞닿은 도로·필지 없음'
            : '';
      const last = pieces[pieces.length - 1];
      if (last && last.kind === kind && last.note === note) last.e = e;
      else pieces.push({ s, e, kind, note });
    }
    pieces.forEach((p, k) => {
      const at = (t: number): Vec2 => (t >= L ? b : [a[0] + u[0] * t, a[1] + u[1] * t]);
      segments.push({
        id: pieces.length === 1 ? `s${i}` : `s${i}.${k}`,
        edge: i,
        a: at(p.s),
        b: at(p.e),
        kind: p.kind,
        status: p.kind === 'unknown' ? '확인 필요' : '확인',
        note: p.note,
        normal,
        length: p.e - p.s,
      });
    });
  });
  const corners: Corner[] = [];
  segments.forEach((seg, k) => {
    const next = segments[(k + 1) % segments.length];
    const ux = seg.b[0] - seg.a[0],
      uy = seg.b[1] - seg.a[1],
      vx = next.b[0] - next.a[0],
      vy = next.b[1] - next.a[1];
    const turn = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    corners.push({
      id: `c${k}`,
      at: seg.b,
      before: seg.id,
      after: next.id,
      angleDeg: 180 - (turn * 180) / Math.PI,
    });
  });
  return { segments, corners };
}

/**
 * Width of the road across a segment: from just outside the segment's middle, along its outward
 * normal, to where that ray leaves the road polygon containing it. Null when no closed road
 * polygon lies across the segment.
 */
export function roadWidthAt(seg: BoundarySegment, roadRings: readonly Polygon[], tol: number) {
  const m: Vec2 = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2];
  const start: Vec2 = [m[0] + seg.normal[0] * tol * 2, m[1] + seg.normal[1] * tol * 2];
  for (const r of roadRings) {
    if (!inRing(start, r)) continue;
    let best = Infinity;
    for (let i = 0; i < r.length; i++) {
      const c = r[i],
        d = r[(i + 1) % r.length];
      const t = rayHit(m, seg.normal, c, d);
      if (t !== null && t > tol * 3 && t < best) best = t;
    }
    if (Number.isFinite(best)) return best;
  }
  return null;
}

function rayHit(o: Vec2, dir: Vec2, c: Vec2, d: Vec2): number | null {
  const ex = d[0] - c[0],
    ey = d[1] - c[1];
  const den = dir[0] * ey - dir[1] * ex;
  if (Math.abs(den) < 1e-12) return null;
  const wx = c[0] - o[0],
    wy = c[1] - o[1];
  const t = (wx * ey - wy * ex) / den;
  const s = (wx * dir[1] - wy * dir[0]) / den;
  return s >= -1e-12 && s <= 1 + 1e-12 ? t : null;
}

export function inRing(p: Vec2, r: readonly Vec2[]) {
  let h = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i],
      [xj, yj] = r[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) h = !h;
  }
  return h;
}

// Shared plan geometry and shapes of the site modeling steps (SPEC-12.5). Survey coordinates are
// EPSG:5186 metres (f64); the steps after 좌표 통일 work in document coordinates = survey − the
// frame's offset (the site base point, or zero when the survey coordinates are kept).

import { signedArea } from '../../../geometry-kit/plan.ts';
import type { Polygons } from '../../../site-data/geometry.ts';

export type XY = [number, number];
export type XYZ = [number, number, number];
/** An open ring: the first point is not repeated at the end. */
export type Ring = XY[];
/** One polygon: counter-clockwise outer ring and clockwise holes. */
export interface Area {
  outer: Ring;
  holes: Ring[];
}

export const DISCLAIMER = '탐색용 규모검토 — 인허가 도서·면적 산정·법규 검토를 대체하지 않음';
export const BASIS = {
  source: '원본에서 읽음',
  computed: '도구로 계산함',
  user: '사용자가 확정함',
  ai: 'AI가 추정함',
} as const;

export const round = (value: number, digits = 3) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** Drop a closing point equal to the first and consecutive duplicates. */
export function openRing(points: readonly (readonly number[])[]): Ring {
  const ring: Ring = [];
  for (const p of points) {
    const q: XY = [Number(p[0]), Number(p[1])];
    const last = ring.at(-1);
    if (!last || Math.abs(last[0] - q[0]) > 1e-9 || Math.abs(last[1] - q[1]) > 1e-9) ring.push(q);
  }
  const [first, last] = [ring[0], ring.at(-1)];
  if (
    ring.length > 1 &&
    Math.abs(first[0] - last![0]) < 1e-9 &&
    Math.abs(first[1] - last![1]) < 1e-9
  )
    ring.pop();
  return ring;
}

const oriented = (ring: Ring, ccw: boolean) =>
  signedArea(ring) > 0 === ccw ? ring : [...ring].reverse();

/** Site-data MultiPolygon coordinates as areas (outer ccw, holes cw); degenerate rings dropped. */
export function areasOf(polygons: Polygons): Area[] {
  const out: Area[] = [];
  for (const polygon of polygons) {
    const outer = openRing(polygon[0] ?? []);
    if (outer.length < 3 || Math.abs(signedArea(outer)) < 1e-6) continue;
    out.push({
      outer: oriented(outer, true),
      holes: polygon
        .slice(1)
        .map((r) => openRing(r))
        .filter((r) => r.length >= 3)
        .map((r) => oriented(r, false)),
    });
  }
  return out;
}

export const areaOfAreas = (areas: readonly Area[]) =>
  areas.reduce(
    (sum, a) =>
      sum +
      Math.abs(signedArea(a.outer)) -
      a.holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0),
    0,
  );

export const moveRing = (ring: readonly XY[], by: readonly number[]): Ring =>
  ring.map(([x, y]) => [round(x - by[0], 4), round(y - by[1], 4)]);
export const moveArea = (area: Area, by: readonly number[]): Area => ({
  outer: moveRing(area.outer, by),
  holes: area.holes.map((h) => moveRing(h, by)),
});
/** A closed curve for `vide.bake.curves@1`: the ring with its first point repeated, at z. */
export const closedCurve = (ring: readonly XY[], z = 0): XYZ[] =>
  [...ring, ring[0]].map(([x, y]) => [x, y, z]);

export interface Bounds2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export function boundsOfRings(rings: readonly (readonly XY[])[]): Bounds2 | null {
  let b: Bounds2 | null = null;
  for (const ring of rings)
    for (const [x, y] of ring)
      b = b
        ? {
            minX: Math.min(b.minX, x),
            minY: Math.min(b.minY, y),
            maxX: Math.max(b.maxX, x),
            maxY: Math.max(b.maxY, y),
          }
        : { minX: x, minY: y, maxX: x, maxY: y };
  return b;
}
export const touchesBox = (rings: readonly (readonly XY[])[], box: Bounds2) => {
  const b = boundsOfRings(rings);
  return (
    !!b && b.maxX >= box.minX && b.minX <= box.maxX && b.maxY >= box.minY && b.minY <= box.maxY
  );
};

export function inRing([x, y]: readonly number[], ring: readonly XY[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export const inArea = (p: readonly number[], area: Area) =>
  inRing(p, area.outer) && !area.holes.some((h) => inRing(p, h));

/** A key part made safe for the bake key rule (ARCH-03 §9.1 `bake-args-safe`). */
export const keyPart = (text: string) =>
  text.replace(/[^A-Za-z0-9가-힣:_.-]/g, '_').slice(0, 48) || '_';

/** A 지번 label from a PNU ("31", "산1-3"). */
export function lotOf(pnu: string) {
  const mountain = pnu[10] === '2';
  const main = Number(pnu.slice(11, 15));
  const sub = Number(pnu.slice(15, 19));
  return `${mountain ? '산' : ''}${main}${sub ? `-${sub}` : ''}`;
}

/** Union of polygons that share edges (합필): the outer boundaries left after shared edges cancel. */
export function unionOutline(areas: readonly Area[], tolerance = 0.005): Ring[] {
  // Snap vertices to a grid so equal corners of neighbouring parcels meet exactly.
  const snap = (v: number) => Math.round(v / tolerance) * tolerance;
  const rings = areas.map((a) => a.outer.map(([x, y]): XY => [snap(x), snap(y)]));
  const points = rings.flat();
  const keyOf = (p: XY) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  // Split every edge at the vertices of the other rings that lie on it (T-junctions).
  const edges: [XY, XY][] = [];
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) continue;
      const on = points
        .map((p) => ({ p, t: ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 }))
        .filter(({ p, t }) => {
          if (t <= 1e-9 || t >= 1 - 1e-9) return false;
          const qx = a[0] + t * dx;
          const qy = a[1] + t * dy;
          return Math.hypot(p[0] - qx, p[1] - qy) <= tolerance;
        })
        .sort((u, v) => u.t - v.t);
      let from = a;
      for (const { p } of on) {
        if (keyOf(p) !== keyOf(from)) edges.push([from, p]);
        from = p;
      }
      if (keyOf(b) !== keyOf(from)) edges.push([from, b]);
    }
  // Cancel edges that appear in both directions (shared boundaries).
  const count = new Map<string, number>();
  for (const [a, b] of edges) {
    const k = `${keyOf(a)}>${keyOf(b)}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const kept = edges.filter(([a, b]) => !count.get(`${keyOf(b)}>${keyOf(a)}`));
  // Chain the rest into rings.
  const next = new Map<string, [XY, XY][]>();
  for (const e of kept) {
    const k = keyOf(e[0]);
    next.set(k, [...(next.get(k) ?? []), e]);
  }
  const used = new Set<[XY, XY]>();
  const out: Ring[] = [];
  for (const start of kept) {
    if (used.has(start)) continue;
    const ring: XY[] = [];
    let edge: [XY, XY] | undefined = start;
    while (edge && !used.has(edge)) {
      used.add(edge);
      ring.push(edge[0]);
      edge = (next.get(keyOf(edge[1])) ?? []).find((e) => !used.has(e));
    }
    const clean = openRing(ring);
    if (clean.length >= 3 && Math.abs(signedArea(clean)) > 1e-6) out.push(clean);
  }
  // Outer boundaries are counter-clockwise (holes of the union would be clockwise).
  return out.sort((a, b) => signedArea(b) - signedArea(a));
}

/** Text of an azimuth (degrees clockwise from north) as one of eight directions. */
export function directionName(azimuth: number) {
  const names = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
  return names[Math.round((((azimuth % 360) + 360) % 360) / 45) % 8];
}

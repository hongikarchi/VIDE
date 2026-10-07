// ⑤ 도로와 접도 (SPEC-12.5): the road parcels (지목 '도') the site touches, measured from the site
// outline: each outline edge is cut into pieces of at most 0.5 m; a piece touches a road when a
// point just outside it lies in a road parcel, and the width there is how far the outward normal
// runs inside that parcel. Per road: contact length, direction (of the outward normal, from the
// chosen north), minimum and average computed width. These are computed values — whether a road is
// a road in law and which width counts is a legal judgement (SPEC-13 or a person).

import { lineCrossings } from '../../../geometry-kit/polygon.ts';
import { directionName, inArea, round, type Ring, type XY } from './common.ts';
import type { FrameOutput, LocalParcel } from './frame.ts';

export interface Road {
  key: string;
  pnu: string;
  lot: string;
  polygon: XY[];
  curve: [number, number, number][];
  contact_m: number;
  azimuthDeg: number;
  direction: string;
  widthMin_m: number;
  widthAvg_m: number;
  widthMin: string;
  widthAvg: string;
  widthSource: string;
  source: string;
  fetchedAt: string | null;
}
export interface RoadsOutput {
  roads: Road[];
  /** Curves to make on the road layer: touching road parcels and SHP road boundaries. */
  curves: {
    key: string;
    curve: [number, number, number][];
    widthMin?: string;
    widthAvg?: string;
    widthSource?: string;
    source: string;
  }[];
  contact_m: number;
  text: string;
  checks: string[];
}

const PIECE = 0.5;
const STEP_OUT = 0.05;
const MAX_WIDTH = 100;
const WIDTH_SOURCE = '계산: 지적 도로 필지 안의 수직 폭';

/** How far from `p` along `n` (unit) the ray stays inside the road's outer ring. */
function widthAt(p: XY, n: XY, road: LocalParcel) {
  let best = Infinity;
  for (const area of road.areas) {
    const start: XY = [p[0] + n[0] * STEP_OUT, p[1] + n[1] * STEP_OUT];
    if (!inArea(start, area)) continue;
    for (const ring of [area.outer, ...area.holes]) {
      const hits = lineCrossings(start, n, ring).filter((t) => t > 1e-6);
      if (hits.length) best = Math.min(best, Math.min(...hits) + STEP_OUT);
    }
  }
  return Number.isFinite(best) ? Math.min(best, MAX_WIDTH) : null;
}

export function roads(inputs: { steps: { frame: FrameOutput } }): RoadsOutput {
  const { frame } = inputs.steps;
  const roadParcels = frame.parcels.filter((p) => p.road);
  const north = frame.north;
  const found = new Map<
    string,
    { road: LocalParcel; length: number; widths: number[]; nx: number; ny: number }
  >();
  const rings: Ring[] = frame.site.rings;
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 1e-6) continue;
      // Counter-clockwise outer ring: the outward normal is the edge direction turned right.
      const n: XY = [(b[1] - a[1]) / length, -(b[0] - a[0]) / length];
      const pieces = Math.max(1, Math.ceil(length / PIECE));
      for (let k = 0; k < pieces; k++) {
        const t = (k + 0.5) / pieces;
        const p: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const out: XY = [p[0] + n[0] * STEP_OUT, p[1] + n[1] * STEP_OUT];
        const road = roadParcels.find((r) => r.areas.some((area) => inArea(out, area)));
        if (!road) continue;
        const width = widthAt(p, n, road);
        const entry = found.get(road.pnu) ?? { road, length: 0, widths: [], nx: 0, ny: 0 };
        entry.length += length / pieces;
        entry.nx += n[0] * (length / pieces);
        entry.ny += n[1] * (length / pieces);
        if (width !== null) entry.widths.push(width);
        found.set(road.pnu, entry);
      }
    }
  const list: Road[] = [...found.values()]
    .filter((e) => e.length >= 0.25)
    .map(({ road, length, widths, nx, ny }) => {
      // Azimuth of the outward direction measured clockwise from the chosen north.
      const east: XY = [north[1], -north[0]];
      const azimuth =
        (Math.atan2(nx * east[0] + ny * east[1], nx * north[0] + ny * north[1]) * 180) / Math.PI;
      const az = round((azimuth + 360) % 360, 1);
      const min = widths.length ? Math.min(...widths) : 0;
      const avg = widths.length ? widths.reduce((s, w) => s + w, 0) / widths.length : 0;
      return {
        key: `road:${road.pnu}`,
        pnu: road.pnu,
        lot: road.lot,
        polygon: road.polygon,
        curve: road.curve,
        contact_m: round(length, 2),
        azimuthDeg: az,
        direction: directionName(az),
        widthMin_m: round(min, 2),
        widthAvg_m: round(avg, 2),
        widthMin: round(min, 2).toFixed(2),
        widthAvg: round(avg, 2).toFixed(2),
        widthSource: WIDTH_SOURCE,
        source: road.source,
        fetchedAt: road.fetchedAt,
      };
    })
    .sort((a, b) => b.contact_m - a.contact_m);
  const checks: string[] = [];
  if (frame.targets.length && !roadParcels.length && !frame.roadLines.length)
    checks.push('도로 자료 없음: 도로 폭·접도 길이를 계산하지 않았습니다');
  else if (frame.targets.length && !list.length)
    checks.push('대지에 접한 도로 필지를 찾지 못했습니다');
  return {
    roads: list,
    curves: [
      ...list.map((r) => ({
        key: r.key,
        curve: r.curve,
        widthMin: r.widthMin,
        widthAvg: r.widthAvg,
        widthSource: r.widthSource,
        source: r.source,
      })),
      ...frame.roadLines.map((l) => ({ key: l.key, curve: l.curve, source: l.source })),
    ],
    contact_m: round(
      list.reduce((s, r) => s + r.contact_m, 0),
      2,
    ),
    text: list.length
      ? list
          .map(
            (r) =>
              `${r.direction}측 ${r.lot} 폭 최소 ${r.widthMin} m · 평균 ${r.widthAvg} m · 접도 ${r.contact_m} m`,
          )
          .join(' / ')
      : '접한 도로 없음',
    checks,
  };
}

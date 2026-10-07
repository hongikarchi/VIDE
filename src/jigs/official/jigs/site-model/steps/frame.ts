// ④ 좌표 통일 (SPEC-12.5·12.6): one plane CRS (EPSG:5186, the collector asks every source in it and
// SHP files are moved into it on import) and one integer-metre base point from the target parcels
// only, so leaving a layer out or reordering never moves it. Document coordinates are survey
// coordinates less the offset: the base point (default '대지 기준점') or zero ('측량 좌표 그대로').
// Grid convergence at the base point gives true north; the chosen north (진북 default, 도북 by
// setting) is what directions are measured from. The bake carries an f64 origin and f32
// differences (ARCH-03 §9.2), so either mode reaches Rhino without losing centimetres.

import { convergenceAt, crsByEpsg, crsLabel, toGeographic } from '../../../site-data/shp/crs.ts';
import {
  areaOfAreas,
  boundsOfRings,
  closedCurve,
  moveArea,
  moveRing,
  round,
  unionOutline,
  type Area,
  type Ring,
  type XY,
} from './common.ts';
import type { CollectOutput, SiteParcel } from './collect.ts';

export interface LocalParcel extends Omit<SiteParcel, 'areas'> {
  areas: Area[];
  /** Outer ring (map). */
  polygon: XY[];
  /** Closed outline curve at z 0 (bake). */
  curve: [number, number, number][];
  areaText: string;
}
export interface FrameOutput {
  crs: string;
  crsLabel: string;
  mode: 'site' | 'survey';
  /** The base point in survey coordinates (integer m). */
  origin: [number, number, number];
  /** Subtracted from survey coordinates to get document coordinates. */
  offset: [number, number, number];
  originText: string;
  originLatLon: [number, number];
  /** Degrees clockwise from true north to grid north at the base point. */
  convergenceDeg: number;
  trueNorth: [number, number];
  gridNorth: [number, number];
  northBasis: 'true' | 'grid';
  /** The north directions are measured from (document coordinates). */
  north: [number, number];
  targets: LocalParcel[];
  /** The site: union of the target parcels (합필), outer rings counter-clockwise. */
  site: { rings: Ring[]; area: number; pieces: number; separated: boolean; polygon: XY[] };
  outline: { key: string; curve: [number, number, number][]; area: string }[];
  parcels: LocalParcel[];
  roadLines: { key: string; curve: [number, number, number][]; source: string }[];
  contours: { key: string; z: number; line: [number, number, number][] }[];
  spots: { key: string; z: number; at: [number, number, number] }[];
  checks: string[];
}

const CRS = crsByEpsg(5186);

function local(parcel: SiteParcel, by: readonly number[]): LocalParcel {
  const areas = parcel.areas.map((a) => moveArea(a, by));
  return {
    ...parcel,
    areas,
    polygon: areas[0]?.outer ?? [],
    curve: areas[0] ? closedCurve(areas[0].outer) : [],
    areaText: String(parcel.officialArea ?? parcel.computedArea),
  };
}

export function frame(
  inputs: { steps: { collect: CollectOutput } },
  params: { originMode?: string; north?: string },
): FrameOutput {
  const data = inputs.steps.collect;
  const bounds = boundsOfRings(data.targets.flatMap((t) => t.areas.map((a) => a.outer)));
  const origin: [number, number, number] = bounds
    ? [Math.floor((bounds.minX + bounds.maxX) / 2), Math.floor((bounds.minY + bounds.maxY) / 2), 0]
    : [0, 0, 0];
  const mode = params.originMode === 'survey' ? 'survey' : 'site';
  const offset: [number, number, number] = mode === 'site' ? origin : [0, 0, 0];
  const [lat, lon] = toGeographic(CRS, origin[0], origin[1]);
  const convergenceDeg = round(convergenceAt(CRS, origin[0], origin[1]), 6);
  const g = (convergenceDeg * Math.PI) / 180;
  const trueNorth: [number, number] = [round(-Math.sin(g), 9), round(Math.cos(g), 9)];
  const northBasis = params.north === 'grid' ? 'grid' : 'true';
  const targets = data.targets.map((t) => local(t, offset));
  const rings = unionOutline(targets.flatMap((t) => t.areas));
  const checks: string[] = [];
  const separated = rings.length > 1;
  if (separated)
    checks.push(
      `떨어진 필지: 대상 필지가 ${rings.length}덩어리로 나뉩니다. 사람이 확정해야 합니다`,
    );
  const area = round(areaOfAreas(rings.map((outer) => ({ outer, holes: [] }))), 2);
  return {
    crs: 'EPSG:5186',
    crsLabel: crsLabel(CRS),
    mode,
    origin,
    offset,
    originText: `${origin[0]}, ${origin[1]}`,
    originLatLon: [round(lat, 8), round(lon, 8)],
    convergenceDeg,
    trueNorth,
    gridNorth: [0, 1],
    northBasis,
    north: northBasis === 'grid' ? [0, 1] : trueNorth,
    targets,
    site: { rings, area, pieces: rings.length, separated, polygon: rings[0] ?? [] },
    outline:
      targets.length > 1
        ? rings.map((ring, i) => ({
            key: `site:outline${rings.length > 1 ? `-${i + 1}` : ''}`,
            curve: closedCurve(ring),
            area: String(area),
          }))
        : [],
    parcels: data.parcels.map((p) => local(p, offset)),
    roadLines: data.roadLines.map((r) => ({
      key: r.key,
      curve: moveRing(r.line, offset).map(([x, y]): [number, number, number] => [x, y, 0]),
      source: r.source,
    })),
    contours: data.contours.map((c) => ({
      key: c.key,
      z: c.z,
      line: moveRing(c.line, offset).map(([x, y]): [number, number, number] => [x, y, c.z]),
    })),
    spots: data.spots.map((s) => ({
      key: s.key,
      z: s.z,
      at: [round(s.at[0] - offset[0], 4), round(s.at[1] - offset[1], 4), s.z],
    })),
    checks,
  };
}

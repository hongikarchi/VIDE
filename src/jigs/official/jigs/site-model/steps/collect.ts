// ③ 수집 (SPEC-12.4): the engine's read-copy of the public sources (`vide/site-data` collectSite)
// and the SHP put in, as one set in survey coordinates (EPSG:5186): target parcels, surrounding
// parcels (roads are 지목 '도'), buildings with their recorded heights, land use, and from the SHP
// the road boundaries, contours and spot heights. Each source keeps its own status and '확인 필요'
// lines; an unusable public source falls back to the SHP layer of the same kind (대체 출처), never
// to another public source. Without a target boundary the steps after this one stop.

import type { Snapshot } from '../../../site-data/snapshot.ts';
import {
  areaOfAreas,
  areasOf,
  boundsOfRings,
  keyPart,
  lotOf,
  round,
  touchesBox,
  type Area,
  type Bounds2,
  type XY,
} from './common.ts';
import type { ShpCopy, ShpLayer, SiteInput } from './inputs.ts';

export interface SiteParcel {
  key: string;
  pnu: string;
  lot: string;
  address: string | null;
  landCategory: string | null;
  road: boolean;
  officialArea: number | null;
  computedArea: number;
  areas: Area[];
  source: string;
  fetchedAt: string | null;
}
export interface SiteBuilding {
  key: string;
  id: string;
  pnu: string | null;
  name: string | null;
  floors: number | null;
  height: number | null;
  /** Who recorded the height: 건물 정보 (VWorld) · 대장 (건축물대장); null → estimated later. */
  heightFrom: '건물 정보' | '대장' | null;
  use: string | null;
  wallless: boolean;
  areas: Area[];
  source: string;
  fetchedAt: string | null;
}
export interface SourceRow {
  key: string;
  name: string;
  status: 'ok' | 'check' | 'failed' | 'no-key' | 'off' | 'none' | 'shp';
  text: string;
  count: number;
  fetchedAt: string | null;
  checks: string;
}
export interface CollectOutput {
  crs: 'EPSG:5186';
  fetchedAt: string | null;
  radius: number;
  targets: SiteParcel[];
  /** Target parcels found, also when some are missing (then `targets` is empty). */
  found: SiteParcel[];
  parcels: SiteParcel[];
  buildings: SiteBuilding[];
  landUse: {
    pnu: string;
    entries: { name: string; code: string | null; conflict: string | null; notices: string }[];
    districtPlans: string[];
  }[];
  roadLines: { key: string; line: XY[]; source: string }[];
  contours: { key: string; z: number; line: XY[] }[];
  spots: { key: string; z: number; at: XY }[];
  sources: SourceRow[];
  checks: string[];
  missing: string[];
  blocked: boolean;
}

const SOURCE_NAME: Record<string, string> = {
  target: '대상 필지 (연속지적)',
  landCharacteristics: '공부 면적·지목 (토지특성)',
  landUse: '용도지역·지구 (토지이용계획)',
  parcels: '주변 필지 (연속지적)',
  buildings: '주변 건물 (도로명주소 건물)',
  buildingInfo: '건물 높이 (건물 정보)',
  register: '건축물대장 표제부',
};
const STATUS_TEXT: Record<string, string> = {
  ok: '가져옴',
  check: '확인 필요',
  failed: '가져오지 못함',
  'no-key': '키 없음',
  off: '공공 자료 끔',
  none: '가져오기 전',
  shp: '넣은 SHP',
};
const FAILURE: Record<string, string> = {
  NO_KEY: '키 없음',
  REJECTED: '자료원이 요청을 거절함',
  LIMIT: '자료원 호출 한도 초과',
  BAD_RESPONSE: '응답 형식이 예상과 다름',
  NETWORK: '네트워크 끊김 또는 응답 없음',
  FORBIDDEN_ENDPOINT: '허용되지 않은 자료원',
};
const usable = (copy: Snapshot<unknown> | undefined) =>
  !!copy && (copy.status === 'ok' || copy.status === 'check') && copy.items.length > 0;

function sourceRow(key: string, copy: Snapshot<unknown> | undefined): SourceRow {
  if (!copy)
    return {
      key,
      name: SOURCE_NAME[key],
      status: 'none',
      text: STATUS_TEXT.none,
      count: 0,
      fetchedAt: null,
      checks: '',
    };
  return {
    key,
    name: SOURCE_NAME[key],
    status: copy.status,
    text:
      STATUS_TEXT[copy.status] +
      (copy.reason ? ` · ${FAILURE[copy.reason] ?? copy.reason}` : '') +
      (copy.detail ? ` (${copy.detail})` : ''),
    count: copy.items.length,
    fetchedAt: copy.fetchedAt,
    checks: copy.checks.join(' · '),
  };
}

/** SHP features of one role in survey coordinates. */
function shpLayers(shp: ShpCopy | null, role: ShpLayer['role']) {
  return (shp?.layers ?? []).filter((l) => l.role === role);
}
const toSurvey = (shp: ShpCopy, [x, y]: readonly number[]): XY => [
  round(x + (shp.frame?.origin[0] ?? 0), 4),
  round(y + (shp.frame?.origin[1] ?? 0), 4),
];

export function collect(
  inputs: { site: Pick<SiteInput, 'targets' | 'collection' | 'shp'> },
  params: { radius?: number },
): CollectOutput {
  const { collection, shp } = inputs.site;
  const pnus = inputs.site.targets?.pnus ?? [];
  const radius = Number(params.radius ?? 200);
  const checks: string[] = [];
  const sources: SourceRow[] = [];
  const fresh =
    !!collection &&
    pnus.length > 0 &&
    pnus.every((p) => collection.sent.pnus.includes(p)) &&
    collection.sent.pnus.every((p) => pnus.includes(p));
  if (collection && !fresh && pnus.length) checks.push('대상 필지가 바뀌었습니다. 다시 가져오세요');
  if (collection && fresh && radius > collection.radius + 1e-9)
    checks.push(
      `주변 반경 ${radius} m가 가져온 범위 ${collection.radius} m보다 큽니다. 다시 가져오세요`,
    );
  const copy = fresh ? collection : null;
  const copies: Record<string, Snapshot<unknown> | undefined> = copy
    ? {
        target: copy.target,
        landCharacteristics: copy.landCharacteristics,
        landUse: copy.landUse,
        parcels: copy.parcels,
        buildings: copy.buildings,
        buildingInfo: copy.buildingInfo,
        register: copy.register,
      }
    : {};
  for (const key of Object.keys(SOURCE_NAME)) {
    const row = sourceRow(key, copies[key]);
    sources.push(row);
    if (row.status === 'check' && row.checks) checks.push(`${row.name}: ${row.checks}`);
    if (row.status === 'failed' || row.status === 'no-key')
      checks.push(`${row.name}: ${row.text} — SHP 넣기 또는 사람 입력으로 보완하세요`);
  }

  // Target parcels: the public copy, else the 연속지적도 SHP.
  const official = new Map(
    (copy?.landCharacteristics.items ?? []).map((row) => [row.pnu, row] as const),
  );
  const parcelOf = (
    pnu: string,
    address: string | null,
    category: string | null,
    areas: Area[],
    source: string,
    fetchedAt: string | null,
  ): SiteParcel => ({
    key: `parcel:${pnu}`,
    pnu,
    lot: lotOf(pnu),
    address,
    landCategory: category ?? official.get(pnu)?.landCategory ?? null,
    road: (category ?? official.get(pnu)?.landCategory) === '도',
    officialArea: official.get(pnu)?.officialArea ?? null,
    computedArea: round(areaOfAreas(areas), 2),
    areas,
    source,
    fetchedAt,
  });
  const publicName = '공공 자료 · 브이월드 연속지적';
  const targets: SiteParcel[] = [];
  for (const pnu of pnus) {
    const item = copy?.target.items.find((p) => p.pnu === pnu);
    if (item) {
      targets.push(
        parcelOf(
          pnu,
          item.address,
          item.landCategory,
          areasOf(item.polygons),
          publicName,
          copy!.fetchedAt,
        ),
      );
      continue;
    }
    for (const layer of shpLayers(shp, 'parcel')) {
      const feature = layer.features.find((f) => f.parcel?.pnu === pnu);
      if (!feature || feature.geometry.kind !== 'polygon') continue;
      const areas = areasOf(
        feature.geometry.polygons.map((p) =>
          [p.outer, ...p.holes].map((r) => r.map((q) => toSurvey(shp!, q))),
        ),
      );
      const jibun = feature.parcel?.jibun ?? null;
      targets.push(
        parcelOf(
          pnu,
          jibun,
          jibun ? (/[가-힣]+$/.exec(jibun)?.[0] ?? null) : null,
          areas,
          `넣은 SHP · ${layer.file}`,
          shp!.importedAt,
        ),
      );
      break;
    }
  }
  const missing = pnus.filter((pnu) => !targets.some((t) => t.pnu === pnu));
  if (missing.length)
    checks.push(`대상 필지 경계 없음: ${missing.map((p) => `${lotOf(p)}(${p})`).join(', ')}`);

  // The surrounding box: target bounds + radius.
  const targetBounds = boundsOfRings(targets.flatMap((t) => t.areas.map((a) => a.outer)));
  const box: Bounds2 | null = targetBounds
    ? {
        minX: targetBounds.minX - radius,
        minY: targetBounds.minY - radius,
        maxX: targetBounds.maxX + radius,
        maxY: targetBounds.maxY + radius,
      }
    : null;
  const near = (rings: XY[][]) => !!box && touchesBox(rings, box);

  // Surrounding parcels (roads included): public, else SHP.
  let parcels: SiteParcel[] = [];
  if (copy && usable(copy.parcels))
    parcels = copy.parcels.items
      .filter((p) => !pnus.includes(p.pnu))
      .map((p) =>
        parcelOf(p.pnu, p.address, p.landCategory, areasOf(p.polygons), publicName, copy.fetchedAt),
      );
  else
    for (const layer of shpLayers(shp, 'parcel'))
      for (const f of layer.features) {
        const pnu = f.parcel?.pnu;
        if (!pnu || pnus.includes(pnu) || f.geometry.kind !== 'polygon') continue;
        const areas = areasOf(
          f.geometry.polygons.map((p) =>
            [p.outer, ...p.holes].map((r) => r.map((q) => toSurvey(shp!, q))),
          ),
        );
        const jibun = f.parcel?.jibun ?? null;
        parcels.push(
          parcelOf(
            pnu,
            jibun,
            jibun ? (/[가-힣]+$/.exec(jibun)?.[0] ?? null) : null,
            areas,
            `넣은 SHP · ${layer.file}`,
            shp!.importedAt,
          ),
        );
      }
  parcels = parcels.filter((p) => near(p.areas.map((a) => a.outer)));
  if (!copy && parcels.length)
    sources.push(shpRow('parcels-shp', '주변 필지 (넣은 SHP)', parcels.length));

  // Buildings: public (heights joined by the collector), else the 수치지형도 SHP.
  let buildings: SiteBuilding[] = [];
  if (copy && usable(copy.buildings))
    buildings = copy.buildings.items.map((b) => ({
      key: `bldg:${keyPart(b.id)}`,
      id: b.id,
      pnu: b.pnu,
      name: [b.name, b.dongName].filter(Boolean).join(' ') || null,
      floors: b.floorsAbove,
      height: b.height,
      heightFrom:
        b.heightSource === 'vworld-building-info'
          ? '건물 정보'
          : b.heightSource === 'building-register'
            ? '대장'
            : null,
      use: b.mainUse,
      wallless: false,
      areas: areasOf(b.polygons),
      source: '공공 자료 · 브이월드 건물',
      fetchedAt: copy.fetchedAt,
    }));
  else {
    for (const layer of shpLayers(shp, 'building'))
      for (const f of layer.features) {
        if (f.geometry.kind !== 'polygon') continue;
        buildings.push({
          key: `bldg:shp-${keyPart(layer.file).slice(0, 24)}-${f.index}`,
          id: `${layer.file}#${f.index}`,
          pnu: null,
          name: f.building?.name ?? null,
          floors: f.building?.floors ?? null,
          height: null,
          heightFrom: null,
          use: f.building?.use ?? null,
          wallless: !!f.building?.wallless,
          areas: areasOf(
            f.geometry.polygons.map((p) =>
              [p.outer, ...p.holes].map((r) => r.map((q) => toSurvey(shp!, q))),
            ),
          ),
          source: `넣은 SHP · ${layer.file}`,
          fetchedAt: shp!.importedAt,
        });
      }
    if (buildings.length)
      sources.push(shpRow('buildings-shp', '주변 건물 (넣은 수치지형도 SHP)', buildings.length));
  }
  buildings = buildings.filter((b) => b.areas.length && near(b.areas.map((a) => a.outer)));

  // Road boundaries, contours and spot heights: SHP only.
  const roadLines: CollectOutput['roadLines'] = [];
  for (const layer of shpLayers(shp, 'road-boundary'))
    for (const f of layer.features) {
      const lines =
        f.geometry.kind === 'polyline'
          ? f.geometry.lines
          : f.geometry.kind === 'polygon'
            ? f.geometry.polygons.flatMap((p) => [p.outer, ...p.holes].map((r) => [...r, r[0]]))
            : [];
      lines.forEach((line, i) => {
        const pts = line.map((q) => toSurvey(shp!, q));
        if (pts.length >= 2 && near([pts]))
          roadLines.push({
            key: `roadline:${keyPart(layer.file).slice(0, 24)}-${f.index}-${i}`,
            line: pts,
            source: `넣은 SHP · ${layer.file}`,
          });
      });
    }
  const contours: CollectOutput['contours'] = [];
  for (const layer of shpLayers(shp, 'contour'))
    for (const f of layer.features) {
      if (f.geometry.kind !== 'polyline') continue;
      f.geometry.lines.forEach((line, i) => {
        const z = f.elevation ?? line[0]?.[2] ?? null;
        const pts = line.map((q) => toSurvey(shp!, q));
        if (z !== null && Number.isFinite(z) && pts.length >= 2 && near([pts]))
          contours.push({
            key: `contour:${keyPart(layer.file).slice(0, 24)}-${f.index}-${i}`,
            z,
            line: pts,
          });
      });
    }
  const spots: CollectOutput['spots'] = [];
  for (const layer of shpLayers(shp, 'spot-height'))
    for (const f of layer.features) {
      if (f.geometry.kind !== 'point') continue;
      f.geometry.points.forEach((p, i) => {
        const z = f.elevation ?? p[2];
        const at = toSurvey(shp!, p);
        if (Number.isFinite(z) && near([[at]]))
          spots.push({ key: `spot:${keyPart(layer.file).slice(0, 24)}-${f.index}-${i}`, z, at });
      });
    }
  if (shp)
    for (const layer of shp.layers)
      for (const warning of layer.warnings) checks.push(`SHP ${layer.file}: ${warning}`);

  const landUse = (copy?.landUse.items ?? []).map((use) => ({
    pnu: use.pnu,
    entries: use.entries.map((e) => ({
      name: e.name,
      code: e.code,
      conflict: e.conflict,
      notices: e.notices.map((n) => `${n.year}-${n.number}`).join(', '),
    })),
    districtPlans: use.districtPlans.map((d) => d.name),
  }));
  if (copy && !landUse.some((u) => u.entries.length)) checks.push('용도지역 미확인');

  return {
    crs: 'EPSG:5186',
    fetchedAt: copy?.fetchedAt ?? null,
    radius: Math.min(radius, copy?.radius ?? radius),
    // A missing target boundary stops the steps after this one (gate non-empty on `targets`).
    targets: missing.length ? [] : targets,
    found: targets,
    parcels,
    buildings,
    landUse,
    roadLines,
    contours,
    spots,
    sources,
    checks: [...new Set(checks)],
    missing,
    blocked: !targets.length || missing.length > 0,
  };
}

const shpRow = (key: string, name: string, count: number): SourceRow => ({
  key,
  name,
  status: 'shp',
  text: STATUS_TEXT.shp,
  count,
  fetchedAt: null,
  checks: '',
});

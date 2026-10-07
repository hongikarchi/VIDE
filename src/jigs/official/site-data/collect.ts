// 수집 (SPEC-12.4·12.5 '수집' 단계): the confirmed target parcels and everything within the
// surrounding radius, each source as its own read-copy (`Snapshot`). A source that fails or has no
// key leaves only its own copy empty with the reason; the others go on (SPEC-12.16). Nothing is
// sent to a different source when one fails. Empty answers, missed pages, a target missing from
// the box and an area gap over 5% become '확인 필요' lines instead of passing as success.

import { SiteDataError, nowIso, type SiteDataContext } from './http.ts';
import {
  boundsOf,
  distance,
  expandBounds,
  interiorPoint,
  unionBounds,
  type Bounds,
  type Position,
} from './geometry.ts';
import { isPnu, lotLabel } from './pnu.ts';
import { Recorder, failedSnapshot, snapshot, type Snapshot } from './snapshot.ts';
import { registerHeight, registerTitles, type RegisterTitle } from './sources/building-register.ts';
import {
  buildingInfoInBox,
  joinBuildingInfo,
  type BuildingInfo,
} from './sources/vworld-building-info.ts';
import { buildingsInBox, type Building } from './sources/vworld-buildings.ts';
import { parcelByPnu, parcelsInBox, type Parcel } from './sources/vworld-cadastral.ts';
import { CRS } from './sources/vworld-data.ts';
import {
  landCharacteristics,
  type LandCharacteristics,
} from './sources/vworld-land-characteristics.ts';
import { landUse, type LandUse } from './sources/vworld-land-use.ts';

export const RADIUS = { default: 200, min: 50, max: 600 } as const;

export interface CollectOptions {
  /** Confirmed target PNUs (합필: several). */
  pnus: string[];
  /** 주변 반경 m (SPEC-12.4: default 200, 50–600). */
  radius?: number;
  /** At most this many parcels are asked for register titles (targets first). */
  registerLimit?: number;
  /** Area gap that makes the target '확인 필요' (default 5%). */
  areaTolerance?: number;
}

export interface SiteCollection {
  crs: typeof CRS;
  fetchedAt: string;
  /** What went to the public services (FR-18): PNUs and the coordinate box. */
  sent: { pnus: string[]; radius: number; box: Bounds | null };
  target: Snapshot<Parcel>;
  landCharacteristics: Snapshot<LandCharacteristics>;
  landUse: Snapshot<LandUse>;
  /** Every parcel in the box (targets included; 도로 = landCategory '도'). */
  parcels: Snapshot<Parcel>;
  buildings: Snapshot<Building>;
  buildingInfo: Snapshot<BuildingInfo>;
  register: Snapshot<RegisterTitle>;
  /** A target boundary is missing: later steps stop (SPEC-12.4 표). */
  blocked: boolean;
  /** Every '확인 필요' line of the copies, for the summary. */
  checks: string[];
}

/** A copy not read because the target boundary is missing; a keyless or failed target passes on. */
function skipped<T>(recorder: Recorder, fetchedAt: string, target: Snapshot<Parcel>): Snapshot<T> {
  const copy = snapshot<T>(recorder, fetchedAt, [], [], []);
  if (target.status === 'no-key' || target.status === 'failed')
    return { ...copy, status: target.status, ...(target.reason ? { reason: target.reason } : {}) };
  return { ...copy, status: 'check', checks: ['대상 필지 경계가 없어 조회하지 않음'] };
}

async function read<T>(
  recorder: Recorder,
  fetchedAt: string,
  run: () => Promise<{ items: T[]; ids: string[]; checks: string[] }>,
  crs?: string,
): Promise<Snapshot<T>> {
  try {
    const { items, ids, checks } = await run();
    return snapshot(recorder, fetchedAt, items, ids, checks, crs);
  } catch (error) {
    return failedSnapshot<T>(recorder, fetchedAt, error);
  }
}

export async function collectSite(
  context: SiteDataContext,
  options: CollectOptions,
): Promise<SiteCollection> {
  const pnus = [...new Set(options.pnus.map((pnu) => pnu.trim()))];
  if (!pnus.length || !pnus.every(isPnu))
    throw new SiteDataError('BAD_RESPONSE', 'vworld-cadastral', 'pnu');
  const radius = Math.min(RADIUS.max, Math.max(RADIUS.min, options.radius ?? RADIUS.default));
  const tolerance = options.areaTolerance ?? 0.05;
  const fetchedAt = nowIso(context);
  const year = new Date(fetchedAt).getUTCFullYear();

  // 대상 필지
  const targetRecorder = new Recorder('vworld-cadastral');
  const target = await read<Parcel>(
    targetRecorder,
    fetchedAt,
    async () => {
      const items: Parcel[] = [];
      const checks: string[] = [];
      for (const pnu of pnus) {
        const parcel = await parcelByPnu(context, targetRecorder, pnu);
        if (parcel) items.push(parcel);
        else checks.push(`대상 필지 ${pnu}(${lotLabel(pnu)})가 연속지적에 없음`);
      }
      return { items, ids: items.map((p) => p.pnu), checks };
    },
    CRS,
  );
  const targets = target.items;
  const blocked = targets.length < pnus.length;
  const box = targets.length
    ? expandBounds(unionBounds(targets.map((p) => boundsOf(p.polygons))), radius)
    : null;
  const center: Position | null = targets.length ? interiorPoint(targets[0].polygons) : null;

  // 공부 면적·지목 and the area check against the cadastre polygons
  const landRecorder = new Recorder('vworld-land-characteristics');
  const land = await read<LandCharacteristics>(landRecorder, fetchedAt, async () => {
    const items: LandCharacteristics[] = [];
    const checks: string[] = [];
    for (const pnu of pnus) {
      const row = await landCharacteristics(context, landRecorder, pnu, year);
      if (row) items.push(row);
      if (!row?.officialArea) checks.push(`${lotLabel(pnu)}: 공부 면적 없음`);
    }
    return { items, ids: items.map((row) => row.pnu), checks };
  });
  if (land.status !== 'failed' && land.status !== 'no-key' && targets.length === pnus.length) {
    const official = land.items.reduce((sum, row) => sum + (row.officialArea ?? 0), 0);
    const computed = targets.reduce((sum, parcel) => sum + parcel.computedArea, 0);
    if (official > 0 && Math.abs(computed - official) / official > tolerance) {
      const gap = (((computed - official) / official) * 100).toFixed(1);
      target.checks.push(
        `대지면적 차이 ${gap}% (공부 ${official.toFixed(1)} m², 계산 ${computed.toFixed(1)} m²)`,
      );
      target.status = target.status === 'ok' ? 'check' : target.status;
    }
  }

  // 용도지역·지구·구역 per target parcel
  const useRecorder = new Recorder('vworld-land-use');
  const uses = targets.length
    ? await read<LandUse>(useRecorder, fetchedAt, async () => {
        const items: LandUse[] = [];
        const checks: string[] = [];
        for (const parcel of targets) {
          const { landUse: use, total } = await landUse(
            context,
            useRecorder,
            parcel.pnu,
            parcel.polygons,
          );
          items.push(use);
          if (!total) checks.push(`${lotLabel(parcel.pnu)}: 토지이용계획 속성 0건`);
          if (!use.entries.length) checks.push(`${lotLabel(parcel.pnu)}: 용도지역 미확인`);
        }
        return { items, ids: items.map((use) => use.pnu), checks };
      })
    : skipped<LandUse>(useRecorder, fetchedAt, target);

  // 주변 필지 (도로 필지 포함)
  const parcelRecorder = new Recorder('vworld-cadastral');
  const parcels = box
    ? await read<Parcel>(
        parcelRecorder,
        fetchedAt,
        async () => {
          const { parcels: items, checks } = await parcelsInBox(context, parcelRecorder, box);
          const missing = targets.filter((t) => !items.some((p) => p.pnu === t.pnu));
          if (missing.length)
            checks.push(`범위 조회에 대상 필지가 없음: ${missing.map((p) => p.pnu).join(', ')}`);
          return { items, ids: items.map((p) => p.pnu), checks };
        },
        CRS,
      )
    : skipped<Parcel>(parcelRecorder, fetchedAt, target);

  // 주변 건물 and their heights (건물 정보 → 대장 → 층수만)
  const buildingRecorder = new Recorder('vworld-buildings');
  const buildings = box
    ? await read<Building>(
        buildingRecorder,
        fetchedAt,
        async () => {
          const { buildings: items, checks } = await buildingsInBox(context, buildingRecorder, box);
          return { items, ids: items.map((b) => b.id), checks };
        },
        CRS,
      )
    : skipped<Building>(buildingRecorder, fetchedAt, target);
  const infoRecorder = new Recorder('vworld-building-info');
  const buildingInfo = box
    ? await read<BuildingInfo>(
        infoRecorder,
        fetchedAt,
        async () => {
          const { info, checks } = await buildingInfoInBox(context, infoRecorder, box);
          return { items: info, ids: info.map((b) => b.id), checks };
        },
        CRS,
      )
    : skipped<BuildingInfo>(infoRecorder, fetchedAt, target);
  joinBuildingInfo(buildings.items, buildingInfo.items);

  // 건축물대장 표제부: the targets, then the nearest parcels whose buildings still lack a height
  const registerRecorder = new Recorder('building-register');
  const wanted = [...pnus];
  const waiting = buildings.items
    .filter((b) => b.height === null && b.pnu)
    .map((b) => ({ pnu: b.pnu!, far: center ? distance(center, interiorPoint(b.polygons)) : 0 }))
    .sort((a, b) => a.far - b.far);
  for (const { pnu } of waiting) if (!wanted.includes(pnu)) wanted.push(pnu);
  const limit = Math.max(pnus.length, options.registerLimit ?? 40);
  const register = await read<RegisterTitle>(registerRecorder, fetchedAt, async () => {
    const items: RegisterTitle[] = [];
    const checks: string[] = [];
    for (const pnu of wanted.slice(0, limit)) {
      const { titles, total, received } = await registerTitles(context, registerRecorder, pnu);
      items.push(...titles);
      if (received < total)
        checks.push(`${lotLabel(pnu)}: 대장 ${total}건 중 ${received}건만 받음`);
      if (pnus.includes(pnu) && !titles.length)
        checks.push(`${lotLabel(pnu)}: 건축물대장 없음(나대지일 수 있음)`);
    }
    if (wanted.length > limit)
      checks.push(
        `대장 조회 상한 ${limit}필지 — 나머지 ${wanted.length - limit}필지는 층수로 추정`,
      );
    return { items, ids: items.map((t) => t.pk ?? t.pnu), checks };
  });
  for (const building of buildings.items) {
    if (building.height !== null || !building.pnu) continue;
    const title = registerHeight(
      register.items.filter((t) => t.pnu === building.pnu),
      building.dongName,
    );
    if (!title) continue;
    building.height = title.height;
    building.heightSource = 'building-register';
    building.floorsBelow ??= title.floorsBelow;
    building.mainUse ??= title.mainUse;
  }

  const copies = [target, land, uses, parcels, buildings, buildingInfo, register];
  return {
    crs: CRS,
    fetchedAt,
    sent: { pnus, radius, box },
    target,
    landCharacteristics: land,
    landUse: uses,
    parcels,
    buildings,
    buildingInfo,
    register,
    blocked,
    checks: copies.flatMap((copy) => copy.checks),
  };
}

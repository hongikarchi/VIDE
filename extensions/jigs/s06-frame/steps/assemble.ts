// S-06 frame jig ⓪ 입력 조립 (PLAN-23 T-051, SPEC-06.10, SPEC-07.5): the roles a person confirmed
// (or the rule and AI proposals still to confirm) are read as geometry by code. Which layer plays
// which role is decided outside this step — layer-name rules and the one-shot AI proposal of the
// runtime, then the role cards — so this step only extracts and reports: what each role holds, the
// slab region, the existing footings and their frame angle, the basin bands, grid and joint lines,
// and grid crossings without a footing ('모델 누락 가능', a warning layer, never a silent merge).
// A role that is missing or unreadable is named with the reason; nothing is invented for it.

import {
  pointInPolygon,
  polygonArea,
  type Vec2,
} from '../../../../src/jigs/official/geometry-kit/index.ts';
import {
  ROLE_IDS,
  ROLE_TITLE,
  bandsOf,
  dominantAngle,
  footprintsOf,
  frameFrom,
  layerOf,
  linesOf,
  slabOf,
  toLocal,
  undersideSampler,
  type Frame,
  type LineShape,
  type RoleId,
  type RoleRows,
  type SiteInput,
  type ZoneInput,
} from './roles.ts';

export interface AssembleInputs {
  site: SiteInput;
  fireRoute?: ZoneInput[];
  requestedZones?: ZoneInput[];
}
export interface AssembleParams {
  /** Where the (u, v) frame comes from: the existing footings, the existing grid lines, or `gridAngle`. */
  gridAngleSource: 'footings' | 'grid' | 'manual';
  gridAngle: number;
  /** A grid crossing with no existing footing within this distance (m) is '모델 누락 가능'. */
  missingReach: number;
}
export interface RoleReport {
  role: RoleId;
  title: string;
  present: boolean;
  count: number;
  layers: string[];
  readable: number;
  unreadable: number;
  reasons: string[];
  /** One line about what the code read (sizes, angle, area). */
  summary: string;
}
export interface AssembleOutput {
  schema: 'vide.s06.assemble/1';
  roles: RoleReport[];
  slab: {
    polygon: Vec2[];
    holes: Vec2[][];
    area_m2: number;
    z: [number, number];
    source: 'curve' | 'mesh';
    underside: 'mesh' | 'curve' | 'none';
  } | null;
  frame: Frame;
  existing: {
    count: number;
    readable: number;
    angleDeg: number | null;
    topZ: number | null;
    side_m: number | null;
  };
  basin: { count: number; readable: number };
  grid: {
    lines: {
      key: string;
      name: string;
      family: 'u' | 'v' | 'other';
      line: [number, number, number][];
    }[];
  };
  joints: {
    newEJ: { key: string; name: string; line: [number, number, number][] }[];
    existingEJ: { key: string; name: string; line: [number, number, number][] }[];
  };
  /** Grid crossings inside the footing extent without a footing near: shown, listed, not merged. */
  possibleMissing: {
    key: string;
    at: [number, number, number];
    nearest_m: number | null;
    grid: string;
  }[];
  zones: { fireRoute: number; requestedZones: number };
  notes: string[];
}

export const DEFAULT_ASSEMBLE_PARAMS: AssembleParams = {
  gridAngleSource: 'footings',
  gridAngle: 0,
  missingReach: 1.0,
};

const round = (v: number, digits = 3) => Number(v.toFixed(digits));
const family = (line: LineShape, frame: Frame): 'u' | 'v' | 'other' => {
  const dx = line.b[0] - line.a[0],
    dy = line.b[1] - line.a[1];
  const along = Math.abs(dx * frame.u[0] + dy * frame.u[1]);
  const across = Math.abs(dx * frame.v[0] + dy * frame.v[1]);
  const length = Math.hypot(dx, dy);
  // Within 15° of an axis; grid lines along u are constant in v ('v' family) and the reverse.
  if (along / length > Math.cos((15 * Math.PI) / 180)) return 'v';
  if (across / length > Math.cos((15 * Math.PI) / 180)) return 'u';
  return 'other';
};
const line3 = (line: LineShape): [number, number, number][] => [
  [line.a[0], line.a[1], line.z],
  [line.b[0], line.b[1], line.z],
];

/** Intersection of two plan lines (a→b, c→d), or null when parallel. */
function crossing(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    vx = d[0] - c[0],
    vy = d[1] - c[1];
  const den = ux * vy - uy * vx;
  if (Math.abs(den) < 1e-12) return null;
  const wx = c[0] - a[0],
    wy = c[1] - a[1];
  const s = (wx * vy - wy * vx) / den;
  return [a[0] + s * ux, a[1] + s * uy];
}

export function assemble(
  inputs: AssembleInputs,
  params: Partial<AssembleParams> = {},
): AssembleOutput {
  const p = { ...DEFAULT_ASSEMBLE_PARAMS, ...params };
  if (!Number.isFinite(p.gridAngle)) throw new RangeError('gridAngle must be a number');
  if (!Number.isFinite(p.missingReach) || p.missingReach < 0)
    throw new RangeError('missingReach must be a length');
  const site = inputs.site ?? {};
  const notes: string[] = [];
  const report = new Map<RoleId, RoleReport>();
  for (const role of ROLE_IDS) {
    const data: RoleRows | undefined = site[role];
    const rows = data?.rows ?? [];
    report.set(role, {
      role,
      title: ROLE_TITLE[role],
      present: !!data,
      count: rows.length,
      layers: [...new Set(rows.map((row) => layerOf(row)))],
      readable: 0,
      unreadable: 0,
      reasons: [],
      summary: data ? (rows.length ? '' : '지정한 레이어에 객체가 없습니다') : '지정하지 않음',
    });
  }
  const done = (
    role: RoleId,
    readable: number,
    unreadable: { reason: string }[],
    summary: string,
  ) => {
    const entry = report.get(role)!;
    entry.readable = readable;
    entry.unreadable = unreadable.length;
    entry.reasons = [...new Set(unreadable.map((u) => u.reason))];
    if (entry.present && entry.count) entry.summary = summary;
  };

  // Slab region and underside.
  const slab = slabOf(site.slab, site.voids);
  notes.push(...slab.notes);
  const region = slab.region;
  const underside = undersideSampler(site.slab);
  done(
    'slab',
    region ? 1 + region.others : 0,
    [],
    region
      ? `${region.source === 'mesh' ? '솔리드 윗면 외곽' : '닫힌 곡선'} · ${round(region.area, 1)} ㎡ · 보이드 ${region.holes.length}개`
      : '경계를 읽지 못함',
  );
  if (site.voids)
    done('voids', region?.holes.length ?? 0, [], `구멍 ${region?.holes.length ?? 0}개`);

  // Existing footings: the base band of every block; their angle is the frame's first choice.
  const existing = footprintsOf('existingFootings', site.existingFootings, 'base');
  const angles = existing.shapes.map((s) => s.angleDeg);
  const existingAngle = dominantAngle(angles);
  const solids = footprintsOf('existingFootings', site.existingFootings, 'solid');
  const topZ = solids.shapes.length ? Math.max(...solids.shapes.map((s) => s.z[1])) : null;
  const sides = existing.shapes.map((s) => Math.sqrt(polygonArea(s.hull))).sort((a, b) => a - b);
  const side = sides.length ? sides[Math.floor((sides.length - 1) / 2)] : null;
  done(
    'existingFootings',
    existing.shapes.length,
    existing.unreadable,
    `발자국 ${existing.shapes.length}개 · 한 변 약 ${side === null ? '—' : round(side, 2)} m · 회전 ${existingAngle === null ? '—' : round(existingAngle, 1)}°`,
  );
  if (existing.unreadable.length)
    notes.push(
      `기존 기초 ${existing.unreadable.length}개는 형상을 읽지 못했습니다(${[...new Set(existing.unreadable.map((u) => u.reason))].join(', ')}). 회전 없는 경계 상자로 대신하지 않습니다.`,
    );

  const basin = bandsOf('basinGirders', site.basinGirders);
  done('basinGirders', basin.shapes.length, basin.unreadable, `평면 띠 ${basin.shapes.length}개`);

  // Frame: footings, grid lines or a set angle. The origin is the slab's first vertex (or 0, 0).
  const grid = linesOf('existingGrid', site.existingGrid, 'X');
  const gridAngle = dominantAngle(
    grid.lines.map(
      (line) => (Math.atan2(line.b[1] - line.a[1], line.b[0] - line.a[0]) * 180) / Math.PI,
    ),
  );
  const origin: Vec2 = region ? [region.outer[0][0], region.outer[0][1]] : [0, 0];
  let frame: Frame;
  if (p.gridAngleSource === 'manual') frame = frameFrom(origin, p.gridAngle, 'manual');
  else if (p.gridAngleSource === 'grid' && gridAngle !== null)
    frame = frameFrom(origin, gridAngle, 'grid');
  else if (p.gridAngleSource === 'grid') {
    frame = frameFrom(
      origin,
      existingAngle ?? p.gridAngle,
      existingAngle === null ? 'none' : 'footings',
    );
    notes.push('기존 그리드 선이 없어 기존 기초의 회전으로 (u, v)를 잡았습니다.');
  } else if (existingAngle !== null) frame = frameFrom(origin, existingAngle, 'footings');
  else if (gridAngle !== null) {
    frame = frameFrom(origin, gridAngle, 'grid');
    notes.push('기존 기초를 읽지 못해 기존 그리드 선의 방향으로 (u, v)를 잡았습니다.');
  } else {
    frame = frameFrom(origin, p.gridAngle, 'none');
    notes.push('기존 기초도 그리드도 없어 설정값 각도로 (u, v)를 잡았습니다.');
  }
  const gridLines = grid.lines.map((line) => ({
    key: line.key,
    name: line.name,
    family: family(line, frame),
    line: line3(line),
  }));
  done(
    'existingGrid',
    grid.lines.length,
    grid.unreadable,
    `선 ${grid.lines.length}개(${gridLines.filter((l) => l.family === 'u').length} + ${gridLines.filter((l) => l.family === 'v').length})`,
  );

  const newEJ = linesOf('newEJ', site.newEJ, 'EJ');
  const existingEJ = linesOf('existingEJ', site.existingEJ, 'XEJ');
  done('newEJ', newEJ.lines.length, newEJ.unreadable, `선 ${newEJ.lines.length}개`);
  done(
    'existingEJ',
    existingEJ.lines.length,
    existingEJ.unreadable,
    `선 ${existingEJ.lines.length}개`,
  );
  for (const role of ['columns', 'girders', 'newFootings'] as const) {
    const rows = site[role]?.rows ?? [];
    done(role, rows.length, [], `객체 ${rows.length}개(진단에 씀)`);
  }
  if (newEJ.lines.some((l) => l.bent) || existingEJ.lines.some((l) => l.bent))
    notes.push('꺾인 E.J. 선은 양 끝만 읽어 직선으로 씁니다.');

  // Grid crossings inside the footing extent without a footing near them.
  const possibleMissing: AssembleOutput['possibleMissing'] = [];
  const uLines = grid.lines.filter((l) => family(l, frame) === 'u');
  const vLines = grid.lines.filter((l) => family(l, frame) === 'v');
  if (uLines.length && vLines.length && existing.shapes.length) {
    const centers = existing.shapes.map((s) => s.center);
    const local = centers.map((c) => toLocal(frame, c));
    const margin = (side ?? 2) / 2;
    const uMin = Math.min(...local.map((c) => c[0])) - margin,
      uMax = Math.max(...local.map((c) => c[0])) + margin,
      vMin = Math.min(...local.map((c) => c[1])) - margin,
      vMax = Math.max(...local.map((c) => c[1])) + margin;
    for (const lu of uLines)
      for (const lv of vLines) {
        const at = crossing(lu.a, lu.b, lv.a, lv.b);
        if (!at) continue;
        const [u, v] = toLocal(frame, at);
        if (u < uMin || u > uMax || v < vMin || v > vMax) continue;
        if (region && !pointInPolygon(at, region.outer, 0)) continue;
        let nearest = Infinity;
        for (const c of centers)
          nearest = Math.min(nearest, Math.hypot(c[0] - at[0], c[1] - at[1]));
        if (nearest <= p.missingReach) continue;
        possibleMissing.push({
          key: `M:${lu.name}-${lv.name}`,
          at: [at[0], at[1], topZ ?? 0],
          nearest_m: Number.isFinite(nearest) ? round(nearest) : null,
          grid: `${lu.name} × ${lv.name}`,
        });
      }
    if (possibleMissing.length)
      notes.push(
        `기존 그리드 교점 ${possibleMissing.length}곳에 기존 기초가 없습니다(${p.missingReach} m 안). 모델 누락 가능 — 토목사무소 확인 목록에 올립니다.`,
      );
  }

  return {
    schema: 'vide.s06.assemble/1',
    roles: [...report.values()],
    slab: region
      ? {
          polygon: region.outer,
          holes: region.holes,
          area_m2: round(region.area, 3),
          z: region.z,
          source: region.source,
          underside: underside.kind,
        }
      : null,
    frame,
    existing: {
      count: (site.existingFootings?.rows ?? []).length,
      readable: existing.shapes.length,
      angleDeg: existingAngle === null ? null : round(existingAngle, 3),
      topZ: topZ === null ? null : round(topZ),
      side_m: side === null ? null : round(side),
    },
    basin: { count: (site.basinGirders?.rows ?? []).length, readable: basin.shapes.length },
    grid: { lines: gridLines },
    joints: {
      newEJ: newEJ.lines.map((l) => ({ key: l.key, name: l.name, line: line3(l) })),
      existingEJ: existingEJ.lines.map((l) => ({ key: l.key, name: l.name, line: line3(l) })),
    },
    possibleMissing,
    zones: {
      fireRoute: inputs.fireRoute?.length ?? 0,
      requestedZones: inputs.requestedZones?.length ?? 0,
    },
    notes,
  };
}

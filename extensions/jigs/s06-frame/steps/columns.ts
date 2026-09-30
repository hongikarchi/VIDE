// S-06 frame jig ③ 기둥 (PLAN-23 T-051, SPEC-06.11 1·7·8, 결정 F2.6·F2.9·F2.11): the columns of
// the chosen layout — inside the slab, outside the fire route — with twin columns on a common cap
// at every new expansion joint, the requested zones judged, and heights: bottom on the existing
// footing top, girder top on the slab underside, the column length floored to whole steps so no
// steel pierces the slab; the rest is a bearing gap shown in a table. Overrides a person made
// (move, add, remove by stable key) apply after every recompute (SPEC-07.8).

import {
  pointInPolygon,
  type Vec2,
  type Vec3,
} from '../../../../src/jigs/official/geometry-kit/index.ts';
import type { AssembleOutput } from './assemble.ts';
import type { AxesOutput } from './axes.ts';
import { undersideSampler, type SiteInput, type ZoneInput } from './roles.ts';

export interface ColumnsInputs {
  site: SiteInput;
  fireRoute?: ZoneInput[];
  requestedZones?: ZoneInput[];
  steps: { axes: AxesOutput; assemble: AssembleOutput };
}
export interface ColumnsParams {
  columnSize: number;
  heightStep: number;
  depthMax: number;
  baseSource: 'footings' | 'manual';
  baseLevel: number;
  topSource: 'slab' | 'manual';
  girderTopLevel: number;
  ejDetail: 'twin' | 'single';
  ejWidth: number;
}
export const DEFAULT_COLUMNS_PARAMS: ColumnsParams = {
  columnSize: 0.5,
  heightStep: 1.0,
  depthMax: 0.9,
  baseSource: 'footings',
  baseLevel: 0,
  topSource: 'slab',
  girderTopLevel: 6,
  ejDetail: 'twin',
  ejWidth: 0.6,
};
export interface Override {
  target: { kind: string; identity: Record<string, string | number> };
  op: 'move' | 'add' | 'remove' | 'set' | 'pin';
  fields: Record<string, unknown>;
}

export interface ColumnRow {
  key: string;
  mark: string;
  at: Vec2;
  bottom: Vec3;
  top: Vec3;
  line: [Vec3, Vec3];
  length: number;
  girderTop: number;
  girderBottom: number;
  gap: number;
  /** Strong axis direction (deg from +x): the main girder direction of the layout. */
  strongAxisDeg: number;
  lineU?: string;
  lineV?: string;
  pair?: string;
  verdict: 'pass' | 'incomplete';
  judgement: string;
  reason?: string;
  overridden?: Override['op'];
}
export interface PairRow {
  key: string;
  ej: string;
  axis: string;
  at: Vec2;
  spacing: number;
  /** Unit direction from column a to column b (normal to the joint). */
  across: Vec2;
  columns: string[];
  replaced: string[];
}
export interface ColumnsOutput {
  schema: 'vide.s06.columns/1';
  columns: ColumnRow[];
  heights: {
    key: string;
    bottom: number;
    top: number;
    length: number;
    girderTop: number;
    girderBottom: number;
    gap: number;
    judgement: string;
  }[];
  pairs: PairRow[];
  requested: {
    key: string;
    zone: string;
    columns: number;
    verdict: 'pass' | 'review';
    judgement: string;
    reason: string;
  }[];
  fireConflicts: { key: string; zone: string }[];
  site: { polygon: Vec2[] };
  base: { z: number; source: 'footings' | 'manual' };
  count: number;
  notes: string[];
}

const round = (v: number, digits = 3) => Number(v.toFixed(digits));
const distance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);

function resolveParams(params: Partial<ColumnsParams>): ColumnsParams {
  const out = { ...DEFAULT_COLUMNS_PARAMS };
  for (const key of Object.keys(DEFAULT_COLUMNS_PARAMS) as (keyof ColumnsParams)[])
    if (params[key] !== undefined) Object.assign(out, { [key]: params[key] });
  for (const key of ['columnSize', 'heightStep', 'depthMax', 'ejWidth'] as const)
    if (!Number.isFinite(out[key]) || out[key] <= 0)
      throw new RangeError(`${key} ${String(out[key])}`);
  for (const key of ['baseLevel', 'girderTopLevel'] as const)
    if (!Number.isFinite(out[key])) throw new RangeError(`${key} ${String(out[key])}`);
  return out;
}
/** Intersection parameter (s along a→b) of two plan lines, or null when parallel. */
function crossing(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { s: number; t: number; at: Vec2 } | null {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    vx = d[0] - c[0],
    vy = d[1] - c[1];
  const den = ux * vy - uy * vx;
  if (Math.abs(den) < 1e-12) return null;
  const wx = c[0] - a[0],
    wy = c[1] - a[1];
  const s = (wx * vy - wy * vx) / den;
  const t = (wx * uy - wy * ux) / den;
  return { s, t, at: [a[0] + s * ux, a[1] + s * uy] };
}
const insideZone = (p: readonly number[], zones: readonly ZoneInput[]) =>
  zones.some((z) => z.shape?.length >= 3 && pointInPolygon(p, z.shape, 0));

export function columns(
  inputs: ColumnsInputs,
  params: Partial<ColumnsParams> = {},
  overrides: Override[] = [],
): ColumnsOutput {
  const p = resolveParams(params);
  const axesOut = inputs.steps?.axes;
  const assembled = inputs.steps?.assemble;
  if (!axesOut || !assembled) throw new Error('AXES_MISSING: 축선·배치 결과가 없습니다');
  const notes: string[] = [];
  const slab = assembled.slab;
  if (!slab) throw new Error('SLAB_MISSING: 슬래브 경계가 없습니다');
  const fire = (inputs.fireRoute ?? []).filter((z) => z.shape?.length >= 3);
  const placeable = (q: readonly number[]) =>
    pointInPolygon(q, slab.polygon, 0) &&
    !slab.holes.some((hole) => pointInPolygon(q, hole, 0)) &&
    !insideZone(q, fire);

  // Levels.
  const base = p.baseSource === 'manual' ? p.baseLevel : (assembled.existing.topZ ?? p.baseLevel);
  if (p.baseSource !== 'manual' && assembled.existing.topZ === null)
    notes.push('기존 기초의 높이를 읽지 못해 기둥 하단을 설정값 레벨로 두었습니다.');
  const underside = undersideSampler(inputs.site?.slab);
  const topAt = (x: number, y: number): number => {
    if (p.topSource === 'manual') return p.girderTopLevel;
    return underside.at(x, y) ?? p.girderTopLevel;
  };
  if (p.topSource === 'slab' && underside.kind === 'none')
    notes.push('슬래브 하면을 읽지 못해 거더 상단을 설정값 레벨로 두었습니다.');
  const frame = axesOut.frame;
  const strongAxisDeg = round(
    axesOut.chosen === 'staggered' && axesOut.axes.every((a) => a.axis === 'u')
      ? frame.angleDeg + 90
      : frame.angleDeg,
    3,
  );

  const out: ColumnRow[] = [];
  const make = (key: string, at: Vec2, extra: Partial<ColumnRow> = {}): ColumnRow => {
    const girderTop = topAt(at[0], at[1]);
    const girderBottom = girderTop - p.depthMax;
    const steps = Math.floor((girderBottom - base) / p.heightStep + 1e-9);
    const length = Math.max(steps, 0) * p.heightStep;
    const top = base + length;
    const gap = girderBottom - top;
    const short = steps < 1;
    return {
      key,
      mark: key.replace(/^col:/, ''),
      at: [round(at[0], 6), round(at[1], 6)],
      bottom: [round(at[0], 6), round(at[1], 6), round(base)],
      top: [round(at[0], 6), round(at[1], 6), round(top)],
      line: [
        [round(at[0], 6), round(at[1], 6), round(base)],
        [round(at[0], 6), round(at[1], 6), round(top)],
      ],
      length: round(length),
      girderTop: round(girderTop),
      girderBottom: round(girderBottom),
      gap: round(gap),
      strongAxisDeg,
      verdict: short ? 'incomplete' : 'pass',
      judgement: short ? '? 미완' : '✓ 통과',
      ...(short
        ? {
            reason: `거더 하단(${round(girderBottom, 2)})이 기둥 하단(${round(base, 2)})보다 ${p.heightStep} m 이상 높지 않습니다`,
          }
        : {}),
      ...extra,
    };
  };
  for (const q of axesOut.points)
    out.push(
      make(q.key, q.at, {
        ...(q.lineU ? { lineU: q.lineU } : {}),
        ...(q.lineV ? { lineV: q.lineV } : {}),
      }),
    );

  // Twin columns at every new expansion joint crossing an axis (F2.11): they replace the layout's
  // column near the crossing and share one cap; `single` keeps one column with a sliding bearing.
  const pairs: PairRow[] = [];
  const fireConflicts: ColumnsOutput['fireConflicts'] = [];
  const spacing = p.columnSize + p.ejWidth;
  const replaceReach = Math.max(spacing, 1.0) + 1.0;
  for (const ej of assembled.joints?.newEJ ?? []) {
    const a: Vec2 = [ej.line[0][0], ej.line[0][1]],
      b: Vec2 = [ej.line[1][0], ej.line[1][1]];
    const ejDir: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const ejLength = Math.hypot(ejDir[0], ejDir[1]);
    if (!(ejLength > 0)) continue;
    const across: Vec2 = [-ejDir[1] / ejLength, ejDir[0] / ejLength];
    for (const axis of axesOut.axes) {
      const c: Vec2 = [axis.line[0][0], axis.line[0][1]],
        d: Vec2 = [axis.line[1][0], axis.line[1][1]];
      const axisDir: Vec2 = [d[0] - c[0], d[1] - c[1]];
      const axisLength = Math.hypot(axisDir[0], axisDir[1]);
      const cosine =
        Math.abs(axisDir[0] * ejDir[0] + axisDir[1] * ejDir[1]) / (axisLength * ejLength);
      if (cosine > Math.cos((30 * Math.PI) / 180)) continue; // nearly parallel: no crossing column
      const hit = crossing(a, b, c, d);
      if (!hit || hit.s < -1e-9 || hit.s > 1 + 1e-9) continue; // the joint line ends before the axis
      if (!placeable(hit.at)) {
        if (insideZone(hit.at, fire))
          fireConflicts.push({ key: `${ej.name}-${axis.name}`, zone: '소방 동선' });
        continue;
      }
      const pairKey = `pair:${ej.name}-${axis.name}`;
      const replaced = out
        .filter((col) => !col.pair && distance(col.at, hit.at) <= replaceReach)
        .map((col) => col.key);
      for (const key of replaced)
        out.splice(
          out.findIndex((col) => col.key === key),
          1,
        );
      if (p.ejDetail === 'single') {
        out.push(make(`col:${ej.name}-${axis.name}`, hit.at, { pair: pairKey }));
        pairs.push({
          key: pairKey,
          ej: ej.name,
          axis: axis.name,
          at: [round(hit.at[0], 6), round(hit.at[1], 6)],
          spacing: 0,
          across,
          columns: [`col:${ej.name}-${axis.name}`],
          replaced,
        });
        continue;
      }
      const sides: [string, number][] = [
        ['a', -spacing / 2],
        ['b', spacing / 2],
      ];
      const made: string[] = [];
      for (const [side, offset] of sides) {
        const at: Vec2 = [hit.at[0] + across[0] * offset, hit.at[1] + across[1] * offset];
        if (!placeable(at)) {
          notes.push(
            `${ej.name} × ${axis.name}의 쌍기둥 ${side}가 슬래브 밖이거나 소방 동선 안이라 두지 않았습니다.`,
          );
          continue;
        }
        const key = `col:${ej.name}-${axis.name}-${side}`;
        out.push(make(key, at, { pair: pairKey }));
        made.push(key);
      }
      pairs.push({
        key: pairKey,
        ej: ej.name,
        axis: axis.name,
        at: [round(hit.at[0], 6), round(hit.at[1], 6)],
        spacing: round(spacing),
        across: [round(across[0], 6), round(across[1], 6)],
        columns: made,
        replaced,
      });
    }
  }
  if (pairs.length)
    notes.push(
      `신설 E.J. ${assembled.joints.newEJ.length}곳에 쌍기둥 ${pairs.length}쌍(공통 파일캡)을 두었습니다. E.J. 폭 ${p.ejWidth} m는 가정입니다.`,
    );

  // Overrides by stable key (SPEC-07.8).
  for (const override of overrides) {
    if (override.target.kind !== 'column') continue;
    const key = String(override.target.identity.key ?? '');
    const index = out.findIndex((c) => c.key === key);
    const at = Array.isArray(override.fields.at)
      ? (override.fields.at as number[]).slice(0, 2)
      : undefined;
    if (override.op === 'remove' && index >= 0) out.splice(index, 1);
    else if (override.op === 'move' && index >= 0 && at && at.every(Number.isFinite))
      out[index] = {
        ...make(key, [at[0], at[1]], {
          lineU: out[index].lineU,
          lineV: out[index].lineV,
          pair: out[index].pair,
        }),
        overridden: 'move',
      };
    else if (override.op === 'add' && index < 0 && at && at.every(Number.isFinite))
      out.push({ ...make(key, [at[0], at[1]]), overridden: 'add' });
  }

  // Requested zones (구조사무소 요청 위치): a column inside, or '확인 필요' with the reason.
  const requested: ColumnsOutput['requested'] = (inputs.requestedZones ?? [])
    .filter((z) => z.shape?.length >= 3)
    .map((zone, i) => {
      const inside = out.filter((col) => pointInPolygon(col.at, zone.shape, 0)).length;
      const overlapsFire = fire.some(
        (f) =>
          zone.shape.some((q) => pointInPolygon(q, f.shape, 0)) ||
          f.shape.some((q) => pointInPolygon(q, zone.shape, 0)),
      );
      const reason = inside
        ? ''
        : overlapsFire
          ? '요청 영역이 소방 동선과 겹쳐 기둥을 둘 수 없습니다'
          : '축선이 요청 영역을 지나지 않습니다 — 축선 조정이나 수정 사항으로 기둥을 두세요';
      return {
        key: `req:${zone.id || i + 1}`,
        zone: zone.id || `요청 ${i + 1}`,
        columns: inside,
        verdict: inside ? 'pass' : 'review',
        judgement: inside ? '✓ 있음' : '? 확인 필요',
        reason,
      };
    });
  const fireInside = out.filter((col) => insideZone(col.at, fire));
  for (const col of fireInside) {
    fireConflicts.push({ key: col.key, zone: '소방 동선' });
    out.splice(out.indexOf(col), 1);
  }
  if (fireInside.length)
    notes.push(`소방 동선 안의 기둥 ${fireInside.length}개를 뺐습니다(결정 F2.9).`);
  const short = out.filter((c) => c.verdict === 'incomplete').length;
  if (short)
    notes.push(
      `기둥 ${short}개는 거더 하단이 기둥 하단보다 한 단(${p.heightStep} m) 이상 높지 않아 높이가 미완입니다.`,
    );

  return {
    schema: 'vide.s06.columns/1',
    columns: out,
    heights: out.map((c) => ({
      key: c.key,
      bottom: c.bottom[2],
      top: c.top[2],
      length: c.length,
      girderTop: c.girderTop,
      girderBottom: c.girderBottom,
      gap: c.gap,
      judgement: c.judgement,
    })),
    pairs,
    requested,
    fireConflicts,
    site: { polygon: slab.polygon },
    base: {
      z: round(base),
      source: p.baseSource === 'manual' || assembled.existing.topZ === null ? 'manual' : 'footings',
    },
    count: out.length,
    notes,
  };
}

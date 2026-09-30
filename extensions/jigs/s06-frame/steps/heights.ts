// S-06 frame jig ⑩ 기둥 높이 (PLAN-23 T-056, SPEC-06.11 9, 결정 F2.6): the drawn columns of
// step 'model' get a length that is a whole number of `heightStep` below the underside of the
// deepest girder they carry, so the steel never reaches into the slab; the difference is the
// bearing (받침) height listed per column. The girder depth is the section step 'sizing' chose,
// else the model's section, else the depth limit. Depth + finish over the limit (default
// 1,200 mm) is flagged. Pure: JSON in and out.

import { polylineOf, type SiteInput } from './roles.ts';
import type { ModelOutput } from './model.ts';
import type { SizingOutput } from './sizing.ts';

type Vec3 = [number, number, number];

export interface HeightRow {
  /** Column key of step 'model' (e.g. 'col:c-1'). */
  columnId: string;
  sourceId: string;
  /** Length of the drawn column line (m); null when the drawn line was not found. */
  drawnLength_m: number | null;
  /** Steel length: floored to `heightStep` (m). */
  length_m: number;
  /** Bearing height between the column top and the girder underside (m). */
  gap_m: number;
  topZ: number;
  bottomZ: number;
  /** Top of steel of the girders carried (m). */
  girderTopZ: number;
  girderBottomZ: number;
  /** Deepest carried girder (mm) and where the depth came from. */
  depth_mm: number;
  depthFrom: 'sizing' | 'model' | 'limit';
  /** Level difference girder top − drawn column top (m); null without the drawn line. */
  levelDiff_m: number | null;
  status: 'ok' | 'short';
  judgement: string;
  /** Depth + finish exceeds the limit. */
  depthFinishOver: boolean;
}
export interface HeightsOutput {
  schema: 'vide.s06.heights/1';
  rows: HeightRow[];
  summary: {
    columns: number;
    /** Columns whose length was cut down (gap > 1 mm). */
    floored: number;
    short: number;
    maxGap_m: number | null;
    depthFinishOver: number;
    heightStep: number;
  };
  notes: string[];
}

export interface HeightsInputs {
  site?: SiteInput;
  steps: { model: ModelOutput; sizing?: SizingOutput | null };
}
export interface HeightsParams {
  heightStep: number;
  /** Depth used when no section is known (mm). */
  depthMax_mm: number;
  /** Jig setting `depthMax` in metres; wins over `depthMax_mm` when given. */
  depthMax?: number;
  /** Finish below the girder (m), assumed. */
  finish_m: number;
  /** Depth + finish limit (m). */
  depthFinishMax_m: number;
}
export const DEFAULT_HEIGHTS_PARAMS: HeightsParams = {
  heightStep: 1.0,
  depthMax_mm: 900,
  finish_m: 0.15,
  depthFinishMax_m: 1.2,
};

const round = (v: number, k = 1e6) => Math.round(v * k) / k;

/** Step 'heights': column lengths floored to the height step and the bearing table (T-056 ⑩). */
export function heights(inputs: HeightsInputs, params: Partial<HeightsParams> = {}): HeightsOutput {
  const p = { ...DEFAULT_HEIGHTS_PARAMS, ...params };
  if (typeof p.depthMax === 'number' && p.depthMax > 0) p.depthMax_mm = p.depthMax * 1000;
  const step = p.heightStep > 0 ? p.heightStep : DEFAULT_HEIGHTS_PARAMS.heightStep;
  const model = inputs.steps.model;
  const sizing = inputs.steps.sizing;
  const notes: string[] = [];

  // Drawn column lines by source id (and '#index').
  const drawn = new Map<string, { base: Vec3; top: Vec3 }>();
  (inputs.site?.columns?.rows ?? []).forEach((row, index) => {
    const line = row ? polylineOf(row) : null;
    if (!line) return;
    const a = line[0],
      b = line[line.length - 1];
    const [base, top] = a[2] <= b[2] ? [a, b] : [b, a];
    const id = row.id === undefined || row.id === null ? `#${index}` : String(row.id);
    drawn.set(id, { base, top });
    drawn.set(`#${index}`, { base, top });
  });

  // Depth of a girder: sizing section, else the model's section, else the limit.
  const sizedSection = new Map<string, string>();
  for (const g of sizing?.groups ?? [])
    if (g.sectionId) for (const id of g.memberIds) sizedSection.set(id, g.sectionId);
  const modelSection = new Map(model.model.members.map((m) => [m.id, m.section]));
  const dims = new Map(model.model.sections.map((s) => [s.id, s.dims_mm.h]));
  const depthOf = (girderId: string): { h: number; from: HeightRow['depthFrom'] } => {
    const key = model.map.physical[girderId] ? girderId : `G:${girderId}`;
    const sized = sizedSection.get(key);
    const h = sized ? sizing?.sectionsById[sized]?.h_mm : undefined;
    if (h) return { h, from: 'sizing' };
    const seg = model.map.physical[key]?.[0];
    const mh = seg ? dims.get(modelSection.get(seg) ?? '') : undefined;
    if (mh) return { h: mh, from: 'model' };
    return { h: p.depthMax_mm, from: 'limit' };
  };
  if (!sizing) notes.push('단면 선정 전이라 모델 단면(없으면 춤 상한)으로 거더 하단을 잡았습니다.');

  const rows: HeightRow[] = [];
  for (const c of model.columns) {
    const bottomZ = c.base[2];
    const girderTop = c.top[2];
    const depths = c.girders.map(depthOf);
    const deepest = depths.reduce<{ h: number; from: HeightRow['depthFrom'] } | null>(
      (m, d) => (m === null || d.h > m.h ? d : m),
      null,
    ) ?? { h: p.depthMax_mm, from: 'limit' as const };
    const girderBottom = girderTop - deepest.h / 1000;
    const steps = Math.floor((girderBottom - bottomZ) / step + 1e-9);
    const length = Math.max(steps, 0) * step;
    const topZ = bottomZ + length;
    const line = drawn.get(c.sourceId);
    const short = steps < 1;
    rows.push({
      columnId: c.key,
      sourceId: c.sourceId,
      drawnLength_m: line
        ? round(
            Math.hypot(
              line.top[0] - line.base[0],
              line.top[1] - line.base[1],
              line.top[2] - line.base[2],
            ),
          )
        : null,
      length_m: round(length),
      gap_m: round(girderBottom - topZ),
      topZ: round(topZ),
      bottomZ: round(bottomZ),
      girderTopZ: round(girderTop),
      girderBottomZ: round(girderBottom),
      depth_mm: deepest.h,
      depthFrom: deepest.from,
      levelDiff_m: line ? round(girderTop - line.top[2]) : null,
      status: short ? 'short' : 'ok',
      judgement: short ? '? 미완' : '✓ 통과',
      depthFinishOver: deepest.h / 1000 + p.finish_m > p.depthFinishMax_m + 1e-9,
    });
  }
  rows.sort((a, b) => (a.columnId < b.columnId ? -1 : a.columnId > b.columnId ? 1 : 0));
  const short = rows.filter((r) => r.status === 'short').length;
  if (short)
    notes.push(
      `기둥 ${short}개는 거더 하단이 기둥 하단보다 한 단(${step} m) 이상 높지 않아 높이가 미완입니다.`,
    );
  const over = rows.filter((r) => r.depthFinishOver).length;
  if (over)
    notes.push(
      `보 춤 + 마감(${p.finish_m} m 가정)이 ${p.depthFinishMax_m} m를 넘는 기둥 ${over}개가 있습니다.`,
    );
  notes.push('거더 편심(상단 기준)은 무시하고 기둥 위 가장 깊은 거더 하단을 기준으로 했습니다.');
  return {
    schema: 'vide.s06.heights/1',
    rows,
    summary: {
      columns: rows.length,
      floored: rows.filter((r) => r.gap_m > 0.001).length,
      short,
      maxGap_m: rows.length ? round(Math.max(...rows.map((r) => r.gap_m))) : null,
      depthFinishOver: over,
      heightStep: step,
    },
    notes,
  };
}

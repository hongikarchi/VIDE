// S-06 frame jig: the proposed-layout branch (② 축선 ~ ④ 간섭) behind the setting `layoutSource`
// (PLAN-23 M2 머리말 2026-09-30: the drawn columns and girders come first, generation second).
// With 'drawn' (the default) these steps return an empty result that says why, so the drawn
// chain (girders → cells → beams → model → analysis) runs alone; with 'proposed' they run as in
// 0.1. The empty results keep the output schemas and the panel bindings ('배치 전').

import { axes, type AxesInputs, type AxesParams } from './axes.ts';
import { columns, type ColumnsInputs, type ColumnsParams } from './columns.ts';
import { footprints } from './footprints.ts';
import { interference } from './interference.ts';

type Source = { layoutSource?: 'drawn' | 'proposed' };
const drawn = (params: Source | undefined) => (params?.layoutSource ?? 'drawn') === 'drawn';
const NOTE =
  '그려진 배치로 계산 중입니다. 새 배치 후보는 배치 기준을 ‘새 배치 제안’으로 바꾸면 만듭니다.';
const skipped = { skipped: true, notes: [NOTE] };

export function axesStep(inputs: AxesInputs, params: Partial<AxesParams> & Source = {}) {
  if (!drawn(params)) return axes(inputs, params);
  return {
    ...skipped,
    schema: 'vide.s06.axes/1',
    frame: null,
    chosen: '',
    alternatives: [],
    axes: [],
    points: [],
    spans: [],
    objective: { spanOver: 0, spanExcess: 0, cap: 0, basin: 0, openCut: 0, columns: 0 },
    summary: null,
    violations: [],
    relaxed: [],
    bands: { span: [0, 0] },
  };
}

export function columnsStep(
  inputs: ColumnsInputs,
  params: Partial<ColumnsParams> & Source = {},
  overrides: Parameters<typeof columns>[2] = [],
) {
  if (!drawn(params)) return columns(inputs, params, overrides);
  return {
    ...skipped,
    schema: 'vide.s06.columns/1',
    columns: [],
    heights: [],
    pairs: [],
    requested: [],
    site: { polygon: [] },
    count: 0,
  };
}

export function footprintsStep(
  inputs: Parameters<typeof footprints>[0],
  params: Parameters<typeof footprints>[1] & Source = {},
) {
  if (!drawn(params)) return footprints(inputs, params);
  return {
    ...skipped,
    schema: 'vide.s06.footprints/1',
    caps: [],
    openCuts: [],
    existing: [],
    basin: [],
    definitions: {},
  };
}

export function interferenceStep(
  inputs: Parameters<typeof interference>[0],
  params: Parameters<typeof interference>[1] & Source = {},
) {
  if (!drawn(params)) return interference(inputs, params);
  return {
    ...skipped,
    schema: 'vide.s06.interference/1',
    params: {},
    summary: null,
    tables: { interference: [], spans: [], nudges: [], ejCross: [], review: [] },
    fills: { capClash: [], cutClash: [], basinClash: [], nudges: [] },
    missing: [],
    bands: { span: [0, 0] },
  };
}

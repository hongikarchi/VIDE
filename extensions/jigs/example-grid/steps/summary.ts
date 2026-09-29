// Example jig step ③ : the numbers the KPI strip shows.

import type { BeamsOutput } from './beams.ts';
import type { GridOutput } from './grid.ts';

export interface SummaryInputs {
  steps: { grid: GridOutput; beams: BeamsOutput };
}
export interface SummaryOutput {
  columns: number;
  beams: number;
  maxSpan_m: number;
  avgSpan_m: number;
  area_m2: number;
  areaPerColumn_m2: number;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export function summary(inputs: SummaryInputs): SummaryOutput {
  const { grid, beams } = inputs.steps;
  const spans = beams.beams.map((b) => b.span_m);
  return {
    columns: grid.columns.length,
    beams: beams.beams.length,
    maxSpan_m: spans.length ? Math.max(...spans) : 0,
    avgSpan_m: spans.length ? round(spans.reduce((s, v) => s + v, 0) / spans.length) : 0,
    area_m2: grid.site.area_m2,
    areaPerColumn_m2: grid.columns.length ? round(grid.site.area_m2 / grid.columns.length) : 0,
  };
}

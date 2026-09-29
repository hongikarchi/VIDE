// Example jig step ② : beams between grid-adjacent columns (same row i→i+1, same column j→j+1).
// Depth from the span ratio rounded to 50 mm; width is the column size. Keys `G:<from>><to>`.

import type { Column, GridOutput, Point2 } from './grid.ts';

export interface BeamsInputs {
  steps: { grid: GridOutput };
}
export interface BeamsParams {
  columnSize: number;
  beamDepthRatio: number;
}
export interface Beam {
  key: string;
  from: string;
  to: string;
  span_m: number;
  depth_m: number;
  width_m: number;
  line: [Point2, Point2];
  direction: 'x' | 'y';
}
export interface BeamsOutput {
  beams: Beam[];
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const distance = (a: Point2, b: Point2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function beams(inputs: BeamsInputs, params: BeamsParams): BeamsOutput {
  const columns = inputs.steps.grid.columns.filter((c) => c.i >= 0 && c.j >= 0);
  const byIndex = new Map<string, Column>(columns.map((c) => [`${c.i},${c.j}`, c]));
  const out: Beam[] = [];
  const connect = (a: Column, b: Column, direction: 'x' | 'y') => {
    const span = distance(a.at, b.at);
    out.push({
      key: `G:${a.mark}>${b.mark}`,
      from: a.key,
      to: b.key,
      span_m: round(span),
      depth_m: round(Math.ceil((span * params.beamDepthRatio) / 0.05) * 0.05),
      width_m: params.columnSize,
      line: [a.at, b.at],
      direction,
    });
  };
  for (const column of columns) {
    const right = byIndex.get(`${column.i + 1},${column.j}`);
    if (right) connect(column, right, 'x');
    const up = byIndex.get(`${column.i},${column.j + 1}`);
    if (up) connect(column, up, 'y');
  }
  return { beams: out };
}

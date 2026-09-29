// Example jig step ① (PLAN-22 T-046, SPEC-07.7): columns on a rotated grid inside the slab
// outline, outside voids and keep-out zones. Pure `(inputs, params, overrides) → output`; no
// imports outside the package. Lengths are metres, the plan is XY. Keys are stable per grid
// index (`col:C3-2`), so an override or a bake record finds the same column after a recompute.

export type Point2 = [number, number];
/** A read row of a curve layer: `line` is flat xyz. */
export interface CurveRow {
  id?: string;
  layer?: string;
  line?: number[];
  [key: string]: unknown;
}
export interface RoleRows {
  rows: CurveRow[];
}
export interface GridInputs {
  site: { outline?: RoleRows; voids?: RoleRows };
  keepOut?: { id: string; shape: Point2[] }[];
}
export interface GridParams {
  spacingX: number;
  spacingY: number;
  angle: number;
  markPrefix: string;
}
export interface Override {
  target: { kind: string; identity: Record<string, string | number> };
  op: 'move' | 'add' | 'remove' | 'set' | 'pin';
  fields: Record<string, unknown>;
}
export interface Column {
  key: string;
  mark: string;
  i: number;
  j: number;
  at: Point2;
  overridden?: Override['op'];
}
export interface GridOutput {
  columns: Column[];
  axes: { x: number[]; y: number[] };
  angle_deg: number;
  origin: Point2;
  site: { polygon: Point2[]; area_m2: number };
}

export function polygonsOf(role: RoleRows | undefined): Point2[][] {
  const out: Point2[][] = [];
  for (const row of role?.rows ?? []) {
    const line = row.line;
    if (!Array.isArray(line) || line.length < 9) continue;
    const points: Point2[] = [];
    for (let k = 0; k + 1 < line.length; k += 3) points.push([line[k], line[k + 1]]);
    const [a, b] = [points[0], points[points.length - 1]];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) points.pop();
    if (points.length >= 3) out.push(points);
  }
  return out;
}
export function area(ring: Point2[]) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i],
      [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}
export function inside(point: Point2, ring: Point2[]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
    )
      result = !result;
  }
  return result;
}
const round = (v: number) => Math.round(v * 1000) / 1000;

export function grid(
  inputs: GridInputs,
  params: GridParams,
  overrides: Override[] = [],
): GridOutput {
  const outlines = polygonsOf(inputs.site?.outline).sort(
    (a, b) => Math.abs(area(b)) - Math.abs(area(a)),
  );
  const outline = outlines[0];
  if (!outline) throw new Error('OUTLINE_MISSING: 슬래브 외곽선이 없습니다');
  const ring = area(outline) < 0 ? [...outline].reverse() : outline;
  const holes = [...polygonsOf(inputs.site?.voids), ...(inputs.keepOut ?? []).map((z) => z.shape)];
  const theta = (params.angle * Math.PI) / 180;
  const cos = Math.cos(theta),
    sin = Math.sin(theta);
  const centroid: Point2 = [
    ring.reduce((s, p) => s + p[0], 0) / ring.length,
    ring.reduce((s, p) => s + p[1], 0) / ring.length,
  ];
  const toLocal = (p: Point2): Point2 => {
    const dx = p[0] - centroid[0],
      dy = p[1] - centroid[1];
    return [dx * cos + dy * sin, -dx * sin + dy * cos];
  };
  const toWorld = (p: Point2): Point2 => [
    centroid[0] + p[0] * cos - p[1] * sin,
    centroid[1] + p[0] * sin + p[1] * cos,
  ];
  const local = ring.map(toLocal);
  const minX = Math.min(...local.map((p) => p[0])),
    maxX = Math.max(...local.map((p) => p[0])),
    minY = Math.min(...local.map((p) => p[1])),
    maxY = Math.max(...local.map((p) => p[1]));
  const sx = Math.max(params.spacingX, 0.1),
    sy = Math.max(params.spacingY, 0.1);
  const axesX: number[] = [],
    axesY: number[] = [];
  for (let x = minX + sx / 2; x < maxX; x += sx) axesX.push(round(x));
  for (let y = minY + sy / 2; y < maxY; y += sy) axesY.push(round(y));
  const columns: Column[] = [];
  axesX.forEach((x, i) =>
    axesY.forEach((y, j) => {
      const at = toWorld([x, y]).map(round) as Point2;
      if (!inside(at, ring) || holes.some((hole) => inside(at, hole))) return;
      columns.push({
        key: `col:${params.markPrefix}${i + 1}-${j + 1}`,
        mark: `${params.markPrefix}${i + 1}-${j + 1}`,
        i,
        j,
        at,
      });
    }),
  );
  // Overrides a person made keep applying after a recompute (SPEC-07.8).
  for (const override of overrides) {
    if (override.target.kind !== 'column') continue;
    const key = String(override.target.identity.key ?? '');
    const index = columns.findIndex((c) => c.key === key);
    if (override.op === 'remove' && index >= 0) columns.splice(index, 1);
    else if (override.op === 'move' && index >= 0 && Array.isArray(override.fields.at)) {
      columns[index] = {
        ...columns[index],
        at: (override.fields.at as number[]).slice(0, 2) as Point2,
        overridden: 'move',
      };
    } else if (override.op === 'add' && index < 0 && Array.isArray(override.fields.at)) {
      columns.push({
        key,
        mark: key.replace(/^col:/, ''),
        i: -1,
        j: -1,
        at: (override.fields.at as number[]).slice(0, 2) as Point2,
        overridden: 'add',
      });
    }
  }
  return {
    columns,
    axes: { x: axesX, y: axesY },
    angle_deg: params.angle,
    origin: centroid.map(round) as Point2,
    site: { polygon: ring, area_m2: round(area(ring)) },
  };
}

// Area loads → member line loads by one-way distribution, with a load ledger (ARCH-02 §3).
// A slab spanning in X is carried by members running along Y (and vice versa); each carrier
// takes half the distance to its neighbours on either side, clipped to the area.

import type { StructureModel, StructureModelInput } from '../../contracts/structure-model.ts';

type Pt = [number, number, number];
export interface LedgerRow {
  area: string;
  pattern: string;
  input_kN: number;
  delivered_kN: number;
  undelivered_kN: number;
  carriers: string[];
}

/** Inside the polygon, or within `edge` of its boundary (members often sit on the area's edge). */
function inside(x: number, y: number, polygon: Pt[], edge = 0.05): boolean {
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j],
      [bx, by] = polygon[i];
    const dx = bx - ax,
      dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= edge) return true;
  }
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i],
      [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const planArea = (polygon: Pt[]) =>
  Math.abs(
    polygon.reduce(
      (sum, p, i) =>
        sum +
        p[0] * polygon[(i + 1) % polygon.length][1] -
        polygon[(i + 1) % polygon.length][0] * p[1],
      0,
    ),
  ) / 2;

/** Replace `areaLoads` with member uniform loads; returns the new model and the ledger. */
export function distributeAreaLoads(model: StructureModel): {
  model: StructureModel;
  ledger: LedgerRow[];
} {
  if (!model.areaLoads.length) return { model, ledger: [] };
  const nodes = new Map(model.nodes.map((n) => [n.id, n.xyz_m]));
  const loads = [...model.loads];
  const ledger: LedgerRow[] = [];
  for (const area of model.areaLoads) {
    const z = area.polygon_m.reduce((s, p) => s + p[2], 0) / area.polygon_m.length;
    const tol = Math.max(0.05, model.meta.mergeTolerance_m * 5);
    const horizontal = model.members
      .filter((m) => m.role === 'beam' || m.role === 'girder')
      .map((m) => ({ m, a: nodes.get(m.i)!, b: nodes.get(m.j)! }))
      .filter(({ a, b }) => Math.abs(a[2] - z) <= tol && Math.abs(b[2] - z) <= tol)
      .filter(({ a, b }) => inside((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, area.polygon_m));
    const alongX = horizontal.filter(({ a, b }) => Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]));
    const alongY = horizontal.filter(({ a, b }) => Math.abs(b[0] - a[0]) < Math.abs(b[1] - a[1]));
    // Span direction: given, or the direction that leaves more carriers (the secondary beams).
    const span = area.spanDirection ?? (alongY.length >= alongX.length ? 'X' : 'Y');
    const carriers = span === 'X' ? alongY : alongX;
    const axis = span === 'X' ? 0 : 1;
    const [lo, hi] = [
      Math.min(...area.polygon_m.map((p) => p[axis])),
      Math.max(...area.polygon_m.map((p) => p[axis])),
    ];
    const lines = [
      ...new Set(carriers.map(({ a, b }) => Math.round(((a[axis] + b[axis]) / 2) * 1000) / 1000)),
    ].sort((u, v) => u - v);
    let delivered = 0;
    const names: string[] = [];
    for (const { m, a, b } of carriers) {
      const s = Math.round(((a[axis] + b[axis]) / 2) * 1000) / 1000;
      const k = lines.indexOf(s);
      const left = k > 0 ? (s - lines[k - 1]) / 2 : s - lo;
      const right = k < lines.length - 1 ? (lines[k + 1] - s) / 2 : hi - s;
      const width = Math.max(0, left) + Math.max(0, right);
      const w = area.value_kPa * width;
      if (w <= 0) continue;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      delivered += w * length;
      names.push(m.id);
      loads.push({
        id: `${area.id}:${m.id}`,
        pattern: area.pattern,
        type: 'memberUniform',
        targets: [m.id],
        direction: '-Z',
        value_kNpm: w,
        provenance: {
          by: 'auto',
          assumed: true,
          note: `면하중 ${area.id} 한 방향 분배, 부담폭 ${width.toFixed(2)} m`,
        },
      });
    }
    const input = area.value_kPa * planArea(area.polygon_m);
    ledger.push({
      area: area.id,
      pattern: area.pattern,
      input_kN: input,
      delivered_kN: delivered,
      undelivered_kN: input - delivered,
      carriers: names,
    });
  }
  return { model: { ...model, loads, areaLoads: [] }, ledger };
}

export type { StructureModelInput };

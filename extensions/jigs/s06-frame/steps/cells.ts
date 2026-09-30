// S-06 frame jig ⑦-1 칸 (PLAN-23 T-053 drawn mode, SPEC-06.11 6): the closed cells of the
// corrected girder network (`girders` step), clipped to the slab and less the voids. A cell is a
// face of the girder plan graph (T-junctions split, concave cells kept); where the slab edge or a
// void cuts through a girder cell, the part inside the slab is the cell and a void wholly inside a
// cell is its hole. The infill beams (`beams` step) are laid inside these cells. Pure, JSON only.

import {
  interiorPoint,
  planarFaces,
  pointInRegion,
  polygonArea,
  type FaceSegment,
  type Vec2,
} from '../../../../src/jigs/official/geometry-kit/index.ts';
import type { GirderRow, GirdersOutput } from './girders.ts';
import { slabOf, type SiteInput } from './roles.ts';

export interface CellsInputs {
  site: SiteInput;
  steps: { girders: Pick<GirdersOutput, 'girders'> };
}
export interface CellsParams {
  /** Girder ends and crossings closer than this are one node (m). */
  nodeTol_m: number;
  /** Cells smaller than this are slivers and left out (m²). */
  minArea_m2: number;
}
export const DEFAULT_CELLS_PARAMS: CellsParams = { nodeTol_m: 0.01, minArea_m2: 0.05 };

export interface CellRow {
  id: string;
  /** Counter-clockwise outer ring (plan, m). */
  polygon: Vec2[];
  /** Clockwise rings of voids inside the cell (present only when there are some). */
  holes?: Vec2[][];
  /** Girders on the cell boundary, sorted. */
  girderIds: string[];
  /** Whether part of the boundary is the slab edge or a void edge rather than a girder. */
  edges?: ('slab' | 'void')[];
  /** Net area (m²). */
  area_m2: number;
}
export interface CellsOutput {
  schema: 'vide.s06.cells/1';
  cells: CellRow[];
  summary: { cells: number; area_m2: number };
  notes: string[];
}

const r4 = (value: number) => Number(value.toFixed(4));
const pt = (p: readonly number[]): Vec2 => [r4(p[0]), r4(p[1])];

/** Plan segments of the girders, tagged with the girder id. */
export function girderSegments(girders: readonly GirderRow[]): FaceSegment[] {
  const out: FaceSegment[] = [];
  for (const g of girders)
    for (let i = 1; i < (g.points?.length ?? 0); i++)
      out.push({ a: g.points[i - 1], b: g.points[i], tag: g.id });
  return out;
}

export function cells(inputs: CellsInputs, params: Partial<CellsParams> = {}): CellsOutput {
  const p = { ...DEFAULT_CELLS_PARAMS, ...params };
  const notes: string[] = [];
  const girders = inputs.steps?.girders?.girders ?? [];
  const slab = slabOf(inputs.site?.slab, inputs.site?.voids);
  notes.push(...slab.notes);
  const empty = (): CellsOutput => ({
    schema: 'vide.s06.cells/1',
    cells: [],
    summary: { cells: 0, area_m2: 0 },
    notes,
  });
  if (!slab.region) {
    notes.push('슬래브 경계가 없어 칸을 만들지 않았습니다.');
    return empty();
  }
  if (!girders.length) {
    notes.push('거더가 없어 칸을 만들지 않았습니다.');
    return empty();
  }
  const region = { outer: slab.region.outer, holes: slab.region.holes };
  const girderSegs = girderSegments(girders);
  // Cells of the girder network alone decide which parts of the slab are framed.
  const network = planarFaces(girderSegs, { tol: p.nodeTol_m, minArea: p.minArea_m2 });
  if (!network.faces.length) {
    notes.push('거더가 닫힌 칸을 이루지 않습니다.');
    return empty();
  }
  const framed = (point: Vec2) =>
    network.faces.some((f) => pointInRegion(point, { outer: f.outer, holes: f.holes }, 0));

  const ringSegs = (ring: readonly Vec2[], tag: string): FaceSegment[] =>
    ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length], tag }));
  const all = planarFaces(
    [
      ...girderSegs,
      ...ringSegs(slab.region.outer, '#slab'),
      ...slab.region.holes.flatMap((h) => ringSegs(h, '#void')),
    ],
    { tol: p.nodeTol_m, minArea: p.minArea_m2 },
  );

  const rows: (CellRow & { at: Vec2 })[] = [];
  for (const face of all.faces) {
    let at: Vec2;
    try {
      at = interiorPoint(face.outer, face.holes);
    } catch {
      continue;
    }
    if (!pointInRegion(at, region, 0) || !framed(at)) continue;
    // A void island inside the cell comes back as a face of its own; keep it only as the hole.
    const girderIds = face.tags.filter((t) => !t.startsWith('#'));
    const edges = (['slab', 'void'] as const).filter((e) => face.tags.includes(`#${e}`));
    const holes = face.holes.map((h) => h.map(pt));
    const area = polygonArea(face.outer) - face.holes.reduce((s, h) => s + polygonArea(h), 0);
    if (area < p.minArea_m2) continue;
    rows.push({
      id: '',
      polygon: face.outer.map(pt),
      ...(holes.length ? { holes } : {}),
      girderIds,
      ...(edges.length ? { edges } : {}),
      area_m2: r4(area),
      at,
    });
  }
  // Stable order and ids: by the interior point, rounded to millimetres (y, then x).
  const mm = (v: number) => Math.round(v * 1000);
  rows.sort((a, b) => mm(a.at[1]) - mm(b.at[1]) || mm(a.at[0]) - mm(b.at[0]));
  const out: CellRow[] = rows.map(({ at: _at, ...row }, i) => ({
    ...row,
    id: `K${String(i + 1).padStart(2, '0')}`,
  }));
  const cut = out.filter((c) => c.edges?.length).length;
  if (cut) notes.push(`칸 ${cut}개는 슬래브 끝이나 보이드에서 잘렸습니다.`);
  if (network.pruned)
    notes.push(`닫힌 칸을 이루지 않는 거더 조각 ${network.pruned}개는 칸 계산에서 뺐습니다.`);
  return {
    schema: 'vide.s06.cells/1',
    cells: out,
    summary: { cells: out.length, area_m2: r4(out.reduce((s, c) => s + c.area_m2, 0)) },
    notes,
  };
}

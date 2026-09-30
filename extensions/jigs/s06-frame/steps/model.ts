// S-06 frame jig ⑧-1 해석 모델 (PLAN-23 T-053 drawn mode, SPEC-06.11 10): the corrected girders
// (step 'girders'), the secondary beams and edge cantilevers (step 'beams', cells from 'cells')
// and the drawn columns become one frame plan for `buildFrameModel` of vide/structure-analysis:
// top-of-steel lines (eccentricity ignored and listed), arcs segmented ≤ 1 m by the library,
// beams pinned at both ends, columns with the bottom fixity of the settings and the web along the
// main girder, lateral restraint only at the column nodes on the restraint (basin slab) level,
// steel self-weight on, zone area loads turned into line loads by tributary width, and the named
// combinations 1.2D+1.6L (± notional X/Y) and 1.0D+1.0L. Pure: no I/O, JSON in and out.

import { createHash } from 'node:crypto';
import type { StructureModelInput } from '../../../../src/contracts/structure-model.ts';
import {
  buildFrameModel,
  type FrameColumn,
  type FrameCombo,
  type FrameLineLoad,
  type FrameMember,
  type FramePlan,
  type MemberMap,
} from '../../../../src/jigs/official/structure-analysis/index.ts';
import { KS_H, hId, hName, parseSectionName } from '../../../../src/jigs/structure/sections.ts';
import { polylineOf, type SiteInput, type ZoneInput } from './roles.ts';

type Vec3 = [number, number, number];
type Vec2 = [number, number];

// --- inputs (the contract fields of the steps 'girders', 'cells' and 'beams') -------------------

export interface GirderIn {
  id: string;
  sourceId?: string;
  points: Vec3[];
  kind: 'line' | 'arc';
  arc?: unknown;
  supports?: { columnId: string; t: number }[];
}
export interface GirdersIn {
  girders: GirderIn[];
  dangling?: { girderId: string; end: 'start' | 'end' }[];
  /** The column keys (C01…) the girders step gave, with the drawn object each stands for. */
  columns?: { id: string; sourceId: string }[];
  /** `zTol_m`: a column top counts for a girder only within this height of it (m). */
  params?: { zTol_m?: number };
}
export interface CellIn {
  id: string;
  polygon: Vec2[];
  girderIds: string[];
  area_m2: number;
}
export interface BeamIn {
  id: string;
  cellId: string;
  points: Vec3[];
  /** `girderId: null` (with `edge`) = the end meets the slab edge or a void, not a girder. */
  from?: { girderId: string | null; t: number | null; edge?: string };
  to?: { girderId: string | null; t: number | null; edge?: string };
  length_m?: number;
}
export interface CantileverIn {
  id: string;
  from: { girderId: string; t: number };
  points: Vec3[];
  length_m?: number;
}
export interface BeamsIn {
  cells?: CellIn[];
  beams: BeamIn[];
  edgeCantilevers?: CantileverIn[];
  summary?: { spacingUsed_m?: number };
}

export interface ModelInputs {
  site?: SiteInput;
  /** Load zones drawn on the instance; outside them the deck load applies. */
  dryZones?: ZoneInput[];
  planterZones?: ZoneInput[];
  steps: { girders: GirdersIn; beams: BeamsIn; cells?: { cells: CellIn[] } };
}

export type LoadZone = 'deck' | 'dry' | 'planter';
export interface ModelParams {
  /** Basin slab level (world z, m): column nodes there are held in X and Y. null = none. */
  restraintLevel: number | null;
  baseFixity: 'pinned' | 'fixed';
  girderEnds: 'rigid' | 'pinned';
  swayK: number;
  columnSection: string;
  girderSection: string;
  beamSection: string;
  cantileverSection: string;
  /** Area loads per zone (kPa): D = finishes/soil/deck, L = live. */
  loads: Record<LoadZone, { D: number; L: number }>;
  /** Ceiling under the beams (kPa, D) added everywhere. */
  ceiling: number;
  notionalRatio: number;
  /** Plan distance within which a girder point is taken to sit on a column (m). */
  supportTol: number;
  /** Arc segmentation chord limit (m). */
  arcMaxLen: number;
}
export const DEFAULT_MODEL_PARAMS: ModelParams = {
  restraintLevel: null,
  baseFixity: 'pinned',
  girderEnds: 'rigid',
  swayK: 2.0,
  columnSection: 'H-300x300x10x15',
  girderSection: 'H-600x200x11x17',
  beamSection: 'H-400x200x8x13',
  cantileverSection: 'H-400x200x8x13',
  loads: {
    deck: { D: 3.0, L: 5.0 },
    dry: { D: 1.5, L: 3.0 },
    planter: { D: 12.0, L: 3.0 },
  },
  ceiling: 0.3,
  notionalRatio: 0.002,
  supportTol: 0.05,
  arcMaxLen: 1.0,
};

export const MODEL_COMBOS: FrameCombo[] = [
  { id: '1.2D+1.6L', factors: { D: 1.2, L: 1.6 }, use: 'strength' },
  { id: '1.2D+1.6L+NX', factors: { D: 1.2, L: 1.6, NX: 1 }, use: 'strength' },
  { id: '1.2D+1.6L+NY', factors: { D: 1.2, L: 1.6, NY: 1 }, use: 'strength' },
  { id: '1.0D+1.0L', factors: { D: 1, L: 1 }, use: 'service' },
];

export const MODEL_ASSUMPTIONS = {
  eccentricity: '편심 무시: 거더·작은보·기둥을 거더 상단선에서 잇는다',
  steel: '강재 등급 가정: SM355(기준 원문 확인 전)',
  restraint: '구속 완전 강성: 구속 레벨의 기둥 절점을 X·Y로 완전히 잡는다고 본다',
  joints: '강접 단부는 완전 강성 접합으로 본다(접합부 설계는 검토하지 않음)',
  sections: '단면은 설정 기본값(단면 선정 전)',
  loads: '면하중은 작은보 부담폭으로 나누고, 작은보가 받지 않은 나머지는 칸의 거더에 고르게 준다',
  noRestraint: '수평 구속 레벨 없음: 기둥 전 길이를 흔들림 골조로 본다',
} as const;

export interface ColumnOut {
  key: string;
  sourceId: string;
  base: Vec3;
  top: Vec3;
  /** Plan move of the column onto the girder point it carries (m). */
  moved_m: number;
  girders: string[];
}
export interface LoadRow {
  memberKey: string;
  case: 'D' | 'L';
  value_kNpm: number;
  source: 'area' | 'ceiling';
  zone: LoadZone | 'mixed';
}
export interface ModelIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  members?: string[];
}
export interface ModelOutput {
  schema: 'vide.s06.model/1';
  params: ModelParams;
  model: StructureModelInput;
  map: MemberMap;
  modelHash: string;
  assumptions: string[];
  issues: ModelIssue[];
  columns: ColumnOut[];
  loads: LoadRow[];
  totals: { area_m2: number; D_kN: number; L_kN: number };
  summary: {
    columns: number;
    girders: number;
    beams: number;
    cantilevers: number;
    segments: number;
    errors: number;
    warnings: number;
  };
}

export interface ModelOverride {
  target: { kind: string; identity: Record<string, string | number> };
  op: 'move' | 'add' | 'remove' | 'set' | 'pin';
  fields: Record<string, unknown>;
}

// --- geometry -----------------------------------------------------------------------------------

const d2 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const d3 = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const round = (v: number, k = 1e6) => Math.round(v * k) / k;
const finite3 = (p: unknown): p is Vec3 =>
  Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every((v) => Number.isFinite(v));

function polyLength(points: readonly Vec3[]) {
  let sum = 0;
  for (let k = 1; k < points.length; k++) sum += d3(points[k - 1], points[k]);
  return sum;
}

/** Nearest point of a polyline to a plan point (plan distance), with the rail z there. */
function nearestOnPolyline(points: readonly Vec3[], p: readonly number[]) {
  let best = { point: points[0], distance: Infinity, s: 0 };
  let along = 0;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1],
      b = points[k];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    const q = lerp3(a, b, t);
    const distance = d2(q, p);
    if (distance < best.distance) best = { point: q, distance, s: along + d3(a, q) };
    along += d3(a, b);
  }
  return { ...best, t: along > 0 ? best.s / along : 0 };
}

/** Densify a drawn arc through its first, middle and last points (3-D circle); others unchanged. */
function densifyArc(points: Vec3[], step: number): Vec3[] {
  if (points.length < 2) return points;
  const total = polyLength(points);
  let half = total / 2,
    mid = points[0];
  for (let k = 1; k < points.length; k++) {
    const l = d3(points[k - 1], points[k]);
    if (half <= l) {
      mid = lerp3(points[k - 1], points[k], l > 0 ? half / l : 0);
      break;
    }
    half -= l;
  }
  const a = points[0],
    b = mid,
    c = points[points.length - 1];
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const nn = n[0] ** 2 + n[1] ** 2 + n[2] ** 2;
  if (nn < 1e-12) return points;
  const ab2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const ac2 = ac[0] ** 2 + ac[1] ** 2 + ac[2] ** 2;
  // Circumcentre: a + ((|ac|²(n×ab)) + (|ab|²(ac×n))) / (2|n|²)
  const nxab = [
    n[1] * ab[2] - n[2] * ab[1],
    n[2] * ab[0] - n[0] * ab[2],
    n[0] * ab[1] - n[1] * ab[0],
  ];
  const acxn = [
    ac[1] * n[2] - ac[2] * n[1],
    ac[2] * n[0] - ac[0] * n[2],
    ac[0] * n[1] - ac[1] * n[0],
  ];
  const o: Vec3 = [0, 1, 2].map((i) => a[i] + (ac2 * nxab[i] + ab2 * acxn[i]) / (2 * nn)) as Vec3;
  const r = d3(o, a);
  const u = [a[0] - o[0], a[1] - o[1], a[2] - o[2]].map((v) => v / r);
  const nl = Math.sqrt(nn);
  const nu = n.map((v) => v / nl);
  const w = [nu[1] * u[2] - nu[2] * u[1], nu[2] * u[0] - nu[0] * u[2], nu[0] * u[1] - nu[1] * u[0]];
  const angleOf = (p: readonly number[]) => {
    const v = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    let t = Math.atan2(
      v[0] * w[0] + v[1] * w[1] + v[2] * w[2],
      v[0] * u[0] + v[1] * u[1] + v[2] * u[2],
    );
    if (t < 0) t += 2 * Math.PI;
    return t;
  };
  const sweep = angleOf(c);
  if (!(sweep > 0) || angleOf(b) > sweep) return points;
  const count = Math.max(2, Math.ceil((r * sweep) / step));
  const out: Vec3[] = [];
  for (let k = 0; k <= count; k++) {
    const t = (sweep * k) / count;
    out.push([0, 1, 2].map((i) => o[i] + r * (Math.cos(t) * u[i] + Math.sin(t) * w[i])) as Vec3);
  }
  out[0] = [...a];
  out[out.length - 1] = [...c];
  return out;
}

function pointInPolygon(p: readonly number[], ring: readonly (readonly number[])[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

function centroid(ring: readonly Vec2[]): Vec2 {
  let x = 0,
    y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return ring.length ? [x / ring.length, y / ring.length] : [0, 0];
}

function polygonArea(ring: readonly Vec2[]) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(s) / 2;
}

// --- sections -------------------------------------------------------------------------------------

function sectionFor(text: string): StructureModelInput['sections'][number] | null {
  const parsed = parseSectionName(text);
  if (!parsed || parsed.shape !== 'H') return null;
  const size = parsed.dims;
  const inTable = KS_H.some(
    (s) => s.h === size.h && s.b === size.b && s.tw === size.tw && s.tf === size.tf,
  );
  return {
    id: hId(size),
    name: hName(size),
    shape: 'H',
    dims_mm: { h: size.h, b: size.b, tw: size.tw, tf: size.tf, ...(size.r ? { r: size.r } : {}) },
    source: inTable ? 'KS D 3502' : 'user',
    provenance: { by: 'user', assumed: true, note: MODEL_ASSUMPTIONS.sections },
  };
}

/** Flat jig settings (scalars only): `deckD`·`deckL`·`dryD`·…, `restraintOn` + `restraintLevel`. */
export type FlatModelParams = Partial<Record<`${LoadZone}${'D' | 'L'}`, number>> & {
  restraintOn?: boolean;
};

function mergeParams(params: (Partial<ModelParams> & FlatModelParams) | undefined): ModelParams {
  const p = { ...DEFAULT_MODEL_PARAMS, ...(params ?? {}) };
  const loads = { ...DEFAULT_MODEL_PARAMS.loads };
  for (const zone of ['deck', 'dry', 'planter'] as const) {
    loads[zone] = { ...DEFAULT_MODEL_PARAMS.loads[zone], ...(params?.loads?.[zone] ?? {}) };
    for (const c of ['D', 'L'] as const) {
      const flat = params?.[`${zone}${c}`];
      if (typeof flat === 'number') loads[zone] = { ...loads[zone], [c]: flat };
    }
  }
  if (params?.restraintOn === false) p.restraintLevel = null;
  return { ...p, loads };
}

// --- the step -------------------------------------------------------------------------------------

export function model(
  inputs: ModelInputs,
  params: Partial<ModelParams> & FlatModelParams = {},
  overrides: ModelOverride[] = [],
): ModelOutput {
  const p = mergeParams(params);
  const issues: ModelIssue[] = [];
  const girdersIn = (inputs.steps?.girders?.girders ?? []).filter(
    (g) => g && typeof g.id === 'string' && Array.isArray(g.points),
  );
  const beamsStep = inputs.steps?.beams ?? { beams: [] };
  const cells = inputs.steps?.cells?.cells ?? beamsStep.cells ?? [];

  // Section overrides: { target: { kind: 'member', identity: { key } }, op: 'set', fields: { section } }.
  const sectionOverride = new Map<string, string>();
  for (const o of overrides ?? [])
    if (
      o?.op === 'set' &&
      o.target?.kind === 'member' &&
      typeof o.target.identity?.key === 'string' &&
      typeof o.fields?.section === 'string'
    )
      sectionOverride.set(o.target.identity.key, o.fields.section);

  const sections = new Map<string, StructureModelInput['sections'][number]>();
  const sectionId = (text: string, owner: string) => {
    const section = sectionFor(text);
    if (!section) {
      issues.push({
        level: 'error',
        code: 'SECTION_TEXT',
        message: `${owner}: 단면 '${text}'을 읽지 못함`,
      });
      return 'H-UNKNOWN';
    }
    sections.set(section.id, section);
    return section.id;
  };

  // 1. Girder rails: arcs densified (the library segments them to ≤ arcMaxLen).
  const rails = new Map<string, Vec3[]>();
  for (const g of girdersIn) {
    const points = g.points.filter(finite3).map((q) => [q[0], q[1], q[2]] as Vec3);
    if (points.length < 2 || polyLength(points) <= 1e-6) {
      issues.push({
        level: 'warning',
        code: 'GIRDER_SHORT',
        message: `거더 ${g.id}: 점이 부족해 제외`,
        members: [g.id],
      });
      continue;
    }
    rails.set(
      g.id,
      g.kind === 'arc' ? densifyArc(points, Math.min(0.25, p.arcMaxLen / 4)) : points,
    );
  }

  // 2. Drawn columns (vertical lines of the role 'columns').
  interface DrawnColumn {
    sourceId: string;
    index: number;
    base: Vec3;
    top: Vec3;
  }
  const drawn: DrawnColumn[] = [];
  (inputs.site?.columns?.rows ?? []).forEach((row, index) => {
    const line = row ? polylineOf(row) : null;
    if (!line) return;
    const a = line[0],
      b = line[line.length - 1];
    const [base, top] = a[2] <= b[2] ? [a, b] : [b, a];
    if (top[2] - base[2] < 0.1) return;
    drawn.push({
      sourceId: row.id === undefined || row.id === null ? `#${index}` : String(row.id),
      index,
      base: [base[0], base[1], base[2]],
      top: [top[0], top[1], top[2]],
    });
  });
  // Ids the girders step may use: the object id, '#index', and the diagnosis keys C01… (plan order).
  const byId = new Map<string, DrawnColumn>();
  const mm = (v: number) => Math.round(v * 1000);
  [...drawn]
    .sort((a, b) => mm(a.base[0]) - mm(b.base[0]) || mm(a.base[1]) - mm(b.base[1]))
    .forEach((c, k) => byId.set(`C${String(k + 1).padStart(2, '0')}`, c));
  for (const c of drawn) {
    byId.set(c.sourceId, c);
    byId.set(`#${c.index}`, c);
  }
  // The girders step's own keys win: its order (column tops, source id on ties) is not this one,
  // and stacked columns at one plan point must not swap.
  for (const ref of inputs.steps?.girders?.columns ?? []) {
    const c = drawn.find((d) => d.sourceId === ref?.sourceId);
    if (c && typeof ref.id === 'string') byId.set(ref.id, c);
  }

  // A column carries the girder points within supportTol of it in plan, plus the supports the
  // girders step named (snapped there already).
  interface Carry {
    girderId: string;
    point: Vec3;
  }
  const carries = new Map<DrawnColumn, Carry[]>();
  const zTol =
    typeof inputs.steps?.girders?.params?.zTol_m === 'number'
      ? inputs.steps.girders.params.zTol_m
      : 2.0;
  const addCarry = (c: DrawnColumn, carry: Carry) => {
    const list = carries.get(c) ?? [];
    if (!list.some((x) => x.girderId === carry.girderId)) list.push(carry);
    carries.set(c, list);
  };
  for (const g of girdersIn) {
    const rail = rails.get(g.id);
    if (!rail) continue;
    for (const c of drawn) {
      const near = nearestOnPolyline(rail, c.top);
      // Plan and height: a column of another storey under the girder in plan does not carry it.
      if (near.distance <= p.supportTol && Math.abs(near.point[2] - c.top[2]) <= zTol)
        addCarry(c, { girderId: g.id, point: near.point });
    }
    for (const s of g.supports ?? []) {
      const c = byId.get(String(s.columnId));
      if (!c) continue;
      const near = nearestOnPolyline(rail, c.top);
      addCarry(c, { girderId: g.id, point: near.point });
    }
  }

  const columnsOut: ColumnOut[] = [];
  const frameColumns: FrameColumn[] = [];
  const columnAtGirderEnd = new Map<string, Vec3>();
  const usedKeys = new Set<string>();
  for (const c of drawn) {
    const list = carries.get(c);
    if (!list?.length) {
      issues.push({
        level: 'warning',
        code: 'COLUMN_FREE',
        message: `기둥 ${c.sourceId}: 받치는 거더가 없어 제외`,
      });
      continue;
    }
    // The column top goes to the highest girder point it carries (top-of-steel line).
    const top = list.reduce((best, x) => (x.point[2] > best.point[2] ? x : best)).point;
    if (top[2] - c.base[2] < 0.1) {
      issues.push({
        level: 'warning',
        code: 'COLUMN_HEIGHT',
        message: `기둥 ${c.sourceId}: 거더가 기둥 하단보다 낮아 제외`,
      });
      continue;
    }
    let key = `col:${c.sourceId}`;
    while (usedKeys.has(key)) key += "'";
    usedKeys.add(key);
    // Web along the longest girder framing in (the main girder direction).
    let axis: Vec3 | undefined,
      longest = 0;
    for (const x of list) {
      const rail = rails.get(x.girderId)!;
      const l = polyLength(rail);
      if (l > longest) {
        longest = l;
        const a = rail[0],
          b = rail[rail.length - 1];
        axis = [b[0] - a[0], b[1] - a[1], 0];
      }
    }
    const section = sectionOverride.get(key) ?? p.columnSection;
    frameColumns.push({
      key,
      base: [top[0], top[1], c.base[2]],
      top: [top[0], top[1], top[2]],
      section: sectionId(section, `기둥 ${key}`),
      ...(axis && Math.hypot(axis[0], axis[1]) > 1e-9 ? { strongAxis: axis } : {}),
    });
    columnsOut.push({
      key,
      sourceId: c.sourceId,
      base: [round(top[0]), round(top[1]), round(c.base[2])],
      top: [round(top[0]), round(top[1]), round(top[2])],
      moved_m: round(d2(top, c.top), 1e4),
      girders: list.map((x) => x.girderId),
    });
    for (const x of list) columnAtGirderEnd.set(`${x.girderId}@${key}`, x.point);
  }
  const columnTops = frameColumns.map((c) => c.top);
  const atColumn = (q: readonly number[]) => columnTops.some((t) => d3(t, q) <= 1e-3);

  // 3. Members. Girders: rigid (setting) at columns, pinned elsewhere; a girder with one free end
  // off every support becomes a cantilever from its supported end.
  const members: FrameMember[] = [];
  const memberRail = new Map<string, Vec3[]>();
  const onOtherGirder = (id: string, q: Vec3) => {
    for (const [other, rail] of rails)
      if (other !== id && nearestOnPolyline(rail, q).distance <= 1e-3) return true;
    return false;
  };
  // Beam joints on each girder (for the top-flange brace positions).
  const bracesOf = new Map<string, number[]>();
  const snapToGirder = (
    girderId: string | undefined,
    q: Vec3,
  ): { point: Vec3; girderId?: string } => {
    let bestId = girderId && rails.has(girderId) ? girderId : undefined;
    let best = bestId ? nearestOnPolyline(rails.get(bestId)!, q) : undefined;
    if (!best || best.distance > p.supportTol * 4) {
      bestId = undefined;
      best = undefined;
      for (const [id, rail] of rails) {
        const near = nearestOnPolyline(rail, q);
        if (!best || near.distance < best.distance) {
          best = near;
          bestId = id;
        }
      }
    }
    if (!best || !bestId) return { point: q };
    const list = bracesOf.get(bestId) ?? [];
    if (best.t > 1e-6 && best.t < 1 - 1e-6) list.push(best.t);
    bracesOf.set(bestId, list);
    return { point: best.point, girderId: bestId };
  };

  interface PendingBeam {
    key: string;
    role: 'beam' | 'arm';
    rail: Vec3[];
    cellId?: string;
  }
  const pending: PendingBeam[] = [];
  for (const b of beamsStep.beams ?? []) {
    const points = (b.points ?? []).filter(finite3);
    if (points.length < 2) continue;
    // An end on the slab edge or a void (`girderId: null`) is free: the beam is carried as a
    // cantilever from its girder end, never pulled onto the nearest girder.
    const onA = b.from?.girderId !== null,
      onZ = b.to?.girderId !== null;
    if (!onA && !onZ) {
      issues.push({
        level: 'warning',
        code: 'BEAM_UNSUPPORTED',
        message: `B:${b.id}: 양 끝이 거더에 닿지 않아 해석에서 뺌`,
        members: [`B:${b.id}`],
      });
      continue;
    }
    if (!onA || !onZ) {
      const root = snapToGirder(
        (onA ? b.from?.girderId : b.to?.girderId) ?? undefined,
        onA ? points[0] : points[points.length - 1],
      ).point;
      const free = onA ? points[points.length - 1] : points[0];
      const tipAt: Vec3 = [free[0], free[1], root[2]];
      if (d3(root, tipAt) < 0.05) continue;
      pending.push({ key: `B:${b.id}`, role: 'arm', rail: [root, tipAt], cellId: b.cellId });
      continue;
    }
    const a = snapToGirder(b.from?.girderId ?? undefined, points[0]).point;
    const z = snapToGirder(b.to?.girderId ?? undefined, points[points.length - 1]).point;
    if (d3(a, z) < 0.05) continue;
    pending.push({ key: `B:${b.id}`, role: 'beam', rail: [a, z], cellId: b.cellId });
  }
  for (const e of beamsStep.edgeCantilevers ?? []) {
    const points = (e.points ?? []).filter(finite3);
    if (points.length < 2) continue;
    const root = snapToGirder(e.from?.girderId, points[0]).point;
    const tip = points[points.length - 1];
    const tipAt: Vec3 = [tip[0], tip[1], root[2]];
    if (d3(root, tipAt) < 0.05) continue;
    pending.push({ key: `A:${e.id}`, role: 'arm', rail: [root, tipAt] });
  }

  for (const g of girdersIn) {
    const rail = rails.get(g.id);
    if (!rail) continue;
    const start = rail[0],
      end = rail[rail.length - 1];
    const supported = [start, end].map((q) => atColumn(q) || onOtherGirder(g.id, q));
    const interiorSupport = columnTops.some((t) => {
      const near = nearestOnPolyline(rail, t);
      return near.distance <= 1e-3 && near.t > 1e-6 && near.t < 1 - 1e-6;
    });
    if (!supported[0] && !supported[1] && !interiorSupport) {
      issues.push({
        level: 'error',
        code: 'GIRDER_UNSUPPORTED',
        message: `거더 ${g.id}: 양 끝이 기둥·거더에 닿지 않음`,
        members: [`G:${g.id}`],
      });
      continue;
    }
    const key = `G:${g.id}`;
    // A free end is a cantilever tip: no release there (nothing else meets the node). Without an
    // interior column the supported end must hold the moment, so it is rigid.
    let freeEnd: 'i' | 'j' | undefined;
    if (!supported[0] || !supported[1]) {
      const tip = supported[0] ? 'j' : 'i';
      issues.push({
        level: 'warning',
        code: 'GIRDER_FREE_END',
        message: `거더 ${g.id}: ${tip === 'i' ? '시작' : '끝'} 끝이 떠 있어 내민 부분으로 봄`,
        members: [key],
      });
      if (!interiorSupport) freeEnd = tip;
    }
    const endOf = (q: Vec3, k: 0 | 1): 'rigid' | 'pinned' =>
      !supported[k] || freeEnd ? 'rigid' : atColumn(q) ? p.girderEnds : 'pinned';
    const ends: [FrameMember['ends'][0], FrameMember['ends'][1]] = [endOf(start, 0), endOf(end, 1)];
    const braces = [...new Set((bracesOf.get(g.id) ?? []).map((t) => round(t, 1e4)))].sort(
      (a, b) => a - b,
    );
    members.push({
      key,
      role: 'girder',
      rail,
      section: sectionId(sectionOverride.get(key) ?? p.girderSection, `거더 ${key}`),
      ends,
      ...(braces.length ? { bracedAt: braces } : {}),
      ...(freeEnd ? { freeEnd } : {}),
    });
    memberRail.set(key, rail);
  }
  for (const b of pending) {
    members.push({
      key: b.key,
      role: b.role,
      rail: b.rail,
      section: sectionId(
        sectionOverride.get(b.key) ?? (b.role === 'arm' ? p.cantileverSection : p.beamSection),
        `${b.role === 'arm' ? '내민 보' : '작은보'} ${b.key}`,
      ),
      // A cantilever's tip is free: no release there (a released free end is a mechanism).
      ends: b.role === 'arm' ? ['rigid', 'rigid'] : ['pinned', 'pinned'],
      ...(b.role === 'arm' ? { freeEnd: 'j' as const } : {}),
    });
    memberRail.set(b.key, b.rail);
  }

  // 4. Loads: zone area loads by tributary width on the beams, the rest of each cell on its girders.
  const zoneAt = (q: readonly number[]): LoadZone =>
    (inputs.planterZones ?? []).some((z) => z?.shape?.length >= 3 && pointInPolygon(q, z.shape))
      ? 'planter'
      : (inputs.dryZones ?? []).some((z) => z?.shape?.length >= 3 && pointInPolygon(q, z.shape))
        ? 'dry'
        : 'deck';
  const acc = new Map<string, { D: number; L: number; ceiling: number; zones: Set<LoadZone> }>();
  const addLoad = (key: string, w: number, zone: LoadZone) => {
    if (!(w > 0) || !memberRail.has(key)) return;
    const q = p.loads[zone];
    const row = acc.get(key) ?? { D: 0, L: 0, ceiling: 0, zones: new Set<LoadZone>() };
    row.D += q.D * w;
    row.L += q.L * w;
    row.ceiling += p.ceiling * w;
    row.zones.add(zone);
    acc.set(key, row);
  };
  let area = 0;
  const beamsOfCell = new Map<string, PendingBeam[]>();
  // A beam cut short by the slab edge or a void (an arm with a cell) carries its cell strip like
  // a beam; only the edge cantilevers outside every cell get their own strip below.
  for (const b of pending)
    if (b.cellId) beamsOfCell.set(b.cellId, [...(beamsOfCell.get(b.cellId) ?? []), b]);
  for (const cell of cells) {
    const ring = (cell.polygon ?? []).filter((q) => Array.isArray(q) && q.length >= 2) as Vec2[];
    if (ring.length < 3) continue;
    const cellArea =
      Number.isFinite(cell.area_m2) && cell.area_m2 > 0 ? cell.area_m2 : polygonArea(ring);
    area += cellArea;
    const zone = zoneAt(centroid(ring));
    const beams = beamsOfCell.get(cell.id) ?? [];
    let carried = 0;
    if (beams.length) {
      // Offsets across the beams (normal of the first beam), bounded by the cell's extent.
      const [a, b] = beams[0].rail;
      const l = d2(a, b) || 1;
      const nrm: Vec2 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
      const off = (q: readonly number[]) => q[0] * nrm[0] + q[1] * nrm[1];
      const lo = Math.min(...ring.map(off)),
        hi = Math.max(...ring.map(off));
      const sorted = beams
        .map((beam) => ({ beam, o: (off(beam.rail[0]) + off(beam.rail[1])) / 2 }))
        .sort((x, y) => x.o - y.o);
      sorted.forEach((x, k) => {
        const prev = k === 0 ? lo : sorted[k - 1].o;
        const next = k === sorted.length - 1 ? hi : sorted[k + 1].o;
        const width = Math.max(0, (next - prev) / 2);
        const length = d2(x.beam.rail[0], x.beam.rail[1]);
        const w = Math.min(width, (cellArea - carried) / Math.max(length, 1e-9));
        if (w > 0) {
          addLoad(x.beam.key, w, zone);
          carried += w * length;
        }
      });
    }
    const rest = cellArea - carried;
    const girderKeys = (cell.girderIds ?? [])
      .map((id) => `G:${id}`)
      .filter((k) => memberRail.has(k));
    const girderLength = girderKeys.reduce((s, k) => s + polyLength(memberRail.get(k)!), 0);
    if (rest > 1e-6 && girderLength > 0)
      for (const k of girderKeys) addLoad(k, rest / girderLength, zone);
    else if (rest > 1e-6)
      issues.push({
        level: 'warning',
        code: 'CELL_LOAD_LOST',
        message: `칸 ${cell.id}: 거더가 없어 ${round(rest, 100)} m² 하중을 싣지 못함`,
      });
  }
  const spacing = beamsStep.summary?.spacingUsed_m ?? 2.5;
  for (const b of pending)
    if (b.role === 'arm' && !b.cellId) {
      const tip = b.rail[1];
      addLoad(b.key, spacing, zoneAt(tip));
      area += spacing * d2(b.rail[0], tip);
    }

  const lineLoads: FrameLineLoad[] = [];
  const loads: LoadRow[] = [];
  let totalD = 0,
    totalL = 0;
  for (const [key, row] of [...acc].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const zone = row.zones.size === 1 ? [...row.zones][0] : 'mixed';
    const length = polyLength(memberRail.get(key)!);
    const push = (c: 'D' | 'L', value: number, source: 'area' | 'ceiling') => {
      if (!(value > 0)) return;
      lineLoads.push({ memberKey: key, case: c, value_kNpm: round(value, 1e4), source });
      loads.push({ memberKey: key, case: c, value_kNpm: round(value, 1e4), source, zone });
      if (c === 'D') totalD += value * length;
      else totalL += value * length;
    };
    push('D', row.D, 'area');
    push('L', row.L, 'area');
    push('D', row.ceiling, 'ceiling');
  }

  // 5. The frame model.
  if (p.restraintLevel === null)
    issues.push({
      level: 'warning',
      code: 'NO_RESTRAINT',
      message: '수평 구속 레벨(유수지 슬래브)이 설정되지 않음',
    });
  const plan: FramePlan = {
    name: 's06-frame',
    sections: [...sections.values()],
    columns: frameColumns,
    members,
    lineLoads,
    combos: MODEL_COMBOS,
    notional: p.notionalRatio > 0 ? { ratio: p.notionalRatio } : false,
    restraintLevels_m: p.restraintLevel === null ? [] : [p.restraintLevel],
    swayK: p.swayK,
    baseFixity: p.baseFixity,
    curve: { maxLen_m: p.arcMaxLen },
  };
  if (!frameColumns.length)
    issues.push({ level: 'error', code: 'NO_COLUMNS', message: '거더를 받치는 기둥이 없음' });
  plan.sections = [...sections.values()];
  const built = buildFrameModel(plan);
  const assumptions = [
    MODEL_ASSUMPTIONS.eccentricity,
    MODEL_ASSUMPTIONS.steel,
    p.restraintLevel === null ? MODEL_ASSUMPTIONS.noRestraint : MODEL_ASSUMPTIONS.restraint,
    MODEL_ASSUMPTIONS.joints,
    MODEL_ASSUMPTIONS.sections,
    MODEL_ASSUMPTIONS.loads,
    ...built.assumptions,
  ].filter((text, k, all) => all.indexOf(text) === k);
  for (const i of built.issues)
    issues.push({
      level: i.level === 'error' ? 'error' : 'warning',
      code: i.code,
      message: i.message,
      ...(i.members?.length ? { members: i.members } : {}),
    });
  const modelHash = createHash('sha256').update(JSON.stringify(built.model)).digest('hex');
  return {
    schema: 'vide.s06.model/1',
    params: p,
    model: built.model,
    map: built.map,
    modelHash,
    assumptions,
    issues,
    columns: columnsOut,
    loads,
    totals: { area_m2: round(area, 100), D_kN: round(totalD, 100), L_kN: round(totalL, 100) },
    summary: {
      columns: frameColumns.length,
      girders: members.filter((m) => m.role === 'girder').length,
      beams: members.filter((m) => m.role === 'beam').length,
      cantilevers: members.filter((m) => m.role === 'arm').length,
      segments: built.model.members.length,
      errors: issues.filter((i) => i.level === 'error').length,
      warnings: issues.filter((i) => i.level === 'warning').length,
    },
  };
}

// S-06 골조 jig ① 진단 (PLAN-23 T-044, SPEC-06.14): reads the layout as it is drawn — new columns
// and girders, new footing blocks, existing footings and the basin's underground beams — and
// reports footing interference and girder spans. Nothing is generated or analysed and no host is
// touched. A pure step `(inputs, params) → output` in the shape of a v3 `code` step, so T-051 can
// move it as it is; geometry comes from the official `vide/geometry-kit`. No node: imports.
// Lengths are metres, plan is XY.
//
// Footprints are the real ones: a block definition placed by its instance transform, rotation
// kept. A block whose definition is missing is never replaced by an unrotated bounding box; the
// judgements that need it become '미완' with the reason.

import {
  GeometryError,
  blockFootprints,
  clipConvex,
  convexHull,
  pointInPolygon,
  polygonArea,
  separation,
  splitAtSupports,
  transformPoints,
  validatePolygon,
  type BlockDefinition,
  type CurvePiece,
  type FootprintMode,
  type Polygon,
  type Vec2,
  type Vec3,
} from '../../../../src/jigs/official/geometry-kit/index.ts';
import { ROLE_LABEL, VERDICT_RANK, type Judgement, type RoleKey, type Verdict } from './labels.ts';

/** One Sync scene row of a role layer (layer name decoded). Coordinates are metres. */
export interface DiagnoseRow {
  syncId: string;
  id: string;
  nativeId?: string;
  layer: string;
  name?: string;
  /** Polyline points, flat xyz (curves). */
  line?: ArrayLike<number>;
  /** Display mesh, flat xyz (Breps, meshes). */
  vertices?: ArrayLike<number>;
  /** Wire segments, flat xyz pairs. */
  segments?: ArrayLike<number>;
  /** Block instance: definition id in `definitions[syncId]` and its row-major 4×4 transform. */
  block?: { definition: string; transform: ArrayLike<number> };
}

/** Rows by role. A role left out makes the judgements that need it '미완'. */
export type DiagnoseInputs = { [K in RoleKey]?: DiagnoseRow[] } & {
  /** Block definitions by Sync id, then definition id. */
  definitions?: Record<string, Record<string, BlockDefinition>>;
};

export interface DiagnoseParams {
  /** Span limit (m), for every girder including diagonals (결정 F2.4·D5). */
  spanMax: number;
  /** Plan distance (m) within which a column top cuts a girder curve. */
  splitTol: number;
  /** Side of the square column section (m); the square turns with the column's pile cap. */
  columnSize: number;
  /** Clear distance (m) a pile cap keeps from existing footings; closer is '불가'. */
  capClearance: number;
  /** An open cut over an existing footing: '협의' (civil consultation list) or '불가'. */
  openCutRule: 'consult' | 'forbid';
  /**
   * Side (m) of the open cut assumed for a footing block that has no open-cut outline: a square
   * on the pile cap's centre, turned with the cap. null: such a block's open cut is '미완'.
   */
  openCutSize: number | null;
}
/** Generic defaults; a work instance brings the project's own values (PLAN-23 설정값 표). */
export const DEFAULT_PARAMS: DiagnoseParams = {
  spanMax: 12,
  splitTol: 0.3,
  columnSize: 0.5,
  capClearance: 0,
  openCutRule: 'consult',
  openCutSize: null,
};

export interface ObjectRef {
  syncId: string;
  id: string;
  layer: string;
  name?: string;
}
export interface Box {
  min: Vec3;
  max: Vec3;
}
export interface Measure {
  verdict: Verdict;
  /** Signed plan distance (m) to the nearest footprint: < 0 overlap depth, > 0 clear gap. */
  distance: number | null;
  /** Overlap area with every overlapping footprint (m²). */
  area: number;
  /** Number of footprints overlapped. */
  overlaps: number;
  /** The nearest footprint. */
  target?: ObjectRef;
  /** Why the check is '미완'. */
  reason?: string;
}
export interface InterferenceRow {
  /** C01, C02 … in plan order; overlay items carry it before ':'. */
  key: string;
  column: ObjectRef;
  bottom: Vec3;
  top: Vec3;
  /** The new footing block under the column. */
  footing?: ObjectRef;
  cap: Measure;
  openCut: Measure;
  basin: Measure;
  /** Worst of the three. */
  verdict: Verdict;
  focus: Box;
}
export interface SpanRow {
  /** G01-1, G01-2 … along the curve. */
  key: string;
  girderKey: string;
  girder: ObjectRef;
  /** `unsupported`: no column top within the tolerance, so the curve has no span. */
  kind: 'span' | 'overhang' | 'unsupported';
  /** Column keys at the ends (twin columns joined with ·); null is a free end. */
  from: string | null;
  to: string | null;
  /** Plan length along the curve (m): the value compared with the span limit. */
  length: number;
  /** Along the curve in 3D (m). */
  length3d: number;
  /** Spans only: 통과·초과. Overhangs are shown, not judged (cantilever limits come with M1). */
  verdict: Verdict | null;
  reason?: string;
  focus: Box;
  /** The piece of the girder curve (world metres); the whole curve for an unsupported one. */
  points: Vec3[];
}
export interface CurveRow {
  key: string;
  girder: ObjectRef;
  planLength: number;
  length3d: number;
  /** Column stations on the curve and the spans between them. */
  supports: number;
  spans: number;
  /** Plan length above the span limit: a reference column, never counted as a span excess. */
  overLimit: boolean;
  focus: Box;
}
export interface CountSummary {
  /** Rows the check flags (불가 / 협의 / 경고). */
  count: number;
  incomplete: number;
  /** Set when the whole check could not run. */
  reason?: string;
}
export interface DiagnoseSummary {
  columns: number;
  girders: number;
  cap: CountSummary;
  openCut: CountSummary;
  basin: CountSummary;
  spans: {
    total: number;
    over: number;
    overhangs: number;
    unsupported: number;
    max: number | null;
    maxKey?: string;
    reason?: string;
  };
  curves: { total: number; over: number; max: number | null; maxKey?: string; reason?: string };
}
export type OverlayTone =
  | 'ov-grid'
  | 'ov-new'
  | 'ov-existing'
  | 'ov-clash'
  | 'ok'
  | 'warn'
  | 'ng'
  | 'na';
/** A display primitive of the viewport overlay contract (PLAN-22 T-041), world metres. */
export type OverlayItem = { id: string; tone?: OverlayTone; label?: string } & (
  | { kind: 'polygon'; points: Vec2[]; z: number; fill?: boolean }
  | { kind: 'polyline'; points: Vec3[]; closed?: boolean; dashed?: boolean; width?: number }
  | { kind: 'point'; at: Vec3 }
);
export interface OverlayLayer {
  key: string;
  title: string;
  items: OverlayItem[];
}
export interface DiagnoseOutput {
  schema: 'vide.s06.diagnose/1';
  params: DiagnoseParams;
  summary: DiagnoseSummary;
  /** Checks that could not run at all, with the reason. */
  missing: { judgement: Judgement; reason: string }[];
  tables: { interference: InterferenceRow[]; spans: SpanRow[]; curves: CurveRow[] };
  overlays: OverlayLayer[];
  /** Objects left out and why (e.g. unreadable blocks), in plain words. */
  notes: string[];
}

/** A column finds its new footing block by containment, else by insertion point this close (m). */
const MATCH_DISTANCE = 1.0;
/** An unreadable footing this close (m) to a footprint's reach makes that check '미완'. */
const UNREADABLE_REACH = 3.0;
/**
 * Footprints closer than this (m) either way are touching (distance 0). Sync rounds coordinates
 * to 1 µm, so two footprints drawn edge to edge can read a fraction of a micrometre into each
 * other; that is not an overlap (S-06 real data: one cap 0.1 µm into an existing footing).
 */
const CONTACT_TOLERANCE = 1e-5;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

interface Shape {
  ref: ObjectRef;
  hull: Polygon;
  center: Vec2;
  radius: number;
  z: [number, number];
}
interface Unreadable {
  ref: ObjectRef;
  anchor: Vec2 | null;
  reason: string;
}
interface NewFooting {
  ref: ObjectRef;
  anchor: Vec2 | null;
  cap?: Shape;
  capAngle?: number;
  cut?: Shape;
  /** The open cut is the assumed square of `openCutSize`, not a drawn outline. */
  cutAssumed?: boolean;
  capError?: string;
  cutError?: string;
}
type Source =
  | { definition: BlockDefinition; transform: ArrayLike<number>; anchor: Vec2 }
  | { error: string; anchor: Vec2 | null };

function resolve(params: Partial<DiagnoseParams>): DiagnoseParams {
  // Known keys only: the result echoes its parameters, so nothing else passes through.
  const out = { ...DEFAULT_PARAMS };
  for (const key of Object.keys(DEFAULT_PARAMS) as (keyof DiagnoseParams)[])
    if (params[key] !== undefined) Object.assign(out, { [key]: params[key] });
  for (const key of ['spanMax', 'splitTol', 'columnSize', 'capClearance'] as const)
    if (!Number.isFinite(out[key]) || out[key] < 0)
      throw new GeometryError('no-nan', `${key} ${String(out[key])}`);
  if (!(out.spanMax > 0) || !(out.columnSize > 0))
    throw new RangeError('spanMax and columnSize must be positive');
  if (out.openCutRule !== 'consult' && out.openCutRule !== 'forbid')
    throw new RangeError(`openCutRule ${String(out.openCutRule)}`);
  if (out.openCutSize !== null && !(Number.isFinite(out.openCutSize) && out.openCutSize > 0))
    throw new GeometryError('no-nan', `openCutSize ${String(out.openCutSize)}`);
  return out;
}

const refOf = (row: DiagnoseRow): ObjectRef => ({
  syncId: row.syncId,
  id: row.id,
  layer: row.layer,
  ...(row.name ? { name: row.name } : {}),
});
const key2 = (prefix: string, n: number) => prefix + String(n).padStart(2, '0');
const mm = (value: number) => Math.round(value * 1000);
const planOrder = (a: readonly number[], b: readonly number[]) =>
  mm(a[0]) - mm(b[0]) || mm(a[1]) - mm(b[1]);

function polyline(flat?: ArrayLike<number>): Vec3[] | null {
  if (!flat || flat.length < 6 || flat.length % 3 !== 0) return null;
  const out: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) {
    const p: Vec3 = [flat[i], flat[i + 1], flat[i + 2]];
    if (!p.every(Number.isFinite)) return null;
    out.push(p);
  }
  return out;
}

function meanXY(flat: ArrayLike<number>): Vec2 | null {
  let x = 0,
    y = 0,
    n = 0;
  for (let i = 0; i + 2 < flat.length; i += 3) {
    x += flat[i];
    y += flat[i + 1];
    n++;
  }
  return n && Number.isFinite(x) && Number.isFinite(y) ? [x / n, y / n] : null;
}

/** Where a row's shape comes from: a block definition and transform, or its own mesh/wires. */
function sourceOf(row: DiagnoseRow, definitions: DiagnoseInputs['definitions']): Source {
  if (row.block) {
    const t = row.block.transform;
    const anchor: Vec2 | null =
      t && t.length === 16 && Number.isFinite(t[3]) && Number.isFinite(t[7]) ? [t[3], t[7]] : null;
    const definition = definitions?.[row.syncId]?.[row.block.definition];
    if (!definition) return { error: '블록 정의를 읽지 못함', anchor };
    if (!anchor) return { error: '블록 배치 변환을 읽지 못함', anchor };
    return { definition, transform: t, anchor };
  }
  const flat = row.vertices?.length ? row.vertices : row.segments;
  if (flat?.length) {
    const anchor = meanXY(flat);
    if (!anchor) return { error: '좌표에 숫자가 아닌 값이 있음', anchor: null };
    return {
      definition: { vertices: row.vertices, segments: row.segments },
      transform: IDENTITY,
      anchor,
    };
  }
  return { error: '블록이나 솔리드가 아님', anchor: null };
}

function centroid(points: readonly Vec2[]): Vec2 {
  let x = 0,
    y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
}

function shapeOf(ref: ObjectRef, hull: Polygon, z: [number, number]): Shape | string {
  if (!validatePolygon(hull, { convex: true }).ok) return '평면 외곽이 면적을 이루지 않음';
  const center = centroid(hull);
  let radius = 0;
  for (const p of hull) radius = Math.max(radius, Math.hypot(p[0] - center[0], p[1] - center[1]));
  return { ref, hull, center, radius, z };
}

function footprintShape(
  ref: ObjectRef,
  source: Extract<Source, { definition: BlockDefinition }>,
  mode: FootprintMode,
): { shape: Shape; angle: number; center: Vec2 } | string {
  try {
    const footprint = blockFootprints(source.definition, source.transform, mode);
    const shape = shapeOf(ref, footprint.hull, footprint.z);
    return typeof shape === 'string'
      ? shape
      : { shape, angle: footprint.rect.angleDeg, center: footprint.rect.center };
  } catch (error) {
    if (!(error instanceof GeometryError)) throw error;
    return error.code === 'no-nan'
      ? '좌표에 숫자가 아닌 값이 있음'
      : mode === 'outline'
        ? '외곽선이 면적을 이루지 않음'
        : '솔리드가 평면에서 면적을 이루지 않음';
  }
}

/** Plan band of a mesh (convex hull) and its height range. */
function bandShape(
  ref: ObjectRef,
  source: Extract<Source, { definition: BlockDefinition }>,
): Shape | string {
  const vertices = source.definition.vertices;
  if (!vertices?.length) return '솔리드가 없음';
  let world: Float64Array;
  try {
    world = transformPoints(vertices, source.transform);
  } catch (error) {
    if (error instanceof GeometryError) return '좌표에 숫자가 아닌 값이 있음';
    throw error;
  }
  const points: Vec2[] = [];
  let z0 = Infinity,
    z1 = -Infinity;
  for (let i = 0; i < world.length; i += 3) {
    points.push([world[i], world[i + 1]]);
    z0 = Math.min(z0, world[i + 2]);
    z1 = Math.max(z1, world[i + 2]);
  }
  return shapeOf(ref, convexHull(points), [z0, z1]);
}

function square(center: Vec2, size: number, angleDeg: number): Polygon {
  const h = size / 2,
    a = (angleDeg * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  return (
    [
      [-h, -h],
      [h, -h],
      [h, h],
      [-h, h],
    ] as const
  ).map(([x, y]): Vec2 => [center[0] + c * x - s * y, center[1] + s * x + c * y]);
}

/** Direction (deg) of the polyline segment nearest to `at` in plan. */
function directionAt(points: readonly Vec3[], at: readonly number[]) {
  let best = Infinity,
    angle = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const length2 = dx * dx + dy * dy;
    if (!(length2 > 0)) continue;
    let t = ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / length2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(at[0] - (a[0] + t * dx), at[1] - (a[1] + t * dy));
    if (d < best) {
      best = d;
      angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    }
  }
  return angle;
}

interface Measured {
  /** Nearest footprint and signed distance; null without targets. */
  nearest: { distance: number; target: Shape } | null;
  overlaps: { target: Shape; polygon: Polygon; area: number }[];
  /** Unreadable footprints near enough that they could matter. */
  unreadableNear: number;
}

/**
 * Signed distance from a convex footprint to the nearest target and every overlap. Bounding
 * circles skip targets that cannot be nearer (or overlap) once one exact distance is known.
 */
function measure(subject: Polygon, targets: readonly Shape[], unreadable: Unreadable[]): Measured {
  const center = centroid(subject);
  let radius = 0;
  for (const p of subject)
    radius = Math.max(radius, Math.hypot(p[0] - center[0], p[1] - center[1]));
  const bound = new Float64Array(targets.length);
  let seed = -1;
  targets.forEach((t, k) => {
    bound[k] = Math.hypot(t.center[0] - center[0], t.center[1] - center[1]) - radius - t.radius;
    if (seed < 0 || bound[k] < bound[seed]) seed = k;
  });
  const out: Measured = { nearest: null, overlaps: [], unreadableNear: 0 };
  const visit = (k: number) => {
    const target = targets[k];
    const exact = separation(subject, target.hull).distance;
    const distance = Math.abs(exact) < CONTACT_TOLERANCE ? 0 : exact;
    if (!out.nearest || distance < out.nearest.distance) out.nearest = { distance, target };
    if (distance < 0) {
      const polygon = clipConvex(subject, target.hull);
      if (polygon.length >= 3) out.overlaps.push({ target, polygon, area: polygonArea(polygon) });
    }
  };
  if (seed >= 0) visit(seed);
  for (let k = 0; k < targets.length; k++)
    if (k !== seed && bound[k] < Math.max(out.nearest!.distance, 0)) visit(k);
  out.unreadableNear = unreadable.filter(
    (u) =>
      u.anchor &&
      Math.hypot(u.anchor[0] - center[0], u.anchor[1] - center[1]) <= radius + UNREADABLE_REACH,
  ).length;
  return out;
}

function boxOf(points: readonly (readonly number[])[], z0: number, z1: number): Box {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  return { min: [x0, y0, Math.min(z0, z1)], max: [x1, y1, Math.max(z0, z1)] };
}
/** A loop, not Math.min(...spread): a finely drawn curve can have more points than a call takes. */
function zRange(points: readonly Vec3[]): [number, number] {
  let z0 = Infinity,
    z1 = -Infinity;
  for (const p of points) {
    if (p[2] < z0) z0 = p[2];
    if (p[2] > z1) z1 = p[2];
  }
  return [z0, z1];
}

const worst = (...verdicts: Verdict[]) =>
  verdicts.reduce((a, b) => (VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a), 'pass' as Verdict);

const incomplete = (reason: string): Measure => ({
  verdict: 'incomplete',
  distance: null,
  area: 0,
  overlaps: 0,
  reason,
});

/** Run the diagnosis. Invalid parameters throw; bad objects are left out and named in `notes`. */
export function diagnose(
  inputs: DiagnoseInputs,
  params: Partial<DiagnoseParams> = {},
): DiagnoseOutput {
  const p = resolve(params);
  const notes: string[] = [];
  const missing: DiagnoseOutput['missing'] = [];
  const roleMissing = (key: RoleKey) => {
    const rows = inputs[key];
    if (!rows) return `${ROLE_LABEL[key]} 레이어를 지정하지 않았습니다`;
    if (!rows.length) return `지정한 ${ROLE_LABEL[key]} 레이어에 객체가 없습니다`;
    return undefined;
  };

  // Columns: vertical curves, bottom = lowest point, top = highest (drawn either way).
  const columns: { row: DiagnoseRow; key: string; bottom: Vec3; top: Vec3 }[] = [];
  let skipped = 0;
  for (const row of inputs.columns ?? []) {
    const points = polyline(row.line);
    if (!points) {
      skipped++;
      continue;
    }
    let bottom = points[0],
      top = points[0];
    for (const q of points) {
      if (q[2] < bottom[2]) bottom = q;
      if (q[2] > top[2]) top = q;
    }
    columns.push({ row, key: '', bottom, top });
  }
  if (skipped) notes.push(`신설 기둥 레이어에서 곡선이 아닌 객체 ${skipped}개는 뺐습니다.`);
  columns.sort((a, b) => planOrder(a.bottom, b.bottom) || a.row.id.localeCompare(b.row.id));
  columns.forEach((c, k) => (c.key = key2('C', k + 1)));
  const columnsMissing =
    roleMissing('columns') ?? (columns.length ? undefined : '신설 기둥 레이어에 곡선이 없습니다');

  // Girders: curves, split at column tops within the plan tolerance.
  const girders: { row: DiagnoseRow; key: string; points: Vec3[] }[] = [];
  skipped = 0;
  for (const row of inputs.girders ?? []) {
    const points = polyline(row.line);
    if (points) girders.push({ row, key: '', points });
    else skipped++;
  }
  if (skipped) notes.push(`거더 레이어에서 곡선이 아닌 객체 ${skipped}개는 뺐습니다.`);
  const middle = (points: Vec3[]) => {
    const a = points[0],
      b = points[points.length - 1];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  girders.sort(
    (a, b) => planOrder(middle(a.points), middle(b.points)) || a.row.id.localeCompare(b.row.id),
  );
  girders.forEach((g, k) => (g.key = key2('G', k + 1)));
  const girdersMissing =
    roleMissing('girders') ?? (girders.length ? undefined : '거더 레이어에 곡선이 없습니다');
  if (girdersMissing) {
    missing.push({ judgement: 'span', reason: girdersMissing });
    missing.push({ judgement: 'curve', reason: girdersMissing });
  } else if (columnsMissing)
    missing.push({ judgement: 'span', reason: `${columnsMissing} — 거더를 끊을 기둥이 없습니다` });

  const spans: SpanRow[] = [];
  const curves: CurveRow[] = [];
  const spanItems: OverlayItem[] = [];
  const girderAngle = new Map<number, number>();
  const supports = columns.map((c) => c.top);
  for (const g of girders) {
    const split = splitAtSupports(g.points, columnsMissing ? [] : supports, p.splitTol);
    const [z0, z1] = zRange(g.points);
    curves.push({
      key: g.key,
      girder: refOf(g.row),
      planLength: split.planLength,
      length3d: split.length,
      supports: split.stations.length,
      spans: split.spans.length,
      overLimit: split.planLength > p.spanMax + 1e-9,
      focus: boxOf(g.points, z0, z1),
    });
    if (columnsMissing) continue;
    for (const station of split.stations) {
      const angle = directionAt(g.points, station.point);
      for (const k of station.supports) if (!girderAngle.has(k)) girderAngle.set(k, angle);
    }
    const at = (station: number | null) =>
      station === null
        ? null
        : split.stations[station].supports.map((k) => columns[k].key).join('·');
    const pieces: CurvePiece[] = [
      ...split.overhangs.filter((o) => o.from === null),
      ...split.spans,
      ...split.overhangs.filter((o) => o.from !== null),
    ];
    if (!pieces.length) {
      spans.push({
        key: `${g.key}-1`,
        girderKey: g.key,
        girder: refOf(g.row),
        kind: 'unsupported',
        from: null,
        to: null,
        length: split.planLength,
        length3d: split.length,
        verdict: 'incomplete',
        reason: `허용오차 ${p.splitTol} m 안에 기둥 상단이 없어 경간을 나눌 수 없습니다`,
        focus: boxOf(g.points, z0, z1),
        points: g.points,
      });
      continue;
    }
    pieces.forEach((piece, n) => {
      const over = piece.kind === 'span' && piece.planLength > p.spanMax + 1e-9;
      const row: SpanRow = {
        key: `${g.key}-${n + 1}`,
        girderKey: g.key,
        girder: refOf(g.row),
        kind: piece.kind,
        from: at(piece.from),
        to: at(piece.to),
        length: piece.planLength,
        length3d: piece.length,
        verdict: piece.kind === 'span' ? (over ? 'over' : 'pass') : null,
        focus: boxOf(piece.points, ...zRange(piece.points)),
        points: piece.points,
      };
      spans.push(row);
      if (over)
        spanItems.push({
          id: `${row.key}:span`,
          kind: 'polyline',
          points: piece.points,
          tone: 'ng',
          width: 4,
          label: `${row.length.toFixed(1)} m`,
        });
    });
  }

  // New footings: pile cap = the whole solid, open cut = the outline curves of the same block
  // (or, when asked, a square of the set size on the cap, turned with it).
  const newItems: OverlayItem[] = [];
  const newFootings: NewFooting[] = (inputs.newFootings ?? []).map((row, n) => {
    const ref = refOf(row);
    const source = sourceOf(row, inputs.definitions);
    if ('error' in source)
      return { ref, anchor: source.anchor, capError: source.error, cutError: source.error };
    const footing: NewFooting = { ref, anchor: source.anchor };
    let capRect: { center: Vec2; angle: number; z: [number, number] } | undefined;
    if (!source.definition.vertices?.length)
      footing.capError = '신설 기초 블록에 파일캡 솔리드가 없음';
    else {
      const cap = footprintShape(ref, source, 'solid');
      if (typeof cap === 'string') footing.capError = cap;
      else {
        footing.cap = cap.shape;
        footing.capAngle = cap.angle;
        capRect = { center: cap.center, angle: cap.angle, z: cap.shape.z };
        newItems.push({
          id: `F${n + 1}:cap`,
          kind: 'polygon',
          points: cap.shape.hull,
          z: cap.shape.z[1],
          tone: 'ov-new',
        });
      }
    }
    let cut: Shape | string;
    const assumed = !source.definition.segments?.length && p.openCutSize !== null && !!capRect;
    if (source.definition.segments?.length) {
      const drawn = footprintShape(ref, source, 'outline');
      cut = typeof drawn === 'string' ? drawn : drawn.shape;
    } else if (assumed)
      cut = shapeOf(ref, square(capRect!.center, p.openCutSize!, capRect!.angle), capRect!.z);
    else cut = '신설 기초 블록에 오픈컷 외곽선이 없음';
    if (typeof cut === 'string') footing.cutError = cut;
    else {
      footing.cut = cut;
      footing.cutAssumed = assumed;
      const z = cut.z[1];
      newItems.push({
        id: `F${n + 1}:cut`,
        kind: 'polyline',
        points: cut.hull.map(([x, y]): Vec3 => [x, y, z]),
        closed: true,
        dashed: true,
        tone: 'ov-new',
      });
    }
    return footing;
  });
  const assumedCuts = newFootings.filter((f) => f.cutAssumed).length;
  if (assumedCuts)
    notes.push(
      `신설 기초 ${assumedCuts}개는 블록에 오픈컷 외곽선이 없어 ${p.openCutSize} m 정사각(파일캡 중심·회전)으로 가정했습니다.`,
    );
  const badFootings = newFootings.filter((f) => f.capError && f.cutError).length;
  if (badFootings)
    notes.push(
      `신설 기초 ${badFootings}개는 형상을 읽지 못했습니다. 그 위의 기둥은 파일캡·오픈컷 판정이 미완입니다.`,
    );

  // Existing footings (the footing slab: lowest band of the solid) and the basin's beams.
  const existingItems: OverlayItem[] = [];
  const readShapes = (
    key: RoleKey,
    read: (
      ref: ObjectRef,
      source: Extract<Source, { definition: BlockDefinition }>,
    ) => Shape | string,
    prefix: string,
  ) => {
    const shapes: Shape[] = [];
    const unreadable: Unreadable[] = [];
    for (const row of inputs[key] ?? []) {
      const ref = refOf(row);
      const source = sourceOf(row, inputs.definitions);
      const shape = 'error' in source ? source.error : read(ref, source);
      if (typeof shape === 'string') {
        unreadable.push({ ref, anchor: source.anchor, reason: shape });
        continue;
      }
      shapes.push(shape);
      existingItems.push({
        id: `${prefix}${shapes.length}`,
        kind: 'polygon',
        points: shape.hull,
        z: shape.z[1],
        tone: 'ov-existing',
      });
    }
    if (unreadable.length) {
      const reasons = [...new Set(unreadable.map((u) => u.reason))].join(', ');
      notes.push(
        `${ROLE_LABEL[key]} ${unreadable.length}개는 형상을 읽지 못해 판정에서 뺐습니다(${reasons}). 가까운 기둥의 판정은 미완입니다.`,
      );
    }
    return { shapes, unreadable };
  };
  const existing = readShapes(
    'existingFootings',
    (ref, source) => {
      const mode: FootprintMode | undefined = source.definition.vertices?.length
        ? 'base'
        : source.definition.segments?.length
          ? 'outline'
          : undefined;
      if (!mode) return '솔리드도 외곽선도 없음';
      const result = footprintShape(ref, source, mode);
      return typeof result === 'string' ? result : result.shape;
    },
    'E',
  );
  const basin = readShapes('basinGirders', bandShape, 'B');

  const existingMissing =
    roleMissing('existingFootings') ??
    (existing.shapes.length
      ? undefined
      : '기존 기초 레이어에서 형상을 읽을 수 있는 객체가 없습니다');
  const newMissing = roleMissing('newFootings');
  const basinMissing =
    roleMissing('basinGirders') ??
    (basin.shapes.length ? undefined : '유수지 보 레이어에서 형상을 읽을 수 있는 객체가 없습니다');
  const capMissing = columnsMissing ?? newMissing ?? existingMissing;
  if (capMissing) {
    missing.push({ judgement: 'cap', reason: capMissing });
    missing.push({ judgement: 'openCut', reason: capMissing });
  }
  if (columnsMissing ?? basinMissing)
    missing.push({ judgement: 'basin', reason: (columnsMissing ?? basinMissing)! });

  // Per column: its footing, then the three distances.
  const interference: InterferenceRow[] = [];
  const clashItems: OverlayItem[] = [];
  const columnItems: OverlayItem[] = [];
  if (!columnsMissing)
    columns.forEach((column, k) => {
      const at: Vec2 = [column.bottom[0], column.bottom[1]];
      let footing: NewFooting | undefined;
      if (!newMissing) {
        const near = (f: NewFooting) =>
          f.anchor ? Math.hypot(f.anchor[0] - at[0], f.anchor[1] - at[1]) : Infinity;
        const containing = newFootings.filter(
          (f) =>
            f.cap &&
            Math.hypot(f.cap.center[0] - at[0], f.cap.center[1] - at[1]) <= f.cap.radius + 0.05 &&
            pointInPolygon(at, f.cap.hull, 0.05),
        );
        footing = (containing.length ? containing : newFootings)
          .filter((f) => containing.length || near(f) <= MATCH_DISTANCE)
          .sort((a, b) => near(a) - near(b))[0];
      }
      const angle = footing?.capAngle ?? girderAngle.get(k) ?? 0;
      const section = square(at, p.columnSize, angle);
      columnItems.push({
        id: `${column.key}:column`,
        kind: 'polygon',
        points: section,
        z: column.bottom[2],
        tone: 'ov-new',
      });
      const focusPoints: Vec2[] = [...section];
      // One number tag per column, on its first 불가 or 경고 overlap (협의 is common: no tag).
      let tagged = false;
      const check = (
        subject: Polygon,
        targets: { shapes: Shape[]; unreadable: Unreadable[] },
        flagged: (distance: number) => Verdict | null,
        clash: { part: string; tone: OverlayTone; frameTarget: boolean },
      ): Measure => {
        const result = measure(subject, targets.shapes, targets.unreadable);
        const nearest = result.nearest!;
        const flag = flagged(nearest.distance);
        // Footings are small enough to frame whole; a basin beam can run the length of the site.
        focusPoints.push(...subject, ...(clash.frameTarget ? nearest.target.hull : []));
        result.overlaps.forEach((overlap, j) => {
          const tag = !tagged && (flag === 'forbidden' || flag === 'warning');
          if (tag) tagged = true;
          focusPoints.push(...overlap.polygon);
          clashItems.push({
            id: `${column.key}:${clash.part}#${j + 1}`,
            kind: 'polygon',
            points: overlap.polygon,
            z: overlap.target.z[1],
            fill: true,
            tone: flag === 'forbidden' ? 'ov-clash' : clash.tone,
            ...(tag ? { label: column.key } : {}),
          });
        });
        // Closer than the set clearance without touching: outline the footprint instead of a fill.
        if (flag && !result.overlaps.length) {
          const tag = !tagged && (flag === 'forbidden' || flag === 'warning');
          if (tag) tagged = true;
          const z = nearest.target.z[1];
          clashItems.push({
            id: `${column.key}:${clash.part}#0`,
            kind: 'polyline',
            points: subject.map(([x, y]): Vec3 => [x, y, z]),
            closed: true,
            width: 3,
            tone: flag === 'forbidden' ? 'ov-clash' : clash.tone,
            ...(tag ? { label: column.key } : {}),
          });
        }
        const measured = {
          distance: nearest.distance,
          area: result.overlaps.reduce((sum, o) => sum + o.area, 0),
          overlaps: result.overlaps.length,
          target: nearest.target.ref,
        };
        if (flag) return { verdict: flag, ...measured };
        if (result.unreadableNear)
          return {
            verdict: 'incomplete',
            ...measured,
            reason: `가까운 객체 ${result.unreadableNear}개의 형상을 읽지 못했습니다(회전 없는 경계 상자로 대신하지 않음)`,
          };
        return { verdict: 'pass', ...measured };
      };
      let cap: Measure, openCut: Measure;
      if (capMissing) cap = openCut = incomplete(capMissing);
      else if (!footing)
        cap = openCut = incomplete('기둥 아래에서 신설 기초 블록을 찾지 못했습니다');
      else {
        cap = footing.cap
          ? check(footing.cap.hull, existing, (d) => (d < p.capClearance ? 'forbidden' : null), {
              part: 'cap',
              tone: 'ov-clash',
              frameTarget: true,
            })
          : incomplete(footing.capError ?? '파일캡 형상이 없습니다');
        openCut = footing.cut
          ? check(
              footing.cut.hull,
              existing,
              (d) => (d < 0 ? (p.openCutRule === 'consult' ? 'consult' : 'forbidden') : null),
              { part: 'cut', tone: 'warn', frameTarget: true },
            )
          : incomplete(footing.cutError ?? '오픈컷 형상이 없습니다');
      }
      const basinMeasure = basinMissing
        ? incomplete(basinMissing)
        : check(section, basin, (d) => (d < 0 ? 'warning' : null), {
            part: 'basin',
            tone: 'warn',
            frameTarget: false,
          });
      interference.push({
        key: column.key,
        column: refOf(column.row),
        bottom: column.bottom,
        top: column.top,
        ...(footing ? { footing: footing.ref } : {}),
        cap,
        openCut,
        basin: basinMeasure,
        verdict: worst(cap.verdict, openCut.verdict, basinMeasure.verdict),
        focus: boxOf(focusPoints, column.bottom[2], column.top[2]),
      });
    });

  const count = (pick: (row: InterferenceRow) => Measure, reason?: string): CountSummary => {
    const measures = interference.map(pick);
    return {
      count: measures.filter((m) => m.verdict !== 'pass' && m.verdict !== 'incomplete').length,
      incomplete: measures.filter((m) => m.verdict === 'incomplete').length,
      ...(reason ? { reason } : {}),
    };
  };
  const longest = <T extends { key: string }>(rows: T[], length: (row: T) => number) =>
    rows.reduce<T | undefined>((a, b) => (!a || length(b) > length(a) ? b : a), undefined);
  const realSpans = spans.filter((s) => s.kind === 'span');
  const maxSpan = longest(realSpans, (s) => s.length);
  const maxCurve = longest(curves, (c) => c.planLength);
  const spanReason = missing.find((m) => m.judgement === 'span')?.reason;
  const curveReason = missing.find((m) => m.judgement === 'curve')?.reason;
  return {
    schema: 'vide.s06.diagnose/1',
    params: p,
    summary: {
      columns: columns.length,
      girders: girders.length,
      cap: count((r) => r.cap, missing.find((m) => m.judgement === 'cap')?.reason),
      openCut: count((r) => r.openCut, missing.find((m) => m.judgement === 'openCut')?.reason),
      basin: count((r) => r.basin, missing.find((m) => m.judgement === 'basin')?.reason),
      spans: {
        total: realSpans.length,
        over: realSpans.filter((s) => s.verdict === 'over').length,
        overhangs: spans.filter((s) => s.kind === 'overhang').length,
        unsupported: spans.filter((s) => s.kind === 'unsupported').length,
        max: maxSpan ? maxSpan.length : null,
        ...(maxSpan ? { maxKey: maxSpan.key } : {}),
        ...(spanReason ? { reason: spanReason } : {}),
      },
      curves: {
        total: curves.length,
        over: curves.filter((c) => c.overLimit).length,
        max: maxCurve ? maxCurve.planLength : null,
        ...(maxCurve ? { maxKey: maxCurve.key } : {}),
        ...(curveReason ? { reason: curveReason } : {}),
      },
    },
    missing,
    tables: { interference, spans, curves },
    overlays: [
      { key: 's06-existing', title: '기존 기초·유수지 보', items: existingItems },
      { key: 's06-new', title: '파일캡·오픈컷·기둥', items: [...newItems, ...columnItems] },
      { key: 's06-clash', title: '간섭', items: clashItems },
      { key: 's06-spans', title: '경간 초과 거더', items: spanItems },
    ],
    notes,
  };
}

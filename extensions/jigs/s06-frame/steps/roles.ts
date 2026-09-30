// Input roles of the S-06 frame jig (PLAN-23 T-051, SPEC-06.10, SPEC-07.5) and the code that turns
// a confirmed role snapshot (`{ rows, definitions }` of a jig input read) into plan geometry: slab
// outline with voids, block footprints, basin bands, grid and joint lines, the (u, v) frame of the
// existing footings. The AI proposes which layer plays a role and a person confirms it; nothing
// here invents a coordinate. Pure, no node: imports; geometry comes from `vide/geometry-kit`.

import {
  GeometryError,
  bandFromMesh,
  blockFootprints,
  outlineFromMesh,
  pointInPolygon,
  polygonArea,
  requirePolygon,
  signedArea,
  transformPoints,
  type BlockDefinition,
  type FootprintMode,
  type Polygon,
  type Vec2,
  type Vec3,
} from '../../../../src/jigs/official/geometry-kit/index.ts';
import type { DiagnoseInputs, DiagnoseRow } from './diagnose.ts';
import { decodeText } from './sync-input.ts';

/** Roles of the assembly input `site` (jig.json); the first five are the M0 diagnosis roles. */
export type RoleId =
  | 'columns'
  | 'girders'
  | 'newFootings'
  | 'existingFootings'
  | 'basinGirders'
  | 'slab'
  | 'voids'
  | 'existingGrid'
  | 'newEJ'
  | 'existingEJ';
export const ROLE_IDS: readonly RoleId[] = [
  'slab',
  'voids',
  'existingFootings',
  'basinGirders',
  'existingGrid',
  'newEJ',
  'existingEJ',
  'columns',
  'girders',
  'newFootings',
];
export const ROLE_TITLE: Record<RoleId, string> = {
  slab: '슬래브 경계',
  voids: '보이드·설치 불가 영역',
  existingFootings: '기존 기초',
  basinGirders: '유수지 보',
  existingGrid: '기존 그리드',
  newEJ: '신설 E.J.',
  existingEJ: '기존 E.J.',
  columns: '현재 배치 · 신설 기둥',
  girders: '현재 배치 · 거더',
  newFootings: '현재 배치 · 신설 기초',
};

/** One row of a role snapshot: a Sync scene row with its layer name decoded by the runtime. */
export interface SiteRow {
  id?: unknown;
  nativeId?: unknown;
  layer?: unknown;
  layer64?: unknown;
  name?: unknown;
  name64?: unknown;
  line?: unknown;
  vertices?: unknown;
  indices?: unknown;
  segments?: unknown;
  block?: unknown;
  [key: string]: unknown;
}
export interface RoleRows {
  rows: SiteRow[];
  definitions?: Record<string, unknown>;
  snapshot?: unknown;
}
export type SiteInput = Partial<Record<RoleId, RoleRows>>;
/** A drawn zone of the instance (runtime `Zone`): plan ring in world metres. */
export interface ZoneInput {
  id: string;
  shape: [number, number][];
}

export interface ObjectRef {
  syncId: string;
  id: string;
  layer: string;
  name?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const numbers = (value: unknown): number[] | undefined =>
  Array.isArray(value) && value.length ? (value as number[]) : undefined;
export const layerOf = (row: SiteRow) =>
  typeof row.layer === 'string' ? row.layer : decodeText(row.layer64);
export const nameOf = (row: SiteRow) =>
  typeof row.name === 'string' && row.name ? row.name : decodeText(row.name64);

/** The rows of a role as the diagnosis reads them; `syncId` is the role, so definitions stay apart. */
export function toDiagnoseRows(
  role: RoleId,
  data: RoleRows | undefined,
): { rows: DiagnoseRow[]; definitions: Record<string, BlockDefinition> } {
  const rows: DiagnoseRow[] = [];
  const definitions: Record<string, BlockDefinition> = {};
  const all = isRecord(data?.definitions) ? data.definitions : {};
  (data?.rows ?? []).forEach((row, index) => {
    if (!isRecord(row)) return;
    const out: DiagnoseRow = {
      syncId: role,
      id: row.id === undefined || row.id === null ? `#${index}` : String(row.id),
      layer: layerOf(row),
    };
    if (typeof row.nativeId === 'string') out.nativeId = row.nativeId;
    const name = nameOf(row);
    if (name) out.name = name;
    const line = numbers(row.line),
      vertices = numbers(row.vertices),
      segments = numbers(row.segments);
    if (line) out.line = line;
    if (vertices) out.vertices = vertices;
    if (segments) out.segments = segments;
    if (isRecord(row.block) && typeof row.block.definition === 'string') {
      out.block = {
        definition: row.block.definition,
        transform: numbers(row.block.transform) ?? [],
      };
      const definition = all[row.block.definition];
      if (isRecord(definition))
        definitions[row.block.definition] = {
          vertices: numbers(definition.vertices),
          indices: numbers(definition.indices),
          segments: numbers(definition.segments),
        };
    }
    rows.push(out);
  });
  return { rows, definitions };
}

/** The M0 diagnosis inputs from the assembled site roles (roles left out stay '미완'). */
export function diagnoseInputsOf(site: SiteInput): DiagnoseInputs {
  const inputs: DiagnoseInputs = { definitions: {} };
  for (const role of [
    'columns',
    'girders',
    'newFootings',
    'existingFootings',
    'basinGirders',
  ] as const) {
    if (!site[role]) continue;
    const read = toDiagnoseRows(role, site[role]);
    inputs[role] = read.rows;
    inputs.definitions![role] = read.definitions;
  }
  return inputs;
}

// --- plan shapes --------------------------------------------------------------------------------

export function polylineOf(row: SiteRow): Vec3[] | null {
  const flat = numbers(row.line);
  if (!flat || flat.length < 6 || flat.length % 3 !== 0) return null;
  const out: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) {
    const p: Vec3 = [flat[i], flat[i + 1], flat[i + 2]];
    if (!p.every(Number.isFinite)) return null;
    out.push(p);
  }
  return out;
}

export interface RingShape {
  ref: ObjectRef;
  /** Counter-clockwise outer ring. */
  outer: Polygon;
  holes: Polygon[];
  z: [number, number];
  area: number;
  source: 'curve' | 'mesh';
}

const refOf = (role: RoleId, row: SiteRow, index: number): ObjectRef => {
  const name = nameOf(row);
  return {
    syncId: role,
    id: row.id === undefined || row.id === null ? `#${index}` : String(row.id),
    layer: layerOf(row),
    ...(name ? { name } : {}),
  };
};
const zRange = (points: readonly Vec3[]): [number, number] => {
  let z0 = Infinity,
    z1 = -Infinity;
  for (const p of points) {
    if (p[2] < z0) z0 = p[2];
    if (p[2] > z1) z1 = p[2];
  }
  return [z0, z1];
};

/**
 * Plan rings of a role: closed curves (first point back on the last within 10 mm) and the top faces
 * of meshes (`outlineFromMesh`, voids kept). Rows that make no ring are named in `unreadable`.
 */
export function ringsOf(
  role: RoleId,
  data: RoleRows | undefined,
): { shapes: RingShape[]; unreadable: { ref: ObjectRef; reason: string }[] } {
  const shapes: RingShape[] = [];
  const unreadable: { ref: ObjectRef; reason: string }[] = [];
  const all = isRecord(data?.definitions) ? data.definitions : {};
  (data?.rows ?? []).forEach((row, index) => {
    if (!isRecord(row)) return;
    const ref = refOf(role, row, index);
    const points = polylineOf(row);
    if (points) {
      const a = points[0],
        b = points[points.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.01) {
        unreadable.push({ ref, reason: '닫히지 않은 곡선' });
        return;
      }
      try {
        const ring = requirePolygon(points, '곡선');
        const outer = signedArea(ring) > 0 ? ring : ring.reverse();
        shapes.push({
          ref,
          outer,
          holes: [],
          z: zRange(points),
          area: polygonArea(outer),
          source: 'curve',
        });
      } catch (error) {
        if (!(error instanceof GeometryError)) throw error;
        unreadable.push({ ref, reason: '곡선이 면적을 이루지 않음' });
      }
      return;
    }
    let vertices = numbers(row.vertices),
      indices = numbers(row.indices),
      transform: number[] | undefined;
    if (isRecord(row.block) && typeof row.block.definition === 'string') {
      const definition = all[row.block.definition];
      if (!isRecord(definition)) {
        unreadable.push({ ref, reason: '블록 정의를 읽지 못함' });
        return;
      }
      vertices = numbers(definition.vertices);
      indices = numbers(definition.indices);
      transform = numbers(row.block.transform);
    }
    if (!vertices || !indices) {
      unreadable.push({ ref, reason: '곡선도 솔리드도 아님' });
      return;
    }
    try {
      const outlines = outlineFromMesh(vertices, indices, { transform, simplify: 0.001 });
      for (const outline of outlines)
        shapes.push({
          ref,
          outer: outline.outer,
          holes: outline.holes,
          z: outline.z,
          area: outline.area,
          source: 'mesh',
        });
    } catch (error) {
      if (!(error instanceof GeometryError)) throw error;
      unreadable.push({ ref, reason: '메시 윗면 외곽을 읽지 못함' });
    }
  });
  return { shapes, unreadable };
}

export interface SlabRegion {
  outer: Polygon;
  holes: Polygon[];
  z: [number, number];
  area: number;
  source: 'curve' | 'mesh';
  ref: ObjectRef;
  /** Other slab pieces that were not merged (largest is the region). */
  others: number;
}

/** The slab: the largest ring of the slab role; smaller rings inside it and the void role are holes. */
export function slabOf(
  slab: RoleRows | undefined,
  voids?: RoleRows,
): { region: SlabRegion | null; notes: string[] } {
  const notes: string[] = [];
  const read = ringsOf('slab', slab);
  if (read.unreadable.length)
    notes.push(
      `슬래브 경계 ${read.unreadable.length}개는 읽지 못했습니다(${[...new Set(read.unreadable.map((u) => u.reason))].join(', ')}).`,
    );
  if (!read.shapes.length) return { region: null, notes };
  const sorted = [...read.shapes].sort((a, b) => b.area - a.area);
  const main = sorted[0];
  const holes: Polygon[] = [...main.holes];
  let others = 0;
  for (const shape of sorted.slice(1)) {
    if (pointInPolygon(shape.outer[0], main.outer, 0)) holes.push([...shape.outer].reverse());
    else others++;
  }
  const voidRead = voids ? ringsOf('voids', voids) : { shapes: [], unreadable: [] };
  if (voidRead.unreadable.length)
    notes.push(`보이드 ${voidRead.unreadable.length}개는 읽지 못했습니다.`);
  for (const shape of voidRead.shapes) holes.push([...shape.outer].reverse());
  if (others)
    notes.push(`슬래브 경계가 ${others + 1}조각입니다. 가장 큰 조각만 배치 범위로 씁니다.`);
  let area = main.area;
  for (const hole of holes) area -= polygonArea(hole);
  return {
    region: {
      outer: main.outer,
      holes,
      z: main.z,
      area,
      source: main.source,
      ref: main.ref,
      others,
    },
    notes,
  };
}

/** The slab underside at a plan point: down-facing triangles of the slab mesh, else the ring's z. */
export function undersideSampler(slab: RoleRows | undefined) {
  const triangles: { a: Vec3; b: Vec3; c: Vec3 }[] = [];
  const all = isRecord(slab?.definitions) ? slab.definitions : {};
  let ringZ: number | null = null;
  for (const row of slab?.rows ?? []) {
    if (!isRecord(row)) continue;
    const points = polylineOf(row);
    if (points) {
      const [z0] = zRange(points);
      ringZ = ringZ === null ? z0 : Math.min(ringZ, z0);
      continue;
    }
    let vertices = numbers(row.vertices),
      indices = numbers(row.indices),
      transform: number[] | undefined;
    if (isRecord(row.block) && typeof row.block.definition === 'string') {
      const definition = all[row.block.definition];
      if (!isRecord(definition)) continue;
      vertices = numbers(definition.vertices);
      indices = numbers(definition.indices);
      transform = numbers(row.block.transform);
    }
    if (!vertices || !indices || indices.length % 3 !== 0) continue;
    let world: Float64Array;
    try {
      world = transformPoints(vertices, transform);
    } catch {
      continue;
    }
    const at = (i: number): Vec3 => [world[3 * i], world[3 * i + 1], world[3 * i + 2]];
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = at(indices[i]),
        b = at(indices[i + 1]),
        c = at(indices[i + 2]);
      if (![...a, ...b, ...c].every(Number.isFinite)) continue;
      const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
      const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const length = Math.hypot(nx, ny, nz);
      if (length > 0 && nz / length < -0.7) triangles.push({ a, b, c });
    }
  }
  const lowest = triangles.length
    ? Math.min(...triangles.flatMap((t) => [t.a[2], t.b[2], t.c[2]]))
    : ringZ;
  return {
    kind: triangles.length
      ? ('mesh' as const)
      : ringZ !== null
        ? ('curve' as const)
        : ('none' as const),
    /** Underside z at (x, y); the mesh's lowest z when no down face covers the point. */
    at(x: number, y: number): number | null {
      for (const { a, b, c } of triangles) {
        const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (Math.abs(d) < 1e-12) continue;
        const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
        const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
        const l3 = 1 - l1 - l2;
        if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return l1 * a[2] + l2 * b[2] + l3 * c[2];
      }
      return lowest;
    },
  };
}

// --- footprints, bands, lines -------------------------------------------------------------------

export interface FootprintShape {
  ref: ObjectRef;
  /** Convex plan hull, counter-clockwise. */
  hull: Polygon;
  center: Vec2;
  /** Angle (deg) of the minimum-area rectangle, folded to (−45°, 45°] for a square. */
  angleDeg: number;
  z: [number, number];
}
type Source =
  | { definition: BlockDefinition; transform: ArrayLike<number> | undefined; anchor: Vec2 | null }
  | { error: string };
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function sourceOf(row: SiteRow, all: Record<string, unknown>): Source {
  if (isRecord(row.block)) {
    if (typeof row.block.definition !== 'string') return { error: '블록 정의 이름이 없음' };
    const definition = all[row.block.definition];
    if (!isRecord(definition)) return { error: '블록 정의를 읽지 못함' };
    const t = numbers(row.block.transform);
    if (!t || t.length !== 16) return { error: '블록 배치 변환을 읽지 못함' };
    return {
      definition: {
        vertices: numbers(definition.vertices),
        indices: numbers(definition.indices),
        segments: numbers(definition.segments),
      },
      transform: t,
      anchor: [t[3], t[7]],
    };
  }
  const vertices = numbers(row.vertices),
    segments = numbers(row.segments);
  if (vertices || segments)
    return { definition: { vertices, segments }, transform: IDENTITY, anchor: null };
  return { error: '블록이나 솔리드가 아님' };
}
const centroid = (points: readonly Vec2[]): Vec2 => {
  let x = 0,
    y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
};

/** Plan footprints of a block or solid role (`base`: the lowest band, the footing slab). */
export function footprintsOf(
  role: RoleId,
  data: RoleRows | undefined,
  mode: FootprintMode = 'base',
): { shapes: FootprintShape[]; unreadable: { ref: ObjectRef; reason: string }[] } {
  const shapes: FootprintShape[] = [];
  const unreadable: { ref: ObjectRef; reason: string }[] = [];
  const all = isRecord(data?.definitions) ? data.definitions : {};
  (data?.rows ?? []).forEach((row, index) => {
    if (!isRecord(row)) return;
    const ref = refOf(role, row, index);
    const source = sourceOf(row, all);
    if ('error' in source) {
      unreadable.push({ ref, reason: source.error });
      return;
    }
    const wanted: FootprintMode = source.definition.vertices?.length
      ? mode
      : source.definition.segments?.length
        ? 'outline'
        : mode;
    try {
      const footprint = blockFootprints(source.definition, source.transform ?? IDENTITY, wanted);
      shapes.push({
        ref,
        hull: footprint.hull,
        center: centroid(footprint.hull),
        angleDeg: footprint.rect.angleDeg,
        z: footprint.z,
      });
    } catch (error) {
      if (!(error instanceof GeometryError)) throw error;
      unreadable.push({
        ref,
        reason:
          error.code === 'no-nan'
            ? '좌표에 숫자가 아닌 값이 있음'
            : '평면 발자국이 면적을 이루지 않음',
      });
    }
  });
  return { shapes, unreadable };
}

/** Plan bands (convex hull) of the basin's underground beams. */
export function bandsOf(
  role: RoleId,
  data: RoleRows | undefined,
): { shapes: FootprintShape[]; unreadable: { ref: ObjectRef; reason: string }[] } {
  const shapes: FootprintShape[] = [];
  const unreadable: { ref: ObjectRef; reason: string }[] = [];
  const all = isRecord(data?.definitions) ? data.definitions : {};
  (data?.rows ?? []).forEach((row, index) => {
    if (!isRecord(row)) return;
    const ref = refOf(role, row, index);
    const source = sourceOf(row, all);
    if ('error' in source) {
      unreadable.push({ ref, reason: source.error });
      return;
    }
    const vertices = source.definition.vertices;
    if (!vertices?.length) {
      unreadable.push({ ref, reason: '솔리드가 없음' });
      return;
    }
    try {
      const world = transformPoints(vertices, source.transform);
      const hull = bandFromMesh(vertices, source.transform);
      let z0 = Infinity,
        z1 = -Infinity;
      for (let i = 2; i < world.length; i += 3) {
        if (world[i] < z0) z0 = world[i];
        if (world[i] > z1) z1 = world[i];
      }
      shapes.push({ ref, hull, center: centroid(hull), angleDeg: 0, z: [z0, z1] });
    } catch (error) {
      if (!(error instanceof GeometryError)) throw error;
      unreadable.push({ ref, reason: '평면 띠가 면적을 이루지 않음' });
    }
  });
  return { shapes, unreadable };
}

export interface LineShape {
  ref: ObjectRef;
  key: string;
  name: string;
  a: Vec2;
  b: Vec2;
  z: number;
  /** A polyline with more than two points is read by its ends. */
  bent: boolean;
}
/** Straight lines of a role (grid lines, expansion joints), keyed in the order read. */
export function linesOf(role: RoleId, data: RoleRows | undefined, prefix: string) {
  const lines: LineShape[] = [];
  const unreadable: { ref: ObjectRef; reason: string }[] = [];
  (data?.rows ?? []).forEach((row, index) => {
    if (!isRecord(row)) return;
    const ref = refOf(role, row, index);
    const points = polylineOf(row);
    if (!points) {
      unreadable.push({ ref, reason: '곡선이 아님' });
      return;
    }
    const a = points[0],
      b = points[points.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) {
      unreadable.push({ ref, reason: '길이가 없는 선' });
      return;
    }
    lines.push({
      ref,
      key: `${prefix}${lines.length + 1}`,
      name: ref.name ?? `${prefix}${lines.length + 1}`,
      a: [a[0], a[1]],
      b: [b[0], b[1]],
      z: (a[2] + b[2]) / 2,
      bent: points.length > 2,
    });
  });
  return { lines, unreadable };
}

// --- frame ----------------------------------------------------------------------------------------

export interface Frame {
  origin: Vec2;
  angleDeg: number;
  u: Vec2;
  v: Vec2;
  source: 'footings' | 'grid' | 'manual' | 'none';
}
export const frameFrom = (origin: Vec2, angleDeg: number, source: Frame['source']): Frame => {
  // Rounded to 1e-4°: a footing block read with float noise still gives the same frame and keys.
  const deg = Number(angleDeg.toFixed(4));
  const a = (deg * Math.PI) / 180;
  return {
    origin,
    angleDeg: deg,
    u: [Math.cos(a), Math.sin(a)],
    v: [-Math.sin(a), Math.cos(a)],
    source,
  };
};
export const toLocal = (f: Frame, p: readonly number[]): Vec2 => {
  const dx = p[0] - f.origin[0],
    dy = p[1] - f.origin[1];
  return [dx * f.u[0] + dy * f.u[1], dx * f.v[0] + dy * f.v[1]];
};
export const toWorld = (f: Frame, p: readonly number[]): Vec2 => [
  f.origin[0] + p[0] * f.u[0] + p[1] * f.v[0],
  f.origin[1] + p[0] * f.u[1] + p[1] * f.v[1],
];
/** An angle folded to (−45°, 45°]: a grid is the same after a quarter turn. */
export const foldAngle = (deg: number) => {
  let a = deg % 90;
  if (a > 45) a -= 90;
  if (a <= -45) a += 90;
  return a;
};
/** Dominant angle (deg, folded) of shapes or lines: the median of the folded angles. */
export function dominantAngle(angles: readonly number[]): number | null {
  if (!angles.length) return null;
  const folded = angles.map(foldAngle).sort((a, b) => a - b);
  return folded[Math.floor((folded.length - 1) / 2)];
}

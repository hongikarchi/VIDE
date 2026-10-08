// 법규 체크의 모델 읽기 (SPEC-15.3·15.4 4·15.10 1, ARCH-03 §8.6, PLAN-48 T-237): display rows of
// one linked Rhino document (the jig input read, same form as the display Sync) + the project's
// classification records → `ClassifiedModel`. Pure: no host, no AI, no storage.
//
// Shapes: a mesh that welds into a closed solid (geometry-kit `weldSolid`·`checkSolid`) is a
// `solid`; a closed curve or a flat mesh (planar surface, hatch fill) lying level within 1 mm is a
// `region`; a block instance or point is a `point`. Nothing is repaired: an object whose shape does
// not fit its role is listed with the role it would have had (SPEC-15.3 5).
//
// Coordinates: display rows are already metres (the host scales them, DisplayScene); `coordinates:
// 'document'` takes raw document units and multiplies by the unit factor. Either way the result is
// document metres − `origin` (the massing work copy's local frame, SPEC-15.5 5). Unknown units never
// fail the read: `toMeters` is null and the engine marks every length row 검사 불가 (SPEC-15.3 1).
// The only numbers here are geometric tolerances (1 mm) and unit factors.

import {
  classifiedModelSchema,
  type ClassifiedModel,
  type ClassifiedObject,
  type ComplianceRoleName,
  type ComplianceRoleRecord,
  type Mesh,
  type PlanRegion,
  type UNCLASSIFIED_REASONS,
  type UNUSED_SHAPES,
} from '../../../contracts/compliance.ts';
import { signedArea, type Vec2, type Vec3 } from '../geometry-kit/plan.ts';
import { checkSolid, solidPolygon, weldSolid, type Solid } from '../geometry-kit/solid.ts';
import { alternativeReading, indexRecords, roleOf, type RoleRow } from './conventions.ts';

/** Level and closing tolerance (m): 1 mm (SPEC-15.3, PLAN-48 T-237). */
export const LEVEL_TOL = 0.001;

type UnclassifiedReason = (typeof UNCLASSIFIED_REASONS)[number];
type UnusedShape = (typeof UNUSED_SHAPES)[number];

/** Rhino `UnitSystem` names → metres. Anything else (None, CustomUnits, missing) is unknown. */
const UNIT_FACTORS: Record<string, number> = {
  nanometers: 1e-9,
  microns: 1e-6,
  millimeters: 1e-3,
  centimeters: 1e-2,
  decimeters: 1e-1,
  meters: 1,
  dekameters: 10,
  hectometers: 100,
  kilometers: 1000,
  microinches: 0.0254e-6,
  mils: 0.0254e-3,
  inches: 0.0254,
  feet: 0.3048,
  yards: 0.9144,
  miles: 1609.344,
};
export function unitsToMeters(units: unknown): number | null {
  if (typeof units !== 'string') return null;
  return UNIT_FACTORS[units.trim().toLowerCase()] ?? null;
}

// --- row decoding -----------------------------------------------------------------------------

const decode64 = (value: unknown) => {
  if (typeof value !== 'string' || !value) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
    );
  } catch {
    return '';
  }
};
/** Plain numbers from a JSON array, a typed array (packed positions keep their origin) or {0:…}. */
function numbers(value: unknown): number[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(Number);
  if (ArrayBuffer.isView(value)) {
    const array = Array.from(value as unknown as ArrayLike<number>);
    const origin = (value as { origin?: unknown }).origin;
    if (Array.isArray(origin) && origin.length === 3)
      for (let i = 0; i < array.length; i++) array[i] += Number(origin[i % 3]);
    return array;
  }
  if (typeof value === 'object')
    return Object.keys(value)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => Number((value as Record<string, unknown>)[k]));
  return [];
}
export const layerOfRow = (row: Record<string, unknown>) =>
  typeof row.layer === 'string' ? row.layer : decode64(row.layer64);
export function attributesOfRow(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(row.attributes64))
    for (const pair of row.attributes64)
      if (Array.isArray(pair) && pair.length === 2) out[decode64(pair[0])] = decode64(pair[1]);
  // Already decoded (tests, older captures).
  if (row.attributes && typeof row.attributes === 'object' && !Array.isArray(row.attributes))
    for (const [k, v] of Object.entries(row.attributes as Record<string, unknown>))
      if (typeof v === 'string') out[k] = v;
  return out;
}

// --- shapes -----------------------------------------------------------------------------------

export type AnalyzedShape =
  | { kind: 'solid'; mesh: Mesh; closed: true; volume: number }
  | { kind: 'open-solid'; mesh: Mesh }
  | { kind: 'region'; region: PlanRegion; z: number }
  | { kind: 'point'; at: Vec3 }
  | { kind: 'bad'; shape: UnusedShape; reason: '닫히지 않음' | '평면이 아님' };

/** What one display row is, in local metres (shape and bounds). */
export interface RowFacts {
  objectId: string;
  layer: string;
  nativeType: string;
  attributes: Record<string, string>;
  geometryHash: string | null;
  hidden: boolean;
  shape: AnalyzedShape | { kind: 'other' };
  bounds: { min: Vec3; max: Vec3 } | null;
}

const HASH = /^[a-f0-9]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function boundsOf(xyz: readonly number[]): RowFacts['bounds'] {
  if (xyz.length < 3) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < xyz.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], xyz[i + k]);
      max[k] = Math.max(max[k], xyz[i + k]);
    }
  return { min, max };
}

/** A ring in plan from xyz points (closing point dropped), counter-clockwise; null when degenerate. */
function ringOf(points: readonly Vec3[]): Vec2[] | null {
  const ring: Vec2[] = [];
  for (const p of points) {
    const last = ring[ring.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) <= 1e-9) continue;
    ring.push([p[0], p[1]]);
  }
  while (
    ring.length > 1 &&
    Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) <=
      LEVEL_TOL
  )
    ring.pop();
  if (ring.length < 3 || !(Math.abs(signedArea(ring)) > 1e-12)) return null;
  return signedArea(ring) > 0 ? ring : ring.reverse();
}

/**
 * A curve's polyline (`line`). Rhino gives a polyline as its points (a closed one repeats the
 * first) and any other curve as 128 division points of a closed curve or 129 of an open one, so a
 * closed smooth curve does not repeat its start: 128 points whose closing gap is no longer than
 * the longest division count as closed.
 */
function curveShape(xyz: readonly number[]): AnalyzedShape {
  const points: Vec3[] = [];
  for (let i = 0; i + 2 < xyz.length; i += 3) points.push([xyz[i], xyz[i + 1], xyz[i + 2]]);
  if (points.length < 3) return { kind: 'bad', shape: 'curve', reason: '닫히지 않음' };
  const first = points[0];
  const last = points[points.length - 1];
  const gap = Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]);
  let longest = 0;
  for (let i = 1; i < points.length; i++)
    longest = Math.max(
      longest,
      Math.hypot(
        points[i][0] - points[i - 1][0],
        points[i][1] - points[i - 1][1],
        points[i][2] - points[i - 1][2],
      ),
    );
  const closed = gap <= LEVEL_TOL || (points.length === 128 && gap <= longest * 1.5);
  if (!closed) return { kind: 'bad', shape: 'curve', reason: '닫히지 않음' };
  const zs = points.map((p) => p[2]);
  if (Math.max(...zs) - Math.min(...zs) > LEVEL_TOL)
    return { kind: 'bad', shape: 'curve', reason: '평면이 아님' };
  const ring = ringOf(points);
  if (!ring) return { kind: 'bad', shape: 'curve', reason: '닫히지 않음' };
  return { kind: 'region', region: { outer: ring, holes: [] }, z: Math.min(...zs) };
}

/** Boundary loops of a flat triangle mesh (edges used by one triangle), chained. */
function boundaryLoops(v: readonly number[], f: readonly number[]): Vec3[][] | null {
  // Weld equal positions first (render meshes repeat vertices per face).
  const ids = new Map<string, number>();
  const at: Vec3[] = [];
  const idOf = (i: number) => {
    const p: Vec3 = [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
    const key = `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)},${Math.round(p[2] * 1e6)}`;
    let id = ids.get(key);
    if (id === undefined) {
      ids.set(key, (id = at.length));
      at.push(p);
    }
    return id;
  };
  const directed = new Map<string, [number, number]>();
  const count = new Map<string, number>();
  for (let t = 0; t + 2 < f.length; t += 3) {
    const tri = [idOf(f[t]), idOf(f[t + 1]), idOf(f[t + 2])];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
    for (let e = 0; e < 3; e++) {
      const a = tri[e],
        b = tri[(e + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
      directed.set(key, [a, b]);
    }
  }
  const next = new Map<number, number>();
  for (const [key, n] of count) {
    if (n !== 1) continue;
    const [a, b] = directed.get(key)!;
    if (next.has(a)) return null; // a vertex where two boundaries meet: not a simple region
    next.set(a, b);
  }
  const loops: Vec3[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: Vec3[] = [];
    let i: number | undefined = start;
    while (i !== undefined && !seen.has(i)) {
      seen.add(i);
      loop.push(at[i]);
      i = next.get(i);
    }
    if (i !== start) return null;
    loops.push(loop);
  }
  return loops;
}
const inside = (p: Vec2, ring: readonly Vec2[]) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
/** A flat mesh (planar surface, hatch fill) as a region: one outer loop and holes inside it. */
function flatRegion(v: readonly number[], f: readonly number[], z: number): AnalyzedShape | null {
  const loops = boundaryLoops(v, f);
  if (!loops?.length) return null;
  const rings = loops.map(ringOf).filter((r): r is Vec2[] => !!r);
  if (rings.length !== loops.length) return null;
  rings.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  const [outer, ...rest] = rings;
  if (!rest.every((hole) => inside(hole[0], outer))) return null;
  return {
    kind: 'region',
    region: { outer, holes: rest.map((hole) => [...hole].reverse()) },
    z,
  };
}

function meshShape(v: readonly number[], f: readonly number[]): AnalyzedShape {
  const zs: number[] = [];
  for (let i = 2; i < v.length; i += 3) zs.push(v[i]);
  const zMin = Math.min(...zs),
    zMax = Math.max(...zs);
  if (zMax - zMin <= LEVEL_TOL) {
    const region = flatRegion(v, f, zMin);
    return region ?? { kind: 'bad', shape: 'other', reason: '닫히지 않음' };
  }
  const polys: Solid = [];
  const tris: number[] = [];
  for (let t = 0; t + 2 < f.length; t += 3) {
    const p = [f[t], f[t + 1], f[t + 2]].map((i) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]] as Vec3);
    const u: Vec3 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const w: Vec3 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const n = Math.hypot(
      u[1] * w[2] - u[2] * w[1],
      u[2] * w[0] - u[0] * w[2],
      u[0] * w[1] - u[1] * w[0],
    );
    if (!(n > 1e-12)) continue; // a sliver the tessellation left
    polys.push(solidPolygon(p));
    tris.push(f[t], f[t + 1], f[t + 2]);
  }
  const mesh: Mesh = { v: [...v], f: tris };
  if (!polys.length) return { kind: 'bad', shape: 'open-solid', reason: '닫히지 않음' };
  const check = checkSolid(weldSolid(polys));
  return check.ok
    ? { kind: 'solid', mesh, closed: true, volume: check.volume }
    : { kind: 'open-solid', mesh };
}

/** The local frame: document metres − origin (display rows are metres already). */
export interface Frame {
  /** Factor applied to the row coordinates: 1 for display rows, the unit factor for raw ones. */
  scale: number;
  origin: Vec3;
}
const local = (xyz: readonly number[], frame: Frame) =>
  xyz.map((c, i) => c * frame.scale - frame.origin[i % 3]);

/** One display row → its facts (null when the row has no usable id). */
export function analyzeRow(
  row: Record<string, unknown>,
  frame: Frame,
  hidden: boolean,
): RowFacts | null {
  const objectId = typeof row.nativeId === 'string' ? row.nativeId : '';
  if (!UUID.test(objectId)) return null;
  const nativeType = typeof row.nativeType === 'string' ? row.nativeType : '';
  const hash =
    typeof row.geometryHash === 'string' && HASH.test(row.geometryHash) ? row.geometryHash : null;
  const base = {
    objectId,
    layer: layerOfRow(row),
    nativeType,
    attributes: attributesOfRow(row),
    geometryHash: hash,
    hidden,
  };
  const block = row.block as { transform?: unknown } | undefined;
  const origin = numbers(row.origin);
  // Block instances and points stand at their insertion point.
  if (block || /^(InstanceReference|Point)$/i.test(nativeType)) {
    const t = numbers(block?.transform);
    const raw = t.length === 16 ? [t[3], t[7], t[11]] : origin.length === 3 ? origin : null;
    if (!raw) return { ...base, shape: { kind: 'other' }, bounds: null };
    const at = local(raw, frame) as Vec3;
    return { ...base, shape: { kind: 'point', at }, bounds: { min: at, max: at } };
  }
  const vertices = local(numbers(row.vertices), frame);
  const indices = numbers(row.indices);
  const line = local(numbers(row.line), frame);
  if (line.length >= 9 && /curve/i.test(nativeType))
    return { ...base, shape: curveShape(line), bounds: boundsOf(line) };
  if (vertices.length >= 9 && indices.length >= 3 && !row.oversized)
    return { ...base, shape: meshShape(vertices, indices), bounds: boundsOf(vertices) };
  if (line.length >= 9) return { ...base, shape: curveShape(line), bounds: boundsOf(line) };
  return { ...base, shape: { kind: 'other' }, bounds: boundsOf(vertices.length ? vertices : line) };
}

/** The unused-shape name of an analyzed shape (SPEC-15.9 7). */
export function unusedShapeOf(shape: RowFacts['shape']): UnusedShape {
  switch (shape.kind) {
    case 'solid':
      return 'closed-solid';
    case 'open-solid':
      return 'open-solid';
    case 'region':
      return 'region';
    case 'point':
      return 'point';
    case 'bad':
      return shape.shape;
    default:
      return 'other';
  }
}

/** The shapes each role takes (SPEC-15.3 2). */
const ACCEPTS: Record<ComplianceRoleName, readonly ('solid' | 'region' | 'point')[]> = {
  mass: ['solid'],
  floor: ['region', 'solid'],
  'building-area': ['region'],
  rooftop: ['solid'],
  parking: ['region', 'point'],
  landscape: ['region'],
  'landscape-roof': ['region'],
  'open-space': ['region'],
  ignore: ['solid', 'region', 'point'],
};

/** Shape of a classified object for the contract, or why it cannot be used for the role. */
function fit(
  role: ComplianceRoleName,
  facts: RowFacts,
): { shape: ClassifiedObject['shape'] } | { reason: UnclassifiedReason } {
  const s = facts.shape;
  if (s.kind === 'solid' && ACCEPTS[role].includes('solid'))
    return { shape: { kind: 'solid', mesh: s.mesh, closed: true, volume: s.volume } };
  if (s.kind === 'region' && ACCEPTS[role].includes('region'))
    return { shape: { kind: 'region', region: s.region, z: s.z } };
  if (s.kind === 'point' && ACCEPTS[role].includes('point'))
    return { shape: { kind: 'point', at: s.at } };
  // `ignore` takes anything: an object that is no usable shape still stands where it is.
  if (role === 'ignore') return { shape: { kind: 'point', at: facts.bounds?.min ?? [0, 0, 0] } };
  if (s.kind === 'open-solid' && ACCEPTS[role].includes('solid')) return { reason: '닫히지 않음' };
  if (s.kind === 'bad' && ACCEPTS[role].includes('region')) return { reason: s.reason };
  return { reason: '역할과 모양이 맞지 않음' };
}

export interface ReadInput {
  rows: Iterable<Record<string, unknown>>;
  /** The document's layer table (hidden layers, their parents included, hide their objects). */
  layers?: readonly { fullPath: string; visible: boolean }[];
  /** Objects a read without hidden objects did not list (hidden objects, objects on off layers). */
  hiddenIds?: Iterable<string>;
  source: {
    linkId: string;
    documentKey: string;
    readId: string;
    revisionKey: string;
    readAt: string;
  };
  /** Rhino `UnitSystem` name of the document (`sourceDocument.units`). */
  units: unknown;
  /** `metres`: display rows (default). `document`: raw document units. */
  coordinates?: 'metres' | 'document';
  /** The massing work copy's frame origin (document metres); [0,0,0] without one. */
  origin?: Vec3;
  /** This document's classification records. */
  records: readonly ComplianceRoleRecord[];
  rolesVersion: number;
  /** `ComplianceLimits.plan.chosenOption` (null = none chosen or no massing work copy). */
  chosenOption: string | null;
  /** 숨긴 객체 포함 (SPEC-15.3 3). */
  includeHidden: boolean;
}

export interface ReadOutput {
  model: ClassifiedModel;
  /** Every row's facts (proposal summaries reuse them). */
  facts: RowFacts[];
  /** Object records whose object the read did not find ('모델에 없음', SPEC-15.4 4). */
  missingRecords: ComplianceRoleRecord[];
  /** Reading notes ('고른 대안 없음 · 모델의 대안 하나로 읽음'). */
  notes: string[];
}

/** Display rows + records → `ClassifiedModel` (checked against the contract). */
export function readClassifiedModel(input: ReadInput): ReadOutput {
  const toMeters = unitsToMeters(input.units);
  const frame: Frame = {
    scale: input.coordinates === 'document' ? (toMeters ?? 1) : 1,
    origin: input.origin ?? [0, 0, 0],
  };
  const hiddenIds = new Set([...(input.hiddenIds ?? [])].map((id) => id.toLowerCase()));
  const offLayers = (input.layers ?? []).filter((l) => !l.visible).map((l) => l.fullPath);
  const onOffLayer = (layer: string) =>
    offLayers.some((off) => layer === off || layer.startsWith(off + '::'));

  const facts: RowFacts[] = [];
  for (const row of input.rows) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.nativeId === 'string' ? row.nativeId.toLowerCase() : '';
    const layer = layerOfRow(row);
    const hidden = hiddenIds.has(id) || onOffLayer(layer) || row.hidden === true;
    const fact = analyzeRow(row, frame, hidden);
    if (fact) facts.push(fact);
  }
  facts.sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0));

  const index = indexRecords(input.records);
  const roleRows: RoleRow[] = facts.map((f) => ({
    objectId: f.objectId,
    layer: f.layer,
    attributes: f.attributes,
  }));
  const reading = alternativeReading(roleRows, input.chosenOption);
  const notes = reading.note ? [reading.note] : [];

  const objects: ClassifiedObject[] = [];
  const unclassified: ClassifiedModel['unclassified'] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    seen.add(f.objectId.toLowerCase());
    const decision = roleOf(
      { objectId: f.objectId, layer: f.layer, attributes: f.attributes },
      index,
      reading.read,
    );
    const unused = (reason: UnclassifiedReason, role: ComplianceRoleName | null) =>
      unclassified.push({
        objectId: f.objectId,
        layer: f.layer,
        nativeType: f.nativeType.slice(0, 80),
        reason,
        role,
        shape: unusedShapeOf(f.shape),
      });
    if (decision.role === null) {
      // A hidden object without a role is left out as hidden unless hidden objects are included.
      unused(
        decision.reason === '역할 없음' && f.hidden && !input.includeHidden
          ? '숨김'
          : decision.reason,
        null,
      );
      continue;
    }
    const fitted = fit(decision.role, f);
    if ('reason' in fitted) {
      unused(fitted.reason, decision.role);
      continue;
    }
    const record = decision.record;
    objects.push({
      objectId: f.objectId,
      layer: f.layer,
      role: decision.role,
      roleSource: decision.source,
      floor: decision.floor,
      use: decision.use,
      count: decision.count,
      hidden: f.hidden,
      geometryHash: f.geometryHash,
      geometryChanged: !!(
        record?.geometryHash &&
        f.geometryHash &&
        record.geometryHash !== f.geometryHash
      ),
      shape: fitted.shape,
    });
  }
  const missingRecords = input.records.filter(
    (r) => r.scope === 'object' && !seen.has(r.key.toLowerCase()),
  );
  const model = classifiedModelSchema.parse({
    schema: 'vide.compliance.model@1',
    source: { ...input.source, toMeters },
    objects,
    unclassified,
    rolesVersion: input.rolesVersion,
  });
  return { model, facts, missingRecords, notes };
}

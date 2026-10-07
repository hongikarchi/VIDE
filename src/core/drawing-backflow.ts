import { createHash } from 'node:crypto';
import { DomainError, type Store } from './store.ts';
import { pathKey, placementsOf, type XrefGraph } from './xref-graph.ts';
import { drawingEligibility, layerMap, type LayerMapEntry } from './drawing-layers.ts';

/**
 * 역반영 차이 계산 (SPEC-14.8~14.10·14.12, PLAN-47 T-232, ARCH-01 「도면 역반영(PLAN-47)」).
 * A backflow compares the source (Rhino) snapshot with the drawings it is paired with and lists one
 * row per pair: add, modify, delete, conflict, broken or unsupported. Nothing here writes a drawing.
 *
 * Pairs come only from (a) the drawing's baseline (pairs recorded from confirmed Sync jig rows or
 * by an applied backflow), (b) Sync jig matched rows handed in now, and (c) VIDE origin marks in the
 * drawing (xdata `VIDE_ORIGIN`: 1000 origin ID, 1000 handle at write, 1071 revision). A mark whose
 * handle string is not the entity's own handle is a copy (COPY, WBLOCK, paste) and pairs nothing.
 * Position alone never makes a pair (SPEC-14.8 2).
 *
 * Units: the source snapshot is in metres (as Sync results are); each drawing's geometry is in its
 * own units (mm; unitless read as mm). Rows carry values in the units of the file they write.
 */

export type Point = [number, number, number];
/** Geometry a backflow can compare and write. Angles in radians, counter-clockwise. */
export type Geometry =
  | { kind: 'line'; points: [Point, Point] }
  | { kind: 'polyline'; points: Point[]; bulges?: number[]; closed: boolean }
  | { kind: 'arc'; center: Point; radius: number; start: number; end: number }
  | { kind: 'circle'; center: Point; radius: number }
  | { kind: 'insert'; block: string; position: Point; rotation: number; scale: Point };

export interface SourceObject {
  /** Rhino object ID. */
  id: string;
  /** Full layer path (`건축::벽`). */
  layer: string;
  type: string;
  /** null: a type backflow does not write (surfaces, text, hatches …). */
  geometry: Geometry | null;
}
export interface SourceSnapshot {
  /** The source document's link (document_links.id); origin marks name it. */
  linkId: string;
  /** Changes whenever the source document changes (checked again before an apply). */
  revision: string;
  objects: SourceObject[];
}

export interface OriginMark {
  /** `<link ID>:<object ID>` (or the object ID alone, written before link IDs). */
  id: string;
  /** The entity's handle when VIDE wrote it; another handle means the entity is a copy. */
  handle: string;
  revision: number;
}
export interface DrawingEntity {
  handle: string;
  type: string;
  layer: string;
  /** null: a type backflow does not write (hatch, text, dimension, proxy, OLE, raster …). */
  geometry: Geometry | null;
  /** Model space of its file, paper space, or inside a block definition. */
  owner?: 'model' | 'paper' | 'block';
  /** A dynamic block insert (its parameters are not written). */
  dynamic?: boolean;
  /** An INSERT of an xref block (moving it moves a whole drawing). */
  xref?: boolean;
  /** Properties kept by a backflow (colour, linetype, lineweight …): part of the hand-edit digest. */
  props?: Record<string, string | number | boolean | null>;
  origin?: OriginMark | null;
}
/** One drawing's entities as read (an open drawing or a hidden ZWCAD copy). */
export interface DrawingEntities {
  path: string;
  /** INSUNITS (4 = mm, 0 = none, read as mm). */
  units: number | null;
  /** Fingerprint of the file read (an apply refuses when it changed). */
  sha256: string;
  entities: DrawingEntity[];
}

/** A Sync jig matched row (or any confirmed pair) naming the entity's file and handle. */
export interface PairInput {
  sourceId: string;
  path: string;
  handle: string;
}
export interface BaselinePair {
  sourceId: string;
  handle: string;
  via: 'sync' | 'origin' | 'backflow';
  sourceLayer: string;
  /** Source geometry when recorded (metres), for before/after and moved-together checks. */
  source: Geometry | null;
  sourceDigest: string;
  entityDigest: string;
}
/** 반영 기준 of one drawing file: every entity's digest by handle, and its pairs. */
export interface DrawingBaseline {
  path: string;
  sha256: string;
  handles: Record<string, string>;
  pairs: BaselinePair[];
  revision: number;
  updatedAt: string;
}

/** Rhino metres → root drawing metres (the Sync jig relation, or a new drawing's transform). */
export interface Relation {
  rotation: number;
  translation: [number, number];
  dz: number;
}

export type BackflowKind = 'add' | 'modify' | 'delete' | 'conflict' | 'broken' | 'unsupported';
export type BackflowReason =
  // add
  | 'LAYER_NEEDED'
  // conflict
  | 'BOTH_CHANGED'
  | 'NO_BASELINE'
  | 'SOURCE_DELETED_DRAWING_CHANGED'
  // broken
  | 'ENTITY_DELETED'
  | 'SOURCE_ID_CHANGED'
  // unsupported
  | 'SOURCE_TYPE'
  | 'ENTITY_TYPE'
  | 'TYPE_CHANGED'
  | 'BLOCK_CONTENT'
  | 'DYNAMIC_BLOCK'
  | 'XREF_INSERT'
  | 'XREF_INSERT_MOVE'
  | 'XREF_MISSING'
  | 'XREF_CYCLE'
  | 'XREF_OUTSIDE'
  | 'XREF_TRANSFORM'
  | 'DRAWING_NOT_READ'
  | 'UNITS_NOT_MM';

export interface BackflowRow {
  id: string;
  kind: BackflowKind;
  reason: BackflowReason | null;
  sourceId: string | null;
  sourceLayer: string | null;
  /** The file written: the drawing that owns the entity (an xref child for its entities). */
  path: string;
  handle: string | null;
  /** The entity's layer (kept), or the mapped layer of an added entity (null: needs a layer). */
  layer: string | null;
  /** The entity now and the value written, in the units of `path`. */
  before: Geometry | null;
  after: Geometry | null;
  via: BaselinePair['via'] | null;
  selectable: boolean;
  selected: boolean;
  /** The xref is attached by an absolute path: a new copy beside it is not what the root shows. */
  absoluteXref: boolean;
  /** Other root drawings that show the file written (SPEC-14.9 3). */
  affectedRoots: string[];
}
export interface BackflowResult {
  root: string;
  sourceRevision: string;
  /** The files read and their fingerprints. */
  drawings: { path: string; sha256: string }[];
  rows: BackflowRow[];
  /** Entities whose origin mark names another handle (copies): never paired. */
  copies: { path: string; handle: string; originId: string }[];
  summary: Record<BackflowKind, number> & {
    pairs: number;
    unchanged: number;
    /** Changed in the drawing only (kept, SPEC-14.12). */
    handEdited: number;
    /** Changed in the source and already equal in the drawing. */
    inSync: number;
  };
}

export interface BackflowInput {
  /** The root drawing (its original path). */
  root: string;
  source: SourceSnapshot;
  relation: Relation;
  /** The root and the xref drawings read, by path. */
  drawings: ReadonlyMap<string, DrawingEntities> | Record<string, DrawingEntities>;
  /** The project's xref graph (T-200); null when the root has no xrefs. */
  graph?: XrefGraph | null;
  /** Baselines of the files, by path. */
  baselines?: readonly DrawingBaseline[];
  /** Sync jig matched rows not yet in a baseline. */
  pairs?: readonly PairInput[];
  /** The root's layer table (T-227) and its own layers, for added entities. */
  layerMap?: readonly LayerMapEntry[];
  rootLayers?: readonly string[];
  /** Source layers whose new objects are added; default the table's sources and paired layers. */
  scope?: readonly string[];
  /** Drawings outside the project folders (written to never). */
  outside?: (path: string) => boolean;
  /** Equal within this distance in drawing units (default 0.001 mm). */
  tolerance?: number;
}

const TWO_PI = Math.PI * 2;
const round = (value: number) => {
  const r = Math.round(value * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};
const canonical = (value: unknown): unknown =>
  typeof value === 'number'
    ? round(value)
    : Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
              .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
          )
        : value;
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
    .slice(0, 32);

/** A 2-point open polyline without arcs is a line (both read the same in a drawing). */
export function normalGeometry(geometry: Geometry): Geometry {
  if (
    geometry.kind === 'polyline' &&
    !geometry.closed &&
    geometry.points.length === 2 &&
    !(geometry.bulges ?? []).some((b) => Math.abs(b) > 1e-12)
  )
    return { kind: 'line', points: [geometry.points[0], geometry.points[1]] };
  if (geometry.kind === 'polyline' && (geometry.bulges ?? []).every((b) => Math.abs(b) <= 1e-12))
    return { kind: 'polyline', points: geometry.points, closed: geometry.closed };
  if (geometry.kind === 'arc')
    return { ...geometry, start: angle(geometry.start), end: angle(geometry.end) };
  return geometry;
}
const angle = (value: number) => ((value % TWO_PI) + TWO_PI) % TWO_PI;

/** The source object's digest: what a model change changes. */
export const sourceDigest = (object: SourceObject) =>
  digest({
    type: object.type,
    layer: object.layer,
    geometry: object.geometry && normalGeometry(object.geometry),
  });
/** The entity's digest: what a hand edit in CAD changes (geometry, layer, kept properties). */
export const entityDigest = (entity: DrawingEntity) =>
  digest({
    type: entity.type,
    layer: entity.layer,
    owner: entity.owner ?? 'model',
    props: entity.props ?? {},
    geometry: entity.geometry && normalGeometry(entity.geometry),
  });

/**
 * The origin mark from an entity's `VIDE_ORIGIN` xdata (`[code, value]` after the RegApp name):
 * 1000 origin ID, 1000 handle at write, 1071 revision. Anything else is no mark.
 */
export function originFromXdata(
  values: readonly (readonly [number, unknown])[],
): OriginMark | null {
  const strings = values.filter(([code]) => code === 1000).map(([, value]) => value);
  const revision = values.find(([code]) => code === 1071)?.[1];
  if (strings.length < 2 || typeof strings[0] !== 'string' || typeof strings[1] !== 'string')
    return null;
  if (!strings[0] || !/^[0-9a-f]+$/i.test(strings[1])) return null;
  return {
    id: strings[0],
    handle: strings[1].toUpperCase(),
    revision: typeof revision === 'number' && Number.isInteger(revision) ? revision : 0,
  };
}
/** The xdata a backflow writes for a new entity (the inverse of `originFromXdata`). */
export const originXdata = (linkId: string, objectId: string, handle: string, revision: number) =>
  [
    [1000, `${linkId}:${objectId}`],
    [1000, handle.toUpperCase()],
    [1071, revision],
  ] as const;
/** The source object an origin ID names in this source document, or null for another document. */
export function originObject(originId: string, linkId: string): string | null {
  const at = originId.lastIndexOf(':');
  if (at < 0) return originId;
  return originId.slice(0, at) === linkId ? originId.slice(at + 1) : null;
}

/** Pairs from Sync jig rows: matched rows only (an offset row is not a confirmed pair). */
export function pairsFromSyncRows(
  rows: readonly {
    state: string;
    rhino?: { id: string; nativeId?: string };
    cad?: { id: string; nativeId?: string };
  }[],
  path: string,
): PairInput[] {
  return rows
    .filter((row) => row.state === 'match' && row.rhino && row.cad)
    .map((row) => ({
      sourceId: row.rhino!.nativeId || row.rhino!.id,
      path,
      handle: String(row.cad!.nativeId || row.cad!.id).toUpperCase(),
    }));
}

/** A similarity p → scale·R(rotation)·p + translation (XY), z shifted and scaled. */
export interface Frame {
  rotation: number;
  scale: number;
  map: (p: Point) => Point;
}
const rotate = (p: Point, r: number): Point => {
  const c = Math.cos(r),
    s = Math.sin(r);
  return [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
};
/** Source geometry (metres) in a file's units. Rigid frames keep bulges and block scales. */
export function mapGeometry(geometry: Geometry, frame: Frame): Geometry {
  switch (geometry.kind) {
    case 'line':
      return {
        kind: 'line',
        points: [frame.map(geometry.points[0]), frame.map(geometry.points[1])],
      };
    case 'polyline':
      return {
        kind: 'polyline',
        points: geometry.points.map(frame.map),
        ...(geometry.bulges ? { bulges: [...geometry.bulges] } : {}),
        closed: geometry.closed,
      };
    case 'arc':
      return {
        kind: 'arc',
        center: frame.map(geometry.center),
        radius: geometry.radius * frame.scale,
        start: angle(geometry.start + frame.rotation),
        end: angle(geometry.end + frame.rotation),
      };
    case 'circle':
      return {
        kind: 'circle',
        center: frame.map(geometry.center),
        radius: geometry.radius * frame.scale,
      };
    case 'insert':
      return {
        kind: 'insert',
        block: geometry.block,
        position: frame.map(geometry.position),
        rotation: angle(geometry.rotation + frame.rotation),
        scale: geometry.scale,
      };
  }
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
const nearPoint = (a: Point, b: Point, tolerance: number) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance;
const nearAngle = (a: number, b: number) => {
  const d = Math.abs(angle(a) - angle(b));
  return Math.min(d, TWO_PI - d) <= 1e-7;
};
/** Same shape within the tolerance (drawing units). */
export function sameGeometry(x: Geometry, y: Geometry, tolerance: number): boolean {
  const a = normalGeometry(x),
    b = normalGeometry(y);
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'line': {
      const q = (b as typeof a).points;
      return a.points.every((p, i) => nearPoint(p, q[i], tolerance));
    }
    case 'polyline': {
      const o = b as typeof a;
      const bulges = (list?: number[]) => (i: number) => list?.[i] ?? 0;
      const ba = bulges(a.bulges),
        bb = bulges(o.bulges);
      return (
        a.closed === o.closed &&
        a.points.length === o.points.length &&
        a.points.every((p, i) => nearPoint(p, o.points[i], tolerance) && near(ba(i), bb(i), 1e-9))
      );
    }
    case 'arc': {
      // End points within the tolerance (a length): angles alone would ask µrad of a large arc.
      const o = b as typeof a;
      const at = (g: typeof a, t: number): Point => [
        g.center[0] + g.radius * Math.cos(t),
        g.center[1] + g.radius * Math.sin(t),
        g.center[2],
      ];
      return (
        nearPoint(a.center, o.center, tolerance) &&
        near(a.radius, o.radius, tolerance) &&
        nearPoint(at(a, a.start), at(o, o.start), tolerance) &&
        nearPoint(at(a, a.end), at(o, o.end), tolerance)
      );
    }
    case 'circle': {
      const o = b as typeof a;
      return nearPoint(a.center, o.center, tolerance) && near(a.radius, o.radius, tolerance);
    }
    case 'insert': {
      const o = b as typeof a;
      // A Rhino Sync does not keep the block name (''): then position and rotation only.
      return (
        (!a.block || !o.block || a.block.toLowerCase() === o.block.toLowerCase()) &&
        nearPoint(a.position, o.position, tolerance) &&
        nearAngle(a.rotation, o.rotation)
      );
    }
  }
}
/** Whether the entity can take the source's shape without being redrawn (a line stays a line). */
export const writable = (source: Geometry, entity: Geometry) =>
  normalGeometry(source).kind === normalGeometry(entity).kind;
const points = (g: Geometry): Point[] =>
  g.kind === 'line' || g.kind === 'polyline'
    ? g.points
    : g.kind === 'insert'
      ? [g.position]
      : [g.center];
/** The single translation that takes `from` to `to`, if the change is only that. */
function translationOf(from: Geometry, to: Geometry): Point | null {
  const a = normalGeometry(from),
    b = normalGeometry(to);
  if (a.kind !== b.kind) return null;
  const pa = points(a),
    pb = points(b);
  if (pa.length !== pb.length) return null;
  const d: Point = [pb[0][0] - pa[0][0], pb[0][1] - pa[0][1], pb[0][2] - pa[0][2]];
  const moved = mapGeometry(a, {
    rotation: 0,
    scale: 1,
    map: (p) => [p[0] + d[0], p[1] + d[1], p[2] + d[2]],
  });
  return sameGeometry(moved, b, 1e-6) && Math.hypot(...d) > 1e-9 ? d : null;
}
const box = (g: Geometry) => {
  const pts = points(g);
  const r = g.kind === 'arc' || g.kind === 'circle' ? g.radius : 0;
  return {
    min: [Math.min(...pts.map((p) => p[0])) - r, Math.min(...pts.map((p) => p[1])) - r],
    max: [Math.max(...pts.map((p) => p[0])) + r, Math.max(...pts.map((p) => p[1])) + r],
  };
};
const touches = (a: Geometry, b: Geometry, margin: number) => {
  const x = box(a),
    y = box(b);
  return (
    x.min[0] <= y.max[0] + margin &&
    y.min[0] <= x.max[0] + margin &&
    x.min[1] <= y.max[1] + margin &&
    y.min[1] <= x.max[1] + margin
  );
};

const ABSOLUTE = /^([a-z]:|\\\\)/i;
export const metresPerUnit = (units: number | null) => (units === 4 || units === 0 ? 0.001 : null);

/** How a source point reaches a file: the relation, then the inverse xref placement. */
export function frameOf(
  relation: Relation,
  fileScale: number,
  placement: number[] | null,
): Frame | { error: 'XREF_TRANSFORM' } {
  let rotation = relation.rotation,
    scale = 1 / fileScale;
  let inverse = (q: Point): Point => q;
  if (placement) {
    // Row-major 4x4, child metres → root metres. Only rotation + uniform scale + translation.
    const [a, b, , tx, c, d, , ty, , , e, tz] = placement;
    const s = Math.hypot(a, c);
    if (s < 1e-12 || !near(a, d, 1e-9 * s) || !near(b, -c, 1e-9 * s) || !near(e, s, 1e-9 * s))
      return { error: 'XREF_TRANSFORM' };
    const theta = Math.atan2(c, a);
    rotation -= theta;
    scale /= s;
    inverse = (q) => {
      const r = rotate([(q[0] - tx) / s, (q[1] - ty) / s, (q[2] - tz) / s], -theta);
      return r;
    };
  }
  const rel = relation;
  return {
    rotation: angle(rotation),
    scale,
    map: (p) => {
      const r = rotate(p, rel.rotation);
      const q: Point = [r[0] + rel.translation[0], r[1] + rel.translation[1], p[2] + rel.dz];
      const c = inverse(q);
      return [c[0] / fileScale, c[1] / fileScale, c[2] / fileScale];
    },
  };
}

const entries = <T>(value: ReadonlyMap<string, T> | Record<string, T>): [string, T][] =>
  value instanceof Map ? [...value.entries()] : Object.entries(value as Record<string, T>);

/**
 * The backflow rows of one root drawing and the xref drawings it shows (SPEC-14.10). Pure: reads
 * nothing and writes nothing. The root must be a mm (or unitless) drawing that was read.
 */
export function computeBackflow(input: BackflowInput): BackflowResult {
  const tolerance = input.tolerance ?? 0.001;
  const files = new Map<string, DrawingEntities>();
  for (const [path, read] of entries(input.drawings)) files.set(pathKey(path), { ...read, path });
  const rootRead = files.get(pathKey(input.root));
  if (!rootRead) throw new DomainError('DRAWING_NOT_READ');
  const rootUnits = drawingEligibility({ error: null, units: rootRead.units });
  if (!rootUnits.eligible) throw new DomainError(rootUnits.reason!);

  // Where each file sits: the root, or a drawing it shows (T-200 placements).
  const graph = input.graph ?? null;
  const placements = new Map<string, number[] | null>([[pathKey(input.root), null]]);
  if (graph)
    for (const p of placementsOf(graph, input.root)) placements.set(pathKey(p.path), p.matrix);
  const otherRoots = (path: string) =>
    graph
      ? graph.roots.filter(
          (root) =>
            pathKey(root) !== pathKey(input.root) &&
            placementsOf(graph, root).some((p) => p.matrix && pathKey(p.path) === pathKey(path)),
        )
      : [];
  const absolute = (path: string) =>
    !!graph?.edges.some(
      (edge) =>
        edge.child && pathKey(edge.child) === pathKey(path) && ABSOLUTE.test(edge.stored.trim()),
    );
  const frames = new Map<string, Frame | { error: BackflowReason }>();
  const frame = (path: string): Frame | { error: BackflowReason } => {
    const key = pathKey(path);
    let value = frames.get(key);
    if (value) return value;
    const read = files.get(key);
    if (!placements.has(key)) {
      const cycle = graph?.edges.some((e) => e.cycle && e.child && pathKey(e.child) === key);
      value = { error: cycle ? 'XREF_CYCLE' : 'XREF_MISSING' };
    } else if (input.outside?.(path)) value = { error: 'XREF_OUTSIDE' };
    else if (!read) value = { error: 'DRAWING_NOT_READ' };
    else {
      const scale = metresPerUnit(read.units);
      value = scale
        ? frameOf(input.relation, scale, placements.get(key)!)
        : { error: 'UNITS_NOT_MM' };
    }
    frames.set(key, value);
    return value;
  };

  const sources = new Map(input.source.objects.map((object) => [object.id, object]));
  const baselines = new Map((input.baselines ?? []).map((b) => [pathKey(b.path), b]));
  const entityOf = new Map<string, Map<string, DrawingEntity>>();
  for (const [key, read] of files)
    entityOf.set(key, new Map(read.entities.map((e) => [e.handle.toUpperCase(), e])));

  // Pairs: baseline first, then origin marks, then the Sync rows handed in.
  interface Pair {
    sourceId: string;
    path: string;
    handle: string;
    via: BaselinePair['via'];
    baseline: BaselinePair | null;
  }
  const pairs: Pair[] = [];
  const bySource = new Set<string>(),
    byHandle = new Set<string>();
  const add = (pair: Pair) => {
    const s = pathKey(pair.path) + '\u0000' + pair.sourceId,
      h = pathKey(pair.path) + '\u0000' + pair.handle;
    if (bySource.has(s) || byHandle.has(h)) return;
    bySource.add(s);
    byHandle.add(h);
    pairs.push(pair);
  };
  const scopeFiles = [...files.values()].map((read) => read.path);
  for (const path of scopeFiles) {
    const baseline = baselines.get(pathKey(path));
    for (const pair of baseline?.pairs ?? [])
      add({
        sourceId: pair.sourceId,
        path,
        handle: pair.handle.toUpperCase(),
        via: pair.via,
        baseline: pair,
      });
  }
  const copies: BackflowResult['copies'] = [];
  for (const read of files.values())
    for (const entity of read.entities) {
      if (!entity.origin) continue;
      const handle = entity.handle.toUpperCase();
      if (entity.origin.handle.toUpperCase() !== handle) {
        copies.push({ path: read.path, handle, originId: entity.origin.id });
        continue;
      }
      const sourceId = originObject(entity.origin.id, input.source.linkId);
      if (sourceId) add({ sourceId, path: read.path, handle, via: 'origin', baseline: null });
    }
  for (const pair of input.pairs ?? []) {
    const read = files.get(pathKey(pair.path));
    // A Sync row whose source is gone pairs nothing (it was not confirmed against this source).
    if (!sources.has(pair.sourceId)) continue;
    add({
      sourceId: pair.sourceId,
      path: read?.path ?? pair.path,
      handle: pair.handle.toUpperCase(),
      via: 'sync',
      baseline: null,
    });
  }
  const pairedSources = new Set(pairs.map((pair) => pair.sourceId));

  const rows: Omit<BackflowRow, 'id'>[] = [];
  const counts = { unchanged: 0, handEdited: 0, inSync: 0 };
  const row = (
    pair: Pair | null,
    kind: BackflowKind,
    reason: BackflowReason | null,
    fields: Partial<Omit<BackflowRow, 'id' | 'kind' | 'reason'>> & { path: string },
  ) => {
    const selectable = (kind === 'add' && !reason) || kind === 'modify' || kind === 'delete';
    rows.push({
      sourceId: pair?.sourceId ?? null,
      sourceLayer: null,
      handle: pair?.handle ?? null,
      layer: null,
      before: null,
      after: null,
      via: pair?.via ?? null,
      absoluteXref: pathKey(fields.path) !== pathKey(input.root) && absolute(fields.path),
      affectedRoots: pathKey(fields.path) !== pathKey(input.root) ? otherRoots(fields.path) : [],
      ...fields,
      kind,
      reason,
      selectable,
      selected: selectable && kind !== 'delete',
    });
  };

  // New source objects (in scope, unpaired): the candidates for add rows and for regenerated IDs.
  const scope = new Set(
    input.scope ?? [
      ...(input.layerMap ?? []).map((entry) => entry.source),
      ...pairs.map((pair) => sources.get(pair.sourceId)?.layer ?? pair.baseline?.sourceLayer ?? ''),
    ],
  );
  const fresh = input.source.objects.filter((o) => !pairedSources.has(o.id) && scope.has(o.layer));

  const moved = new Map<string, { rows: number[]; deltas: (Point | null)[] }>();
  for (const pair of pairs) {
    const f = frame(pair.path);
    const source = sources.get(pair.sourceId) ?? null;
    const entity = entityOf.get(pathKey(pair.path))?.get(pair.handle) ?? null;
    const base = pair.baseline;
    const sourceLayer = source?.layer ?? base?.sourceLayer ?? null;
    if ('error' in f) {
      row(pair, 'unsupported', f.error, {
        path: pair.path,
        sourceLayer,
        layer: entity?.layer ?? null,
      });
      continue;
    }
    const before = entity?.geometry ?? null;
    const common = { path: pair.path, sourceLayer, layer: entity?.layer ?? null, before };
    const entityChanged = !!entity && (!base || entityDigest(entity) !== base.entityDigest);
    if (!source) {
      if (!entity) row(pair, 'broken', 'ENTITY_DELETED', common);
      else if (base && entityChanged)
        row(pair, 'conflict', 'SOURCE_DELETED_DRAWING_CHANGED', common);
      else if (
        base?.source &&
        fresh.some(
          (o) =>
            o.layer === base.sourceLayer && o.geometry && touches(o.geometry, base.source!, 1e-3),
        )
      )
        // Split, joined or rebuilt in place: the old pair ends; the new objects pair nothing.
        row(pair, 'broken', 'SOURCE_ID_CHANGED', common);
      else row(pair, 'delete', null, common);
      continue;
    }
    if (!entity) {
      row(pair, 'broken', 'ENTITY_DELETED', common);
      continue;
    }
    const sourceChanged = !base || sourceDigest(source) !== base.sourceDigest;
    if (!sourceChanged) {
      if (entityChanged) counts.handEdited++;
      else counts.unchanged++;
      continue;
    }
    const unsupported: BackflowReason | null = !source.geometry
      ? 'SOURCE_TYPE'
      : !entity.geometry
        ? 'ENTITY_TYPE'
        : entity.xref
          ? 'XREF_INSERT'
          : entity.dynamic
            ? 'DYNAMIC_BLOCK'
            : (entity.owner ?? 'model') === 'block'
              ? 'BLOCK_CONTENT'
              : !writable(source.geometry, entity.geometry)
                ? 'TYPE_CHANGED'
                : null;
    const after = source.geometry ? mapGeometry(source.geometry, f) : null;
    if (unsupported) {
      row(pair, 'unsupported', unsupported, { ...common, after });
      continue;
    }
    if (sameGeometry(after!, entity.geometry!, tolerance)) {
      counts.inSync++;
      continue;
    }
    if (entityChanged) {
      row(pair, 'conflict', base ? 'BOTH_CHANGED' : 'NO_BASELINE', { ...common, after });
      continue;
    }
    row(pair, 'modify', null, { ...common, after });
    const slot = moved.get(pathKey(pair.path)) ?? { rows: [], deltas: [] };
    slot.rows.push(rows.length - 1);
    slot.deltas.push(base?.source ? translationOf(base.source, source.geometry!) : null);
    moved.set(pathKey(pair.path), slot);
  }
  // An xref drawing whose every pair moved by one translation: the xref insert moved (SPEC-14.9 2).
  for (const [key, slot] of moved) {
    if (key === pathKey(input.root)) continue;
    const inFile = pairs.filter((pair) => pathKey(pair.path) === key).length;
    const first = slot.deltas[0];
    if (
      inFile >= 2 &&
      slot.rows.length === inFile &&
      first &&
      slot.deltas.every((d) => d && nearPoint(d, first, 1e-6))
    )
      for (const index of slot.rows)
        Object.assign(rows[index], {
          kind: 'unsupported',
          reason: 'XREF_INSERT_MOVE',
          selectable: false,
          selected: false,
        });
  }
  // Add rows: new objects go to the root, on the layer its table gives (never a new layer).
  const rootFrame = frame(input.root) as Frame;
  const rootLayers = input.rootLayers ?? [];
  const table = new Map((input.layerMap ?? []).map((entry) => [entry.source, entry.layer]));
  for (const object of fresh) {
    const layer = table.has(object.layer)
      ? table.get(object.layer)!
      : (layerMap([object.layer], rootLayers)[0]?.layer ?? null);
    const fields = {
      path: rootRead.path,
      sourceId: object.id,
      sourceLayer: object.layer,
      layer,
      after: object.geometry ? mapGeometry(object.geometry, rootFrame) : null,
    };
    if (!object.geometry || object.geometry.kind === 'insert')
      row(null, 'unsupported', 'SOURCE_TYPE', fields);
    else row(null, 'add', layer ? null : 'LAYER_NEEDED', fields);
  }

  const rank: Record<BackflowKind, number> = {
    conflict: 0,
    modify: 1,
    add: 2,
    delete: 3,
    broken: 4,
    unsupported: 5,
  };
  const ordered = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank[a.r.kind] - rank[b.r.kind] || a.i - b.i)
    .map(({ r }, i) => ({ id: 'B' + (i + 1), ...r }));
  const kinds = Object.keys(rank) as BackflowKind[];
  return {
    root: rootRead.path,
    sourceRevision: input.source.revision,
    drawings: [...files.values()].map((read) => ({ path: read.path, sha256: read.sha256 })),
    rows: ordered,
    copies,
    summary: {
      ...(Object.fromEntries(
        kinds.map((kind) => [kind, ordered.filter((r) => r.kind === kind).length]),
      ) as Record<BackflowKind, number>),
      pairs: pairs.length,
      ...counts,
    },
  };
}

/**
 * A file's baseline after pairs were confirmed (Sync jig rows) or applied (T-233): every entity's
 * digest, and the pairs given with the source and entity digests of now. Pairs of `previous` that
 * are not replaced are kept when their entity is still there.
 */
export function recordBaseline(
  read: DrawingEntities,
  pairs: readonly { sourceId: string; handle: string; via: BaselinePair['via'] }[],
  source: SourceSnapshot,
  previous: DrawingBaseline | null,
  now: Date,
): { baseline: DrawingBaseline; refused: { sourceId: string; handle: string; reason: string }[] } {
  const handles: Record<string, string> = {};
  const byHandle = new Map<string, DrawingEntity>();
  for (const entity of read.entities) {
    const handle = entity.handle.toUpperCase();
    handles[handle] = entityDigest(entity);
    byHandle.set(handle, entity);
  }
  const objects = new Map(source.objects.map((o) => [o.id, o]));
  const refused: { sourceId: string; handle: string; reason: string }[] = [];
  const next = new Map<string, BaselinePair>();
  const taken = new Set<string>();
  for (const pair of pairs) {
    const handle = pair.handle.toUpperCase();
    const object = objects.get(pair.sourceId);
    const entity = byHandle.get(handle);
    if (!object) refused.push({ sourceId: pair.sourceId, handle, reason: 'SOURCE_MISSING' });
    else if (!entity) refused.push({ sourceId: pair.sourceId, handle, reason: 'ENTITY_MISSING' });
    else if (next.has(pair.sourceId) || taken.has(handle))
      refused.push({ sourceId: pair.sourceId, handle, reason: 'ALREADY_PAIRED' });
    else {
      taken.add(handle);
      next.set(pair.sourceId, {
        sourceId: pair.sourceId,
        handle,
        via: pair.via,
        sourceLayer: object.layer,
        source: object.geometry,
        sourceDigest: sourceDigest(object),
        entityDigest: handles[handle],
      });
    }
  }
  for (const pair of previous?.pairs ?? [])
    if (!next.has(pair.sourceId) && !taken.has(pair.handle) && byHandle.has(pair.handle)) {
      taken.add(pair.handle);
      next.set(pair.sourceId, pair);
    }
  return {
    baseline: {
      path: read.path,
      sha256: read.sha256,
      handles,
      pairs: [...next.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: now.toISOString(),
    },
    refused,
  };
}

/** The project DB rows (schema 14): one baseline per drawing file. */
export class DrawingBackflowStore {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  private db(projectId: string) {
    this.store.project(projectId);
    return this.store.db(projectId);
  }
  baseline(projectId: string, path: string): DrawingBaseline | null {
    const row = this.db(projectId)
      .prepare('SELECT data, revision FROM drawing_backflow_baselines WHERE projectId=? AND key=?')
      .get(projectId, pathKey(path));
    return row
      ? { ...(JSON.parse(String(row.data)) as DrawingBaseline), revision: Number(row.revision) }
      : null;
  }
  baselines(projectId: string, paths: readonly string[]): DrawingBaseline[] {
    return paths.map((path) => this.baseline(projectId, path)).filter((b) => !!b);
  }
  /** Replaces a file's baseline; `revision` (when given) must be the stored one. */
  save(projectId: string, baseline: DrawingBaseline, revision?: number) {
    const db = this.db(projectId);
    const current = this.baseline(projectId, baseline.path);
    if (revision !== undefined && revision !== (current?.revision ?? 0))
      throw new DomainError('REVISION_CONFLICT');
    const value = { ...baseline, revision: (current?.revision ?? 0) + 1 };
    db.prepare(
      `INSERT INTO drawing_backflow_baselines VALUES(?,?,?,?,?,?) ON CONFLICT(projectId, key)
        DO UPDATE SET path=excluded.path, data=excluded.data, revision=excluded.revision,
        updatedAt=excluded.updatedAt`,
    ).run(
      projectId,
      pathKey(baseline.path),
      baseline.path,
      JSON.stringify(value),
      value.revision,
      value.updatedAt,
    );
    return value;
  }
}

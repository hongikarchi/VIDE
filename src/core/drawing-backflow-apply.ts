import {
  originFromXdata,
  sameGeometry,
  type BackflowRow,
  type DrawingEntity,
  type Geometry,
  type Point,
} from './drawing-backflow.ts';

/**
 * 역반영 적용 (SPEC-14.6·14.8 4·14.11, PLAN-47 T-233, ARCH-01 「도면 역반영(PLAN-47)」): the pure parts of an
 * apply. Rows become ops per file; what a file looked like before and after an apply (read in the
 * host, hosts/zwcad/worker/BackflowOps.cs) becomes the preservation check and the list of
 * dimensions to check. Nothing here reads or writes a drawing.
 */

export type BackflowOp =
  | { id: string; op: 'modify'; handle: string; geometry: Geometry; origin: string }
  | { id: string; op: 'add'; layer: string; geometry: Geometry; origin: string }
  | { id: string; op: 'delete'; handle: string };

export interface DimensionRead {
  handle: string;
  type: string;
  layer: string;
  /** Linked to the geometry it measures (the host moves it with that geometry). */
  associative: boolean;
  /** The points it measures between (its definition points), in drawing units. */
  points: Point[];
  measurement: number | null;
}
/** What the preservation check compares (SPEC-14.6), as the host reads it. */
export interface DrawingSnapshot {
  version: string;
  units: number;
  /** Every live object 1..HANDSEED: handle → class name. */
  objects: Record<string, string>;
  /** Every entity of every space and block definition (not xrefs): handle → digest. */
  digests: Record<string, string>;
  tables: Record<string, string[]>;
  layouts: Record<string, unknown>[];
  xrefs: { name: string; path: string }[];
  /** Objects of the named object dictionary: handle → key path (`ACAD_GROUP`, `A/B` …). */
  named: Record<string, string>;
  /** Other dictionaries and xrecords: handle → `<owner class>:<owner handle>` ('' for none). */
  owners: Record<string, string>;
}
export interface DrawingState {
  entities: DrawingEntity[];
  dims: DimensionRead[];
  layers: string[];
  snapshot: DrawingSnapshot | null;
}
/** One file's apply as the host answers it. */
export interface FileApply {
  results: { id: string; handle: string }[];
  before: DrawingState;
  after: DrawingState;
}

// ---- reading host rows ---------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const point = (value: unknown): Point =>
  Array.isArray(value) ? [num(value[0]), num(value[1]), num(value[2])] : [0, 0, 0];

/** A host geometry row (BackflowOps.Geometry), or null for anything else. */
export function geometryOf(value: unknown): Geometry | null {
  if (!isObject(value)) return null;
  switch (value.kind) {
    case 'line': {
      const points = Array.isArray(value.points) ? value.points.map(point) : [];
      return points.length === 2 ? { kind: 'line', points: [points[0], points[1]] } : null;
    }
    case 'polyline': {
      const points = Array.isArray(value.points) ? value.points.map(point) : [];
      if (points.length < 2) return null;
      return {
        kind: 'polyline',
        points,
        ...(Array.isArray(value.bulges) ? { bulges: value.bulges.map(num) } : {}),
        closed: value.closed === true,
      };
    }
    case 'arc':
      return {
        kind: 'arc',
        center: point(value.center),
        radius: num(value.radius),
        start: num(value.start),
        end: num(value.end),
      };
    case 'circle':
      return { kind: 'circle', center: point(value.center), radius: num(value.radius) };
    case 'insert':
      return {
        kind: 'insert',
        block: String(value.block ?? ''),
        position: point(value.position),
        rotation: num(value.rotation),
        scale: point(value.scale),
      };
  }
  return null;
}

/** One entity row of the host (`{h, t, l, o, g, p, dyn?, xr?, x?}`). */
export function entityFromRow(row: unknown): DrawingEntity | null {
  if (!isObject(row) || typeof row.h !== 'string' || !/^[0-9a-f]{1,16}$/i.test(row.h)) return null;
  const props = isObject(row.p)
    ? Object.fromEntries(
        Object.entries(row.p).filter(([, v]) =>
          ['string', 'number', 'boolean'].includes(typeof v),
        ) as [string, string | number | boolean][],
      )
    : undefined;
  const xdata = Array.isArray(row.x)
    ? row.x.filter((v): v is [number, unknown] => Array.isArray(v) && typeof v[0] === 'number')
    : null;
  return {
    handle: row.h.toUpperCase(),
    type: String(row.t ?? ''),
    layer: String(row.l ?? ''),
    owner: row.o === 'paper' || row.o === 'block' ? row.o : 'model',
    geometry: geometryOf(row.g),
    ...(row.dyn === true ? { dynamic: true } : {}),
    ...(row.xr === true ? { xref: true } : {}),
    ...(props ? { props } : {}),
    origin: xdata ? originFromXdata(xdata) : null,
  };
}

export function dimensionFromRow(row: unknown): DimensionRead | null {
  if (!isObject(row) || typeof row.h !== 'string') return null;
  return {
    handle: row.h.toUpperCase(),
    type: String(row.t ?? ''),
    layer: String(row.l ?? ''),
    associative: row.assoc === true,
    points: Array.isArray(row.pts) ? row.pts.map(point) : [],
    measurement: typeof row.m === 'number' ? row.m : null,
  };
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const record = (value: unknown) =>
  isObject(value)
    ? (Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) as Record<
        string,
        string
      >)
    : {};

export function snapshotFromRow(value: unknown): DrawingSnapshot | null {
  if (!isObject(value)) return null;
  const tables = isObject(value.tables)
    ? Object.fromEntries(Object.entries(value.tables).map(([k, v]) => [k, strings(v)]))
    : {};
  return {
    version: String(value.version ?? ''),
    units: num(value.units),
    objects: record(value.objects),
    digests: record(value.digests),
    tables,
    layouts: Array.isArray(value.layouts) ? value.layouts.filter(isObject) : [],
    xrefs: Array.isArray(value.xrefs)
      ? value.xrefs
          .filter(isObject)
          .map((x) => ({ name: String(x.name ?? ''), path: String(x.path ?? '') }))
      : [],
    named: record(value.named),
    owners: record(value.owners),
  };
}

/** A host state (`{entities, dims, layers, snapshot?}`). */
export function stateFromRow(value: unknown): DrawingState {
  const row = isObject(value) ? value : {};
  return {
    entities: (Array.isArray(row.entities) ? row.entities : [])
      .map(entityFromRow)
      .filter((e): e is DrawingEntity => !!e),
    dims: (Array.isArray(row.dims) ? row.dims : [])
      .map(dimensionFromRow)
      .filter((d): d is DimensionRead => !!d),
    layers: strings(row.layers),
    snapshot: snapshotFromRow(row.snapshot),
  };
}

// ---- rows → ops ----------------------------------------------------------------------------

/** The ops of the chosen rows, by the file they write (rows must be add/modify/delete with values). */
export function opsOfRows(rows: readonly BackflowRow[], linkId: string): Map<string, BackflowOp[]> {
  const files = new Map<string, BackflowOp[]>();
  const push = (path: string, op: BackflowOp) => files.set(path, [...(files.get(path) ?? []), op]);
  for (const row of rows) {
    const origin = `${linkId}:${row.sourceId}`;
    if (row.kind === 'delete' && row.handle)
      push(row.path, { id: row.id, op: 'delete', handle: row.handle });
    else if (row.kind === 'add' && row.after && row.layer && row.sourceId)
      push(row.path, { id: row.id, op: 'add', layer: row.layer, geometry: row.after, origin });
    // A conflict the person chose to cover with the model ([모델로 덮기]) is written as a modify.
    else if ((row.kind === 'modify' || row.kind === 'conflict') && row.after && row.handle)
      push(row.path, {
        id: row.id,
        op: 'modify',
        handle: row.handle,
        geometry: row.after,
        origin,
      });
    else throw Object.assign(new Error('ROW_NOT_SELECTABLE'), { code: 'ROW_NOT_SELECTABLE' });
  }
  return files;
}

/**
 * Which ops a drawing shows as done, read again after an unclear apply (SPEC-14.13 3): a modify
 * whose entity has the new shape, a delete whose entity is gone, an add whose marked entity is there.
 */
export function appliedOps(
  ops: readonly BackflowOp[],
  entities: readonly DrawingEntity[],
  tolerance = 0.01,
) {
  const byHandle = new Map(entities.map((e) => [e.handle.toUpperCase(), e]));
  const marked = new Set(
    entities
      .filter((e) => e.origin && e.origin.handle === e.handle.toUpperCase())
      .map((e) => e.origin!.id),
  );
  const applied: string[] = [],
    notApplied: string[] = [];
  for (const op of ops) {
    const done =
      op.op === 'delete'
        ? !byHandle.has(op.handle.toUpperCase())
        : op.op === 'add'
          ? marked.has(op.origin)
          : (() => {
              const entity = byHandle.get(op.handle.toUpperCase());
              return !!entity?.geometry && sameGeometry(entity.geometry, op.geometry, tolerance);
            })();
    (done ? applied : notApplied).push(op.id);
  }
  return { applied, notApplied };
}

// ---- preservation check (SPEC-14.6) --------------------------------------------------------

/**
 * Objects a ZWCAD save writes by itself, never compared: the classes it replaces every time
 * (SPIKE-2026-10-07-drawing-backflow 결과 1), the named object dictionary entries it adds
 * (`ACDB_RECOMPOSE_DATA`) and the extension dictionaries of table styles (both seen on copies of
 * real drawings saved with no change, T-233).
 */
export const SAVE_CHURN = Object.freeze(['AcDbCellStyleMap', 'AcDbDictionaryVar']);
export const SAVE_CHURN_NAMED = Object.freeze(['ACDB_RECOMPOSE_DATA']);
export const SAVE_CHURN_OWNERS = Object.freeze(['AcDbTableStyle']);
const churned = (snapshot: DrawingSnapshot, handle: string) =>
  SAVE_CHURN.includes(snapshot.objects[handle]) ||
  SAVE_CHURN_NAMED.includes(snapshot.named?.[handle] ?? '') ||
  SAVE_CHURN_OWNERS.includes((snapshot.owners?.[handle] ?? '').split(':')[0]);
const REGAPP = 'VIDE_ORIGIN';
const KEPT = ['type', 'layer', 'owner', 'color', 'linetype', 'lineweight'] as const;
const LIST = 50;

export interface PreservationCheck {
  /** No difference beyond the rows applied. */
  ok: boolean;
  differences: number;
  version: { before: string; after: string; same: boolean };
  changed: { modified: number; added: number; deleted: number; byType: Record<string, number> };
  /** Kept properties of the changed entities that are not the same as before. */
  entities: { handle: string; field: string; before: unknown; after: unknown }[];
  tables: { name: string; before: number; after: number; added: string[]; removed: string[] }[];
  layouts: { before: number; after: number; same: boolean };
  xrefs: { before: number; after: number; same: boolean; changed: string[] };
  /** Objects added, removed or changed beyond the rows (first 50 handles each, with counts). */
  unexpected: {
    added: string[];
    removed: string[];
    changed: string[];
    counts: { added: number; removed: number; changed: number };
  };
}

const field = (entity: DrawingEntity, name: (typeof KEPT)[number]) =>
  name === 'type'
    ? entity.type
    : name === 'layer'
      ? entity.layer
      : name === 'owner'
        ? (entity.owner ?? 'model')
        : (entity.props?.[name] ?? null);

/**
 * Compares a file before and after an apply. The rows' own changes are expected: modified handles
 * may change their digest, added handles appear, deleted handles go; the VIDE_ORIGIN application
 * record may appear; objects a save writes by itself (`SAVE_CHURN*`) are left out. Everything else must
 * be the same: other objects and entity digests, symbol tables, layouts, xref paths, DWG version,
 * and the changed entities' handle, type, layer, space, colour, linetype and lineweight.
 */
export function preservation(
  before: DrawingState,
  after: DrawingState,
  done: { modified: readonly string[]; added: readonly string[]; deleted: readonly string[] },
): PreservationCheck {
  const b = before.snapshot,
    a = after.snapshot;
  const up = (list: readonly string[]) => new Set(list.map((h) => h.toUpperCase()));
  const modified = up(done.modified),
    added = up(done.added),
    deleted = up(done.deleted);
  const unexpected = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
  const regApp = (handle: string) =>
    !b?.objects[handle] && /RegAppTableRecord$/.test(a?.objects[handle] ?? '');
  if (b && a) {
    for (const [handle, kind] of Object.entries(b.objects)) {
      if (churned(b, handle) || deleted.has(handle)) continue;
      const now = a.objects[handle];
      if (now === undefined) unexpected.removed.push(handle);
      else if (now !== kind) unexpected.changed.push(handle);
    }
    for (const handle of Object.keys(a.objects))
      if (!(handle in b.objects) && !churned(a, handle) && !added.has(handle) && !regApp(handle))
        unexpected.added.push(handle);
    for (const [handle, digest] of Object.entries(b.digests)) {
      if (modified.has(handle) || deleted.has(handle)) continue;
      if (a.digests[handle] !== undefined && a.digests[handle] !== digest)
        unexpected.changed.push(handle);
    }
  }
  const beforeOf = new Map(before.entities.map((e) => [e.handle.toUpperCase(), e]));
  const afterOf = new Map(after.entities.map((e) => [e.handle.toUpperCase(), e]));
  const entities: PreservationCheck['entities'] = [];
  const byType: Record<string, number> = {};
  for (const handle of [...modified, ...added, ...deleted]) {
    const entity = afterOf.get(handle) ?? beforeOf.get(handle);
    if (entity) byType[entity.type] = (byType[entity.type] ?? 0) + 1;
  }
  for (const handle of modified) {
    const was = beforeOf.get(handle),
      now = afterOf.get(handle);
    if (!was || !now) {
      entities.push({
        handle,
        field: 'handle',
        before: was ? handle : null,
        after: now ? handle : null,
      });
      continue;
    }
    for (const name of KEPT)
      if (JSON.stringify(field(was, name)) !== JSON.stringify(field(now, name)))
        entities.push({ handle, field: name, before: field(was, name), after: field(now, name) });
  }
  const tables: PreservationCheck['tables'] = [];
  for (const name of new Set([...Object.keys(b?.tables ?? {}), ...Object.keys(a?.tables ?? {})])) {
    const was = new Set(b?.tables[name] ?? []),
      now = new Set(a?.tables[name] ?? []);
    const plus = [...now].filter((n) => !was.has(n) && !(name === 'regApps' && n === REGAPP));
    const minus = [...was].filter((n) => !now.has(n));
    tables.push({ name, before: was.size, after: now.size, added: plus, removed: minus });
  }
  const layoutKey = (s: DrawingSnapshot | null) => JSON.stringify(s?.layouts ?? []);
  const xrefList = (s: DrawingSnapshot | null) =>
    (s?.xrefs ?? []).map((x) => `${x.name}=${x.path}`);
  const xb = xrefList(b),
    xa = xrefList(a);
  const xrefChanged = [...xb.filter((x) => !xa.includes(x)), ...xa.filter((x) => !xb.includes(x))];
  const version = {
    before: b?.version ?? '',
    after: a?.version ?? '',
    same: b?.version === a?.version,
  };
  const layouts = {
    before: b?.layouts.length ?? 0,
    after: a?.layouts.length ?? 0,
    same: layoutKey(b) === layoutKey(a),
  };
  const counts = {
    added: unexpected.added.length,
    removed: unexpected.removed.length,
    changed: unexpected.changed.length,
  };
  const differences =
    counts.added +
    counts.removed +
    counts.changed +
    entities.length +
    tables.reduce((n, t) => n + t.added.length + t.removed.length, 0) +
    (layouts.same ? 0 : 1) +
    xrefChanged.length +
    (version.same ? 0 : 1) +
    (b && a ? 0 : 1);
  return {
    ok: differences === 0,
    differences,
    version,
    changed: { modified: modified.size, added: added.size, deleted: deleted.size, byType },
    entities,
    tables,
    layouts,
    xrefs: { before: xb.length, after: xa.length, same: !xrefChanged.length, changed: xrefChanged },
    unexpected: {
      added: unexpected.added.slice(0, LIST),
      removed: unexpected.removed.slice(0, LIST),
      changed: unexpected.changed.slice(0, LIST),
      counts,
    },
  };
}

// ---- dimensions to check (SPEC-14.8 4) -----------------------------------------------------

const TWO_PI = Math.PI * 2;
const wrap = (t: number) => ((t % TWO_PI) + TWO_PI) % TWO_PI;
const segment = (p: Point, a: Point, b: Point) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const arcDistance = (p: Point, c: Point, r: number, start: number, end: number) => {
  const t = wrap(Math.atan2(p[1] - c[1], p[0] - c[0]));
  const s = wrap(start),
    sweep = wrap(end - start) || TWO_PI;
  if (wrap(t - s) <= sweep) return Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1]) - r);
  const at = (u: number): Point => [c[0] + r * Math.cos(u), c[1] + r * Math.sin(u), 0];
  const e1 = at(s),
    e2 = at(s + sweep);
  return Math.min(Math.hypot(p[0] - e1[0], p[1] - e1[1]), Math.hypot(p[0] - e2[0], p[1] - e2[1]));
};
/** Plan distance from a point to a geometry (a polyline's arc segments as arcs; an insert's point). */
export function distanceTo(p: Point, g: Geometry): number {
  switch (g.kind) {
    case 'line':
      return segment(p, g.points[0], g.points[1]);
    case 'circle':
      return Math.abs(Math.hypot(p[0] - g.center[0], p[1] - g.center[1]) - g.radius);
    case 'arc':
      return arcDistance(p, g.center, g.radius, g.start, g.end);
    case 'insert':
      return Math.hypot(p[0] - g.position[0], p[1] - g.position[1]);
    case 'polyline': {
      const n = g.points.length;
      let best = Infinity;
      for (let i = 0; i < (g.closed ? n : n - 1); i++) {
        const a = g.points[i],
          b = g.points[(i + 1) % n],
          bulge = g.bulges?.[i] ?? 0;
        if (Math.abs(bulge) < 1e-12) best = Math.min(best, segment(p, a, b));
        else {
          // Bulge = tan(θ/4); centre on the chord's normal; positive bulge turns counter-clockwise.
          const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const theta = 4 * Math.atan(bulge);
          const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
          const mx = (a[0] + b[0]) / 2,
            my = (a[1] + b[1]) / 2;
          const h = r * Math.cos(theta / 2) * Math.sign(bulge);
          const nx = -(b[1] - a[1]) / chord,
            ny = (b[0] - a[0]) / chord;
          const c: Point = [mx + nx * h, my + ny * h, 0];
          const sa = Math.atan2(a[1] - c[1], a[0] - c[0]),
            sb = Math.atan2(b[1] - c[1], b[0] - c[0]);
          best = Math.min(
            best,
            bulge > 0 ? arcDistance(p, c, r, sa, sb) : arcDistance(p, c, r, sb, sa),
          );
        }
      }
      return best;
    }
  }
}

export interface DimensionToCheck {
  handle: string;
  type: string;
  layer: string;
  associative: boolean;
  /** The entity it measured (before the apply). */
  entity: string;
  /** NOT_LINKED: a hand dimension on a changed entity; NOT_FOLLOWED: it did not move with it. */
  reason: 'NOT_LINKED' | 'NOT_FOLLOWED' | 'ENTITY_DELETED';
}

/**
 * Dimensions that measured a changed entity (a definition point on it before the apply, within
 * `margin` drawing units) and do not now measure the new shape: a dimension not linked to its
 * geometry is never changed by a backflow; a linked one that did not follow is listed too.
 */
export function dimensionsToCheck(
  before: readonly DimensionRead[],
  after: readonly DimensionRead[],
  changes: readonly { handle: string; before: Geometry | null; after: Geometry | null }[],
  margin = 0.5,
): DimensionToCheck[] {
  const now = new Map(after.map((d) => [d.handle, d]));
  const out: DimensionToCheck[] = [];
  for (const dimension of before) {
    const change = changes.find(
      (c) => c.before && dimension.points.some((p) => distanceTo(p, c.before!) <= margin),
    );
    if (!change) continue;
    const later = now.get(dimension.handle);
    const base = {
      handle: dimension.handle,
      type: dimension.type,
      layer: dimension.layer,
      associative: dimension.associative,
      entity: change.handle,
    };
    if (!change.after) out.push({ ...base, reason: 'ENTITY_DELETED' });
    else if (!dimension.associative) out.push({ ...base, reason: 'NOT_LINKED' });
    else if (
      !later ||
      !later.points.some((p) => distanceTo(p, change.after!) <= margin) ||
      later.points.some(
        (p, i) =>
          distanceTo(dimension.points[i] ?? p, change.before!) <= margin &&
          distanceTo(p, change.after!) > margin,
      )
    )
      out.push({ ...base, reason: 'NOT_FOLLOWED' });
  }
  return out;
}

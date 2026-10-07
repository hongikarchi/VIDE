import { DomainError, type Store } from './store.ts';
import { pathKey } from './xref-graph.ts';

/**
 * 도면 읽기와 레이어 대응 (SPEC-14.3, PLAN-47 T-227, ARCH-01 「도면 역반영(PLAN-47)」).
 * A drawing read is the worker's VIDEDRAWINGINSPECT answer for an engine copy of a project drawing;
 * a layer table maps each source (Rhino) layer to a layer that already exists in that drawing.
 * Same names map themselves; other choices are the person's. No layer is ever created (SPEC-14.8 3).
 */

export interface DrawingLayer {
  name: string;
  color: number;
  linetype: string | null;
  lineweight: number;
  off: boolean;
  frozen: boolean;
  locked: boolean;
  plot: boolean;
  /** A layer of an xref (`xref|layer`): never a target. */
  dependent: boolean;
}
export interface DrawingInspection {
  /** Worker read error (the drawing could not be read). */
  error: string | null;
  /** DWG header magic (`AC1032` …). */
  version: string | null;
  /** INSUNITS (4 = mm, 0 = none). */
  units: number | null;
  layers: DrawingLayer[];
  linetypes: { name: string; dependent: boolean }[];
  textStyles: { name: string; font: string; bigFont: string; dependent: boolean }[];
  /** Arrowheads from the style record: [first, second, leader]; "" = the default arrow. */
  dimStyles: {
    name: string;
    textStyle: string | null;
    arrows: (string | null)[];
    scale: number;
    dependent: boolean;
  }[];
  blocks: { name: string; inserts: number; attributes: boolean }[];
  xrefs: { name: string; path: string; overlay: boolean; status: string; inserts: number }[];
}

/** Reads engine copies of drawings (hosts/zwcad/drawing-inspect.ts, a fake in tests). */
export interface DrawingInspector {
  available(): Promise<boolean>;
  /** One answer per copy id; a copy without an answer was not read. */
  inspect(
    files: readonly { id: number; path: string }[],
    work: string,
    progress: (done: number) => void,
    signal?: AbortSignal,
  ): Promise<Map<number, DrawingInspection>>;
}

export type DrawingRefusal = 'READ_FAILED' | 'UNITS_NOT_MM';
const MM = 4,
  UNITLESS = 0;

/**
 * Whether the drawing may be a target of backflow or a new drawing (SPEC-14.3 3). A drawing
 * without units is read as mm, as the xref reader does (T-200), and says so.
 */
export function drawingEligibility(read: Pick<DrawingInspection, 'error' | 'units'>): {
  eligible: boolean;
  reason: DrawingRefusal | null;
  unitsAssumed: boolean;
} {
  if (read.error || read.units === null)
    return { eligible: false, reason: 'READ_FAILED', unitsAssumed: false };
  if (read.units === UNITLESS) return { eligible: true, reason: null, unitsAssumed: true };
  if (read.units !== MM) return { eligible: false, reason: 'UNITS_NOT_MM', unitsAssumed: false };
  return { eligible: true, reason: null, unitsAssumed: false };
}

const list = <T>(value: unknown, item: (row: Record<string, unknown>) => T): T[] =>
  Array.isArray(value)
    ? value
        .filter((row) => row && typeof row === 'object')
        .map((row) => item(row as Record<string, unknown>))
    : [];
const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const flag = (value: unknown, fallback = false) => (typeof value === 'boolean' ? value : fallback);

/** The worker's JSON line as a DrawingInspection (unknown fields dropped, types checked). */
export function inspectionOf(row: Record<string, unknown>): DrawingInspection {
  return {
    error: typeof row.error === 'string' ? row.error : null,
    version: typeof row.version === 'string' ? row.version : null,
    units: typeof row.units === 'number' ? row.units : null,
    layers: list(row.layers, (r) => ({
      name: text(r.name),
      color: num(r.color, 7),
      linetype: typeof r.linetype === 'string' ? r.linetype : null,
      lineweight: num(r.lineweight, -3),
      off: flag(r.off),
      frozen: flag(r.frozen),
      locked: flag(r.locked),
      plot: flag(r.plot, true),
      dependent: flag(r.dependent) || text(r.name).includes('|'),
    })).filter((layer) => layer.name),
    linetypes: list(row.linetypes, (r) => ({ name: text(r.name), dependent: flag(r.dependent) })),
    textStyles: list(row.textStyles, (r) => ({
      name: text(r.name),
      font: text(r.font),
      bigFont: text(r.bigFont),
      dependent: flag(r.dependent),
    })),
    dimStyles: list(row.dimStyles, (r) => ({
      name: text(r.name),
      textStyle: typeof r.textStyle === 'string' ? r.textStyle : null,
      arrows: Array.isArray(r.arrows)
        ? r.arrows.slice(0, 3).map((a) => (typeof a === 'string' ? a : null))
        : [],
      scale: num(r.scale, 1),
      dependent: flag(r.dependent),
    })),
    blocks: list(row.blocks, (r) => ({
      name: text(r.name),
      inserts: num(r.inserts, -1),
      attributes: flag(r.attributes),
    })),
    xrefs: list(row.xrefs, (r) => ({
      name: text(r.name),
      path: text(r.path),
      overlay: flag(r.overlay),
      status: text(r.status, 'Unknown'),
      inserts: num(r.inserts, -1),
    })),
  };
}

export interface LayerMapEntry {
  /** Source (Rhino) layer full path. */
  source: string;
  /** Drawing layer, spelled as in the drawing; null: '레이어 지정 필요'. */
  layer: string | null;
  /** `same`: same name (full path or its last part); `user`: chosen; `none`: nothing found. */
  how: 'same' | 'user' | 'none';
}

const fold = (name: string) => name.trim().toLowerCase();
/** The last part of a Rhino layer path (`건축::벽` → `벽`). */
const leaf = (source: string) => source.split('::').at(-1)!.trim();

/** Layers a backflow may write to: the drawing's own (not xref-dependent) layers. */
export const targetLayers = (read: Pick<DrawingInspection, 'layers'>) =>
  read.layers.filter((layer) => !layer.dependent).map((layer) => layer.name);

/**
 * One drawing's layer table for the given source layers. `chosen` holds the person's choices
 * (source → drawing layer, or null to leave it unmapped); a chosen layer that is not in the drawing
 * is refused (LAYER_NOT_IN_DRAWING) — the table never names a layer the drawing lacks.
 */
export function layerMap(
  sources: readonly string[],
  drawingLayers: readonly string[],
  chosen: Readonly<Record<string, string | null>> = {},
): LayerMapEntry[] {
  const byName = new Map(drawingLayers.map((name) => [fold(name), name]));
  const seen = new Set<string>();
  const entries: LayerMapEntry[] = [];
  for (const raw of sources) {
    const source = typeof raw === 'string' ? raw.trim() : '';
    if (!source || seen.has(source)) continue;
    seen.add(source);
    if (Object.hasOwn(chosen, source)) {
      const want = chosen[source];
      if (want === null) {
        entries.push({ source, layer: null, how: 'user' });
        continue;
      }
      const layer = byName.get(fold(want));
      if (!layer) throw new DomainError('LAYER_NOT_IN_DRAWING');
      entries.push({ source, layer, how: 'user' });
      continue;
    }
    const layer = byName.get(fold(source)) ?? byName.get(fold(leaf(source)));
    entries.push(layer ? { source, layer, how: 'same' } : { source, layer: null, how: 'none' });
  }
  return entries;
}

/**
 * Another drawing's table applied to this one (SPEC-14.3 1): the person's choices whose layer this
 * drawing also has are kept, the others are listed in `dropped`, and every source is matched again
 * by name. The sources are the union of the copied table's and `sources`.
 */
export function copyLayerMap(
  from: readonly LayerMapEntry[],
  drawingLayers: readonly string[],
  sources: readonly string[] = [],
): { entries: LayerMapEntry[]; dropped: string[] } {
  const present = new Set(drawingLayers.map(fold));
  const chosen: Record<string, string | null> = {};
  const dropped: string[] = [];
  for (const entry of from) {
    if (entry.how !== 'user') continue;
    if (entry.layer === null || present.has(fold(entry.layer))) chosen[entry.source] = entry.layer;
    else dropped.push(entry.source);
  }
  return {
    entries: layerMap([...from.map((entry) => entry.source), ...sources], drawingLayers, chosen),
    dropped,
  };
}

export interface DrawingReadRow {
  path: string;
  size: number;
  mtime: string;
  sha256: string;
  readAt: string;
  read: DrawingInspection;
}
export interface DrawingLayerMapRow {
  path: string;
  entries: LayerMapEntry[];
  /** The fingerprint of the read the table was made against. */
  sha256: string;
  revision: number;
  updatedAt: string;
}

/** The project DB rows (schema 15): drawing reads and per-drawing layer tables. */
export class DrawingLayerStore {
  private readonly store: Store;
  private readonly now: () => Date;
  constructor(store: Store, { now = () => new Date() }: { now?: () => Date } = {}) {
    this.store = store;
    this.now = now;
  }
  private db(projectId: string) {
    this.store.project(projectId);
    return this.store.db(projectId);
  }
  reads(projectId: string): DrawingReadRow[] {
    return this.db(projectId)
      .prepare('SELECT * FROM drawing_reads WHERE projectId=? ORDER BY path')
      .all(projectId)
      .map((row) => ({
        path: String(row.path),
        size: Number(row.size),
        mtime: String(row.mtime),
        sha256: String(row.sha256),
        readAt: String(row.readAt),
        read: JSON.parse(String(row.data)) as DrawingInspection,
      }));
  }
  read(projectId: string, path: string): DrawingReadRow | null {
    return this.reads(projectId).find((row) => pathKey(row.path) === pathKey(path)) ?? null;
  }
  saveRead(projectId: string, row: DrawingReadRow) {
    this.db(projectId)
      .prepare(
        `INSERT INTO drawing_reads VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(projectId, key) DO UPDATE SET
          path=excluded.path, size=excluded.size, mtime=excluded.mtime, sha256=excluded.sha256,
          readAt=excluded.readAt, data=excluded.data`,
      )
      .run(
        projectId,
        pathKey(row.path),
        row.path,
        row.size,
        row.mtime,
        row.sha256,
        row.readAt,
        JSON.stringify(row.read),
      );
  }
  map(projectId: string, path: string): DrawingLayerMapRow | null {
    const row = this.db(projectId)
      .prepare('SELECT * FROM drawing_layer_maps WHERE projectId=? AND key=?')
      .get(projectId, pathKey(path));
    return row
      ? {
          path: String(row.path),
          entries: JSON.parse(String(row.entries)) as LayerMapEntry[],
          sha256: String(row.sha256),
          revision: Number(row.revision),
          updatedAt: String(row.updatedAt),
        }
      : null;
  }
  /** Replaces the drawing's table; `revision` (when given) must be the stored one. */
  saveMap(
    projectId: string,
    path: string,
    entries: LayerMapEntry[],
    sha256: string,
    revision?: number,
  ): DrawingLayerMapRow {
    const db = this.db(projectId);
    const current = this.map(projectId, path);
    if (revision !== undefined && revision !== (current?.revision ?? 0))
      throw new DomainError('REVISION_CONFLICT');
    const row = {
      path,
      entries,
      sha256,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: this.now().toISOString(),
    };
    db.prepare(
      `INSERT INTO drawing_layer_maps VALUES(?,?,?,?,?,?,?) ON CONFLICT(projectId, key) DO UPDATE SET
        path=excluded.path, entries=excluded.entries, sha256=excluded.sha256,
        revision=excluded.revision, updatedAt=excluded.updatedAt`,
    ).run(
      projectId,
      pathKey(path),
      path,
      JSON.stringify(entries),
      sha256,
      row.revision,
      row.updatedAt,
    );
    return row;
  }
}

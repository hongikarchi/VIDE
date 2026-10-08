// Nested Rhino blocks (ARCH-01 「Rhino 네이티브 취득의 블록 보존」). The plugin sends each block
// definition's own geometry once per page and its nested blocks as `children` references
// ({definition, transform}) to definitions sent beside it, so a block nested N×M times costs its
// geometry once in the reply instead of N×M copies (which no longer fit a reply and came as a box).
// Everything after the read (storage, the screen, jigs, the offline view) reads a definition as one
// flat geometry in definition space, so the engine expands the references here, per page, before the
// page is checked: each definition is expanded once and reused by every definition that nests it.
// A few MB of references can stand for GBs of copies, so the expansion has two caps: per definition
// and per read (a whole Sync, a Live change read or an export); what passes them is left out and
// the definition is `partial` (counted as not shown in full) instead of exhausting the engine.
import { createHash } from 'node:crypto';
import {
  coordinate,
  jsonSafeGeometry,
  type Indices,
  type PackedPositions,
  type Positions,
} from '../../src/contracts/geometry-transfer.ts';

/**
 * Coordinates (vertex and segment values together) one expanded definition may hold: 4 million
 * points, already more than a browser draws smoothly. Copies beyond it are left out (`partial`).
 */
export const MAX_EXPANDED_VALUES = 12_000_000;
/**
 * Coordinates the large definitions expanded in one read that keeps typed arrays (the display Sync)
 * may hold together, over all its pages: about 0.5 GB at the peak (doubles while a page expands,
 * float32 kept). Within a page the large definitions share it smallest first (see `fairOrder`).
 */
export const MAX_READ_EXPANDED_VALUES = 24_000_000;
/**
 * A definition this small in full (a third of a million points) draws from a pool of its own, so
 * the large blocks read before it in the same read do not leave it out.
 */
export const SMALL_EXPANDED_VALUES = 1_000_000;
/** The small definitions' pool per read (see SMALL_EXPANDED_VALUES). */
export const MAX_READ_SMALL_VALUES = 12_000_000;
/**
 * A read that keeps plain number arrays (a Live change read, the working copy's export) holds a value
 * in about 50 bytes at its peak (the expanded array and the checked copy) rather than 12 to 20 with
 * typed arrays, so it may expand half as much: about 1 GB at the peak, well inside the engine's heap.
 */
export const PLAIN_READ_SHARE = 2;
/** Labels per definition (the display schema's limit); further ones are left out. */
const MAX_TEXTS = 2000;
/**
 * Nesting levels expanded below a definition. The plugin sends every level by reference; this only
 * bounds the recursion. A cut this deep is not cached, so a shallower use of the same definition
 * still expands in full (the result does not depend on which instance is read first).
 */
const MAX_DEPTH = 1000;

/** What one read may still expand (shared by its pages): large definitions and small ones. */
export interface ExpansionBudget {
  left: number;
  small: number;
}
export const expansionBudget = (
  values = MAX_READ_EXPANDED_VALUES,
  small = MAX_READ_SMALL_VALUES,
): ExpansionBudget => ({ left: values, small });
/** The budget of a read that keeps typed arrays, or a plain one (see PLAIN_READ_SHARE). */
export const readBudget = (typed: boolean) =>
  typed
    ? expansionBudget()
    : expansionBudget(
        MAX_READ_EXPANDED_VALUES / PLAIN_READ_SHARE,
        MAX_READ_SMALL_VALUES / PLAIN_READ_SHARE,
      );

/** A label in definition space. `u`: dimension text, kept readable (the plugin turns it upright). */
interface Text {
  s: string;
  p: [number, number, number];
  h: number;
  r: number;
  ax: number;
  ay: number;
  u?: boolean;
}
/**
 * A label inside the expansion also carries `a`, its height as a vector along the definition's X
 * axis, and `d`, its direction, so nested transforms compose like one combined transform.
 */
interface Label extends Text {
  a: [number, number, number];
  d: [number, number, number];
}
interface Child {
  definition: string;
  transform: number[];
}
interface Definition {
  hash?: string;
  vertices?: Positions;
  indices?: Indices;
  segments?: Positions;
  texts?: Text[];
  children?: Child[];
  partial?: true;
}
interface Flat {
  vertices: Float64Array;
  indices: Uint32Array;
  segments: Float64Array;
  texts: Label[];
  /** Something is left out (by the plugin or here). */
  partial: boolean;
  /** Left out here (size caps, a missing or cyclic reference): the plugin's hash no longer fits. */
  cut: boolean;
  /** Cut by MAX_DEPTH below this use: not cached (see MAX_DEPTH). */
  deep: boolean;
}

const empty = (deep = false): Flat => ({
  vertices: new Float64Array(0),
  indices: new Uint32Array(0),
  segments: new Float64Array(0),
  texts: [],
  partial: true,
  cut: true,
  deep,
});

const label = (text: Text): Label => ({
  ...text,
  a: [text.h, 0, 0],
  d: [Math.cos(text.r), Math.sin(text.r), 0],
});

function own(definition: Definition): Flat {
  const read = (values: Positions | undefined) => {
    const out = new Float64Array(values?.length ?? 0);
    for (let i = 0; i < out.length; i++) out[i] = coordinate(values!, i);
    return out;
  };
  return {
    vertices: read(definition.vertices),
    indices: Uint32Array.from(definition.indices ?? []),
    segments: read(definition.segments),
    texts: (definition.texts ?? []).map(label),
    partial: definition.partial === true,
    cut: false,
    deep: false,
  };
}

/** Row-major 4x4 applied to xyz triples (affine: the last row is 0 0 0 1 for block transforms). */
function place(values: Float64Array, m: number[], out: Float64Array, at: number) {
  for (let i = 0; i < values.length; i += 3) {
    const x = values[i],
      y = values[i + 1],
      z = values[i + 2];
    out[at + i] = m[0] * x + m[1] * y + m[2] * z + m[3];
    out[at + i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    out[at + i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  }
}

const linear = (m: number[], [x, y, z]: [number, number, number]): [number, number, number] => [
  m[0] * x + m[1] * y + m[2] * z,
  m[4] * x + m[5] * y + m[6] * z,
  m[8] * x + m[9] * y + m[10] * z,
];

/** Turned to read left to right, as the plugin draws dimension text (DisplayParts.AddLabel). */
const upright = (r: number) =>
  r > Math.PI / 2 + 1e-9 || r <= -Math.PI / 2 + 1e-9 ? r + (r > 0 ? -Math.PI : Math.PI) : r;

/**
 * A label moved by the transform: its point; its height as the length of the moved X axis vector
 * (the plugin's rule, here on the combined transform); its direction, upright again for dimensions.
 */
function placeText(text: Label, m: number[]): Label {
  const [x, y, z] = text.p;
  const a = linear(m, text.a),
    d = linear(m, text.d);
  const h = Math.hypot(...a);
  const r = d[0] || d[1] ? Math.atan2(d[1], d[0]) : text.r;
  return {
    ...text,
    p: [
      m[0] * x + m[1] * y + m[2] * z + m[3],
      m[4] * x + m[5] * y + m[6] * z + m[7],
      m[8] * x + m[9] * y + m[10] * z + m[11],
    ],
    a,
    d,
    h: Number.isFinite(h) ? h : text.h,
    r: text.u ? upright(r) : r,
  };
}

const usable = (child: unknown): child is Child =>
  !!child &&
  typeof (child as Child).definition === 'string' &&
  Array.isArray((child as Child).transform) &&
  (child as Child).transform.length === 16 &&
  (child as Child).transform.every(Number.isFinite);

interface Expansion {
  all: Record<string, Definition>;
  done: Map<string, Flat>;
  limit: number;
  budget: ExpansionBudget;
}

/** One definition with every nested reference expanded (memoized per definition ID). */
function expand(id: string, run: Expansion, path: Set<string>, share = Infinity): Flat {
  const cached = run.done.get(id);
  if (cached) return cached;
  const definition = run.all[id];
  // A missing nested definition or a cycle: left out and marked.
  if (!definition || path.has(id)) return empty();
  if (path.size >= MAX_DEPTH) return empty(true);
  const base = own(definition);
  if (definition.children === undefined) {
    run.done.set(id, base);
    return base;
  }
  const children = definition.children.filter(usable);
  path.add(id);
  const parts = children.map((child) => ({ child, flat: expand(child.definition, run, path) }));
  path.delete(id);
  let vertices = base.vertices.length,
    segments = base.segments.length,
    indices = base.indices.length,
    cut = definition.children.length !== children.length,
    partial = base.partial || cut,
    deep = false;
  // What this expansion may allocate: in full from the small pool when it is small and the pool
  // has room, else its own cap and what the read has left for large definitions.
  let full = vertices + segments;
  for (const part of parts) full += part.flat.vertices.length + part.flat.segments.length;
  const small = full <= SMALL_EXPANDED_VALUES && full <= run.budget.small && full <= run.limit;
  const room = small ? full : Math.min(run.limit, run.budget.left, share);
  const kept: typeof parts = [];
  for (const part of parts) {
    if (part.flat.partial) partial = true;
    if (part.flat.cut) cut = true;
    if (part.flat.deep) deep = true;
    const values = part.flat.vertices.length + part.flat.segments.length;
    if (vertices + segments + values > room) {
      partial = cut = true;
      continue;
    }
    kept.push(part);
    vertices += part.flat.vertices.length;
    segments += part.flat.segments.length;
    indices += part.flat.indices.length;
  }
  if (small) run.budget.small -= vertices + segments;
  else run.budget.left = Math.max(0, run.budget.left - vertices - segments);
  const out: Flat = {
    vertices: new Float64Array(vertices),
    indices: new Uint32Array(indices),
    segments: new Float64Array(segments),
    texts: base.texts.slice(0, MAX_TEXTS),
    partial,
    cut,
    deep,
  };
  out.vertices.set(base.vertices);
  out.indices.set(base.indices);
  out.segments.set(base.segments);
  let v = base.vertices.length,
    s = base.segments.length,
    f = base.indices.length;
  for (const { child, flat } of kept) {
    place(flat.vertices, child.transform, out.vertices, v);
    const offset = v / 3;
    for (let i = 0; i < flat.indices.length; i++) out.indices[f + i] = flat.indices[i] + offset;
    place(flat.segments, child.transform, out.segments, s);
    v += flat.vertices.length;
    s += flat.segments.length;
    f += flat.indices.length;
    for (const text of flat.texts) {
      if (out.texts.length >= MAX_TEXTS) {
        out.partial = out.cut = true;
        break;
      }
      out.texts.push(placeText(text, child.transform));
    }
  }
  if (!deep) run.done.set(id, out);
  return out;
}

/** A definition's size expanded in full (no allocation; memoized; a cycle or a missing one adds 0). */
function fullSize(
  id: string,
  all: Record<string, Definition>,
  sizes: Map<string, number>,
  path = new Set<string>(),
): number {
  const known = sizes.get(id);
  if (known !== undefined) return known;
  const definition = all[id];
  if (!definition || path.has(id) || path.size >= MAX_DEPTH) return 0;
  path.add(id);
  let size = (definition.vertices?.length ?? 0) + (definition.segments?.length ?? 0);
  for (const child of (definition.children ?? []).filter(usable))
    size += fullSize(child.definition, all, sizes, path);
  path.delete(id);
  sizes.set(id, size);
  return size;
}

/**
 * The page's definitions in the order they draw on the read's budget, each with its share: the
 * smallest first, and each large one at most an equal part of what is left for those still to come.
 * So one huge block does not leave the blocks beside it out, whichever row comes first.
 */
function fairOrder(ids: string[], run: Expansion) {
  const sizes = new Map<string, number>();
  const sized = ids
    .map((id) => ({ id, size: fullSize(id, run.all, sizes) }))
    .sort((a, b) => a.size - b.size);
  return sized.map(({ id }, i) => ({
    id,
    share: () => run.budget.left / (sized.length - i),
  }));
}

/** Packed float32 offsets from the first point, as a binary page delivers them (T-128). */
function packed(values: Float64Array): PackedPositions | number[] {
  if (values.length < 3) return Array.from(values);
  const origin: [number, number, number] = [values[0], values[1], values[2]];
  const local = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 3) {
    local[i] = values[i] - origin[0];
    local[i + 1] = values[i + 1] - origin[1];
    local[i + 2] = values[i + 2] - origin[2];
  }
  return Object.assign(local, { origin });
}
function indexArray(values: Uint32Array): Uint16Array | Uint32Array | number[] {
  if (!values.length) return [];
  let max = 0;
  for (const value of values) if (value > max) max = value;
  return max < 0x10000 ? Uint16Array.from(values) : values;
}
/** The label as the display schema has it (without `u` and the expansion's vectors). */
const outputText = ({ s, p, h, r, ax, ay }: Text): Text => ({ s, p, h, r, ax, ay });
/** The hash of a definition cut here: not the plugin's, so a later full read replaces it. */
const cutHash = (hash: string | undefined) =>
  createHash('sha256')
    .update(`${hash ?? ''}:partial`)
    .digest('hex');

/** Labels of definitions as they came (the leaves) without the plugin's `u`. */
function plainLabels<T>(page: T, all: Record<string, Definition>): T {
  for (const definition of Object.values(all))
    if (Array.isArray(definition?.texts) && definition.texts.some((text) => text && 'u' in text))
      definition.texts = definition.texts.map(outputText);
  return page;
}

/** The definitions a page's objects and scene rows use as their own block. */
function usedByRows(page: Record<string, unknown>) {
  const used = new Set<string>();
  for (const key of ['scene', 'objects'])
    for (const row of Array.isArray(page[key]) ? (page[key] as unknown[]) : []) {
      const definition = (row as { block?: { definition?: unknown } } | null)?.block?.definition;
      if (typeof definition === 'string') used.add(definition);
    }
  return used;
}

/**
 * Expands the nested references of a page's block definitions in place (see the file comment).
 * `typed`: the page keeps binary arrays (the display Sync on its way to storage); otherwise the arrays
 * are plain numbers. `budget`: what the read this page belongs to may still expand (one per read).
 * Definitions without references are left as they are, and the plugin's hash stays the expanded
 * definition's hash (it covers the nested definitions) unless the expansion was cut here. A page that
 * lists rows keeps only the definitions they use: one sent only because another nests it is already
 * inside that one, and is neither stored nor sent to the screen.
 */
export function expandNestedDefinitions<T>(
  page: T,
  {
    typed = false,
    limit = MAX_EXPANDED_VALUES,
    budget = readBudget(typed),
  }: { typed?: boolean; limit?: number; budget?: ExpansionBudget } = {},
): T {
  const record = (page as { definitions?: unknown } | null)?.definitions;
  if (!record || typeof record !== 'object') return page;
  const all = record as Record<string, Definition>;
  const nested = Object.keys(all).filter((id) => all[id]?.children !== undefined);
  if (!nested.length) return plainLabels(page, all);
  const rows = page as Record<string, unknown>;
  const listed = Array.isArray(rows.scene) || Array.isArray(rows.objects);
  const used = usedByRows(rows);
  const nestedOnly = new Set(
    nested.flatMap((id) => (all[id].children ?? []).filter(usable).map((c) => c.definition)),
  );
  const unused = (id: string) => listed && nestedOnly.has(id) && !used.has(id);
  const run: Expansion = { all, done: new Map(), limit, budget };
  // What the rows show first, so it gets the read's budget before anything else.
  const kept = nested.filter((id) => !unused(id));
  const flats = [
    ...fairOrder(
      kept.filter((id) => used.has(id)),
      run,
    ),
    ...fairOrder(
      kept.filter((id) => !used.has(id)),
      run,
    ),
  ].map(({ id, share }) => [id, expand(id, run, new Set(), share())] as const);
  for (const id of Object.keys(all)) if (unused(id)) delete all[id];
  plainLabels(page, all);
  for (const [id, flat] of flats) {
    const { children: _children, ...rest } = all[id];
    const next: Definition = {
      ...rest,
      ...(flat.cut ? { hash: cutHash(rest.hash) } : {}),
      vertices: typed ? packed(flat.vertices) : Array.from(flat.vertices),
      indices: typed ? indexArray(flat.indices) : Array.from(flat.indices),
      segments: typed ? packed(flat.segments) : Array.from(flat.segments),
      texts: flat.texts.map(outputText),
    };
    if (flat.partial) next.partial = true;
    else delete next.partial;
    all[id] = typed ? jsonSafeGeometry(next) : next;
  }
  return page;
}

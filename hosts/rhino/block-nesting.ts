// Nested Rhino blocks (ARCH-01 「Rhino 네이티브 취득의 블록 보존」). The plugin sends each block
// definition's own geometry once per page and its nested blocks as `children` references
// ({definition, transform}) to definitions sent beside it, so a block nested N×M times costs its
// geometry once in the reply instead of N×M copies (which no longer fit a reply and came as a box).
// Everything after the read (storage, the screen, jigs, the offline view) reads a definition as one
// flat geometry in definition space, so the engine expands the references here, per page, before the
// page is checked: each definition is expanded once and reused by every definition that nests it.
import {
  coordinate,
  jsonSafeGeometry,
  type Indices,
  type PackedPositions,
  type Positions,
} from '../../src/contracts/geometry-transfer.ts';

/**
 * Coordinates (vertex and segment values together) one expanded definition may hold: about 20 million
 * points, past what a browser can draw. Copies beyond it are left out and the definition is marked
 * `partial` (counted in the display coverage as not shown in full) instead of exhausting memory.
 */
export const MAX_EXPANDED_VALUES = 60_000_000;
/** Labels per definition (the display schema's limit); further ones are left out. */
const MAX_TEXTS = 2000;
/** Nesting levels expanded below a definition (the plugin sends at most 32). */
const MAX_DEPTH = 64;

interface Text {
  s: string;
  p: [number, number, number];
  h: number;
  r: number;
  ax: number;
  ay: number;
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
  texts: Text[];
  partial: boolean;
}

const EMPTY: Flat = {
  vertices: new Float64Array(0),
  indices: new Uint32Array(0),
  segments: new Float64Array(0),
  texts: [],
  partial: true,
};

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
    texts: [...(definition.texts ?? [])],
    partial: definition.partial === true,
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

/** A label moved by the transform: its point, its height by the X axis scale, its direction. */
function placeText(text: Text, m: number[]): Text {
  const [x, y, z] = text.p;
  const dx = Math.cos(text.r),
    dy = Math.sin(text.r);
  const ux = m[0] * dx + m[1] * dy,
    uy = m[4] * dx + m[5] * dy;
  const scale = Math.hypot(m[0], m[4], m[8]);
  return {
    ...text,
    p: [
      m[0] * x + m[1] * y + m[2] * z + m[3],
      m[4] * x + m[5] * y + m[6] * z + m[7],
      m[8] * x + m[9] * y + m[10] * z + m[11],
    ],
    h: text.h * (Number.isFinite(scale) ? scale : 1),
    r: ux || uy ? Math.atan2(uy, ux) : text.r,
  };
}

const usable = (child: unknown): child is Child =>
  !!child &&
  typeof (child as Child).definition === 'string' &&
  Array.isArray((child as Child).transform) &&
  (child as Child).transform.length === 16 &&
  (child as Child).transform.every(Number.isFinite);

/** One definition with every nested reference expanded (memoized per definition ID). */
function expand(
  id: string,
  all: Record<string, Definition>,
  done: Map<string, Flat>,
  path: Set<string>,
  limit: number,
): Flat {
  const cached = done.get(id);
  if (cached) return cached;
  const definition = all[id];
  // A missing nested definition, a cycle or too deep a nesting: left out and marked.
  if (!definition || path.has(id) || path.size >= MAX_DEPTH) return EMPTY;
  const base = own(definition);
  const children = (definition.children ?? []).filter(usable);
  if (!children.length) {
    done.set(id, base);
    return base;
  }
  path.add(id);
  const parts = children.map((child) => ({
    child,
    flat: expand(child.definition, all, done, path, limit),
  }));
  path.delete(id);
  let vertices = base.vertices.length,
    segments = base.segments.length,
    indices = base.indices.length,
    partial = base.partial || (definition.children?.length ?? 0) !== children.length;
  const kept: typeof parts = [];
  for (const part of parts) {
    if (part.flat.partial) partial = true;
    const values = part.flat.vertices.length + part.flat.segments.length;
    if (vertices + segments + values > limit) {
      partial = true;
      continue;
    }
    kept.push(part);
    vertices += part.flat.vertices.length;
    segments += part.flat.segments.length;
    indices += part.flat.indices.length;
  }
  const out: Flat = {
    vertices: new Float64Array(vertices),
    indices: new Uint32Array(indices),
    segments: new Float64Array(segments),
    texts: base.texts.slice(0, MAX_TEXTS),
    partial,
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
        out.partial = true;
        break;
      }
      out.texts.push(placeText(text, child.transform));
    }
  }
  done.set(id, out);
  return out;
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

/**
 * Expands the nested references of a page's block definitions in place (see the file comment).
 * `typed`: the page keeps binary arrays (the display Sync on its way to storage); otherwise the arrays
 * are plain numbers. Definitions without references are left as they are; the plugin's hash already
 * covers the nested definitions, so it stays the expanded definition's hash.
 */
export function expandNestedDefinitions<T>(
  page: T,
  { typed = false, limit = MAX_EXPANDED_VALUES }: { typed?: boolean; limit?: number } = {},
): T {
  const record = (page as { definitions?: unknown } | null)?.definitions;
  if (!record || typeof record !== 'object') return page;
  const all = record as Record<string, Definition>;
  const nested = Object.keys(all).filter((id) => all[id]?.children !== undefined);
  if (!nested.length) return page;
  const done = new Map<string, Flat>();
  const flats = nested.map((id) => [id, expand(id, all, done, new Set(), limit)] as const);
  for (const [id, flat] of flats) {
    const { children: _children, ...rest } = all[id];
    const next: Definition = {
      ...rest,
      vertices: typed ? packed(flat.vertices) : Array.from(flat.vertices),
      indices: typed ? indexArray(flat.indices) : Array.from(flat.indices),
      segments: typed ? packed(flat.segments) : Array.from(flat.segments),
      texts: flat.texts,
    };
    if (flat.partial) next.partial = true;
    else delete next.partial;
    all[id] = typed ? jsonSafeGeometry(next) : next;
  }
  return page;
}

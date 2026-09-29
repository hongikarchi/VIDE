import { gzipSync } from 'node:zlib';
import {
  SNAPSHOT_FORMAT,
  encodeSnapshot,
  type Snapshot,
  type SnapshotKind,
  type SnapshotText,
} from '../contracts/offline-snapshot.ts';
import { aciColor } from '../ui/plot-style.ts';

// Builds the offline view snapshot (PLAN-20) from a stored display Sync: meshes, wires, hatch
// outlines, points and text labels merged per layer, with each object's screen colour per vertex.
// Block instances are placed with their transforms. Nothing else of the document leaves the PC.

interface Item {
  valid?: boolean;
  nativeType?: string;
  vertices?: number[];
  indices?: number[];
  line?: number[];
  segments?: number[];
  origin?: number[];
  layer64?: string;
  displayColor?: string;
  layerColor?: string;
  materialColor?: string | null;
  colorIndex?: number;
  color?: number | string;
  fills?: { loops: number[][] }[];
  texts?: { s: string; p: number[]; h: number; r: number }[];
  block?: { definition: string; transform: number[] };
}
interface Definition {
  vertices: number[];
  indices: number[];
  segments: number[];
  texts?: { s: string; p: number[]; h: number; r: number }[];
}
export interface SyncResult {
  scene?: unknown[];
  definitions?: Record<string, unknown>;
  sourceDocument?: { name?: unknown; units?: unknown; capturedAt?: unknown };
}

const MAX_TEXTS = 20_000;
const hex = (value: unknown) =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
function colorOf(item: Item) {
  return (
    hex(item.displayColor) ??
    hex(item.color) ??
    (item.colorIndex !== undefined ? aciColor(item.colorIndex) : undefined) ??
    (typeof item.color === 'number' ? aciColor(item.color) : undefined) ??
    hex(item.materialColor) ??
    hex(item.layerColor) ??
    '#8a8f98'
  );
}
const rgb = (color: string) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
const layerName = (value: unknown) => {
  if (typeof value !== 'string' || !value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
};

class Bucket {
  positions: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  readonly layer: string;
  readonly kind: SnapshotKind;
  constructor(layer: string, kind: SnapshotKind) {
    this.layer = layer;
    this.kind = kind;
  }
  /** Adds xyz vertices in one colour; returns the index of the first one. */
  add(points: ArrayLike<number>, color: number[]) {
    const first = this.positions.length / 3;
    for (let i = 0; i + 2 < points.length; i += 3) {
      this.positions.push(points[i], points[i + 1], points[i + 2]);
      this.colors.push(color[0], color[1], color[2]);
    }
    return first;
  }
}

/** Row-major 4x4 transform of flat xyz values. */
function place(values: number[], m: number[]) {
  const out = new Array<number>(values.length);
  for (let i = 0; i + 2 < values.length; i += 3) {
    const [x, y, z] = [values[i], values[i + 1], values[i + 2]];
    out[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
    out[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    out[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  }
  return out;
}
const finite = (values: unknown): values is number[] =>
  Array.isArray(values) && values.every((v) => typeof v === 'number' && Number.isFinite(v));

export function buildSnapshot(
  result: SyncResult,
  meta: { name: string; host: 'rhino' | 'zwcad' },
): Snapshot {
  const buckets = new Map<string, Bucket>();
  const bucket = (layer: string, kind: SnapshotKind) => {
    const key = kind + '\u0000' + layer;
    let found = buckets.get(key);
    if (!found) buckets.set(key, (found = new Bucket(layer, kind)));
    return found;
  };
  const texts: (Omit<SnapshotText, 'p'> & { p: number[] })[] = [];
  const definitions = (result.definitions ?? {}) as Record<string, Definition>;
  let objectCount = 0;
  const mesh = (layer: string, color: number[], vertices: number[], indices: number[]) => {
    if (!vertices.length || !indices.length) return;
    const target = bucket(layer, 'mesh');
    const first = target.add(vertices, color);
    const count = vertices.length / 3;
    for (const index of indices) if (index < count) target.indices.push(first + index);
  };
  const pairs = (layer: string, color: number[], segments: number[]) => {
    if (segments.length >= 6)
      bucket(layer, 'lines').add(segments.slice(0, segments.length - (segments.length % 6)), color);
  };
  const polyline = (layer: string, color: number[], line: number[], closed = false) => {
    const out: number[] = [];
    const n = Math.floor(line.length / 3);
    for (let i = 0; i + 1 < n; i++) out.push(...line.slice(i * 3, i * 3 + 6));
    if (closed && n > 2) out.push(...line.slice((n - 1) * 3, n * 3), ...line.slice(0, 3));
    pairs(layer, color, out);
  };
  const label = (
    layer: string,
    color: string,
    text: { s: string; p: number[]; h: number; r: number },
    transform?: number[],
  ) => {
    if (texts.length >= MAX_TEXTS || typeof text.s !== 'string' || !finite(text.p)) return;
    const p = transform ? place(text.p.slice(0, 3), transform) : text.p.slice(0, 3);
    texts.push({ s: text.s.slice(0, 200), p, h: text.h, r: text.r, layer, color });
  };
  for (const raw of result.scene ?? []) {
    const item = raw as Item;
    if (!item || item.valid === false) continue;
    objectCount++;
    const layer = layerName(item.layer64);
    const colorHex = colorOf(item),
      color = rgb(colorHex);
    if (item.block) {
      const definition = definitions[item.block.definition];
      const m = item.block.transform;
      if (definition && finite(m) && m.length === 16) {
        mesh(layer, color, place(definition.vertices ?? [], m), definition.indices ?? []);
        pairs(layer, color, place(definition.segments ?? [], m));
        for (const text of definition.texts ?? []) label(layer, colorHex, text, m);
      }
      continue;
    }
    if (finite(item.vertices) && finite(item.indices))
      mesh(layer, color, item.vertices, item.indices);
    if (finite(item.line)) polyline(layer, color, item.line);
    if (finite(item.segments)) pairs(layer, color, item.segments);
    for (const fill of item.fills ?? [])
      for (const loop of fill.loops ?? []) if (finite(loop)) polyline(layer, color, loop, true);
    for (const text of item.texts ?? []) label(layer, colorHex, text);
    if (
      item.nativeType === 'Point' &&
      !item.vertices?.length &&
      !item.line?.length &&
      !item.segments?.length &&
      finite(item.origin) &&
      item.origin.length === 3
    )
      bucket(layer, 'points').add(item.origin, color);
  }
  // One origin for the whole file keeps float32 positions precise at survey coordinates.
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  const grow = (values: ArrayLike<number>) => {
    for (let i = 0; i < values.length; i++) {
      const axis = i % 3;
      if (values[i] < min[axis]) min[axis] = values[i];
      if (values[i] > max[axis]) max[axis] = values[i];
    }
  };
  for (const b of buckets.values()) grow(b.positions);
  for (const text of texts) grow(text.p);
  const empty = min[0] === Infinity;
  const origin = (empty ? [0, 0, 0] : min.map((v, i) => (v + max[i]) / 2)) as [
    number,
    number,
    number,
  ];
  const extent = (empty ? [0, 0, 0] : max.map((v, i) => (v - min[i]) / 2)) as [
    number,
    number,
    number,
  ];
  const relative = (values: number[]) => {
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) out[i] = values[i] - origin[i % 3];
    return out;
  };
  const groups = [...buckets.values()]
    .filter((b) => b.positions.length)
    // Code-point order: the same file gives the same bytes on every PC locale.
    .sort((a, b) =>
      a.layer !== b.layer
        ? a.layer < b.layer
          ? -1
          : 1
        : a.kind < b.kind
          ? -1
          : a.kind > b.kind
            ? 1
            : 0,
    )
    .map((b) => ({
      layer: b.layer,
      kind: b.kind,
      positions: relative(b.positions),
      colors: Uint8Array.from(b.colors),
      ...(b.kind === 'mesh' ? { indices: Uint32Array.from(b.indices) } : {}),
    }));
  const source = result.sourceDocument ?? {};
  return {
    format: SNAPSHOT_FORMAT,
    name: meta.name,
    host: meta.host,
    ...(typeof source.units === 'string' && source.units ? { units: source.units } : {}),
    capturedAt:
      typeof source.capturedAt === 'string' ? source.capturedAt : new Date().toISOString(),
    objectCount,
    origin,
    extent,
    groups,
    texts: texts.map((text) => ({
      ...text,
      p: [text.p[0] - origin[0], text.p[1] - origin[1], text.p[2] - origin[2]] as [
        number,
        number,
        number,
      ],
    })),
  };
}

/** The gzip-wrapped bytes the PC uploads. */
export const packSnapshot = (snapshot: Snapshot) =>
  gzipSync(encodeSnapshot(snapshot), { level: 6 });

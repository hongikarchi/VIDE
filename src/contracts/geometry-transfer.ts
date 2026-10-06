// Binary transfer of a request's display geometry (PLAN-18 step 2). The workspace fetches one
// request in full to show its model; for a large Sync that JSON is tens of MB of number text. Here
// the coordinate and index arrays of scene items and block definitions travel as typed arrays:
//   "VGT1" | u32 header length | header JSON (UTF-8) | pad to 4 | buffers (4-byte aligned)
// In the header each moved array is replaced by {"$bin":[offset, length, type, ox, oy, oz]}.
// Coordinates are float32 offsets from the array's first point (float64 in the header), so survey
// coordinates keep sub-millimetre precision for objects up to kilometres in size. Everything else
// (ids, attributes, measurements, texts) stays JSON. Decoding restores plain number arrays.

export const GEOMETRY_TYPE = 'application/vnd.vide.geometry';
const MAGIC = [0x56, 0x47, 0x54, 0x31]; // "VGT1"
const POSITION_FIELDS = ['vertices', 'line', 'segments'] as const;
type Reference = { $bin: [number, number, 'f' | 'u16' | 'u32', number, number, number] };

const align = (n: number) => (n + 3) & ~3;
const isNumbers = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length > 0 && typeof value[0] === 'number';

/** Packs the coordinate and index arrays of items into 4-byte aligned buffers (see header). */
function packer() {
  const buffers: Uint8Array[] = [];
  let offset = 0;
  const add = (bytes: Uint8Array) => {
    const at = offset;
    buffers.push(bytes);
    offset += bytes.byteLength;
    const pad = align(offset) - offset;
    if (pad) {
      buffers.push(new Uint8Array(pad));
      offset += pad;
    }
    return at;
  };
  const positions = (values: number[]): Reference | number[] => {
    if (values.length < 3 || values.length % 3 || !values.every(Number.isFinite)) return values;
    const [ox, oy, oz] = values;
    const local = new Float32Array(values.length);
    for (let i = 0; i < values.length; i += 3) {
      local[i] = values[i] - ox;
      local[i + 1] = values[i + 1] - oy;
      local[i + 2] = values[i + 2] - oz;
    }
    return { $bin: [add(new Uint8Array(local.buffer)), values.length, 'f', ox, oy, oz] };
  };
  const indices = (values: number[]): Reference | number[] => {
    let max = 0;
    for (const v of values) {
      if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) return values;
      if (v > max) max = v;
    }
    const small = max < 0x10000;
    const array = small ? Uint16Array.from(values) : Uint32Array.from(values);
    return {
      $bin: [add(new Uint8Array(array.buffer)), values.length, small ? 'u16' : 'u32', 0, 0, 0],
    };
  };
  const pack = (item: unknown) => {
    if (!item || typeof item !== 'object') return item;
    const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
    for (const field of POSITION_FIELDS)
      if (isNumbers(out[field])) out[field] = positions(out[field] as number[]);
    if (isNumbers(out.indices)) out.indices = indices(out.indices as number[]);
    return out;
  };
  return { pack, buffers, size: () => offset };
}

/** "VGT1" | u32 header length | header JSON | pad | buffers (already aligned). */
function container(header: unknown, buffers: Uint8Array[], size: number): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const start = align(8 + json.byteLength);
  const out = new Uint8Array(start + size);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, json.byteLength, true);
  out.set(json, 8);
  let at = start;
  for (const bytes of buffers) {
    out.set(bytes, at);
    at += bytes.byteLength;
  }
  return out;
}

export function encodeGeometry(value: unknown): Uint8Array {
  const { pack, buffers, size } = packer();
  const root = value as { result?: { scene?: unknown; definitions?: unknown } } | null;
  let header: unknown = value;
  const result = root?.result;
  if (result && typeof result === 'object') {
    const next: Record<string, unknown> = { ...result };
    if (Array.isArray(result.scene)) next.scene = result.scene.map(pack);
    if (result.definitions && typeof result.definitions === 'object')
      next.definitions = Object.fromEntries(
        Object.entries(result.definitions as Record<string, unknown>).map(([k, v]) => [k, pack(v)]),
      );
    header = { ...root, result: next };
  }
  return container(header, buffers, size());
}

// Per-object storage (PLAN-27 1단계, ARCH-01 §5 「Sync 표시 형상의 객체 단위 저장」). A scene item
// or block definition is kept as `meta` (the item with each moved array replaced by the string
// "$bin" at its own key, so the key order survives) and `geometry`, a VGT1 container whose header
// is `{field: {$bin: […]}}` for the moved arrays only. Stored coordinates are the float32 offsets
// the screen already receives. `joinGeometry` concatenates stored containers into the same VGT1 as
// `encodeGeometry` of the whole request without decoding a coordinate.
const SLOT = '$bin';
export type EncodedItem = { meta: unknown; geometry: Uint8Array | null };

export function encodeItem(item: unknown): EncodedItem {
  const { pack, buffers, size } = packer();
  const packed = pack(item);
  if (!size() || !packed || typeof packed !== 'object') return { meta: item, geometry: null };
  const meta: Record<string, unknown> = {};
  const header: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(packed as Record<string, unknown>)) {
    const moved = !!value && typeof value === 'object' && Array.isArray((value as Reference).$bin);
    meta[key] = moved ? SLOT : value;
    if (moved) header[key] = value;
  }
  return { meta, geometry: container(header, buffers, size()) };
}

export function decodeItem(meta: unknown, geometry: Uint8Array | null | undefined): unknown {
  if (!geometry || !meta || typeof meta !== 'object') return meta;
  const parts = decodeGeometry(geometry) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta as Record<string, unknown>))
    out[key] = value === SLOT && key in parts ? parts[key] : value;
  return out;
}

/**
 * `decodeItem` deferred (T-129): the item's JSON fields as they are and each moved array as a
 * getter that decodes the item's container on first read. A reader that looks only at ids, layers
 * or measurements decodes nothing; the arrays it does read equal `decodeItem`'s.
 */
export function lazyItem(meta: unknown, geometry: Uint8Array | null | undefined): unknown {
  if (!geometry || !meta || typeof meta !== 'object') return meta;
  let parts: Record<string, unknown> | undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (value !== SLOT) {
      out[key] = value;
      continue;
    }
    Object.defineProperty(out, key, {
      enumerable: true,
      configurable: true,
      get() {
        parts ??= decodeGeometry(geometry) as Record<string, unknown>;
        return key in parts ? parts[key] : value;
      },
      set(next: unknown) {
        Object.defineProperty(out, key, {
          value: next,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
    });
  }
  return out;
}
/** Whether `item[key]` is a moved coordinate array not decoded yet (`lazyItem`): never empty. */
export function lazyArray(item: object, key: string): boolean {
  return typeof Object.getOwnPropertyDescriptor(item, key)?.get === 'function';
}

/** Header and aligned buffer region of a stored item container. */
function split(geometry: Uint8Array) {
  if (geometry.byteLength < 8 || MAGIC.some((v, i) => geometry[i] !== v))
    throw new Error('GEOMETRY_FORMAT');
  const view = new DataView(geometry.buffer, geometry.byteOffset, geometry.byteLength);
  const length = view.getUint32(4, true);
  if (8 + length > geometry.byteLength) throw new Error('GEOMETRY_FORMAT');
  const text = new TextDecoder().decode(geometry.subarray(8, 8 + length));
  return {
    header: JSON.parse(text) as Record<string, Reference>,
    region: geometry.subarray(align(8 + length)),
  };
}

/**
 * One VGT1 container from stored items, equal to `encodeGeometry` of `root` with those items as
 * `scene` and `definitions` (buffers in this order). `at: 'result'` puts them in `root.result` (a
 * request), `'root'` at the top level (a delta). Only each `$bin` offset is shifted.
 */
export function joinGeometry(
  root: Record<string, unknown>,
  items: { scene?: EncodedItem[]; definitions?: [string, EncodedItem][] },
  at: 'result' | 'root' = 'result',
): Uint8Array {
  const buffers: Uint8Array[] = [];
  let size = 0;
  const place = ({ meta, geometry }: EncodedItem) => {
    if (!geometry || !meta || typeof meta !== 'object') return meta;
    const { header, region } = split(geometry);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
      const ref = value === SLOT ? header[key] : undefined;
      out[key] = ref ? { $bin: [ref.$bin[0] + size, ...ref.$bin.slice(1)] } : value;
    }
    if (region.byteLength) buffers.push(region);
    size += region.byteLength;
    return out;
  };
  const target: Record<string, unknown> = {
    ...((at === 'result' ? root.result : root) as Record<string, unknown>),
  };
  if (items.scene) target.scene = items.scene.map(place);
  if (items.definitions)
    target.definitions = Object.fromEntries(items.definitions.map(([k, v]) => [k, place(v)]));
  return container(at === 'result' ? { ...root, result: target } : target, buffers, size);
}

/**
 * A coordinate array kept as received (T-085): float32 offsets from `origin`, the array's first
 * point. The screen uploads it to the GPU as it is; `point(array, i)` gives world coordinates.
 */
export type PackedPositions = Float32Array & { origin: [number, number, number] };
/** Coordinates as plain numbers (JSON, older paths) or as received binary (`PackedPositions`). */
export type Positions = readonly number[] | PackedPositions;
/** Index arrays as plain numbers or as received binary. */
export type Indices = readonly number[] | Uint16Array | Uint32Array;
export const isPacked = (value: unknown): value is PackedPositions =>
  value instanceof Float32Array && Array.isArray((value as { origin?: unknown }).origin);
/** World coordinate `i` (x, y or z by `i % 3`) of a plain or packed array. */
export const coordinate = (values: Positions, i: number) =>
  isPacked(values) ? values.origin[i % 3] + values[i] : values[i];

/**
 * `typed`: coordinate arrays stay views on the received buffer (`PackedPositions`) and index arrays
 * stay `Uint16Array`/`Uint32Array` — nothing is unpacked into number arrays (T-085). Without it
 * every array is restored as plain numbers.
 */
export function decodeGeometry(
  input: ArrayBuffer | Uint8Array,
  { typed = false }: { typed?: boolean } = {},
): unknown {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 8 || MAGIC.some((v, i) => bytes[i] !== v))
    throw new Error('GEOMETRY_FORMAT');
  const data = bytes.byteOffset % 4 ? bytes.slice() : bytes;
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, true);
  if (8 + length > data.byteLength) throw new Error('GEOMETRY_FORMAT');
  const base = data.byteOffset + align(8 + length);
  const end = data.byteOffset + data.byteLength;
  const restore = (reference: Reference['$bin']) => {
    const [offset, count, type, ox, oy, oz] = reference;
    const size = type === 'u16' ? 2 : 4;
    if (base + offset + count * size > end) throw new Error('GEOMETRY_FORMAT');
    if (type === 'f') {
      const local = new Float32Array(data.buffer, base + offset, count);
      if (typed) return Object.assign(local, { origin: [ox, oy, oz] as [number, number, number] });
      const out = new Array<number>(count);
      for (let i = 0; i < count; i += 3) {
        out[i] = ox + local[i];
        out[i + 1] = oy + local[i + 1];
        out[i + 2] = oz + local[i + 2];
      }
      return out;
    }
    const view =
      type === 'u16'
        ? new Uint16Array(data.buffer, base + offset, count)
        : new Uint32Array(data.buffer, base + offset, count);
    return typed ? view : Array.from(view);
  };
  return JSON.parse(new TextDecoder().decode(data.subarray(8, 8 + length)), (_key, value) =>
    value && typeof value === 'object' && Array.isArray(value.$bin) ? restore(value.$bin) : value,
  );
}

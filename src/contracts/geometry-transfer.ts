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

export function encodeGeometry(value: unknown): Uint8Array {
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
  const json = new TextEncoder().encode(JSON.stringify(header));
  const start = align(8 + json.byteLength);
  const out = new Uint8Array(start + offset);
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

export function decodeGeometry(input: ArrayBuffer | Uint8Array): unknown {
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
    return Array.from(view);
  };
  return JSON.parse(new TextDecoder().decode(data.subarray(8, 8 + length)), (_key, value) =>
    value && typeof value === 'object' && Array.isArray(value.$bin) ? restore(value.$bin) : value,
  );
}

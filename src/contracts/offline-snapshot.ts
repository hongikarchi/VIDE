// Offline view snapshot (PLAN-20): the last Sync of a linked file reduced to what the account
// site needs to show it while the work PC is off. Geometry only, merged per layer and kind so the
// site draws a few batches; no source file, attributes or history. Binary container, gzip-wrapped
// in transit and storage:
//   "VSN1" | u32 header length | header JSON (UTF-8) | pad to 4 | buffers (4-byte aligned)
// Positions are float32 relative to `origin` (survey coordinates keep their precision).

export const SNAPSHOT_FORMAT = 'vide-snapshot-v1';
const MAGIC = [0x56, 0x53, 0x4e, 0x31]; // "VSN1"

export type SnapshotKind = 'mesh' | 'lines' | 'points';
interface BufferRef {
  offset: number;
  length: number;
}
export interface SnapshotGroupHeader {
  layer: string;
  kind: SnapshotKind;
  /** xyz float32 per vertex. */
  positions: BufferRef;
  /** rgb uint8 per vertex. */
  colors: BufferRef;
  /** uint32 triangle indices (mesh only). */
  indices?: BufferRef;
}
export interface SnapshotText {
  s: string;
  /** Position relative to `origin`. */
  p: [number, number, number];
  h: number;
  r: number;
  layer: string;
  color: string;
}
export interface SnapshotHeader {
  format: typeof SNAPSHOT_FORMAT;
  name: string;
  host: 'rhino' | 'zwcad';
  units?: string;
  capturedAt: string;
  objectCount: number;
  origin: [number, number, number];
  /** Half extents of the geometry around `origin`. */
  extent: [number, number, number];
  groups: SnapshotGroupHeader[];
  texts: SnapshotText[];
}
export interface SnapshotGroup {
  layer: string;
  kind: SnapshotKind;
  positions: Float32Array;
  colors: Uint8Array;
  indices?: Uint32Array;
}
export interface Snapshot extends Omit<SnapshotHeader, 'groups'> {
  groups: SnapshotGroup[];
}

const align = (n: number) => (n + 3) & ~3;

export function encodeSnapshot(snapshot: Snapshot): Uint8Array {
  const buffers: Uint8Array[] = [];
  let offset = 0;
  const add = (array: Float32Array | Uint8Array | Uint32Array): BufferRef => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const ref = { offset, length: array.length };
    buffers.push(bytes);
    offset += bytes.byteLength;
    const pad = align(offset) - offset;
    if (pad) {
      buffers.push(new Uint8Array(pad));
      offset += pad;
    }
    return ref;
  };
  const header: SnapshotHeader = {
    ...snapshot,
    groups: snapshot.groups.map((group) => ({
      layer: group.layer,
      kind: group.kind,
      positions: add(group.positions),
      colors: add(group.colors),
      ...(group.indices ? { indices: add(group.indices) } : {}),
    })),
  };
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

export function decodeSnapshot(bytes: Uint8Array): Snapshot {
  if (bytes.byteLength < 8 || MAGIC.some((value, i) => bytes[i] !== value))
    throw new Error('SNAPSHOT_FORMAT');
  // Typed views need 4-byte aligned offsets; copy once when the input is not aligned.
  const data = bytes.byteOffset % 4 ? bytes.slice() : bytes;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = view.getUint32(4, true);
  if (8 + length > data.byteLength) throw new Error('SNAPSHOT_FORMAT');
  const header = JSON.parse(
    new TextDecoder().decode(data.subarray(8, 8 + length)),
  ) as SnapshotHeader;
  if (header.format !== SNAPSHOT_FORMAT || !Array.isArray(header.groups))
    throw new Error('SNAPSHOT_FORMAT');
  const base = data.byteOffset + align(8 + length);
  const take = <T>(
    ref: BufferRef,
    Type: {
      new (buffer: ArrayBufferLike, offset: number, length: number): T;
      BYTES_PER_ELEMENT: number;
    },
  ) => {
    if (base + ref.offset + ref.length * Type.BYTES_PER_ELEMENT > data.byteOffset + data.byteLength)
      throw new Error('SNAPSHOT_FORMAT');
    return new Type(data.buffer, base + ref.offset, ref.length);
  };
  return {
    ...header,
    groups: header.groups.map((group) => ({
      layer: group.layer,
      kind: group.kind,
      positions: take(group.positions, Float32Array),
      colors: take(group.colors, Uint8Array),
      ...(group.indices ? { indices: take(group.indices, Uint32Array) } : {}),
    })),
  };
}

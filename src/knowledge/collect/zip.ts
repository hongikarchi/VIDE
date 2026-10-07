// A minimal ZIP reader for Office and HWPX documents (SPEC-08.9 2): the central directory, stored
// and deflated entries. No ZIP64, no encryption (an encrypted entry is reported as such).
import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  readonly code: 'NOT_ZIP' | 'ENCRYPTED' | 'UNSUPPORTED' | 'TOO_LARGE';
  constructor(code: ZipError['code']) {
    super(code);
    this.code = code;
  }
}
interface Entry {
  name: string;
  method: number;
  flags: number;
  compressed: number;
  size: number;
  offset: number;
}
/** The largest entry read (uncompressed). */
const ENTRY_MAX = 64 * 1024 * 1024;

export class Zip {
  private readonly entries = new Map<string, Entry>();
  private readonly bytes: Buffer;
  constructor(bytes: Buffer) {
    this.bytes = bytes;
    const from = Math.max(0, bytes.length - 65557);
    let end = -1;
    for (let i = bytes.length - 22; i >= from; i--)
      if (bytes.readUInt32LE(i) === 0x06054b50) {
        end = i;
        break;
      }
    if (end < 0) throw new ZipError('NOT_ZIP');
    const count = bytes.readUInt16LE(end + 10);
    let at = bytes.readUInt32LE(end + 16);
    for (let n = 0; n < count; n++) {
      if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50)
        throw new ZipError('NOT_ZIP');
      const flags = bytes.readUInt16LE(at + 8);
      const nameLength = bytes.readUInt16LE(at + 28);
      const name = bytes.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength);
      this.entries.set(name.replace(/\\/g, '/'), {
        name,
        method: bytes.readUInt16LE(at + 10),
        flags,
        compressed: bytes.readUInt32LE(at + 20),
        size: bytes.readUInt32LE(at + 24),
        offset: bytes.readUInt32LE(at + 42),
      });
      at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    }
  }
  names() {
    return [...this.entries.keys()];
  }
  has(name: string) {
    return this.entries.has(name);
  }
  read(name: string): Buffer {
    const entry = this.entries.get(name);
    if (!entry) throw new ZipError('NOT_ZIP');
    if (entry.flags & 1) throw new ZipError('ENCRYPTED');
    if (entry.size > ENTRY_MAX || entry.compressed === 0xffffffff) throw new ZipError('TOO_LARGE');
    const at = entry.offset;
    if (this.bytes.readUInt32LE(at) !== 0x04034b50) throw new ZipError('NOT_ZIP');
    const start = at + 30 + this.bytes.readUInt16LE(at + 26) + this.bytes.readUInt16LE(at + 28);
    const data = this.bytes.subarray(start, start + entry.compressed);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: ENTRY_MAX });
    throw new ZipError('UNSUPPORTED');
  }
  text(name: string) {
    return this.read(name).toString('utf8');
  }
}

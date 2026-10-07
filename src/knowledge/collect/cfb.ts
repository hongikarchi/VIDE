// A minimal reader of the Compound File Binary format (MS-CFB) for HWP 5.x documents
// (SPEC-08.9 2): FAT/DIFAT, mini stream, directory tree, stream bytes by path. Read only.

const END = 0xfffffffe;
const FREE = 0xffffffff;
export const CFB_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');

export class Cfb {
  private readonly bytes: Buffer;
  private readonly sectorSize: number;
  private readonly fat: number[] = [];
  private readonly miniFat: number[] = [];
  private readonly miniCutoff: number;
  private readonly miniStream: Buffer;
  /** Stream path ('BodyText/Section0') → start sector and size. */
  private readonly streams = new Map<string, { start: number; size: number }>();

  constructor(bytes: Buffer) {
    if (bytes.length < 512 || !bytes.subarray(0, 8).equals(CFB_SIGNATURE))
      throw new Error('NOT_CFB');
    this.bytes = bytes;
    this.sectorSize = 1 << bytes.readUInt16LE(0x1e);
    if (this.sectorSize !== 512 && this.sectorSize !== 4096) throw new Error('NOT_CFB');
    this.miniCutoff = bytes.readUInt32LE(0x38);
    // The FAT sectors: 109 in the header, the rest in the DIFAT chain.
    const fatSectors: number[] = [];
    for (let i = 0; i < 109; i++) {
      const id = bytes.readUInt32LE(0x4c + i * 4);
      if (id !== FREE && id !== END) fatSectors.push(id);
    }
    let difat = bytes.readUInt32LE(0x44);
    const perSector = this.sectorSize / 4;
    for (let guard = 0; difat !== END && difat !== FREE && guard < 100_000; guard++) {
      const sector = this.sector(difat);
      for (let i = 0; i < perSector - 1; i++) {
        const id = sector.readUInt32LE(i * 4);
        if (id !== FREE && id !== END) fatSectors.push(id);
      }
      difat = sector.readUInt32LE((perSector - 1) * 4);
    }
    for (const id of fatSectors) {
      const sector = this.sector(id);
      for (let i = 0; i < perSector; i++) this.fat.push(sector.readUInt32LE(i * 4));
    }
    const miniFatBytes = this.chain(bytes.readUInt32LE(0x3c));
    for (let i = 0; i + 4 <= miniFatBytes.length; i += 4)
      this.miniFat.push(miniFatBytes.readUInt32LE(i));
    // Directory entries (128 bytes); the root's chain is the mini stream.
    const directory = this.chain(bytes.readUInt32LE(0x30));
    const entry = (n: number) => {
      const at = n * 128;
      const nameLength = directory.readUInt16LE(at + 64);
      return {
        name: directory.toString('utf16le', at, at + Math.max(0, nameLength - 2)),
        type: directory[at + 66],
        left: directory.readUInt32LE(at + 68),
        right: directory.readUInt32LE(at + 72),
        child: directory.readUInt32LE(at + 76),
        start: directory.readUInt32LE(at + 116),
        size: directory.readUInt32LE(at + 120),
      };
    };
    const count = Math.floor(directory.length / 128);
    if (!count) throw new Error('NOT_CFB');
    const root = entry(0);
    this.miniStream = this.chain(root.start);
    const seen = new Set<number>();
    const walk = (n: number, prefix: string) => {
      if (n === FREE || n >= count || seen.has(n)) return;
      seen.add(n);
      const e = entry(n);
      walk(e.left, prefix);
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.type === 2) this.streams.set(path, { start: e.start, size: e.size });
      if (e.type === 1) walk(e.child, path);
      walk(e.right, prefix);
    };
    walk(root.child, '');
  }
  private sector(id: number) {
    const at = (id + 1) * this.sectorSize;
    if (at + this.sectorSize > this.bytes.length) throw new Error('CFB_TRUNCATED');
    return this.bytes.subarray(at, at + this.sectorSize);
  }
  private chain(start: number, size = Infinity) {
    const parts: Buffer[] = [];
    let total = 0;
    for (let id = start, guard = 0; id !== END && id !== FREE && total < size; guard++) {
      if (guard > this.fat.length + 1 || id >= this.fat.length + 1_000_000)
        throw new Error('CFB_LOOP');
      parts.push(this.sector(id));
      total += this.sectorSize;
      id = this.fat[id] ?? END;
    }
    const all = Buffer.concat(parts);
    return Number.isFinite(size) ? all.subarray(0, size) : all;
  }
  private miniChain(start: number, size: number) {
    const parts: Buffer[] = [];
    let total = 0;
    for (let id = start, guard = 0; id !== END && id !== FREE && total < size; guard++) {
      if (guard > this.miniFat.length + 1) throw new Error('CFB_LOOP');
      parts.push(this.miniStream.subarray(id * 64, id * 64 + 64));
      total += 64;
      id = this.miniFat[id] ?? END;
    }
    return Buffer.concat(parts).subarray(0, size);
  }
  paths() {
    return [...this.streams.keys()];
  }
  has(path: string) {
    return this.streams.has(path);
  }
  read(path: string): Buffer {
    const stream = this.streams.get(path);
    if (!stream) throw new Error('NOT_FOUND');
    return stream.size < this.miniCutoff
      ? this.miniChain(stream.start, stream.size)
      : this.chain(stream.start, stream.size);
  }
}

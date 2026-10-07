// Colour-dependent plot style tables (`.ctb`) for the title block preview (SPEC-14.15 3, PLAN-47
// T-235; format from SPIKE-2026-10-07-drawing-backflow 6). A table becomes the `PlotStyleTable`
// shape of src/ui/plot-style.ts (ACI 1–255 → pen colour and lineweight in mm). Layout:
//   48 bytes  "PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec"
//   u32 LE    a checksum of unknown kind (not checked; the zlib stream carries its own Adler-32)
//   u32 LE    decompressed length
//   u32 LE    compressed length
//   zlib      text: `key=value` lines and `name{ … }` groups (strings open with `"`, not closed)
// Lineweights are indexes into the file's own `custom_lineweight_table` (company tables change it,
// so the standard table would be wrong). A named table (`.stb`, STBVER) cannot drive ACI pens.
import { deflateSync, inflateSync } from 'node:zlib';

export interface CtbPen {
  /** #rrggbb, or 'object' to keep the object's colour. */
  color: string | 'object';
  /** mm, or 'object' to use the object's lineweight. */
  lineWeight: number | 'object';
}
/** Same shape as `PlotStyleTable` in src/ui/plot-style.ts. */
export interface CtbTable {
  name: string;
  pens: Record<number, CtbPen>;
  fallback: CtbPen;
  defaultLineWeight: number;
}
export interface CtbInfo {
  styles: number;
  weights: number;
  objectColor: number;
  objectWeight: number;
}
export type CtbFailure = 'CTB_HEADER' | 'CTB_LENGTH' | 'CTB_CORRUPT' | 'NOT_CTB';

const MAGIC = 'PIAFILEVERSION_2.0,';
const failure = (code: CtbFailure) => Object.assign(new Error(code), { code });

/** Text of a .ctb/.stb and its kind; throws on a bad header, length or zlib stream. */
export function inflateTable(buffer: Uint8Array): { kind: string; text: string } {
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.length < 60) throw failure('CTB_HEADER');
  const head = bytes.subarray(0, 48).toString('latin1');
  if (!head.startsWith(MAGIC) || !head.includes('compress')) throw failure('CTB_HEADER');
  const kind = head.slice(MAGIC.length, MAGIC.length + 6);
  const size = bytes.readUInt32LE(52),
    packed = bytes.readUInt32LE(56);
  if (60 + packed > bytes.length) throw failure('CTB_LENGTH');
  let text: Buffer;
  try {
    text = inflateSync(bytes.subarray(60, 60 + packed));
  } catch {
    throw failure('CTB_CORRUPT');
  }
  if (text.length !== size) throw failure('CTB_LENGTH');
  return { kind, text: text.toString('latin1') };
}

type Tree = { [key: string]: string | Tree };
/** Nested `key=value` / `name{ … }` text → plain object (values stay strings). */
export function parseTree(text: string): Tree {
  const root: Tree = {};
  const stack: Tree[] = [root];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '}') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (line.endsWith('{')) {
      const child: Tree = {};
      stack.at(-1)![line.slice(0, -1).trim()] = child;
      stack.push(child);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let value = line.slice(eq + 1);
    if (value.startsWith('"')) value = value.slice(1).replace(/"$/, '');
    stack.at(-1)![line.slice(0, eq)] = value;
  }
  return root;
}

/**
 * Pen colour: low 24 bits RGB, high byte a flag. -1 (ZWCAD) and 0xC3FFFFFF (AutoCAD) keep the
 * object's colour; 0xC2RRGGBB / 0xC3RRGGBB are explicit.
 */
export function penColor(value: string | undefined): CtbPen['color'] {
  const number = Number(value);
  if (!Number.isFinite(number) || number === -1) return 'object';
  const n = number >>> 0;
  if (n === 0xc3ffffff) return 'object';
  const flag = n >>> 24;
  if (flag !== 0xc2 && flag !== 0xc3 && flag !== 0xff && flag !== 0) return 'object';
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0');
}

const group = (value: string | Tree | undefined): Tree =>
  value && typeof value === 'object' ? value : {};

/** A .ctb file → the plot style table and counts. Throws `CtbFailure` codes. */
export function readCtb(
  buffer: Uint8Array,
  name = 'table.ctb',
): { table: CtbTable; info: CtbInfo } {
  const { kind, text } = inflateTable(buffer);
  if (kind !== 'CTBVER') throw failure('NOT_CTB');
  const tree = parseTree(text);
  const weights = new Map<number, number>();
  for (const [key, value] of Object.entries(group(tree.custom_lineweight_table)))
    if (typeof value === 'string' && Number.isFinite(Number(value)))
      weights.set(Number(key), Number(value));
  const styles = group(tree.plot_style);
  const pens: Record<number, CtbPen> = {};
  let objectColor = 0,
    objectWeight = 0;
  for (const [index, entry] of Object.entries(styles)) {
    const aci = Number(index) + 1; // plot_style 0 is ACI 1
    if (!Number.isInteger(aci) || aci < 1 || aci > 255 || typeof entry !== 'object') continue;
    const color = penColor(typeof entry.color === 'string' ? entry.color : undefined);
    // 255 is taken as "use object lineweight" (SPIKE 6: not yet seen in a sample); any other
    // number indexes the file's table (0 → 0 mm, ZWCAD's own tables, the thinnest pen).
    const lw = Number(entry.lineweight);
    const lineWeight: CtbPen['lineWeight'] =
      lw === 255 || !weights.has(lw) ? 'object' : weights.get(lw)!;
    if (color === 'object') objectColor++;
    if (lineWeight === 'object') objectWeight++;
    pens[aci] = { color, lineWeight };
  }
  if (!Object.keys(pens).length) throw failure('CTB_CORRUPT');
  return {
    table: {
      name,
      pens,
      fallback: { color: 'object', lineWeight: 'object' },
      defaultLineWeight: 0.25,
    },
    info: { styles: Object.keys(styles).length, weights: weights.size, objectColor, objectWeight },
  };
}

/** Writes a table file from its text (tests: synthetic tables only). */
export function writeCtb(text: string, kind: 'CTBVER' | 'STBVER' = 'CTBVER') {
  const raw = Buffer.from(text, 'latin1');
  const packed = deflateSync(raw);
  const head = Buffer.alloc(60);
  head.write(MAGIC + kind + '1,compress\r\npmzlibcodec', 0, 'latin1');
  head.writeUInt32LE(0, 48);
  head.writeUInt32LE(raw.length, 52);
  head.writeUInt32LE(packed.length, 56);
  return Buffer.concat([head, packed]);
}

/** Text of a synthetic 255-pen table; `pen(aci)` gives the raw `color` and `lineweight` values. */
export function syntheticCtbText(
  pen: (aci: number) => { color: string; lineweight: number },
  weights = [0, 0.05, 0.09, 0.13, 0.18, 0.25, 0.35, 0.5, 0.7],
) {
  let text =
    'description="synthetic\naci_table_available=TRUE\nscale_factor=1.0\napply_factor=FALSE\nplot_style{\n';
  for (let i = 0; i < 255; i++) {
    const { color, lineweight } = pen(i + 1);
    text += ` ${i}{\n  name="Color_${i + 1}\n  color=${color}\n  screen=100\n  lineweight=${lineweight}\n }\n`;
  }
  text += '}\ncustom_lineweight_table{\n';
  weights.forEach((value, index) => (text += ` ${index}=${value}\n`));
  return text + '}\n';
}

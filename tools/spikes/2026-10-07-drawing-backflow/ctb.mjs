// T-225 question 6: read a .ctb (color-dependent plot style table) into the PlotStyleTable shape of
// src/ui/plot-style.ts. Layout (observed on ZWCAD and AutoCAD-made tables):
//   48 bytes  "PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec"
//   u32 LE    checksum of unknown kind (not checked; the zlib stream carries its own Adler-32)
//   u32 LE    decompressed length
//   u32 LE    compressed length
//   zlib      text: `key=value` lines and `name{ … }` groups (strings open with `"` and are not closed)
// Usage: node ctb.mjs <file.ctb> [...]   → one summary line per file (counts only, no names)
//        node ctb.mjs --synthetic <out-dir> → writes two synthetic tables and checks the round trip
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync, deflateSync } from 'node:zlib';

const MAGIC = 'PIAFILEVERSION_2.0,';

function adler32(buffer) {
  let a = 1, b = 0;
  for (const byte of buffer) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

/** Text of a .ctb/.stb; throws on a bad header, length or checksum. */
export function inflateTable(buffer) {
  const head = buffer.subarray(0, 48).toString('latin1');
  if (!head.startsWith(MAGIC) || !head.includes('compress') || buffer.length < 60) throw new Error('CTB_HEADER');
  const kind = head.slice(MAGIC.length, MAGIC.length + 6); // CTBVER / STBVER
  const checksum = buffer.readUInt32LE(48), size = buffer.readUInt32LE(52), packed = buffer.readUInt32LE(56);
  if (60 + packed > buffer.length) throw new Error('CTB_LENGTH');
  const text = inflateSync(buffer.subarray(60, 60 + packed));
  // The header u32 at 48 is not Adler-32/CRC-32 of the text or the stream (checked on 5 tables);
  // integrity comes from the zlib stream's own Adler-32, which inflateSync verifies.
  void checksum;
  if (text.length !== size) throw new Error('CTB_LENGTH');
  return { kind, text: text.toString('latin1') };
}

/** Nested `key=value` / `name{ … }` text → plain object (values stay strings). */
export function parseTree(text) {
  const root = {}; const stack = [root];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '}') { stack.pop(); continue; }
    if (line.endsWith('{')) { const child = {}; stack.at(-1)[line.slice(0, -1)] = child; stack.push(child); continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let value = line.slice(eq + 1);
    if (value.startsWith('"')) value = value.slice(1).replace(/"$/, '');
    stack.at(-1)[line.slice(0, eq)] = value;
  }
  return root;
}

/**
 * Plot-style colour: low 24 bits RGB, high byte a flag. Seen: -1 (ZWCAD, use object colour),
 * 0xC3FFFFFF (AutoCAD "use object colour"), 0xC2RRGGBB (explicit RGB).
 */
export function penColor(value) {
  const n = Number(value) >>> 0;
  if (Number(value) === -1 || n === 0xc3ffffff) return 'object';
  const flag = n >>> 24;
  if (flag !== 0xc2 && flag !== 0xc3 && flag !== 0xff && flag !== 0) return 'object';
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0');
}

/** .ctb buffer → PlotStyleTable ({ name, pens, fallback, defaultLineWeight }) + diagnostics. */
export function readCtb(buffer, name = 'table.ctb') {
  const { kind, text } = inflateTable(buffer);
  if (kind !== 'CTBVER') throw new Error('NOT_CTB'); // a named .stb table cannot drive ACI pens
  const tree = parseTree(text);
  const weights = Object.entries(tree.custom_lineweight_table ?? {}).reduce((m, [k, v]) => ((m[Number(k)] = Number(v)), m), {});
  const pens = {};
  const styles = tree.plot_style ?? {};
  let objectColor = 0, objectWeight = 0;
  for (const [index, style] of Object.entries(styles)) {
    const aci = Number(index) + 1; // plot_style 0 is ACI 1
    if (!(aci >= 1 && aci <= 255)) continue;
    const color = penColor(style.color);
    // 255 = "use object lineweight"; anything else indexes custom_lineweight_table (0 → 0 mm,
    // which ZWCAD's own tables store and which plots as the thinnest pen).
    const lw = Number(style.lineweight);
    const lineWeight = lw === 255 || !(lw in weights) ? 'object' : weights[lw];
    if (color === 'object') objectColor++;
    if (lineWeight === 'object') objectWeight++;
    pens[aci] = { color, lineWeight };
  }
  return {
    table: { name, pens, fallback: { color: 'object', lineWeight: 'object' }, defaultLineWeight: 0.25 },
    info: { kind, styles: Object.keys(styles).length, weights: Object.keys(weights).length, objectColor, objectWeight, scaleFactor: Number(tree.scale_factor ?? 1), applyFactor: tree.apply_factor === 'TRUE' },
  };
}

export function writeCtb(text) {
  const raw = Buffer.from(text, 'latin1');
  const packed = deflateSync(raw);
  const head = Buffer.alloc(60);
  head.write(MAGIC + 'CTBVER1,compress\r\npmzlibcodec', 0, 'latin1');
  head.writeUInt32LE(adler32(raw), 48); head.writeUInt32LE(raw.length, 52); head.writeUInt32LE(packed.length, 56);
  return Buffer.concat([head, packed]);
}

function syntheticText(pen) {
  let s = 'description="synthetic\naci_table_available=TRUE\nscale_factor=1.0\napply_factor=FALSE\ncustom_lineweight_display_units=0\nplot_style{\n';
  for (let i = 0; i < 255; i++) {
    const { color, lineweight } = pen(i + 1);
    s += ` ${i}{\n  name="Color_${i + 1}\n  color=${color}\n  color_policy=1\n  screen=100\n  lineweight=${lineweight}\n }\n`;
  }
  return s + '}\ncustom_lineweight_table{\n 0=0.0\n 1=0.05\n 2=0.09\n 3=0.13\n 4=0.18\n 5=0.25\n 6=0.35\n 7=0.5\n 8=0.7\n}\n';
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === '--synthetic') {
    const out = args[1]; mkdirSync(out, { recursive: true });
    // A: every pen black, lineweight by ACI band; B: ZWCAD-style "use object" with ACI 1 red 0.5 mm.
    const a = writeCtb(syntheticText((aci) => ({ color: String((0xc2000000 | 0) >> 0), lineweight: aci <= 8 ? aci : 255 })));
    const b = writeCtb(syntheticText((aci) => (aci === 1 ? { color: String((0xc2ff0000) >> 0), lineweight: 7 } : { color: '-1', lineweight: 255 })));
    writeFileSync(join(out, 'synthetic-a.ctb'), a); writeFileSync(join(out, 'synthetic-b.ctb'), b);
    const ra = readCtb(a).table, rb = readCtb(b).table;
    const ok = ra.pens[1].color === '#000000' && ra.pens[3].lineWeight === 0.13 && ra.pens[9].lineWeight === 'object' &&
      rb.pens[1].color === '#ff0000' && rb.pens[1].lineWeight === 0.5 && rb.pens[2].color === 'object' && rb.pens[2].lineWeight === 'object';
    const broken = Buffer.from(a); broken[70] ^= 0xff;
    let corrupt; try { readCtb(broken); corrupt = 'accepted'; } catch (e) { corrupt = e.message; }
    console.log(JSON.stringify({ synthetic: ok, corrupt }));
  } else {
    for (const file of args) {
      try {
        const { table, info } = readCtb(readFileSync(file));
        const colors = new Set(Object.values(table.pens).map((p) => p.color));
        const widths = new Set(Object.values(table.pens).map((p) => p.lineWeight));
        console.log(JSON.stringify({ ...info, pens: Object.keys(table.pens).length, distinctColors: colors.size, distinctWeights: widths.size, sample: [1, 2, 7, 8, 250].map((a) => table.pens[a]) }));
      } catch (e) { console.log(JSON.stringify({ error: e.message })); }
    }
  }
}

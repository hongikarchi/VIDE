// HWP 5.x body text (SPEC-08.9 2): the CFB container's FileHeader and BodyText/SectionN streams
// (raw deflate unless the header says otherwise), HWPTAG_PARA_TEXT records as UTF-16LE with the
// inline and extended controls (8 characters each) left out. Tables come out as their cells'
// paragraphs in order. Encrypted and 배포용 documents are not read.
import { inflateRawSync } from 'node:zlib';
import { Cfb } from './cfb.ts';

const PARA_TEXT = 67;
/** Controls that take 8 WCHARs (16 bytes): inline 4–9, 19, 20; extended 1–3, 11, 12, 14–18, 21–23. */
const WIDE = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

export class HwpError extends Error {
  readonly code: 'ENCRYPTED' | 'DISTRIBUTION' | 'NOT_HWP';
  constructor(code: HwpError['code']) {
    super(code);
    this.code = code;
  }
}

function paragraph(record: Buffer) {
  let out = '';
  for (let i = 0; i + 1 < record.length; ) {
    const c = record.readUInt16LE(i);
    if (c < 32) {
      if (c === 9) out += '\t';
      else if (c === 10) out += '\n';
      else if (c === 30 || c === 31) out += ' ';
      i += WIDE.has(c) ? 16 : 2;
      continue;
    }
    out += String.fromCharCode(c);
    i += 2;
  }
  return out.trim();
}

/** The paragraphs of one HWP 5.x document, section by section. */
export function hwpSections(bytes: Buffer): { section: number; text: string }[] {
  let cfb: Cfb;
  try {
    cfb = new Cfb(bytes);
  } catch {
    throw new HwpError('NOT_HWP');
  }
  if (!cfb.has('FileHeader')) throw new HwpError('NOT_HWP');
  const header = cfb.read('FileHeader');
  if (!header.toString('latin1', 0, 17).startsWith('HWP Document File'))
    throw new HwpError('NOT_HWP');
  const properties = header.readUInt32LE(36);
  if (properties & 2) throw new HwpError('ENCRYPTED');
  if (properties & 4) throw new HwpError('DISTRIBUTION');
  const compressed = (properties & 1) === 1;
  const sections = cfb
    .paths()
    .map((path) => /^BodyText\/Section(\d+)$/.exec(path))
    .filter((match): match is RegExpExecArray => !!match)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  return sections.map((match) => {
    let data = cfb.read(match[0]);
    if (compressed) data = inflateRawSync(data, { maxOutputLength: 256 * 1024 * 1024 });
    const paragraphs: string[] = [];
    for (let at = 0; at + 4 <= data.length; ) {
      const head = data.readUInt32LE(at);
      at += 4;
      const tag = head & 0x3ff;
      let size = head >>> 20;
      if (size === 0xfff) {
        size = data.readUInt32LE(at);
        at += 4;
      }
      if (tag === PARA_TEXT) {
        const text = paragraph(data.subarray(at, at + size));
        if (text) paragraphs.push(text);
      }
      at += size;
    }
    return { section: Number(match[1]), text: paragraphs.join('\n\n') };
  });
}

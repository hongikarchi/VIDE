// Shapefile byte readers (`.shp`, `.dbf`, `.cpg`) for site data (SPEC-12.4, PLAN-45 T-206).
// Rewritten from S-02 Site Maker `read_shp`·`read_dbf`·`read_cpg` (pure parsing, no OSS reader),
// with the S-04 lesson that the text encoding comes from what the file declares, not a guess:
// 수치지형도 is UTF-8 and 연속지적도 EUC-KR, so "국토부 SHP는 cp949" is wrong. Pure TypeScript.

export type Vec3 = [number, number, number];

export type ShpErrorCode =
  | 'SHP_INVALID'
  | 'SHP_UNSUPPORTED_TYPE'
  | 'DBF_INVALID'
  | 'ENCODING_UNSUPPORTED'
  | 'ENCODING_UNDECLARED';
export class ShpError extends Error {
  readonly code: ShpErrorCode;
  constructor(code: ShpErrorCode, message: string) {
    super(message);
    this.name = 'ShpError';
    this.code = code;
  }
}

export type ShapeKind = 'null' | 'point' | 'polyline' | 'polygon';
export type ShpRecord =
  | { kind: 'null' }
  | { kind: 'point'; points: Vec3[] }
  | { kind: 'polyline' | 'polygon'; parts: Vec3[][] };

export interface ShpFile {
  /** Header shape type (1 Point, 3 PolyLine, 5 Polygon, 8 MultiPoint, +10 Z, +20 M). */
  shapeType: number;
  kind: ShapeKind;
  bbox: [number, number, number, number];
  records: ShpRecord[];
}

const KIND_BY_TYPE: Record<number, ShapeKind> = {
  0: 'null',
  1: 'point',
  8: 'point',
  11: 'point',
  18: 'point',
  21: 'point',
  28: 'point',
  3: 'polyline',
  13: 'polyline',
  23: 'polyline',
  5: 'polygon',
  15: 'polygon',
  25: 'polygon',
};

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Parse a `.shp`. Z is read for the Z types; M values are ignored. */
export function readShp(bytes: Uint8Array, name = '.shp'): ShpFile {
  if (bytes.byteLength < 100)
    throw new ShpError('SHP_INVALID', `${name}: 헤더(100바이트)가 없습니다`);
  const dv = view(bytes);
  if (dv.getInt32(0, false) !== 9994)
    throw new ShpError('SHP_INVALID', `${name}: 올바른 .shp 파일이 아닙니다(파일 코드)`);
  const shapeType = dv.getInt32(32, true);
  const kind = KIND_BY_TYPE[shapeType];
  if (!kind)
    throw new ShpError(
      'SHP_UNSUPPORTED_TYPE',
      `${name}: 지원하지 않는 형상 종류 ${shapeType}(점·선·면만 읽습니다)`,
    );
  const bbox: ShpFile['bbox'] = [
    dv.getFloat64(36, true),
    dv.getFloat64(44, true),
    dv.getFloat64(52, true),
    dv.getFloat64(60, true),
  ];
  const fileLength = Math.min(dv.getInt32(24, false) * 2, bytes.byteLength);
  const records: ShpRecord[] = [];
  let off = 100;
  while (off + 8 <= fileLength) {
    const length = dv.getInt32(off + 4, false) * 2;
    const c = off + 8;
    off = c + length;
    if (length < 4 || off > fileLength)
      throw new ShpError(
        'SHP_INVALID',
        `${name}: 레코드 ${records.length + 1}의 길이가 파일을 넘습니다`,
      );
    const st = dv.getInt32(c, true);
    const z = st === 11 || st === 13 || st === 15 || st === 18;
    if (st === 0) records.push({ kind: 'null' });
    else if (st === 1 || st === 11 || st === 21) {
      records.push({
        kind: 'point',
        points: [
          [
            dv.getFloat64(c + 4, true),
            dv.getFloat64(c + 12, true),
            z ? dv.getFloat64(c + 20, true) : 0,
          ],
        ],
      });
    } else if (st === 8 || st === 18 || st === 28) {
      const n = dv.getInt32(c + 36, true);
      const xy = c + 40;
      const zo = xy + n * 16 + 16;
      const points: Vec3[] = [];
      for (let i = 0; i < n; i++)
        points.push([
          dv.getFloat64(xy + i * 16, true),
          dv.getFloat64(xy + i * 16 + 8, true),
          z ? dv.getFloat64(zo + i * 8, true) : 0,
        ]);
      records.push({ kind: 'point', points });
    } else if (KIND_BY_TYPE[st] === 'polyline' || KIND_BY_TYPE[st] === 'polygon') {
      const nParts = dv.getInt32(c + 36, true);
      const nPoints = dv.getInt32(c + 40, true);
      const po = c + 44;
      const xy = po + nParts * 4;
      const zo = xy + nPoints * 16 + 16;
      if (nParts < 0 || nPoints < 0 || xy + nPoints * 16 > off)
        throw new ShpError(
          'SHP_INVALID',
          `${name}: 레코드 ${records.length + 1}의 점 개수가 맞지 않습니다`,
        );
      const starts: number[] = [];
      for (let k = 0; k < nParts; k++) starts.push(dv.getInt32(po + k * 4, true));
      starts.push(nPoints);
      const parts: Vec3[][] = [];
      for (let k = 0; k < nParts; k++) {
        const part: Vec3[] = [];
        for (let i = starts[k]; i < starts[k + 1]; i++)
          part.push([
            dv.getFloat64(xy + i * 16, true),
            dv.getFloat64(xy + i * 16 + 8, true),
            z ? dv.getFloat64(zo + i * 8, true) : 0,
          ]);
        parts.push(part);
      }
      records.push({ kind: KIND_BY_TYPE[st] as 'polyline' | 'polygon', parts });
    } else
      throw new ShpError(
        'SHP_UNSUPPORTED_TYPE',
        `${name}: 레코드 ${records.length + 1}의 형상 종류 ${st}를 읽지 않습니다`,
      );
  }
  return { shapeType, kind, bbox, records };
}

// --- Encoding -----------------------------------------------------------------------------------

export interface TextEncodingChoice {
  /** TextDecoder label. */
  label: 'utf-8' | 'euc-kr' | 'windows-1252';
  /** Where it came from: the `.cpg`, the DBF language driver byte, or nothing (strict UTF-8). */
  source: 'cpg' | 'dbf' | 'none';
  declared: string;
}

const CPG_LABELS: Record<string, TextEncodingChoice['label']> = {
  UTF8: 'utf-8',
  '65001': 'utf-8',
  ASCII: 'utf-8',
  USASCII: 'utf-8',
  '20127': 'utf-8',
  EUCKR: 'euc-kr',
  CP949: 'euc-kr',
  '949': 'euc-kr',
  ANSI949: 'euc-kr',
  MS949: 'euc-kr',
  WINDOWS949: 'euc-kr',
  UHC: 'euc-kr',
  KSC5601: 'euc-kr',
  KSC56011987: 'euc-kr',
  '51949': 'euc-kr',
  ISO88591: 'windows-1252',
  LATIN1: 'windows-1252',
  '1252': 'windows-1252',
  CP1252: 'windows-1252',
  WINDOWS1252: 'windows-1252',
  ANSI1252: 'windows-1252',
};

/**
 * The text encoding a layer declares: the `.cpg` first, then the DBF language driver byte for
 * Korean (0x79 = code page 949). Undeclared returns `source: 'none'` and the reader then accepts
 * only valid UTF-8 (S-02 TRAPS D1). An unknown declaration throws instead of guessing.
 */
export function resolveEncoding(
  cpg: string | null | undefined,
  dbf?: Uint8Array,
): TextEncodingChoice {
  const declared = String(cpg ?? '')
    .replace(/^﻿/, '')
    .trim();
  if (declared) {
    const label = CPG_LABELS[declared.toUpperCase().replace(/[^A-Z0-9]/g, '')];
    if (!label)
      throw new ShpError('ENCODING_UNSUPPORTED', `.cpg의 인코딩 '${declared}'를 지원하지 않습니다`);
    return { label, source: 'cpg', declared };
  }
  if (dbf && dbf.byteLength > 29 && dbf[29] === 0x79)
    return { label: 'euc-kr', source: 'dbf', declared: 'DBF LDID 0x79 (949)' };
  return { label: 'utf-8', source: 'none', declared: '' };
}

// --- DBF ----------------------------------------------------------------------------------------

export type DbfValue = string | number | boolean | null;
export interface DbfField {
  name: string;
  type: string;
  length: number;
  decimals: number;
}
export interface DbfTable {
  fields: DbfField[];
  /** One entry per record; null = deleted record. */
  records: (Record<string, DbfValue> | null)[];
}

/** Parse a `.dbf` with a resolved encoding. Undeclared encodings must decode as strict UTF-8. */
export function readDbf(bytes: Uint8Array, encoding: TextEncodingChoice, name = '.dbf'): DbfTable {
  if (bytes.byteLength < 32) throw new ShpError('DBF_INVALID', `${name}: 헤더가 없습니다`);
  const dv = view(bytes);
  const nRec = dv.getUint32(4, true);
  const headerLength = dv.getUint16(8, true);
  const recordLength = dv.getUint16(10, true);
  const fields: DbfField[] = [];
  const ascii = new TextDecoder('latin1');
  for (let o = 32; o + 32 <= headerLength && bytes[o] !== 0x0d; o += 32) {
    const raw = bytes.subarray(o, o + 11);
    const end = raw.indexOf(0);
    fields.push({
      name: ascii.decode(end >= 0 ? raw.subarray(0, end) : raw).trim(),
      type: String.fromCharCode(bytes[o + 11]).toUpperCase(),
      length: bytes[o + 16],
      decimals: bytes[o + 17],
    });
  }
  const width = 1 + fields.reduce((sum, f) => sum + f.length, 0);
  if (recordLength < width)
    throw new ShpError(
      'DBF_INVALID',
      `${name}: 레코드 길이(${recordLength})가 필드 합(${width})보다 짧습니다`,
    );
  if (headerLength + nRec * recordLength > bytes.byteLength)
    throw new ShpError('DBF_INVALID', `${name}: 레코드 ${nRec}개가 파일 길이를 넘습니다`);
  const decoder = new TextDecoder(encoding.label, { fatal: encoding.source === 'none' });
  const records: DbfTable['records'] = [];
  for (let i = 0; i < nRec; i++) {
    const start = headerLength + i * recordLength;
    if (bytes[start] === 0x2a) {
      records.push(null);
      continue;
    }
    const record: Record<string, DbfValue> = {};
    let o = start + 1;
    for (const f of fields) {
      const cell = bytes.subarray(o, o + f.length);
      o += f.length;
      let text: string;
      try {
        text = (f.type === 'C' || f.type === 'M' ? decoder : ascii)
          .decode(cell)
          .replace(/\0+$/, '')
          .trim();
      } catch {
        throw new ShpError(
          'ENCODING_UNDECLARED',
          `${name}: 인코딩을 밝힌 .cpg가 없고 내용이 UTF-8이 아닙니다. .cpg를 함께 넣으세요`,
        );
      }
      if (f.type === 'N' || f.type === 'F') {
        const n = text === '' ? NaN : Number(text);
        record[f.name] = Number.isFinite(n) ? n : text === '' ? null : text;
      } else if (f.type === 'L')
        record[f.name] = /^[YyTt]$/.test(text) ? true : /^[NnFf]$/.test(text) ? false : null;
      else record[f.name] = text;
    }
    records.push(record);
  }
  return { fields, records };
}

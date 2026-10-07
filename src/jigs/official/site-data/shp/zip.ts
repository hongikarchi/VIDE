// A small ZIP reader for shapefile bundles (SPEC-12.4 "파일 또는 압축 파일"). 국토정보플랫폼 hands out
// 수치지형도 as ZIP files. Reads the central directory, stored and deflate entries only, through
// the web-standard DecompressionStream (no node: imports, no new dependency).

export interface NamedBytes {
  name: string;
  bytes: Uint8Array;
}

export class ZipError extends Error {
  readonly code = 'ZIP_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Entries of a ZIP (directories skipped). Names without the UTF-8 flag are read as EUC-KR. */
export async function unzip(bytes: Uint8Array, name = '.zip'): Promise<NamedBytes[]> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 65535); i--)
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new ZipError(`${name}: 압축 파일의 목차를 찾지 못했습니다`);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder('utf-8');
  const korean = new TextDecoder('euc-kr');
  const out: NamedBytes[] = [];
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.byteLength || dv.getUint32(p, true) !== 0x02014b50)
      throw new ZipError(`${name}: 압축 파일의 목차가 손상되었습니다`);
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compressed = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLength = dv.getUint16(p + 28, true);
    const extraLength = dv.getUint16(p + 30, true);
    const commentLength = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const rawName = bytes.subarray(p + 46, p + 46 + nameLength);
    const entryName = (flags & 0x800 ? utf8 : korean).decode(rawName);
    p += 46 + nameLength + extraLength + commentLength;
    if (entryName.endsWith('/')) continue;
    if (flags & 1) throw new ZipError(`${name}: 암호가 걸린 항목(${entryName})은 읽지 않습니다`);
    if (dv.getUint32(local, true) !== 0x04034b50)
      throw new ZipError(`${name}: ${entryName}의 머리가 손상되었습니다`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    let content: Uint8Array;
    if (method === 0) content = data.slice();
    else if (method === 8) content = await inflateRaw(data);
    else throw new ZipError(`${name}: ${entryName}의 압축 방식 ${method}는 읽지 않습니다`);
    if (content.byteLength !== size)
      throw new ZipError(`${name}: ${entryName}의 크기가 맞지 않습니다`);
    out.push({ name: entryName, bytes: content });
  }
  return out;
}

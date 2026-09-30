// Data block `vide.bake.data/1` (ARCH-03 §9.2): the one value a Rhino bake template receives.
// A little-endian binary bundle that goes base64 into the template's single placeholder, so no
// key, mark, section name or coordinate is ever part of the C# text (decision A7). Coordinates
// are metres: an f64 origin and f32 differences (0.1 mm inside 1 km); the template scales them to
// the document's units. `decodeDataBlock` is the reference reader the tests check the C# against.

export const DATA_FORMAT = 'vide.bake.data/1';
export const TEMPLATE_NAMES = [
  'vide.bake.curves@1',
  'vide.bake.sweep-h@1',
  'vide.bake.extrude-column@1',
  'vide.bake.textdot@1',
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];
export type Vec3 = [number, number, number];
/** A polyline (n ≥ 2 points) or a three-point arc (start, interior, end). */
export interface BakeCurve {
  kind: 'polyline' | 'arc';
  points: Vec3[];
}
interface ItemBase {
  /** The stable result key (`vide-key`); the bake record finds the object by it later. */
  key: string;
  /** Extra user strings (`vide-mark`, `vide-section`, `vide-role`, …). */
  attrs: [string, string][];
}
export interface CurveItem extends ItemBase {
  curve: BakeCurve;
}
export interface SectionSize {
  section: string;
  H_mm: number;
  B_mm: number;
  tw_mm: number;
  tf_mm: number;
}
/** H section under its top line, web vertical. */
export interface SweepItem extends ItemBase, SectionSize {
  rail: BakeCurve;
}
/** H column from base to top; `strongAxis` is the flange direction. */
export interface ColumnItem extends ItemBase, SectionSize {
  base: Vec3;
  top: Vec3;
  strongAxis: Vec3;
}
export interface TextDotItem extends ItemBase {
  text: string;
  point: Vec3;
}
export type BakeItem = CurveItem | SweepItem | ColumnItem | TextDotItem;
export interface ItemsOf {
  'vide.bake.curves@1': CurveItem;
  'vide.bake.sweep-h@1': SweepItem;
  'vide.bake.extrude-column@1': ColumnItem;
  'vide.bake.textdot@1': TextDotItem;
}
export interface DataBlockHeader {
  template: TemplateName;
  jigId: string;
  instanceId: string;
  bakeId: string;
  runId: string;
  /** `layerRoot::layer` — one level under the fixed parent (ARCH-03 §9.5). */
  layerPath: string;
  /** GUIDs the template may delete (only those tagged with this instance and bake). */
  deleteIds: string[];
}

/** Keys, marks, section names and dot texts (gate `bake-args-safe`, ARCH-03 §9.1). */
export const SAFE_ARG = /^[A-Za-z0-9가-힣:_>.\-]{1,64}$/;
/** User-string names a bake may add; the five tags the template sets itself are reserved. */
export const ATTR_NAME = /^vide-[a-z]{1,20}$/;
export const RESERVED_ATTRS = ['vide-jig', 'vide-instance', 'vide-run', 'vide-bake', 'vide-key'];
export const bakeArgSafe = (value: unknown) => typeof value === 'string' && SAFE_ARG.test(value);

/** Every argument of the items that would fail `bake-args-safe`, as `key:field` descriptions. */
export function unsafeArgs(items: readonly BakeItem[]): string[] {
  const failed: string[] = [];
  items.forEach((item, index) => {
    const at = bakeArgSafe(item.key) ? item.key : `#${index}`;
    if (!bakeArgSafe(item.key)) failed.push(`${at}:key`);
    for (const [name, value] of item.attrs) {
      if (!ATTR_NAME.test(name) || RESERVED_ATTRS.includes(name)) failed.push(`${at}:attr-name`);
      if (!bakeArgSafe(value)) failed.push(`${at}:${name}`);
    }
    if ('section' in item && !bakeArgSafe(item.section)) failed.push(`${at}:section`);
    if ('text' in item && !bakeArgSafe(item.text)) failed.push(`${at}:text`);
  });
  return failed;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isVec3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every(finite);
function validCurve(curve: BakeCurve, at: string, problems: string[]) {
  if (!curve.points.every(isVec3)) problems.push(`${at}: 좌표가 수가 아닙니다`);
  else if (curve.kind === 'arc' && curve.points.length !== 3)
    problems.push(`${at}: 원호는 세 점이어야 합니다`);
  else if (curve.kind === 'polyline' && curve.points.length < 2)
    problems.push(`${at}: 폴리라인은 두 점 이상이어야 합니다`);
}
/** Why an item cannot be encoded (missing or non-finite numbers, bad curves), or nothing. */
export function itemProblems(template: TemplateName, items: readonly BakeItem[]): string[] {
  const problems: string[] = [];
  items.forEach((item, index) => {
    const at = item.key || `#${index}`;
    if (template === 'vide.bake.curves@1') validCurve((item as CurveItem).curve, at, problems);
    else if (template === 'vide.bake.textdot@1') {
      const dot = item as TextDotItem;
      if (!isVec3(dot.point)) problems.push(`${at}: 점 좌표가 수가 아닙니다`);
      if (typeof dot.text !== 'string') problems.push(`${at}: 문자가 없습니다`);
    } else {
      const size = item as SweepItem | ColumnItem;
      for (const field of ['H_mm', 'B_mm', 'tw_mm', 'tf_mm'] as const)
        if (!finite(size[field]) || size[field] <= 0)
          problems.push(`${at}: ${field}가 양수가 아닙니다`);
      if (typeof size.section !== 'string') problems.push(`${at}: 단면 이름이 없습니다`);
      if (template === 'vide.bake.sweep-h@1') validCurve((item as SweepItem).rail, at, problems);
      else {
        const column = item as ColumnItem;
        if (!isVec3(column.base) || !isVec3(column.top) || !isVec3(column.strongAxis))
          problems.push(`${at}: 기둥의 아래·위·강축 방향이 수가 아닙니다`);
      }
    }
  });
  return problems;
}

/** All world points of an item (origin choice and bounds). */
export function itemPoints(item: BakeItem): Vec3[] {
  if ('curve' in item) return item.curve.points;
  if ('rail' in item) return item.rail.points;
  if ('base' in item) return [item.base, item.top];
  return [item.point];
}
/** A whole-metre origin near the items: keeps every f32 difference small. */
export function originOf(items: readonly BakeItem[]): Vec3 {
  let n = 0;
  const sum: Vec3 = [0, 0, 0];
  for (const item of items)
    for (const point of itemPoints(item)) {
      n++;
      for (let i = 0; i < 3; i++) sum[i] += point[i];
    }
  if (!n) return [0, 0, 0];
  return [Math.round(sum[0] / n), Math.round(sum[1] / n), Math.round(sum[2] / n)];
}

class Writer {
  private buffer = Buffer.alloc(4096);
  private size = 0;
  private reserve(n: number) {
    if (this.size + n <= this.buffer.length) return;
    let length = this.buffer.length * 2;
    while (length < this.size + n) length *= 2;
    const next = Buffer.alloc(length);
    this.buffer.copy(next, 0, 0, this.size);
    this.buffer = next;
  }
  i32(value: number) {
    this.reserve(4);
    this.buffer.writeInt32LE(value, this.size);
    this.size += 4;
  }
  f32(value: number) {
    this.reserve(4);
    this.buffer.writeFloatLE(value, this.size);
    this.size += 4;
  }
  f64(value: number) {
    this.reserve(8);
    this.buffer.writeDoubleLE(value, this.size);
    this.size += 8;
  }
  str(value: string) {
    const bytes = Buffer.from(value, 'utf8');
    this.i32(bytes.length);
    this.reserve(bytes.length);
    bytes.copy(this.buffer, this.size);
    this.size += bytes.length;
  }
  vec3(point: Vec3, origin: Vec3) {
    for (let i = 0; i < 3; i++) this.f32(point[i] - origin[i]);
  }
  curve(curve: BakeCurve, origin: Vec3) {
    this.i32(curve.kind === 'arc' ? 1 : 0);
    this.i32(curve.points.length);
    for (const point of curve.points) this.vec3(point, origin);
  }
  bytes() {
    return this.buffer.subarray(0, this.size);
  }
}
function writeItem(w: Writer, template: TemplateName, item: BakeItem, origin: Vec3) {
  w.str(item.key);
  w.i32(item.attrs.length);
  for (const [name, value] of item.attrs) {
    w.str(name);
    w.str(value);
  }
  if (template === 'vide.bake.curves@1') w.curve((item as CurveItem).curve, origin);
  else if (template === 'vide.bake.textdot@1') {
    const dot = item as TextDotItem;
    w.str(dot.text);
    w.vec3(dot.point, origin);
  } else {
    const size = item as SweepItem | ColumnItem;
    w.str(size.section);
    w.f32(size.H_mm);
    w.f32(size.B_mm);
    w.f32(size.tw_mm);
    w.f32(size.tf_mm);
    if (template === 'vide.bake.sweep-h@1') w.curve((item as SweepItem).rail, origin);
    else {
      const column = item as ColumnItem;
      w.vec3(column.base, origin);
      w.vec3(column.top, origin);
      for (const component of column.strongAxis) w.f32(component);
    }
  }
}
/** Byte size one item adds to a block (chunking). */
export function itemBytes(template: TemplateName, item: BakeItem): number {
  const w = new Writer();
  writeItem(w, template, item, [0, 0, 0]);
  return w.bytes().length;
}
export function encodeDataBlock(
  header: DataBlockHeader,
  items: readonly BakeItem[],
  origin: Vec3 = originOf(items),
): Buffer {
  const w = new Writer();
  w.str(DATA_FORMAT);
  w.str(header.template);
  w.str(header.jigId);
  w.str(header.instanceId);
  w.str(header.bakeId);
  w.str(header.runId);
  w.str(header.layerPath);
  for (const component of origin) w.f64(component);
  w.i32(header.deleteIds.length);
  for (const id of header.deleteIds) w.str(id);
  w.i32(items.length);
  for (const item of items) writeItem(w, header.template, item, origin);
  return Buffer.from(w.bytes());
}

export interface DecodedBlock {
  format: string;
  header: DataBlockHeader;
  origin: Vec3;
  items: BakeItem[];
}
/** Reference reader (tests, verification); coordinates come back in world metres. */
export function decodeDataBlock(bytes: Buffer): DecodedBlock {
  let pos = 0;
  const i32 = () => {
    const v = bytes.readInt32LE(pos);
    pos += 4;
    return v;
  };
  const f32 = () => {
    const v = bytes.readFloatLE(pos);
    pos += 4;
    return v;
  };
  const f64 = () => {
    const v = bytes.readDoubleLE(pos);
    pos += 8;
    return v;
  };
  const str = () => {
    const n = i32();
    if (n < 0 || pos + n > bytes.length) throw new Error('BAKE_DATA');
    const v = bytes.toString('utf8', pos, pos + n);
    pos += n;
    return v;
  };
  const format = str();
  if (format !== DATA_FORMAT) throw new Error('BAKE_FORMAT');
  const template = str() as TemplateName;
  if (!TEMPLATE_NAMES.includes(template)) throw new Error('BAKE_TEMPLATE');
  const header: DataBlockHeader = {
    template,
    jigId: str(),
    instanceId: str(),
    bakeId: str(),
    runId: str(),
    layerPath: str(),
    deleteIds: [],
  };
  const origin: Vec3 = [f64(), f64(), f64()];
  const vec3 = (): Vec3 => [origin[0] + f32(), origin[1] + f32(), origin[2] + f32()];
  const curve = (): BakeCurve => {
    const kind = i32() === 1 ? 'arc' : 'polyline';
    const n = i32();
    const points: Vec3[] = [];
    for (let i = 0; i < n; i++) points.push(vec3());
    return { kind, points };
  };
  const nDelete = i32();
  for (let i = 0; i < nDelete; i++) header.deleteIds.push(str());
  const items: BakeItem[] = [];
  const nItems = i32();
  for (let i = 0; i < nItems; i++) {
    const key = str();
    const attrs: [string, string][] = [];
    const nAttr = i32();
    for (let a = 0; a < nAttr; a++) attrs.push([str(), str()]);
    if (template === 'vide.bake.curves@1') items.push({ key, attrs, curve: curve() });
    else if (template === 'vide.bake.textdot@1')
      items.push({ key, attrs, text: str(), point: vec3() });
    else {
      const size = { section: str(), H_mm: f32(), B_mm: f32(), tw_mm: f32(), tf_mm: f32() };
      if (template === 'vide.bake.sweep-h@1') items.push({ key, attrs, ...size, rail: curve() });
      else
        items.push({
          key,
          attrs,
          ...size,
          base: vec3(),
          top: vec3(),
          strongAxis: [f32(), f32(), f32()],
        });
    }
  }
  if (pos !== bytes.length) throw new Error('BAKE_DATA_TRAILING');
  return { format, header, origin, items };
}

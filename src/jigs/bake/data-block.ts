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
  'vide.bake.extrude-polygon@1',
  'vide.bake.brep-faces@1',
  'vide.bake.mesh@1',
  'vide.bake.panels-uv@1',
  'vide.bake.panel-solids@1',
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];
/**
 * The 패널링 make templates (SPEC-16.9, PLAN-49 T-255): panels given as UV outlines on faces of the
 * picked object, cut by Rhino out of the ORIGINAL face (open faces) or offset into closed members.
 * Their blocks carry a surface header after the delete list (`SurfaceHeader`).
 */
export const PANEL_TEMPLATES = ['vide.bake.panels-uv@1', 'vide.bake.panel-solids@1'] as const;
export type PanelTemplateName = (typeof PANEL_TEMPLATES)[number];
export const isPanelTemplate = (name: string): name is PanelTemplateName =>
  (PANEL_TEMPLATES as readonly string[]).includes(name);
/** `vide-status` codes of a made panel (the template writes the word). */
export const PANEL_STATUS = ['ok', 'boundary', 'pole'] as const;
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
/** A closed planar ring (n ≥ 3 points, the first point not repeated at the end). */
export type Ring = Vec3[];
/**
 * A closed polygon extruded up by `height` m (T-208, site buildings). `rings[0]` is the outline,
 * the rest are holes; every point's z is the bottom elevation (one horizontal plane).
 */
export interface ExtrudeItem extends ItemBase {
  rings: Ring[];
  height: number;
}
/**
 * A closed polyhedron as its planar faces (T-208, envelopes; SPIKE-2026-10-07-envelope). Each face
 * is an outer ring wound counter-clockwise seen from outside plus holes wound the other way;
 * `volume` is the engine's (m³, positive). The template refuses faces whose wound volume or Brep
 * volume differs from it by more than 1e-6 relative.
 */
export interface FacesItem extends ItemBase {
  faces: Ring[][];
  volume: number;
}
/** A mesh (T-208, terrain): triangles `[a, b, c]` and quads `[a, b, c, d]` by vertex index. */
export interface MeshItem extends ItemBase {
  vertices: Vec3[];
  faces: number[][];
}
/**
 * One panel of a 패널링 make (T-255). `key` is the header's `keyPrefix` + `id` (`makeKey`); the
 * template writes `vide-panel-id`, `vide-panel-size`, `vide-status` and `vide-deviation-mm` itself,
 * so `attrs` stays empty (attributes every panel shares are in the surface header).
 */
export interface PanelItem extends ItemBase {
  /** Panel id (`P-1-1`, `P-2-3a`, `P-1-1+1-2`). */
  id: string;
  faceIndex: number;
  /** Size written as `vide-panel-size` (m; the template writes mm). */
  width: number;
  height: number;
  /** Index into `PANEL_STATUS` for a made panel. */
  status: number;
  /** '' to make; a failure code the engine already knows: drawn on the failure layer, not made. */
  fail: string;
  /** Outline in the face's own parameters (closed implicitly). */
  uv: [number, number][];
  /** The engine's interpolated points at `uv` (m): the template measures `vide-deviation-mm`. */
  expect: Vec3[];
}
/** The block header of the panel templates (ARCH-03 §9.1). */
export interface SurfaceHeader {
  objectId: string;
  /** Faces the items may name, with the fingerprint each was read with (SPEC-16.3 2). */
  faces: { index: number; hash: string }[];
  /** `makeKey(kind, layoutHash, '')`: the template sets `vide-key` = prefix + panel id. */
  keyPrefix: string;
  /** Members: signed offset in m along the face's oriented normal; 0 for open faces. */
  offset: number;
  /** Time limit of one body inside Rhino (ms); past it the body throws and is undone. */
  budgetMs: number;
  /** `layerRoot::실패`: failed panels are left there as outline and number (SPEC-16.9 5). */
  failLayerPath: string;
  /** Attributes every made object gets (`vide-assumed`, `vide-thickness`, `vide-joint`). */
  attrs: [string, string][];
}
export type BakeItem =
  | CurveItem
  | SweepItem
  | ColumnItem
  | TextDotItem
  | ExtrudeItem
  | FacesItem
  | MeshItem
  | PanelItem;
export interface ItemsOf {
  'vide.bake.curves@1': CurveItem;
  'vide.bake.sweep-h@1': SweepItem;
  'vide.bake.extrude-column@1': ColumnItem;
  'vide.bake.textdot@1': TextDotItem;
  'vide.bake.extrude-polygon@1': ExtrudeItem;
  'vide.bake.brep-faces@1': FacesItem;
  'vide.bake.mesh@1': MeshItem;
  'vide.bake.panels-uv@1': PanelItem;
  'vide.bake.panel-solids@1': PanelItem;
}
export interface DataBlockHeader {
  template: TemplateName;
  jigId: string;
  instanceId: string;
  bakeId: string;
  runId: string;
  /** `layerRoot::layer`; the template makes every missing level under its own parent (ARCH-03 §9.5). */
  layerPath: string;
  /** GUIDs the template may delete (only those tagged with this instance and bake). */
  deleteIds: string[];
  /** Panel templates only (`PANEL_TEMPLATES`). */
  surface?: SurfaceHeader;
}

/**
 * Keys, marks, section names, roles and dot texts (gate `bake-args-safe`, ARCH-03 §9.1). `+` joins
 * the panels of a merged 패널링 panel (`P-1-1+1-2`, SPEC-16.5 2).
 */
export const SAFE_ARG = /^[A-Za-z0-9가-힣:_>.+\-]{1,64}$/;
/**
 * User-string names a bake may add: `vide-` and lowercase kebab words, at most 40 characters
 * (ARCH-03 §9.1); the five tags the template sets itself are reserved.
 */
export const ATTR_NAME = /^vide-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const ATTR_NAME_MAX = 40;
export const RESERVED_ATTRS = ['vide-jig', 'vide-instance', 'vide-run', 'vide-bake', 'vide-key'];
/** Attributes whose values are identifiers and keep the key rule (the template names by `vide-mark`). */
export const IDENTIFIER_ATTRS = ['vide-mark', 'vide-section', 'vide-role'];
/** Longest other attribute value (UTF-16 units) and most attributes on one object. */
export const ATTR_VALUE_MAX = 2000;
export const ATTRS_MAX = 32;
// Control characters (C0, DEL, C1), line/paragraph separators, bidirectional overrides and
// isolates, and lone surrogates.
const UNSAFE_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/**
 * Other attribute values are free text (addresses, Korean with spaces, numbers, short JSON): 1 to
 * 2000 characters with no control or direction characters. They travel inside the base64 data
 * block and are set as user strings, never as C# text.
 */
export const attrValueSafe = (value: unknown) =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= ATTR_VALUE_MAX &&
  !UNSAFE_TEXT.test(value);
export const attrNameSafe = (name: unknown) =>
  typeof name === 'string' &&
  name.length <= ATTR_NAME_MAX &&
  ATTR_NAME.test(name) &&
  !RESERVED_ATTRS.includes(name);
/**
 * Attribute names of the site and massing jigs (SPEC-12.6, 12.9의 6, 12.10의 8; ARCH-03 §9.1).
 * Lengths are metres, areas square metres, volumes cubic metres, as the name says.
 */
export const SITE_ATTRS = {
  parcel: [
    'vide-pnu',
    'vide-jibun',
    'vide-jimok',
    'vide-area-m2',
    'vide-source',
    'vide-fetched-at',
  ],
  road: ['vide-width-min', 'vide-width-avg', 'vide-width-source'],
  building: [
    'vide-floors',
    'vide-height',
    'vide-height-source',
    'vide-use',
    'vide-source',
    'vide-fetched-at',
  ],
  zone: ['vide-zone-name', 'vide-zone-code', 'vide-notice'],
  site: ['vide-site-summary', 'vide-crs', 'vide-origin-survey', 'vide-true-north'],
  envelope: ['vide-envelope', 'vide-rules', 'vide-volume-m3', 'vide-unconfirmed'],
  mass: ['vide-option', 'vide-floor', 'vide-area-m2', 'vide-use', 'vide-unconfirmed'],
  ground: ['vide-ground', 'vide-area-m2'],
} as const;
export const bakeArgSafe = (value: unknown) => typeof value === 'string' && SAFE_ARG.test(value);

/** Every argument of the items that would fail `bake-args-safe`, as `key:field` descriptions. */
export function unsafeArgs(items: readonly BakeItem[]): string[] {
  const failed: string[] = [];
  items.forEach((item, index) => {
    const at = bakeArgSafe(item.key) ? item.key : `#${index}`;
    if (!bakeArgSafe(item.key)) failed.push(`${at}:key`);
    if (item.attrs.length > ATTRS_MAX) failed.push(`${at}:attr-count`);
    const seen = new Set<string>();
    for (const [name, value] of item.attrs) {
      if (!attrNameSafe(name) || seen.has(name)) failed.push(`${at}:attr-name`);
      seen.add(name);
      const ok = IDENTIFIER_ATTRS.includes(name) ? bakeArgSafe(value) : attrValueSafe(value);
      if (!ok) failed.push(`${at}:${attrNameSafe(name) ? name : 'attr-value'}`);
    }
    if ('section' in item && !bakeArgSafe(item.section)) failed.push(`${at}:section`);
    if ('uv' in item) {
      if (!bakeArgSafe(item.id) || !item.key.endsWith(item.id)) failed.push(`${at}:id`);
      if (item.fail && !bakeArgSafe(item.fail)) failed.push(`${at}:fail`);
    }
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
/** Bottom planes of an extrusion may differ by this much (m) before the item is refused. */
const LEVEL_TOLERANCE = 1e-6;
function validRings(rings: unknown, at: string, problems: string[], what: string) {
  if (!Array.isArray(rings) || !rings.length) {
    problems.push(`${at}: ${what}의 고리가 없습니다`);
    return false;
  }
  for (const ring of rings)
    if (!Array.isArray(ring) || ring.length < 3 || !ring.every(isVec3)) {
      problems.push(`${at}: ${what}의 고리는 수로 된 세 점 이상이어야 합니다`);
      return false;
    }
  return true;
}
function validTemplateItem(template: TemplateName, item: BakeItem, at: string, problems: string[]) {
  if (template === 'vide.bake.extrude-polygon@1') {
    const solid = item as ExtrudeItem;
    if (!finite(solid.height) || solid.height <= 0) problems.push(`${at}: 높이가 양수가 아닙니다`);
    if (validRings(solid.rings, at, problems, '윤곽')) {
      const z = solid.rings[0][0][2];
      if (solid.rings.some((ring) => ring.some((p) => Math.abs(p[2] - z) > LEVEL_TOLERANCE)))
        problems.push(`${at}: 윤곽이 한 수평면에 있지 않습니다`);
    }
  } else if (template === 'vide.bake.brep-faces@1') {
    const solid = item as FacesItem;
    if (!finite(solid.volume) || solid.volume <= 0)
      problems.push(`${at}: 엔진 부피가 양수가 아닙니다`);
    if (!Array.isArray(solid.faces) || solid.faces.length < 4)
      problems.push(`${at}: 닫힌 다면체는 면이 넷 이상이어야 합니다`);
    else for (const face of solid.faces) if (!validRings(face, at, problems, '면')) break;
  } else if (template === 'vide.bake.mesh@1') {
    const mesh = item as MeshItem;
    const n = Array.isArray(mesh.vertices) ? mesh.vertices.length : 0;
    if (n < 3 || !mesh.vertices.every(isVec3))
      problems.push(`${at}: 메쉬 꼭짓점은 수로 된 세 점 이상이어야 합니다`);
    if (!Array.isArray(mesh.faces) || !mesh.faces.length)
      problems.push(`${at}: 메쉬 면이 없습니다`);
    else if (
      !mesh.faces.every(
        (face) =>
          Array.isArray(face) &&
          (face.length === 3 || face.length === 4) &&
          face.every((i) => Number.isInteger(i) && i >= 0 && i < n) &&
          new Set(face).size === face.length,
      )
    )
      problems.push(`${at}: 메쉬 면은 서로 다른 꼭짓점 번호 셋 또는 넷이어야 합니다`);
  } else if (isPanelTemplate(template)) {
    const panel = item as PanelItem;
    const n = Array.isArray(panel.uv) ? panel.uv.length : 0;
    if (n < 3 || n > PANEL_OUTLINE_MAX || !panel.uv.every((q) => q.length === 2 && q.every(finite)))
      problems.push(`${at}: 패널 윤곽은 수로 된 UV 점 3~${PANEL_OUTLINE_MAX}개여야 합니다`);
    if (!Array.isArray(panel.expect) || panel.expect.length !== n || !panel.expect.every(isVec3))
      problems.push(`${at}: 표본 꼭짓점이 윤곽과 맞지 않습니다`);
    if (!Number.isInteger(panel.faceIndex) || panel.faceIndex < 0)
      problems.push(`${at}: 면 번호가 없습니다`);
    if (![panel.width, panel.height].every(finite))
      problems.push(`${at}: 패널 크기가 수가 아닙니다`);
    if (!Number.isInteger(panel.status) || panel.status < 0 || panel.status >= PANEL_STATUS.length)
      problems.push(`${at}: 상태 번호가 맞지 않습니다`);
  } else return false;
  return true;
}
/** Most outline points one panel may send (contract `OUTLINE_LIMIT`). */
export const PANEL_OUTLINE_MAX = 64;
/** Why a panel template's surface header cannot be encoded, or nothing. */
export function surfaceHeaderProblems(surface: SurfaceHeader | undefined): string[] {
  if (!surface) return ['기준 면 머리가 없습니다'];
  const problems: string[] = [];
  if (!/^[0-9a-fA-F-]{36}$/.test(surface.objectId))
    problems.push('기준 면 객체 ID가 맞지 않습니다');
  if (!surface.faces.length) problems.push('기준 면의 면이 없습니다');
  for (const face of surface.faces)
    if (!Number.isInteger(face.index) || face.index < 0 || !/^[a-f0-9]{8,64}$/.test(face.hash))
      problems.push(`면 ${face.index}: 번호·지문이 맞지 않습니다`);
  if (!bakeArgSafe(surface.keyPrefix + 'x')) problems.push('키 앞머리가 맞지 않습니다');
  if (!finite(surface.offset) || !finite(surface.budgetMs) || surface.budgetMs <= 0)
    problems.push('두께·시간 한도가 수가 아닙니다');
  const pseudo: CurveItem = {
    key: surface.keyPrefix + 'x',
    attrs: surface.attrs,
    curve: { kind: 'polyline', points: [] },
  };
  problems.push(...unsafeArgs([pseudo]).map((p) => `공통 속성 ${p}`));
  return problems;
}
/** Why an item cannot be encoded (missing or non-finite numbers, bad curves), or nothing. */
export function itemProblems(template: TemplateName, items: readonly BakeItem[]): string[] {
  const problems: string[] = [];
  items.forEach((item, index) => {
    const at = item.key || `#${index}`;
    if (validTemplateItem(template, item, at, problems)) return;
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
  if ('rings' in item) return item.rings.flat();
  if ('volume' in item) return item.faces.flat(2);
  if ('vertices' in item) return item.vertices;
  if ('expect' in item) return item.expect;
  return [item.point];
}

/**
 * A mesh split into pieces of at most `maxFaces` faces, each with only the vertices it uses, so a
 * terrain larger than one worker body bakes in several items (keys `<key>:<n>`, n from 1).
 */
export function splitMesh(item: MeshItem, maxFaces = 1500): MeshItem[] {
  if (item.faces.length <= maxFaces) return [item];
  const pieces: MeshItem[] = [];
  for (let start = 0; start < item.faces.length; start += maxFaces) {
    const index = new Map<number, number>();
    const vertices: Vec3[] = [];
    const faces = item.faces.slice(start, start + maxFaces).map((face) =>
      face.map((i) => {
        let j = index.get(i);
        if (j === undefined) {
          j = vertices.length;
          index.set(i, j);
          vertices.push(item.vertices[i]);
        }
        return j;
      }),
    );
    pieces.push({ key: `${item.key}:${pieces.length + 1}`, attrs: item.attrs, vertices, faces });
  }
  return pieces;
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
  rings(rings: readonly Ring[], origin: Vec3) {
    this.i32(rings.length);
    for (const ring of rings) {
      this.i32(ring.length);
      for (const point of ring) this.vec3(point, origin);
    }
  }
  bytes() {
    return this.buffer.subarray(0, this.size);
  }
}
function writeItem(
  w: Writer,
  template: TemplateName,
  item: BakeItem,
  origin: Vec3,
  table?: Map<string, number>,
) {
  if (isPanelTemplate(template)) {
    // Compact: the key and per-panel attributes are the template's; corners are indexes into the
    // block's vertex table (`panelVertices`), so neighbours share their lattice corners.
    const panel = item as PanelItem;
    w.str(panel.id);
    w.i32(panel.faceIndex);
    w.i32(panel.status);
    w.f32(panel.width);
    w.f32(panel.height);
    w.str(panel.fail);
    w.i32(panel.uv.length);
    for (let k = 0; k < panel.uv.length; k++) {
      const index = table?.get(vertexKey(panel, k));
      if (index === undefined) throw new Error('BAKE_PANEL_VERTEX');
      w.i32(index);
    }
    return;
  }
  w.str(item.key);
  w.i32(item.attrs.length);
  for (const [name, value] of item.attrs) {
    w.str(name);
    w.str(value);
  }
  if (template === 'vide.bake.extrude-polygon@1') {
    const solid = item as ExtrudeItem;
    w.f32(solid.height);
    w.rings(solid.rings, origin);
  } else if (template === 'vide.bake.brep-faces@1') {
    const solid = item as FacesItem;
    w.f64(solid.volume);
    w.i32(solid.faces.length);
    for (const face of solid.faces) w.rings(face, origin);
  } else if (template === 'vide.bake.mesh@1') {
    const mesh = item as MeshItem;
    w.i32(mesh.vertices.length);
    for (const point of mesh.vertices) w.vec3(point, origin);
    w.i32(mesh.faces.length);
    for (const face of mesh.faces) for (let i = 0; i < 4; i++) w.i32(face[i] ?? -1);
  } else if (template === 'vide.bake.curves@1') w.curve((item as CurveItem).curve, origin);
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
  if (isPanelTemplate(template)) return panelItemBytes(item as PanelItem);
  const w = new Writer();
  writeItem(w, template, item, [0, 0, 0]);
  return w.bytes().length;
}
/** One corner of a panel in the vertex table: face, exact UV. */
const vertexKey = (panel: PanelItem, k: number) =>
  `${panel.faceIndex}|${panel.uv[k][0]}|${panel.uv[k][1]}`;
/** Bytes of one vertex table row: f64 u, f64 v, f32 × 3 expected point. */
const VERTEX_BYTES = 28;
/** The vertex table keys of a panel's corners. */
export const panelCornerKeys = (panel: PanelItem) => panel.uv.map((_, k) => vertexKey(panel, k));
/**
 * Bytes a panel adds to a block whose vertex table already has `seen` (not changed here); without
 * `seen` every corner counts as new.
 */
export function panelItemBytes(panel: PanelItem, seen?: ReadonlySet<string>): number {
  const fixed = 4 + Buffer.byteLength(panel.id, 'utf8') + 4 * 4 + 4 + Buffer.byteLength(panel.fail);
  const fresh = new Set(panelCornerKeys(panel).filter((key) => !seen?.has(key)));
  return fixed + 4 + 4 * panel.uv.length + VERTEX_BYTES * fresh.size;
}
/** The vertex table of a block: each distinct corner once, in first-use order. */
function panelVertices(items: readonly PanelItem[]) {
  const index = new Map<string, number>();
  const rows: { uv: [number, number]; expect: Vec3 }[] = [];
  for (const panel of items)
    for (let k = 0; k < panel.uv.length; k++) {
      const key = vertexKey(panel, k);
      if (index.has(key)) continue;
      index.set(key, rows.length);
      rows.push({ uv: panel.uv[k], expect: panel.expect[k] });
    }
  return { index, rows };
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
  if (isPanelTemplate(header.template)) {
    const surface = header.surface;
    if (!surface) throw new Error('BAKE_SURFACE_HEADER');
    w.str(surface.objectId);
    w.i32(surface.faces.length);
    for (const face of surface.faces) {
      w.i32(face.index);
      w.str(face.hash);
    }
    w.str(surface.keyPrefix);
    w.f64(surface.offset);
    w.f64(surface.budgetMs);
    w.str(surface.failLayerPath);
    w.i32(surface.attrs.length);
    for (const [name, value] of surface.attrs) {
      w.str(name);
      w.str(value);
    }
    for (const item of items)
      if (item.key !== surface.keyPrefix + (item as PanelItem).id)
        throw new Error('BAKE_PANEL_KEY');
    const table = panelVertices(items as PanelItem[]);
    w.i32(table.rows.length);
    for (const row of table.rows) {
      w.f64(row.uv[0]);
      w.f64(row.uv[1]);
      w.vec3(row.expect, origin);
    }
    w.i32(items.length);
    for (const item of items) writeItem(w, header.template, item, origin, table.index);
    return Buffer.from(w.bytes());
  }
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
  const rings = (): Vec3[][] => {
    const list: Vec3[][] = [];
    for (let r = i32(); r > 0; r--) {
      const ring: Vec3[] = [];
      for (let p = i32(); p > 0; p--) ring.push(vec3());
      list.push(ring);
    }
    return list;
  };
  const nDelete = i32();
  for (let i = 0; i < nDelete; i++) header.deleteIds.push(str());
  if (isPanelTemplate(template)) {
    const objectId = str();
    const faces: SurfaceHeader['faces'] = [];
    for (let n = i32(); n > 0; n--) faces.push({ index: i32(), hash: str() });
    const keyPrefix = str();
    const offset = f64();
    const budgetMs = f64();
    const failLayerPath = str();
    const attrs: [string, string][] = [];
    for (let n = i32(); n > 0; n--) attrs.push([str(), str()]);
    header.surface = { objectId, faces, keyPrefix, offset, budgetMs, failLayerPath, attrs };
  }
  const table: { uv: [number, number]; expect: Vec3 }[] = [];
  if (header.surface)
    for (let n = i32(); n > 0; n--) {
      const uv: [number, number] = [f64(), f64()];
      table.push({ uv, expect: vec3() });
    }
  const items: BakeItem[] = [];
  const nItems = i32();
  for (let i = 0; i < nItems; i++) {
    if (header.surface) {
      const id = str();
      const faceIndex = i32();
      const status = i32();
      const width = f32();
      const height = f32();
      const fail = str();
      const n = i32();
      const uv: [number, number][] = [];
      const expect: Vec3[] = [];
      for (let k = 0; k < n; k++) {
        const row = table[i32()];
        if (!row) throw new Error('BAKE_DATA');
        uv.push(row.uv);
        expect.push(row.expect);
      }
      items.push({
        key: header.surface.keyPrefix + id,
        attrs: [],
        id,
        faceIndex,
        status,
        width,
        height,
        fail,
        uv,
        expect,
      });
      continue;
    }
    const key = str();
    const attrs: [string, string][] = [];
    const nAttr = i32();
    for (let a = 0; a < nAttr; a++) attrs.push([str(), str()]);
    if (template === 'vide.bake.extrude-polygon@1') {
      const height = f32();
      items.push({ key, attrs, height, rings: rings() });
    } else if (template === 'vide.bake.brep-faces@1') {
      const volume = f64();
      const faces: Vec3[][][] = [];
      for (let f = i32(); f > 0; f--) faces.push(rings());
      items.push({ key, attrs, volume, faces });
    } else if (template === 'vide.bake.mesh@1') {
      const vertices: Vec3[] = [];
      for (let v = i32(); v > 0; v--) vertices.push(vec3());
      const faces: number[][] = [];
      for (let f = i32(); f > 0; f--) {
        const face = [i32(), i32(), i32(), i32()];
        faces.push(face[3] < 0 ? face.slice(0, 3) : face);
      }
      items.push({ key, attrs, vertices, faces });
    } else if (template === 'vide.bake.curves@1') items.push({ key, attrs, curve: curve() });
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

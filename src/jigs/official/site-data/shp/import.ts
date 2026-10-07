// SHP 넣기 (SPEC-12.4·12.5 좌표 통일, PLAN-45 T-206). Rewritten from S-02 Site Maker `1_importer.py`
// and S-04 `geo.js`, keeping their hard-won rules (RESEARCH-04 J-01 함정):
// - every file's CRS comes from its `.prj` parameters; files without one, or in a Bessel system,
//   are rejected with the reason (never assumed, never datum-shifted);
// - all files move into ONE projected CRS and ONE origin computed from every accepted file, so the
//   layers never drift apart and the origin does not move when a layer is left out (TRAPS A1·A3);
// - coordinates are returned in the site's local frame (f64, metres from an integer-metre origin).
//   Computation stays local and only the transfer to Rhino narrows to f32 offsets (ARCH-03 §9.2,
//   SPIKE-2026-10-07-envelope: absolute f32 coordinates lose centimetres and fold polygons);
// - polygon rings are grouped by nesting and normalised to counter-clockwise outer rings and
//   clockwise holes, so an extrusion goes up, not into the ground (TRAPS B1);
// - the text encoding is the declared one (TRAPS D1); road-boundary polygons are never buildings and
//   wall-less buildings (BDK005) are flagged, not counted as floor area (TRAPS B2·B3).
// The imported data lives only in the caller's work copy; nothing here stores it (SPEC-12.4).
import { pointInPolygon, signedArea } from '../../geometry-kit/plan.ts';
import {
  CrsError,
  beltFor,
  convergenceAt,
  crsByEpsg,
  crsLabel,
  parsePrj,
  toGeographic,
  tmConvergence,
  transformer,
  type Crs,
} from './crs.ts';
import { codeName, describeLayer, fieldName, type LayerInfo, type LayerRole } from './ngii.ts';
import {
  ShpError,
  readDbf,
  readShp,
  resolveEncoding,
  type DbfValue,
  type TextEncodingChoice,
  type Vec3,
} from './read.ts';
import { ZipError, isZip, unzip, type NamedBytes } from './zip.ts';

export type { NamedBytes } from './zip.ts';

export type RejectCode =
  | 'MISSING_PAIR'
  | 'SHP_DBF_MISMATCH'
  | 'TARGET_NOT_PROJECTED'
  | CrsError['code']
  | ShpError['code']
  | ZipError['code'];

export interface Rejected {
  /** File (base) name as given. */
  file: string;
  code: RejectCode;
  reason: string;
  /** For MISSING_PAIR: the missing extensions. */
  missing?: string[];
}

export interface LocalPolygon {
  /** Counter-clockwise outer ring, open (last point ≠ first). */
  outer: Vec3[];
  /** Clockwise holes, open. */
  holes: Vec3[][];
}
export type LocalGeometry =
  | { kind: 'polygon'; polygons: LocalPolygon[] }
  | { kind: 'polyline'; lines: Vec3[][] }
  | { kind: 'point'; points: Vec3[] };

export interface SiteFeature {
  /** Record index in the file (0-based), the original identifier together with the file name. */
  index: number;
  geometry: LocalGeometry;
  attributes: Record<string, DbfValue>;
  /** Korean meaning of code values (KIND: 무벽건물 …). */
  decoded: Record<string, string>;
  building?: {
    floors: number | null;
    kind: string | null;
    kindName: string | null;
    use: string | null;
    name: string | null;
    /** 무벽건물(BDK005): listed, not made into a mass or counted as floor area. */
    wallless: boolean;
  };
  /** Contour or spot height elevation (m), null when the file carries none. */
  elevation?: number | null;
  parcel?: { pnu: string | null; jibun: string | null; ledger: string | null };
}

export interface ImportedLayer extends LayerInfo {
  sourceCrs: { epsg: string | null; label: string };
  /** True when the coordinates were moved from another CRS into the frame's CRS. */
  reprojected: boolean;
  /** Rotation between the source grid and the frame grid at the origin (degrees), or null. */
  rotationDeg: number | null;
  encoding: TextEncodingChoice;
  fields: { id: string; name: string }[];
  features: SiteFeature[];
  counts: {
    records: number;
    deleted: number;
    nullShapes: number;
    features: number;
    reversedRings: number;
    skippedParts: number;
  };
  /** Local bounding box [xmin, ymin, xmax, ymax] of the features, or null when empty. */
  bbox: [number, number, number, number] | null;
  warnings: string[];
}

export interface SiteFrame {
  crs: { epsg: string | null; name: string; label: string };
  /** f64 origin in the frame CRS (m). Local coordinates are offsets from it. */
  origin: [number, number, number];
  /** Grid convergence at the origin: degrees clockwise from true north to grid north. */
  convergenceDeg: number;
  /** Unit vector of true north in local coordinates (+Y is grid north). */
  trueNorth: [number, number];
  /** Geographic position of the origin [lat, lon]. */
  originLatLon: [number, number];
}

export interface ShpImport {
  frame: SiteFrame | null;
  layers: ImportedLayer[];
  /** Layers read but not used by site modeling (other NGII layers). */
  ignored: { file: string; name: string }[];
  rejected: Rejected[];
}

export interface ImportOptions {
  /** Target projected CRS (EPSG code or a parsed Crs). Default: the first 연속지적도 layer's CRS,
   *  else the first accepted layer's, else the Korea 2000 belt of the data. */
  target?: string | number | Crs;
  /** Frame origin (m, in the target CRS). Default: the centre of all accepted files, floored to m. */
  origin?: [number, number];
}

const PAIR_EXTENSIONS = ['.shp', '.dbf', '.prj'] as const;
const READ_EXTENSIONS = new Set(['.shp', '.dbf', '.prj', '.cpg', '.shx']);
const text = new TextDecoder('utf-8');

function splitName(name: string) {
  const norm = name.replace(/\\/g, '/');
  const dot = norm.lastIndexOf('.');
  const slash = norm.lastIndexOf('/');
  if (dot <= slash) return { base: norm, ext: '' };
  return { base: norm.slice(0, dot), ext: norm.slice(dot).toLowerCase() };
}

/** Unpack ZIP files (one level) and keep only shapefile parts. */
export async function expandInputs(
  files: readonly NamedBytes[],
): Promise<{ files: NamedBytes[]; rejected: Rejected[] }> {
  const out: NamedBytes[] = [];
  const rejected: Rejected[] = [];
  for (const f of files) {
    const { ext } = splitName(f.name);
    if (ext === '.zip' || (ext === '' && isZip(f.bytes))) {
      try {
        const zipBase = splitName(f.name).base;
        for (const entry of await unzip(f.bytes, f.name))
          if (READ_EXTENSIONS.has(splitName(entry.name).ext))
            out.push({ name: `${zipBase}/${entry.name}`, bytes: entry.bytes });
      } catch (error) {
        if (!(error instanceof ZipError)) throw error;
        rejected.push({ file: f.name, code: error.code, reason: error.message });
      }
    } else if (READ_EXTENSIONS.has(ext)) out.push(f);
  }
  return { files: out, rejected };
}

interface FileSet {
  base: string;
  parts: Map<string, Uint8Array>;
}
function groupSets(files: readonly NamedBytes[]) {
  const sets = new Map<string, FileSet>();
  for (const f of files) {
    const { base, ext } = splitName(f.name);
    const key = base.toLowerCase();
    let set = sets.get(key);
    if (!set) sets.set(key, (set = { base, parts: new Map() }));
    set.parts.set(ext, f.bytes);
  }
  return [...sets.values()].sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
}

interface ReadSet {
  base: string;
  info: LayerInfo;
  crs: Crs;
  encoding: TextEncodingChoice;
  fields: { id: string; name: string }[];
  shp: ReturnType<typeof readShp>;
  records: (Record<string, DbfValue> | null)[];
}

function readSet(set: FileSet): ReadSet | Rejected {
  const missing = PAIR_EXTENSIONS.filter((ext) => !set.parts.has(ext));
  if (missing.length)
    return {
      file: set.base,
      code: 'MISSING_PAIR',
      reason: `짝 파일이 없습니다: ${missing.join(', ')}. 형상(.shp)·속성(.dbf)·좌표계(.prj)를 함께 넣으세요`,
      missing: [...missing],
    };
  try {
    const crs = parsePrj(text.decode(set.parts.get('.prj')!));
    const dbfBytes = set.parts.get('.dbf')!;
    const cpg = set.parts.get('.cpg');
    const encoding = resolveEncoding(cpg ? text.decode(cpg) : null, dbfBytes);
    const table = readDbf(dbfBytes, encoding, `${set.base}.dbf`);
    const shp = readShp(set.parts.get('.shp')!, `${set.base}.shp`);
    if (shp.records.length !== table.records.length)
      return {
        file: set.base,
        code: 'SHP_DBF_MISMATCH',
        reason: `형상 ${shp.records.length}개와 속성 ${table.records.length}개의 수가 다릅니다`,
      };
    const ids = table.fields.map((f) => f.name);
    return {
      base: set.base,
      info: describeLayer(set.base, ids),
      crs,
      encoding,
      fields: ids.map((id) => ({ id, name: fieldName(id) })),
      shp,
      records: table.records,
    };
  } catch (error) {
    if (error instanceof CrsError || error instanceof ShpError)
      return { file: set.base, code: error.code, reason: error.message };
    throw error;
  }
}

function resolveTarget(option: ImportOptions['target'], sets: readonly ReadSet[]): Crs {
  if (option !== undefined) {
    const crs = typeof option === 'object' ? option : crsByEpsg(option);
    if (crs.kind !== 'projected')
      throw new CrsError(
        'CRS_NOT_PROJECTED',
        `대상 좌표계(${crsLabel(crs)})가 평면 좌표계가 아닙니다`,
      );
    return crs;
  }
  const projected = sets.filter((s) => s.crs.kind === 'projected');
  const parcel = projected.find((s) => s.info.role === 'parcel');
  if (parcel) return parcel.crs;
  if (projected.length) return projected[0].crs;
  const [x0, , x1] = sets[0].shp.bbox;
  return beltFor((x0 + x1) / 2);
}

const num = (v: DbfValue | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: DbfValue | undefined) =>
  v === null || v === undefined || v === '' ? null : String(v);
function attr(record: Record<string, DbfValue>, id: string): DbfValue | undefined {
  if (id in record) return record[id];
  const key = Object.keys(record).find((k) => k.toUpperCase() === id);
  return key === undefined ? undefined : record[key];
}

/** Drop consecutive duplicates and the closing duplicate of a ring. */
function cleanRing(points: Vec3[], closed: boolean): Vec3[] {
  const out: Vec3[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) out.push(p);
  }
  if (closed && out.length > 1) {
    const [a, b] = [out[0], out[out.length - 1]];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-9) out.pop();
  }
  return out;
}

/** Group rings by nesting depth (even = outer, odd = hole) and orient them. */
function buildPolygons(rings: Vec3[][], counts: ImportedLayer['counts']): LocalPolygon[] {
  const usable = rings.filter((r) => r.length >= 3 && Math.abs(signedArea(r)) > 1e-12);
  counts.skippedParts += rings.length - usable.length;
  const area = usable.map((r) => Math.abs(signedArea(r)));
  const contains = (outer: number, inner: number) =>
    area[outer] > area[inner] && usable[inner].every((p) => pointInPolygon(p, usable[outer], 0));
  const depth = usable.map((_, i) =>
    usable.reduce((d, _r, j) => (j !== i && contains(j, i) ? d + 1 : d), 0),
  );
  const polygons = new Map<number, LocalPolygon>();
  const orient = (ring: Vec3[], ccw: boolean) => {
    if (signedArea(ring) > 0 === ccw) return ring;
    counts.reversedRings++;
    return [...ring].reverse();
  };
  usable.forEach((ring, i) => {
    if (depth[i] % 2 === 0) polygons.set(i, { outer: orient(ring, true), holes: [] });
  });
  usable.forEach((ring, i) => {
    if (depth[i] % 2 === 0) return;
    let parent = -1;
    for (const [j] of polygons)
      if (depth[j] === depth[i] - 1 && contains(j, i) && (parent < 0 || area[j] < area[parent]))
        parent = j;
    polygons.get(parent)?.holes.push(orient(ring, false));
  });
  return [...polygons.values()];
}

function featureProps(role: LayerRole, record: Record<string, DbfValue>, geometry: LocalGeometry) {
  const firstZ = (): number | null => {
    const p =
      geometry.kind === 'point'
        ? geometry.points[0]
        : geometry.kind === 'polyline'
          ? geometry.lines[0]?.[0]
          : geometry.polygons[0]?.outer[0];
    return p && p[2] !== 0 ? p[2] : null;
  };
  switch (role) {
    case 'building': {
      const kind = str(attr(record, 'KIND'));
      const use = str(attr(record, 'SERV'));
      const floors = num(attr(record, 'NMLY'));
      return {
        building: {
          floors: floors !== null && floors >= 0 ? floors : null,
          kind,
          kindName: codeName('KIND', kind),
          use: use ? (codeName('SERV', use) ?? use) : null,
          name: str(attr(record, 'NAME')),
          wallless: kind === 'BDK005',
        },
      };
    }
    case 'contour':
      return { elevation: num(attr(record, 'CONT')) ?? firstZ() };
    case 'spot-height':
      return { elevation: num(attr(record, 'NUME')) ?? num(attr(record, 'ALTI')) ?? firstZ() };
    case 'parcel':
      return {
        parcel: {
          pnu: str(attr(record, 'PNU')),
          jibun: str(attr(record, 'JIBUN')),
          ledger: codeName('BCHK', str(attr(record, 'BCHK'))) ?? str(attr(record, 'BCHK')),
        },
      };
    default:
      return {};
  }
}

/**
 * Import already-unpacked shapefile parts (name + bytes) into one site frame. Each layer that
 * cannot be used is listed in `rejected` with its reason; the others continue.
 */
export function importUnpacked(
  files: readonly NamedBytes[],
  options: ImportOptions = {},
): ShpImport {
  const rejected: Rejected[] = [];
  const sets: ReadSet[] = [];
  for (const set of groupSets(files)) {
    const read = readSet(set);
    if ('code' in read) rejected.push(read);
    else sets.push(read);
  }
  if (!sets.length) return { frame: null, layers: [], ignored: [], rejected };

  let target: Crs;
  try {
    target = resolveTarget(options.target, sets);
  } catch (error) {
    if (!(error instanceof CrsError)) throw error;
    return {
      frame: null,
      layers: [],
      ignored: [],
      rejected: [
        ...rejected,
        { file: String(options.target), code: error.code, reason: error.message },
      ],
    };
  }
  const moves = sets.map((s) => transformer(s.crs, target));

  // Origin from every accepted file (not only the used layers), so it never moves with a filter.
  let origin: [number, number];
  if (options.origin) {
    const [ox, oy] = options.origin;
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) throw new RangeError('origin must be finite');
    origin = [ox, oy];
  } else {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    sets.forEach((s, i) => {
      const [a, b, c, d] = s.shp.bbox;
      for (const [px, py] of [
        [a, b],
        [c, b],
        [c, d],
        [a, d],
      ]) {
        const [x, y] = moves[i]?.(px, py) ?? [px, py];
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    });
    origin = [Math.floor((x0 + x1) / 2), Math.floor((y0 + y1) / 2)];
  }
  const [lat, lon] = toGeographic(target, origin[0], origin[1]);
  const convergenceDeg = convergenceAt(target, origin[0], origin[1]);
  const g = (convergenceDeg * Math.PI) / 180;
  const frame: SiteFrame = {
    crs: { epsg: target.epsg, name: target.name, label: crsLabel(target) },
    origin: [origin[0], origin[1], 0],
    convergenceDeg,
    trueNorth: [-Math.sin(g), Math.cos(g)],
    originLatLon: [lat, lon],
  };

  const layers: ImportedLayer[] = [];
  const ignored: ShpImport['ignored'] = [];
  sets.forEach((s, i) => {
    if (s.info.role === 'unused') {
      ignored.push({ file: s.base, name: s.info.name });
      return;
    }
    const move = moves[i];
    const local = (p: Vec3): Vec3 => {
      const [x, y] = move ? move(p[0], p[1]) : [p[0], p[1]];
      return [x - origin[0], y - origin[1], p[2]];
    };
    const counts: ImportedLayer['counts'] = {
      records: s.records.length,
      deleted: 0,
      nullShapes: 0,
      features: 0,
      reversedRings: 0,
      skippedParts: 0,
    };
    const features: SiteFeature[] = [];
    s.shp.records.forEach((shape, index) => {
      const record = s.records[index];
      if (record === null) {
        counts.deleted++;
        return;
      }
      let geometry: LocalGeometry;
      if (shape.kind === 'null') {
        counts.nullShapes++;
        return;
      } else if (shape.kind === 'point')
        geometry = { kind: 'point', points: shape.points.map(local) };
      else if (shape.kind === 'polyline') {
        const lines = shape.parts.map((part) => cleanRing(part.map(local), false));
        const kept = lines.filter((l) => l.length >= 2);
        counts.skippedParts += lines.length - kept.length;
        if (!kept.length) return;
        geometry = { kind: 'polyline', lines: kept };
      } else {
        const polygons = buildPolygons(
          shape.parts.map((part) => cleanRing(part.map(local), true)),
          counts,
        );
        if (!polygons.length) return;
        geometry = { kind: 'polygon', polygons };
      }
      const decoded: Record<string, string> = {};
      for (const [k, v] of Object.entries(record)) {
        const meaning = codeName(k, v);
        if (meaning) decoded[k] = meaning;
      }
      features.push({
        index,
        geometry,
        attributes: record,
        decoded,
        ...featureProps(s.info.role, record, geometry),
      });
    });
    counts.features = features.length;

    let bbox: ImportedLayer['bbox'] = null;
    const grow = (p: Vec3) => {
      bbox = bbox
        ? [
            Math.min(bbox[0], p[0]),
            Math.min(bbox[1], p[1]),
            Math.max(bbox[2], p[0]),
            Math.max(bbox[3], p[1]),
          ]
        : [p[0], p[1], p[0], p[1]];
    };
    for (const f of features) {
      const geo = f.geometry;
      if (geo.kind === 'point') geo.points.forEach(grow);
      else if (geo.kind === 'polyline') geo.lines.forEach((l) => l.forEach(grow));
      else geo.polygons.forEach((p) => p.outer.forEach(grow));
    }

    const warnings: string[] = [];
    if (!features.length) warnings.push('형상이 하나도 없습니다(빈 결과는 확인 필요)');
    if (s.encoding.source === 'none') warnings.push('인코딩을 밝힌 .cpg가 없어 UTF-8로 읽었습니다');
    if (counts.skippedParts) warnings.push(`퇴화한 고리·선 ${counts.skippedParts}개를 뺐습니다`);
    if (s.info.role === 'building') {
      const wallless = features.filter((f) => f.building?.wallless).length;
      if (wallless) warnings.push(`무벽건물 ${wallless}동은 매스·면적에서 뺄 대상입니다`);
    }
    if (s.info.role === 'contour' || s.info.role === 'spot-height') {
      const missing = features.filter((f) => f.elevation === null).length;
      if (missing) warnings.push(`높이 값이 없는 형상 ${missing}개`);
    }
    const rotationDeg =
      s.crs.kind === 'projected'
        ? tmConvergence(lat, lon, s.crs.tm!, s.crs.ellipsoid) - convergenceDeg
        : null;
    layers.push({
      ...s.info,
      sourceCrs: { epsg: s.crs.epsg, label: crsLabel(s.crs) },
      reprojected: move !== null,
      rotationDeg,
      encoding: s.encoding,
      fields: s.fields,
      features,
      counts,
      bbox,
      warnings,
    });
  });
  return { frame, layers, ignored, rejected };
}

/** Import shapefiles given as separate parts and/or ZIP files. */
export async function importShapefiles(
  files: readonly NamedBytes[],
  options: ImportOptions = {},
): Promise<ShpImport> {
  const expanded = await expandInputs(files);
  const result = importUnpacked(expanded.files, options);
  return { ...result, rejected: [...expanded.rejected, ...result.rejected] };
}

/**
 * f32 offsets for the transfer to Rhino (ARCH-03 §9.2 `vec3`): local coordinates are already
 * offsets from the frame's f64 origin, so only this last step narrows the precision.
 */
export function packOffsets(points: readonly Vec3[]): Float32Array {
  const out = new Float32Array(points.length * 3);
  points.forEach((p, i) => out.set(p, i * 3));
  return out;
}

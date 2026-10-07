// SHP 넣기와 좌표계 (PLAN-45 T-206) — part of the official library `vide/site-data` (T-205 adds the
// public-data sources next to it). Pure TypeScript without node: imports.

export {
  CrsError,
  GRS80,
  KNOWN_CRS,
  WGS84,
  beltFor,
  convergenceAt,
  crsByEpsg,
  crsLabel,
  parsePrj,
  sameCrs,
  tmConvergence,
  tmForward,
  tmInverse,
  toGeographic,
  transformer,
} from './crs.ts';
export type { Crs, CrsErrorCode, Ellipsoid, TmParams, XY } from './crs.ts';
export { ShpError, readDbf, readShp, resolveEncoding } from './read.ts';
export type {
  DbfField,
  DbfTable,
  DbfValue,
  ShpFile,
  ShpRecord,
  TextEncodingChoice,
  Vec3,
} from './read.ts';
export { ZipError, isZip, unzip } from './zip.ts';
export { codeName, describeLayer, dictionarySize, fieldName } from './ngii.ts';
export type { LayerInfo, LayerRole } from './ngii.ts';
export { expandInputs, importShapefiles, importUnpacked, packOffsets } from './import.ts';
export type {
  ImportOptions,
  ImportedLayer,
  LocalGeometry,
  LocalPolygon,
  NamedBytes,
  RejectCode,
  Rejected,
  ShpImport,
  SiteFeature,
  SiteFrame,
} from './import.ts';

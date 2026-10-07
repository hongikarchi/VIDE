// vide/site-data (PLAN-45 T-205, SPEC-12.3·12.4·12.14·12.16): the official public site-data
// library. Only this library calls the public services and only it receives the keys (from
// `src/server/public-data-keys.ts`); jig steps, compute boxes and the screen get its read-copies.

export const library = { id: 'vide/site-data', version: '0.1.0' } as const;

export {
  ALLOWED_ENDPOINTS,
  FORBIDDEN_ENDPOINTS,
  KEY_NAMES,
  SOURCE_KEYS,
  SiteDataError,
  endpointAllowed,
} from './http.ts';
export type { FailureCode, KeyName, PublicDataKeys, SiteDataContext, SourceId } from './http.ts';
export { FAILURE_TEXT } from './snapshot.ts';
export type { Provenance, Snapshot, SnapshotStatus } from './snapshot.ts';
export { lookupParcel } from './lookup.ts';
export type { LookupResult, LookupStatus, ParcelCandidate } from './lookup.ts';
export { RADIUS, collectSite } from './collect.ts';
export type { CollectOptions, SiteCollection } from './collect.ts';
export { isPnu, lotLabel, splitPnu } from './pnu.ts';
export type { Bounds, Polygons, Position } from './geometry.ts';
export type { Parcel } from './sources/vworld-cadastral.ts';
export type { LandCharacteristics } from './sources/vworld-land-characteristics.ts';
export type { LandUse, LandUseEntry, DistrictPlan } from './sources/vworld-land-use.ts';
export type { Building, HeightSource } from './sources/vworld-buildings.ts';
export type { BuildingInfo } from './sources/vworld-building-info.ts';
export type { RegisterTitle } from './sources/building-register.ts';

// `vide/site-data` as jig steps and compute boxes see it (LIBRARY_MODULES, ARCH-03 §2.3): the SHP
// reading of T-206 and the PNU helpers — pure functions. The public-data calls (`lookupParcel`,
// `collectSite` in index.ts) are not here: they need this PC's keys, which only the engine holds
// and passes in (PLAN-45 「공공 자료 키」, SPEC-07.9). A jig reaches them through the engine.

export { library } from './index.ts';
export * from './shp/index.ts';
export { isPnu, lotLabel, splitPnu } from './pnu.ts';

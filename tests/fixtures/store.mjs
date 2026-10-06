// Test helper for the per-project DBs (ADR-032): the DB of a store's only project, or of the
// project named when a test has several.
/** The DB holding the rows of `projectId`, else of the store's one project. */
export function soleDb(store, projectId) {
  if (projectId) return store.db(projectId);
  const dbs = store.databases();
  if (dbs.length !== 1) throw Error(`soleDb: the store has ${dbs.length} project DBs`);
  return dbs[0];
}

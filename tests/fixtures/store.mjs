// Test helper for the per-project DBs (ADR-032): the DB of a store's only project.
/** The DB holding the rows of the store's one project (the one DB of a single-file store). */
export function soleDb(store) {
  const dbs = store.databases();
  if (dbs.length !== 1) throw Error(`soleDb: the store has ${dbs.length} project DBs`);
  return dbs[0];
}

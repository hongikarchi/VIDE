// Opens the engine's Store for a data folder (ADR-032, ARCH-01 §5, PLAN-28 T-124 phase 2).
//
// - `app.sqlite` present: the split layout (app.sqlite + projects/<id>/project.sqlite).
// - Only the old `vide.sqlite`: it is opened once as before (its schema brought up to date), then
//   split once (`splitProjectDatabase`: backup, verify, roll back on failure). If the split fails
//   the engine keeps running on the old single DB exactly as before, and the failure is reported
//   for the diagnostics log; the next start tries again.
// - Neither: a new install starts in the split layout.
// A file other than `vide.sqlite` (tests, tools) that already exists is opened as one DB.
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Store } from './store.ts';
import { splitProjectDatabase } from './project-split.ts';

export interface StoreOpening {
  store: Store;
  /** What the opening did, for the diagnostics log (`db-split`, `db-split-failed`, …). */
  event?: { name: string; data: Record<string, unknown>; error?: unknown };
}
const filled = (path: string) => existsSync(path) && statSync(path).size > 0;
const codeOf = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'DB_SPLIT_FAILED';

export async function openStore(
  filename: string,
  split: typeof splitProjectDatabase = splitProjectDatabase,
): Promise<StoreOpening> {
  if (filename === ':memory:') return { store: new Store(':memory:') };
  const directory = dirname(filename);
  const app = join(directory, 'app.sqlite');
  if (basename(filename) !== 'vide.sqlite' && filled(filename) && !existsSync(app))
    return { store: new Store(filename) };
  if (existsSync(app))
    return {
      store: new Store({ directory }),
      ...(filled(filename)
        ? { event: { name: 'db-split-conflict', data: { kept: basename(filename) } } }
        : {}),
    };
  if (basename(filename) !== 'vide.sqlite' || !filled(filename))
    return { store: new Store({ directory }) };
  // The old single DB. Opening it first brings its schema up to date (and fails as before when it
  // cannot be opened: corrupt, newer, or held by another engine).
  new Store(filename).close();
  try {
    const report = await split(directory);
    if (report.status === 'split')
      return {
        store: new Store({ directory }),
        event: {
          name: 'db-split',
          data: {
            ms: report.ms,
            bytes: report.sourceBytes,
            projects: report.projects.length,
            knowledge: report.projects.filter((project) => project.knowledge).length,
          },
        },
      };
    return {
      store: new Store(filename),
      event: { name: 'db-split-failed', data: { code: 'DB_SPLIT_' + report.status.toUpperCase() } },
    };
  } catch (error) {
    // The split put everything back: the old DB is used as it was.
    return {
      store: new Store(filename),
      event: {
        name: 'db-split-failed',
        data: { code: codeOf(error) },
        error,
      },
    };
  }
}

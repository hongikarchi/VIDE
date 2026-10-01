// Run folders of the test scripts (user decision 2026-10-01: "시험 결과 중 인용되지 않은 것은
// 지우고, 성공하면 지우기로"). `runDirectory(name)` makes `.vide/<name>/<uuid>` in the repository; when
// the process ends with exit code 0 and no uncaught error the folder is removed, otherwise it stays
// for debugging. VIDE_KEEP_TEST_OUTPUT=1 keeps every run. A folder named by the caller (`id`, e.g.
// from a harness that reads it afterwards) is kept unless `keep: false`.
//
// Evidence screenshots meant for VERIFY documents (`docs/assets/**`, tracked files) go to a run
// folder by default; only VIDE_WRITE_EVIDENCE=1 writes them to their place in docs/assets.
import { mkdirSync, rmdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '..', '..');
const removable = new Set();
let crashed = false;
process.on('uncaughtExceptionMonitor', () => {
  crashed = true;
});
process.on('exit', (code) => {
  if (code !== 0 || crashed || process.env.VIDE_KEEP_TEST_OUTPUT === '1') return;
  for (const directory of removable)
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
      // `.vide/<name>` too once its last run is gone (another run's folder keeps it).
      rmdirSync(dirname(directory));
    } catch {
      /* A host that still holds a file keeps the folder; nothing else depends on it. */
    }
});

/** `.vide/<name>/<id>`, created; removed after a successful run unless kept. */
export function runDirectory(name, { id, keep = id !== undefined } = {}) {
  const directory = join(repository, '.vide', name, id || randomUUID());
  mkdirSync(directory, { recursive: true });
  if (!keep) removable.add(directory);
  return directory;
}

let evidenceFolder;
/**
 * Where a screenshot for `docs/assets/...` goes: that tracked path only with VIDE_WRITE_EVIDENCE=1,
 * else this run's evidence folder (removed after a successful run).
 */
export function evidencePath(target) {
  if (process.env.VIDE_WRITE_EVIDENCE === '1') {
    const path = resolve(repository, target);
    mkdirSync(dirname(path), { recursive: true });
    return path;
  }
  evidenceFolder ??= runDirectory('evidence');
  return join(evidenceFolder, basename(target));
}

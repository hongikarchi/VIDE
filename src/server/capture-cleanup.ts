// VIDE's own copies of Rhino documents (PLAN-27 T-087, done early on 2026-10-01 at the user's
// request). A candidate run or an application read-back makes the attached Rhino write the whole
// document to <data>/rhino-connections/<session>/<operation>.3dm (+ .capture.json), and every
// work copy runs in <data>/sdk-models/<uuid>. Nothing deleted them: four leftover copies took
// 0.75 GB. What goes, and when:
// - the copy (.3dm) right after the work copy has read it (the work copy keeps its own),
// - its receipt (.capture.json: per-object hashes an application checks) once no candidate made
//   from it can still be applied: the run ended without one, or the application settled,
// - the work folder a capture was imported into once the run that started from it ended,
// - at engine start: copies, receipts and work folders older than a day that no unfinished
//   request or application refers to, and session folders of Rhino sessions that have ended.
// Only paths inside VIDE's own folders are touched, never through a link or junction.
import { lstat, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPTURE = /^([0-9a-f-]{36})\.3dm(\.capture\.json)?$/i;
const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
/** `path` is strictly inside `root` (case-insensitive, as Windows paths are). */
export const within = (root: string, path: string) => {
  const rest = relative(resolve(root).toLowerCase(), resolve(path).toLowerCase());
  return !!rest && !rest.startsWith('..') && !isAbsolute(rest);
};
const quiet = async <T>(work: Promise<T>) => {
  try {
    return await work;
  } catch {
    return undefined;
  }
};

/** Deletes VIDE's copies under the given roots only, refusing links and junctions on the way. */
export class CopyFiles {
  readonly roots: string[];
  constructor(roots: string[]) {
    this.roots = roots.map((root) => resolve(root));
  }
  /** Every folder from the root down to `path` is a real folder (no link or junction). */
  private async plain(path: string) {
    const root = this.roots.find((candidate) => within(candidate, path));
    if (!root) return false;
    let current = root;
    for (const part of ['', ...relative(root, resolve(path)).split(sep)]) {
      current = part ? join(current, part) : current;
      const info = await quiet(lstat(current));
      if (!info || info.isSymbolicLink()) return false;
    }
    return true;
  }
  /** A capture's document copy, its receipt, or both. Missing files are fine. */
  async removeCapture(filename: unknown, parts: { copy?: boolean; receipt?: boolean }) {
    if (typeof filename !== 'string' || !CAPTURE.test(filename.split(/[\\/]/).at(-1) ?? ''))
      return 0;
    const paths = [
      ...(parts.copy ? [filename] : []),
      ...(parts.receipt ? [filename + '.capture.json'] : []),
    ];
    let removed = 0;
    for (const path of paths) {
      if (!(await this.plain(path)) || !(await quiet(lstat(path)))?.isFile()) continue;
      if ((await quiet(rm(path, { force: true }).then(() => true))) === true) removed++;
    }
    return removed;
  }
  /** A work folder `<root>/<uuid>`. */
  async removeDirectory(directory: unknown) {
    if (typeof directory !== 'string') return false;
    const path = resolve(directory);
    const root = this.roots.find((candidate) => within(candidate, path));
    if (!root || !UUID.test(relative(root, path)) || !(await this.plain(path))) return false;
    const info = await quiet(lstat(path));
    if (!info?.isDirectory()) return false;
    return (await quiet(rm(path, { recursive: true, force: true }).then(() => true))) === true;
  }
}

/** Paths unfinished work still refers to: requests not yet settled and pending applications. */
export function unsettledCopies(db: DatabaseSync) {
  const rows = db
    .prepare(
      `SELECT json_extract(result,'$.filename') AS a, json_extract(result,'$.workerDirectory') AS b,
        json_extract(result,'$.sourceDocument.capture') AS c FROM workspace_requests
      WHERE state IN ('queued','running','unknown') OR id IN (
        SELECT json_extract(payload,'$.requestId') FROM commands
        WHERE kind='applyCandidate' AND state IN ('queued','running','unknown'))`,
    )
    .all() as { a: unknown; b: unknown; c: unknown }[];
  return rows.flatMap((row) =>
    [row.a, row.b, row.c].filter((path): path is string => typeof path === 'string' && !!path),
  );
}

interface SweepOptions {
  /** <data>/rhino-connections: one folder per attached Rhino session, `<session>.json` while it runs. */
  connections?: string;
  /** <data>/sdk-models: work folders; `<models>.editors.json` lists the open editing copies. */
  models?: string;
  keep: string[];
  now?: number;
  maxAgeMs?: number;
  /** An ended session's folder younger than this stays (a Rhino may be connecting right now). */
  emptyAgeMs?: number;
  alive?: (pid: number) => boolean;
}
const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'EPERM';
  }
};

/** Engine start: removes stale copies and folders. Never throws. */
export async function sweepCopies(options: SweepOptions) {
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? DAY;
  const emptyAge = options.emptyAgeMs ?? 10 * 60_000;
  const alive = options.alive ?? processAlive;
  const { connections, models } = options;
  const copies = new CopyFiles([connections, models].filter((root) => root !== undefined));
  const kept = (path: string) =>
    options.keep.some(
      (used) => same(used, path) || within(path, used) || same(used + '.capture.json', path),
    );
  const result = { captures: 0, directories: 0, sessions: 0, bytes: 0 };
  const realFolder = async (path: string) => {
    const info = await quiet(lstat(path));
    return info?.isDirectory() && !info.isSymbolicLink() ? info : undefined;
  };
  // Capture copies and receipts; folders of ended sessions.
  if (connections && (await realFolder(connections))) {
    for (const name of (await quiet(readdir(connections))) ?? []) {
      if (!UUID.test(name)) continue;
      const folder = join(connections, name);
      const info = await realFolder(folder);
      if (!info) continue;
      const running = !!(await quiet(lstat(join(connections, name + '.json'))));
      for (const file of (await quiet(readdir(folder))) ?? []) {
        const match = CAPTURE.exec(file);
        if (!match) continue;
        const path = join(folder, file);
        const stat = await quiet(lstat(path));
        if (!stat?.isFile() || now - stat.mtimeMs <= maxAge || kept(path)) continue;
        const copy = !match[2];
        const removed = await copies.removeCapture(copy ? path : path.slice(0, -13), {
          copy,
          receipt: !copy,
        });
        if (removed) {
          result.captures++;
          result.bytes += stat.size;
        }
      }
      // rmdir removes only an empty folder; one still holding anything stays.
      if (
        !running &&
        now - info.mtimeMs > emptyAge &&
        (await quiet(rmdir(folder).then(() => true))) === true
      )
        result.sessions++;
    }
  }
  // Work folders: not an open editing copy, not a live worker, not referred to by unfinished work.
  if (models && (await realFolder(models))) {
    const editors = new Set<string>();
    const registry = await quiet(readFile(models + '.editors.json', 'utf8'));
    try {
      for (const entry of JSON.parse(registry ?? '[]') as { identity?: { sessionId?: unknown } }[])
        if (typeof entry?.identity?.sessionId === 'string') editors.add(entry.identity.sessionId);
    } catch {
      return result; // An unreadable registry: no work folder can be shown to be closed.
    }
    for (const name of (await quiet(readdir(models))) ?? []) {
      if (!UUID.test(name)) continue;
      const folder = join(models, name);
      const info = await realFolder(folder);
      if (!info || kept(folder)) continue;
      let newest = info.mtimeMs,
        size = 0,
        linked = false;
      for (const file of (await quiet(readdir(folder))) ?? []) {
        const stat = await quiet(lstat(join(folder, file)));
        if (!stat) continue;
        if (stat.isSymbolicLink()) linked = true;
        newest = Math.max(newest, stat.mtimeMs);
        size += stat.isFile() ? stat.size : 0;
      }
      if (linked || now - newest <= maxAge) continue;
      const ready = await quiet(readFile(join(folder, 'ready.json'), 'utf8'));
      if (ready) {
        let identity: { pid?: unknown; sessionId?: unknown } = {};
        try {
          identity = JSON.parse(ready);
        } catch {
          /* A torn report: the folder is judged by age alone. */
        }
        if (typeof identity.sessionId === 'string' && editors.has(identity.sessionId)) continue;
        if (typeof identity.pid === 'number' && identity.pid > 0 && alive(identity.pid)) continue;
      }
      if (await copies.removeDirectory(folder)) {
        result.directories++;
        result.bytes += size;
      }
    }
  }
  return result;
}

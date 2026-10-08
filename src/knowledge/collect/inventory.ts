// Stage 1 of the collector (SPEC-08.9 1·2): list the project folders (read only), leave out what
// SPEC-01.13 4 never reads and generated noise, hash what changed (size and modification time
// first), mark files that are gone and bring back files that came back. Folder and file names
// give dates and document types by rule (no AI; the spike's names stage without Jev).
import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { tx, type KnowledgeDb } from './schema.ts';
import { pool } from './ai.ts';

/** Text-bearing kinds by extension; everything else is `binary` (listed, not read). */
const KINDS: Record<string, string> = {
  eml: 'mail',
  msg: 'mail',
  pdf: 'pdf',
  docx: 'office',
  docm: 'office',
  pptx: 'office',
  xlsx: 'office',
  xlsm: 'office',
  hwpx: 'office',
  hwp: 'hwp',
  doc: 'legacy',
  ppt: 'legacy',
  xls: 'legacy',
  txt: 'text',
  md: 'text',
  csv: 'text',
  dwg: 'dwg',
};
/** Generated or lock files: never evidence of what someone said. */
const NOISE = new Set(['bak', '3dmbak', 'dwl', 'dwl2', 'tmp', 'save', 'db', 'ini', 'lnk', 'log']);
/** Folders never walked. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.vide', '$recycle.bin']);

export interface Roots {
  /**
   * The deepest common folder of the first folder and the folders beside it (`meta.root`). Source
   * paths under it are recorded relative to it.
   */
  root: string;
  /**
   * Every folder walked, in order. A folder on another drive or share, or one whose only common
   * folder with the first is a drive root, is walked too: its files are recorded by absolute path.
   */
  folders: string[];
}
const fold = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const isDriveRoot = (path: string) => resolve(path) === parse(resolve(path)).root;

/**
 * The root of several project folders (SPEC-08.9 1): the deepest common folder of the first folder
 * and the folders that share one with it below a drive or share root. No folder is left out.
 */
export function rootsOf(folders: readonly string[]): Roots | null {
  const list = folders.map((f) => resolve(f));
  if (!list.length) return null;
  let root = list[0];
  for (const folder of list.slice(1)) {
    let common = root;
    while (!isInside(common, folder) && dirname(common) !== common) common = dirname(common);
    if (isInside(common, folder) && !isDriveRoot(common)) root = common;
  }
  return { root, folders: list };
}
function isInside(root: string, target: string) {
  const rel = relative(fold(root), fold(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
/** A recorded source path: relative to `root` when under it, else absolute (both with `/`). */
export function recordedPath(root: string, path: string) {
  const full = resolve(path);
  return (isInside(root, full) ? relative(root, full) : full).split(sep).join('/');
}
/** The file a recorded source path names (relative to `root`, or absolute). */
export const sourceFile = (root: string, rel: string) => resolve(root, rel);

/** Folder-name dates (`260917`), episodes and document types by rule. */
const TYPES: [string, RegExp][] = [
  ['mail', /\.eml$/i],
  ['minutes', /회의록|협의내용|협의 내용|회의 ?결과/],
  ['contract', /계약서|제안서/],
  ['estimate', /견적|공사비|용역비|설계비|적산/],
  ['study', /지반조사|안전진단|진단보고서|조사보고서/],
  ['regulation', /법규|가이드라인|기준|양식/],
  ['schedule', /공정표|연락망|일정|스케줄/],
  ['review', /검토|자문|의견|체크/],
  ['drawing', /\.(dwg|dxf)$|도면|평면도|단면도|배치도|입면도|상세도/i],
  ['report', /보고|발표|PT|심의자료|심의 자료/i],
];
const DAY = /(?:^|[^\d])(2[0-9])(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/;
export function parsePath(rel: string) {
  const parts = rel.split('/');
  const out: Record<string, string> = {};
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = parts[i].match(DAY);
    if (m) {
      out.day = `20${m[1]}-${m[2]}-${m[3]}`;
      if (i < parts.length - 1) out.episode = parts.slice(0, i + 1).join('/');
      break;
    }
  }
  if (/(^|\/)(old|del)(\/|$)/i.test(rel)) out.superseded = 'yes';
  const name = parts.at(-1) ?? '',
    folder = parts.at(-2) ?? '';
  const type =
    TYPES.find(([, pattern]) => pattern.test(name)) ??
    TYPES.find(([, pattern]) => pattern.test(folder));
  if (type) out.type = type[0];
  return out;
}

interface Listed {
  /** The recorded path (`source.rel_path`). */
  rel: string;
  /** The path below the folder it is named from, for dates, document types and the top folder. */
  local: string;
}
async function walk(
  root: string,
  base: string,
  folder: string,
  denied: (path: string) => boolean,
  out: Listed[],
  signal?: AbortSignal,
) {
  if (signal?.aborted) return;
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return; // An unreadable folder is skipped.
  }
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (denied(path)) continue;
    // Links and junctions are not followed (they may lead outside the project folder).
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name.toLowerCase()))
        await walk(root, base, path, denied, out, signal);
    } else if (entry.isFile())
      out.push({
        rel: recordedPath(root, path),
        local: relative(base, path).split(sep).join('/'),
      });
  }
}

const hashFile = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });

export interface InventoryResult {
  files: number;
  changed: number;
  removed: number;
  returned: number;
}

/**
 * Lists the folders into `source`. A file whose size and time are unchanged keeps its hash; a new
 * or changed file is hashed (its extraction runs again when the hash differs). Files not seen get
 * `skip = 'removed'` and their statements `status = 'removed'`; a file that came back is shown
 * again.
 */
export async function inventory(
  db: KnowledgeDb,
  roots: Roots,
  denied: (path: string) => boolean,
  signal?: AbortSignal,
): Promise<InventoryResult> {
  const runId = Number(
    (db.prepare('select coalesce(max(seen_run), 0) + 1 as n from source').get() as { n: number }).n,
  );
  const listed = new Map<string, Listed>();
  for (const folder of roots.folders) {
    // A folder under the root is named from the root; one outside it from itself.
    const base = isInside(roots.root, folder) ? roots.root : folder;
    const out: Listed[] = [];
    await walk(roots.root, base, folder, denied, out, signal);
    for (const item of out) if (!listed.has(fold(item.rel))) listed.set(fold(item.rel), item);
  }
  const files = [...listed.values()];
  if (signal?.aborted) throw new Error('STOPPED');
  const known = new Map(
    (
      db.prepare('select rel_path, size, mtime, sha256, skip from source').all() as {
        rel_path: string;
        size: number;
        mtime: string;
        sha256: string | null;
        skip: string | null;
      }[]
    ).map((r) => [r.rel_path, r]),
  );
  interface Row {
    rel: string;
    local: string;
    ext: string;
    size: number;
    mtime: string;
    kind: string;
    skip: string | null;
    sha256?: string | null;
  }
  const rows: Row[] = [];
  await pool(
    files,
    16,
    async ({ rel, local }) => {
      const info = await stat(sourceFile(roots.root, rel)).catch(() => undefined);
      if (!info) return;
      const ext = extname(rel).slice(1).toLowerCase();
      const name = basename(rel);
      const kind = KINDS[ext] ?? 'binary';
      const skip =
        NOISE.has(ext) || name.startsWith('~$') || name.startsWith('.') ? 'generated' : null;
      rows.push({ rel, local, ext, size: info.size, mtime: info.mtime.toISOString(), kind, skip });
    },
    signal,
  );
  let changed = 0;
  const needHash = rows.filter((r) => {
    const old = known.get(r.rel);
    if (old && old.size === r.size && old.mtime === r.mtime && old.sha256) {
      r.sha256 = old.sha256;
      return false;
    }
    if (r.skip || r.kind === 'binary') return false;
    changed++;
    return true;
  });
  await pool(
    needHash,
    6,
    async (r) => {
      r.sha256 = await hashFile(sourceFile(roots.root, r.rel)).catch(() => null);
    },
    signal,
  );
  if (signal?.aborted) throw new Error('STOPPED');
  const upsert =
    db.prepare(`insert into source(rel_path, ext, size, mtime, sha256, top, kind, skip, group_key, seen_run)
    values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(rel_path) do update set size = excluded.size, mtime = excluded.mtime, sha256 = excluded.sha256,
      kind = excluded.kind, skip = excluded.skip, group_key = excluded.group_key, seen_run = excluded.seen_run`);
  const meta =
    db.prepare(`insert into source_meta(source_id, key, value, method, confidence) values(?, ?, ?, 'rule', 1)
    on conflict(source_id, key) do update set value = excluded.value, method = excluded.method`);
  const idOf = db.prepare('select id from source where rel_path = ?');
  const episode = db.prepare(
    'insert or ignore into episode(day, counterpart, rel_folder) values(?, null, ?)',
  );
  let returned = 0,
    removed = 0;
  tx(db, () => {
    for (const r of rows) {
      if (known.get(r.rel)?.skip === 'removed') returned++;
      const stem = basename(r.rel, extname(r.rel)).normalize('NFC').toLowerCase().trim();
      upsert.run(
        r.rel,
        r.ext,
        r.size,
        r.mtime,
        r.sha256 ?? null,
        r.local.split('/')[0],
        r.kind,
        r.skip,
        dirname(r.rel) + '/' + stem,
        runId,
      );
      if (r.skip || r.kind === 'binary' || known.has(r.rel)) continue;
      const id = Number((idOf.get(r.rel) as { id: number }).id);
      const parsed = parsePath(r.local);
      for (const [key, value] of Object.entries(parsed)) meta.run(id, key, value);
      if (parsed.episode) episode.run(parsed.day, parsed.episode);
    }
    removed = Number(
      db
        .prepare(
          "update source set skip = 'removed' where seen_run <> ? and coalesce(skip, '') <> 'removed'",
        )
        .run(runId).changes,
    );
    // Statements follow their file: hidden while it is gone, shown again when it is back. Hidden
    // means support_prob -1 too, so every reader of the DB (the 자료 tab, the AI tools, the site
    // copy) leaves them out without knowing `status`; the earlier value waits in `held_prob`.
    db.exec(`update statement set status = 'removed', held_prob = support_prob, support_prob = -1
      where coalesce(status, 'ai') <> 'removed' and excerpt_id in
        (select e.id from excerpt e join source s on s.id = e.source_id where s.skip = 'removed')`);
    db.exec(`update statement set status = 'ai', support_prob = held_prob, held_prob = null
      where status = 'removed' and excerpt_id in
        (select e.id from excerpt e join source s on s.id = e.source_id where s.skip is null)`);
  });
  return { files: rows.length, changed, removed, returned };
}

/**
 * When the root moves (a folder was added above or beside the first one, or the first one
 * changed), recorded paths are rewritten for the new root so their excerpts and statements stay:
 * relative when under it, absolute when not (SPEC-08.9 1).
 */
export function moveRoot(db: KnowledgeDb, oldRoot: string, newRoot: string) {
  if (fold(resolve(oldRoot)) === fold(resolve(newRoot))) return;
  const rows = db.prepare('select id, rel_path from source').all() as {
    id: number;
    rel_path: string;
  }[];
  const set = db.prepare('update or ignore source set rel_path = ? where id = ?');
  tx(db, () => {
    for (const row of rows) {
      const rel = recordedPath(newRoot, sourceFile(oldRoot, row.rel_path));
      if (rel !== row.rel_path) set.run(rel, row.id);
    }
  });
}

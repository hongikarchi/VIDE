// Stage 1: list the project folder (read-only), drop generated noise, hash text-bearing files.
// Unchanged files (same size and mtime) keep their hash, so a second run only reads what changed.
import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, basename, dirname } from 'node:path';
import { logRun, tx } from './db.mjs';

const TEXT = {
  eml: 'mail', msg: 'mail',
  pdf: 'pdf',
  docx: 'office', pptx: 'office', xlsx: 'office', xlsm: 'office', hwpx: 'office',
  hwp: 'hwp', doc: 'legacy', ppt: 'legacy', xls: 'legacy',
  txt: 'text', csv: 'text',
  dwg: 'dwg', dxf: 'dwg',
};
// Generated or lock files: never evidence of what someone said.
const NOISE = new Set(['bak', '3dmbak', 'dwl', 'dwl2', 'tmp', 'save', 'db', 'ini', 'lnk', 'log']);

async function walk(root, relative = '', out = []) {
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const rel = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) await walk(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

const hashFile = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export async function inventory(db, root) {
  const started = performance.now();
  const runId = Number(db.prepare('select coalesce(max(id), 0) + 1 as n from run').get().n);
  const files = await walk(root);
  const known = new Map(
    db.prepare('select rel_path, size, mtime, sha256 from source').all().map((r) => [r.rel_path, r]),
  );
  const rows = [];
  await pool(files, 16, async (rel) => {
    const info = await stat(join(root, rel));
    const ext = extname(rel).slice(1).toLowerCase();
    const name = basename(rel);
    const kind = TEXT[ext] ?? 'binary';
    const skip = NOISE.has(ext) || name.startsWith('~$') || name.startsWith('.') ? 'generated' : null;
    rows.push({ rel, ext, size: info.size, mtime: info.mtime.toISOString(), kind, skip });
  });
  let hashed = 0,
    hashedBytes = 0;
  const needHash = rows.filter((r) => {
    const old = known.get(r.rel);
    if (old && old.size === r.size && old.mtime === r.mtime && old.sha256) {
      r.sha256 = old.sha256;
      return false;
    }
    return !r.skip && r.kind !== 'binary';
  });
  await pool(needHash, 6, async (r) => {
    r.sha256 = await hashFile(join(root, r.rel));
    hashed++;
    hashedBytes += r.size;
  });
  const upsert = db.prepare(`insert into source(rel_path, ext, size, mtime, sha256, top, kind, skip, group_key, seen_run)
    values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(rel_path) do update set size = excluded.size, mtime = excluded.mtime, sha256 = excluded.sha256,
      kind = excluded.kind, skip = excluded.skip, group_key = excluded.group_key, seen_run = excluded.seen_run`);
  tx(db, () => {
    for (const r of rows) {
      const stem = basename(r.rel, extname(r.rel)).normalize('NFC').toLowerCase().trim();
      upsert.run(r.rel, r.ext, r.size, r.mtime, r.sha256 ?? null, r.rel.split('/')[0],
        r.kind, r.skip, dirname(r.rel) + '/' + stem, runId);
    }
  });
  const missing = db.prepare('select count(*) as n from source where seen_run <> ?').get(runId).n;
  const ms = logRun(db, 'inventory', started, {
    items: rows.length,
    note: JSON.stringify({ hashed, hashedMB: Math.round(hashedBytes / 1e6), missing }),
  });
  return { files: rows.length, hashed, hashedMB: Math.round(hashedBytes / 1e6), missing, ms };
}

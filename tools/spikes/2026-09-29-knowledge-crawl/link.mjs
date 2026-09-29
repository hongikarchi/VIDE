// Stage 4: connect mail attachments to server files (same bytes first, then same file name) and
// count threads and duplicate copies. No AI.
import { logRun, tx } from './db.mjs';

const norm = (name) => name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

export async function link(db) {
  const started = performance.now();
  const bySha = new Map(),
    byName = new Map();
  for (const s of db.prepare("select id, rel_path, sha256 from source where skip is null and rel_path not like '%99_MAIL%'").all()) {
    if (s.sha256 && !bySha.has(s.sha256)) bySha.set(s.sha256, s.id);
    const name = norm(s.rel_path.split('/').at(-1));
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(s.id);
  }
  const set = db.prepare('update attachment set matched_source_id = ?, match_method = ? where id = ?');
  const counts = { attachments: 0, sha: 0, name: 0, none: 0 };
  tx(db, () => {
    for (const a of db.prepare('select id, filename, sha256 from attachment').all()) {
      counts.attachments++;
      const exact = bySha.get(a.sha256);
      const named = byName.get(norm(a.filename ?? ''));
      if (exact) (set.run(exact, 'sha', a.id), counts.sha++);
      else if (named?.length) (set.run(named[0], 'name', a.id), counts.name++);
      else (set.run(null, null, a.id), counts.none++);
    }
  });
  counts.threads = db.prepare('select count(distinct thread) as n from mail').get().n;
  counts.threadsWithReplies = db.prepare('select count(*) as n from (select thread from mail group by thread having count(*) > 1)').get().n;
  counts.duplicateFiles = db.prepare('select coalesce(sum(n - 1), 0) as n from (select count(*) as n from source where sha256 is not null group by sha256 having n > 1)').get().n;
  counts.ms = logRun(db, 'link', started, { items: counts.attachments, note: JSON.stringify(counts) });
  return counts;
}

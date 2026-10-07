// Stage 2 of the collector (SPEC-08.9 2): changed files into excerpts. Documents are read in
// worker threads (time limit per file), drawings through a hidden ZWCAD of the engine's own
// (dwg.ts). An excerpt whose text did not change keeps its row, its selection and statements, so a
// changed file sends only its new text to the AI.
import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import { tx, type KnowledgeDb } from './schema.ts';
import { extractAll } from './extract-pool.ts';
import type { Excerpt, Extracted, FileStatus } from './documents.ts';
import type { Mail } from './mail.ts';

export const textSha = (text: string) =>
  createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');

/** Removes excerpts with their statements; a shared text's selection moves to another copy. */
export function removeExcerpts(db: KnowledgeDb, ids: readonly number[]) {
  if (!ids.length) return;
  const gone = new Set(ids);
  const statements = db.prepare('select id from statement where excerpt_id = ?');
  const dropLink = db.prepare('delete from statement_issue where statement_id = ?');
  const dropStatement = db.prepare('delete from statement where id = ?');
  const dropDone = db.prepare('delete from statement_done where excerpt_id = ?');
  const shaOf = db.prepare('select text_sha from excerpt where id = ?');
  const copies = db.prepare('select id from excerpt where text_sha = ? order by id');
  const moveSelection = db.prepare('update selection set excerpt_id = ? where excerpt_id = ?');
  const dropSelection = db.prepare('delete from selection where excerpt_id = ?');
  const drop = db.prepare('delete from excerpt where id = ?');
  for (const id of ids) {
    for (const row of statements.all(id) as { id: number }[]) {
      dropLink.run(row.id);
      dropStatement.run(row.id);
    }
    dropDone.run(id);
    const sha = (shaOf.get(id) as { text_sha: string } | undefined)?.text_sha;
    const other = sha
      ? (copies.all(sha) as { id: number }[]).find((row) => !gone.has(row.id))
      : undefined;
    if (other) moveSelection.run(other.id, id);
    else dropSelection.run(id);
    drop.run(id);
  }
}

/** Saves one file's excerpts, keeping rows whose text is unchanged. */
export function saveExcerpts(
  db: KnowledgeDb,
  sourceId: number,
  excerpts: readonly Excerpt[],
  status: FileStatus,
  error: string | null,
) {
  const existing = db
    .prepare('select id, text_sha from excerpt where source_id = ? order by id')
    .all(sourceId) as { id: number; text_sha: string }[];
  const free = new Map<string, number[]>();
  for (const row of existing) free.set(row.text_sha, [...(free.get(row.text_sha) ?? []), row.id]);
  const keep = db.prepare('update excerpt set locator = ?, kind = ? where id = ?');
  const add = db.prepare(
    'insert into excerpt(source_id, locator, text, text_sha, kind) values(?, ?, ?, ?, ?)',
  );
  let added = 0;
  for (const e of excerpts) {
    const sha = textSha(e.text);
    const id = free.get(sha)?.shift();
    if (id !== undefined) keep.run(e.locator, e.kind, id);
    else {
      add.run(sourceId, e.locator, e.text, sha, e.kind);
      added++;
    }
  }
  removeExcerpts(db, [...free.values()].flat());
  db.prepare(
    'update source set extracted_sha = sha256, extract_error = ?, status = ? where id = ?',
  ).run(error, status, sourceId);
  return added;
}

function saveMail(db: KnowledgeDb, sourceId: number, mail: Mail) {
  db.prepare(
    `insert or replace into mail(source_id, message_id, in_reply_to, refs, thread, sent_at,
      from_addr, from_name, to_addrs, cc_addrs, subject) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sourceId,
    mail.messageId,
    mail.inReplyTo,
    mail.refs,
    mail.thread,
    mail.sentAt,
    mail.from.addr,
    mail.from.name,
    JSON.stringify(mail.to),
    JSON.stringify(mail.cc),
    mail.subject,
  );
  db.prepare('delete from attachment where mail_source_id = ?').run(sourceId);
  const add = db.prepare(
    'insert into attachment(mail_source_id, filename, ext, size, sha256) values(?, ?, ?, ?, ?)',
  );
  for (const a of mail.attachments)
    add.run(sourceId, a.filename, extname(a.filename).slice(1).toLowerCase(), a.size, a.sha256);
}

export interface SourceRow {
  id: number;
  rel_path: string;
  ext: string;
  kind: string;
  size: number;
  sha256: string;
}
/** Readable sources whose content changed since they were last read. */
export function changedSources(db: KnowledgeDb, kinds: readonly string[]) {
  return db
    .prepare(
      `select id, rel_path, ext, kind, size, sha256 from source
        where skip is null and sha256 is not null and kind in (${kinds.map(() => '?').join(',')})
        and (extracted_sha is null or extracted_sha <> sha256) order by id`,
    )
    .all(...kinds) as unknown as SourceRow[];
}

/** Saves a file's result in one transaction. */
export function saveResult(db: KnowledgeDb, row: SourceRow, result: Extracted) {
  return tx(db, () => {
    if (result.mail) saveMail(db, row.id, result.mail);
    return saveExcerpts(db, row.id, result.excerpts, result.status, result.error ?? null);
  });
}

/** The excerpt search index (an external-content FTS table) after excerpts changed. */
export const rebuildSearch = (db: KnowledgeDb) =>
  db.exec("insert into excerpt_fts(excerpt_fts) values('rebuild')");

/** Reads every changed document; `progress(done, total)` after each file. */
export async function extractDocuments(
  db: KnowledgeDb,
  root: string,
  progress: (done: number, total: number) => void,
  signal?: AbortSignal,
) {
  const todo = changedSources(db, ['mail', 'pdf', 'office', 'hwp', 'text', 'legacy']);
  const counts: Record<string, number> = {};
  let done = 0,
    excerpts = 0;
  progress(0, todo.length);
  const tally = (status: string) => (counts[status] = (counts[status] ?? 0) + 1);
  // Old Office formats and Outlook messages are recorded as not read.
  for (const row of todo.filter((r) => r.kind === 'legacy' || r.ext === 'msg')) {
    saveResult(db, row, { status: 'unsupported', excerpts: [] });
    tally('unsupported');
    progress(++done, todo.length);
  }
  const jobs = todo.filter((r) => r.kind !== 'legacy' && r.ext !== 'msg');
  try {
    await extractAll(
      jobs.map((row) => ({ path: join(root, row.rel_path), ext: row.ext, size: row.size })),
      (index, result) => {
        excerpts += saveResult(db, jobs[index], result);
        tally(result.status);
        progress(++done, todo.length);
      },
      { signal },
    );
  } finally {
    if (done) rebuildSearch(db);
  }
  return { files: todo.length, excerpts, counts };
}

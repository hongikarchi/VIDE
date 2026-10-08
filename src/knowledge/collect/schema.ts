// The project knowledge DB as the collector writes it (SPEC-08.9, ARCH-01 §3 「자료 정리」). The
// tables and columns are the knowledge-crawl spike's (tools/spikes/2026-09-29-knowledge-crawl/db.mjs
// and issues.mjs), so the 자료 tab (src/jigs/knowledge.ts) reads the result unchanged and a DB the
// spike built is updated in place. Added here: `source.status` (per-file extraction result),
// `agenda_proposal` (T-196), and for statements of removed files `statement.status = 'removed'`
// with `support_prob = -1` (the earlier value kept in `held_prob`), which every reader already
// leaves out.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
create table if not exists meta(key text primary key, value text);
create table if not exists run(id integer primary key, stage text, started text, ms integer,
  items integer, jev_calls integer default 0, jev_tokens integer default 0,
  llm_calls integer default 0, llm_in integer default 0, llm_out integer default 0, note text);
create table if not exists source(id integer primary key, rel_path text unique, ext text, size integer,
  mtime text, sha256 text, top text, kind text, skip text, group_key text, seen_run integer,
  extracted_sha text, extract_error text);
create table if not exists source_meta(source_id integer, key text, value text, method text,
  confidence real, primary key(source_id, key));
create table if not exists episode(id integer primary key, day text, counterpart text, rel_folder text unique);
create table if not exists excerpt(id integer primary key, source_id integer, locator text,
  text text, text_sha text, kind text);
create index if not exists excerpt_source on excerpt(source_id);
create index if not exists excerpt_sha on excerpt(text_sha);
create virtual table if not exists excerpt_fts using fts5(text, content='excerpt', content_rowid='id', tokenize='trigram');
create table if not exists mail(source_id integer primary key, message_id text, in_reply_to text, refs text,
  thread text, sent_at text, from_addr text, from_name text, to_addrs text, cc_addrs text, subject text);
create table if not exists attachment(id integer primary key, mail_source_id integer, filename text, ext text,
  size integer, sha256 text, matched_source_id integer, match_method text);
create table if not exists dwg_text(id integer primary key, source_id integer, layout text, block text,
  entity text, layer text, handle text, x real, y real, text text);
create index if not exists dwg_text_source on dwg_text(source_id);
create table if not exists selection(text_sha text primary key, excerpt_id integer, jev_label text, jev_prob real,
  jev_structural real, route text, llm_label text, final_label text, audit_label text);
create table if not exists statement(id integer primary key, excerpt_id integer, kind text, party text,
  subject text, content text, quote text, said_on text, structural integer, quote_ok integer,
  support_prob real, status text default 'ai');
create table if not exists statement_done(excerpt_id integer primary key);
create table if not exists party_alias(alias text primary key, party text, method text, confidence real);
create table if not exists issue(id integer primary key, discipline text, title text, status text,
  summary text, note text, statements integer);
create table if not exists statement_issue(statement_id integer primary key, issue_id integer, discipline text, raw_title text);
create table if not exists agenda_proposal(id integer primary key, key text, text text, kind text,
  date text, time text, end_date text, end_time text, location text, attendees text, evidence text,
  status text default 'pending', created text, decided text, agenda_id text);
create index if not exists agenda_proposal_key on agenda_proposal(key);
`;

export type KnowledgeDb = DatabaseSync;

/** Opens (creates) a project's knowledge DB for writing; older DBs get the added columns. */
export function openKnowledgeDb(path: string): KnowledgeDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000;');
  db.exec(SCHEMA);
  const columns = (table: string) =>
    new Set(
      (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );
  const source = columns('source');
  if (!source.has('status')) db.exec('alter table source add column status text');
  // T-261: excerpts past the per-file cap, and why a text was judged without AI.
  if (!source.has('excerpt_overflow'))
    db.exec('alter table source add column excerpt_overflow integer');
  // The .txt/.csv reader version a file was read with (filters.ts TEXT_READER_VERSION).
  if (!source.has('reader')) db.exec('alter table source add column reader integer');
  if (!columns('selection').has('reason')) db.exec('alter table selection add column reason text');
  const statement = columns('statement');
  if (!statement.has('status'))
    db.exec("alter table statement add column status text default 'ai'");
  if (!statement.has('held_prob')) db.exec('alter table statement add column held_prob real');
  return db;
}

export const tx = <T>(db: KnowledgeDb, fn: () => T): T => {
  db.exec('begin');
  try {
    const value = fn();
    db.exec('commit');
    return value;
  } catch (error) {
    db.exec('rollback');
    throw error;
  }
};

export const getMeta = (db: KnowledgeDb, key: string) =>
  (db.prepare('select value from meta where key = ?').get(key) as { value?: string } | undefined)
    ?.value ?? null;
export const setMeta = (db: KnowledgeDb, key: string, value: string) =>
  db.prepare('insert or replace into meta(key, value) values(?, ?)').run(key, value);

export interface StageUsage {
  items?: number;
  llmCalls?: number;
  llmIn?: number;
  llmOut?: number;
  note?: unknown;
}
/** One stage's time and AI usage in the `run` table (the spike's columns). */
export function logRun(db: KnowledgeDb, stage: string, started: number, usage: StageUsage = {}) {
  const ms = Math.round(performance.now() - started);
  db.prepare(
    `insert into run(stage, started, ms, items, llm_calls, llm_in, llm_out, note)
     values(?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stage,
    new Date().toISOString(),
    ms,
    usage.items ?? 0,
    usage.llmCalls ?? 0,
    usage.llmIn ?? 0,
    usage.llmOut ?? 0,
    usage.note === undefined ? null : JSON.stringify(usage.note),
  );
  return ms;
}

/** Statements shown and given to AI tools: the reader's rule (src/jigs/knowledge.ts VERIFIED). */
export const VISIBLE = 'st.quote_ok = 1 and coalesce(st.support_prob, 1) >= 0.5';

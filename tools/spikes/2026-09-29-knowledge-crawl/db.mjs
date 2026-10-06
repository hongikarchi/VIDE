// Spike schema for one project's knowledge DB (PLAN-08 K0). Product schema belongs to ARCH-01.
// The file lives outside the repository: %LOCALAPPDATA%\VIDE\projects\<projectId>\knowledge.sqlite
// (ADR-032), or %LOCALAPPDATA%\VIDE\knowledge\<projectId>.sqlite before the data folder is split.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const dataDir = () =>
  process.env.VIDE_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'VIDE');

export function knowledgePath(projectId) {
  if (!/^[0-9a-f-]{36}$/.test(projectId)) throw new Error('project id must be a UUID');
  return existsSync(join(dataDir(), 'app.sqlite'))
    ? join(dataDir(), 'projects', projectId, 'knowledge.sqlite')
    : join(dataDir(), 'knowledge', projectId + '.sqlite');
}

/** Resolve a VIDE project by id or exact name from the work engine DB (read-only). */
export function findProject(value) {
  const shared = join(dataDir(), 'app.sqlite');
  const db = new DatabaseSync(existsSync(shared) ? shared : join(dataDir(), 'vide.sqlite'), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare('select id, name from projects where id = ? or name = ?')
      .get(value, value);
    if (!row) throw new Error('VIDE project not found: ' + value);
    return row;
  } finally {
    db.close();
  }
}

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
`;

export function openKnowledge(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on;');
  db.exec(SCHEMA);
  return db;
}

/** Record one stage's timing and usage so the SPIKE can compare Jev against the LLM. */
export function logRun(db, stage, started, fields = {}) {
  const ms = Math.round(performance.now() - started);
  db.prepare(
    `insert into run(stage, started, ms, items, jev_calls, jev_tokens, llm_calls, llm_in, llm_out, note)
     values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stage,
    new Date().toISOString(),
    ms,
    fields.items ?? 0,
    fields.jevCalls ?? 0,
    fields.jevTokens ?? 0,
    fields.llmCalls ?? 0,
    fields.llmIn ?? 0,
    fields.llmOut ?? 0,
    fields.note ?? null,
  );
  return ms;
}

export const tx = (db, fn) => {
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

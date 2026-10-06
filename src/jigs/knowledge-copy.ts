// The project knowledge DB shared through the account site (ADR-037 3, ARCH-01 「팀 공유 프로젝트
// 층」). The PC that crawled reads its DB as rows of the shared tables (`packRows`); another PC
// writes the rows it received into a knowledge DB of the same columns (`writeKnowledgeCopy`), so
// the 자료 workspace and the AI's knowledge tools read it unchanged. Source documents never leave
// the PC that has them: only statements, the excerpts they cite and the sources' paths go.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  KNOWLEDGE_EXCERPT_MAX,
  KNOWLEDGE_TABLES,
  KNOWLEDGE_TABLE_NAMES,
  type KnowledgeRow,
  type KnowledgeTableName,
} from '../contracts/knowledge-pack.ts';

/** The meta key a received copy carries: the site's revision it holds. */
export const COPY_KEY = 'vide_copy';
/** The meta key with the crawl's counts (files, mails, excerpts) a copy cannot recount. */
export const COUNTS_KEY = 'vide_counts';

const hasTable = (db: DatabaseSync, name: string) =>
  !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name);
const columnsOf = (db: DatabaseSync, name: string) =>
  new Set(
    (db.prepare(`pragma table_info(${name})`).all() as { name: string }[]).map((row) => row.name),
  );

/** Whether the knowledge DB at `file` is a copy received from the site (and of which revision). */
export function copyRevision(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!hasTable(db, 'meta')) return undefined;
    const row = db.prepare('select value from meta where key = ?').get(COPY_KEY) as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : undefined;
  } finally {
    db.close();
  }
}
/** Size and change time of the DB and its WAL: a crawl that wrote anything changes it. */
export function knowledgeFingerprint(file: string) {
  const part = (path: string) => {
    try {
      const stat = statSync(path);
      return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    } catch {
      return '-';
    }
  };
  return `${part(file)}|${part(file + '-wal')}`;
}

export interface KnowledgePack {
  builtAt: string | null;
  counts: { files: number; mails: number; excerpts: number };
  tables: Record<KnowledgeTableName, KnowledgeRow[]>;
}
/**
 * The shared rows of a crawler DB: every statement, the excerpts they cite (text cut to
 * {@link KNOWLEDGE_EXCERPT_MAX}), those excerpts' sources (path only), issues, briefs, aliases and
 * the meta rows. Tables or columns the DB lacks are left out (older crawls).
 */
export function packRows(file: string): KnowledgePack {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    const tables = {} as Record<KnowledgeTableName, KnowledgeRow[]>;
    for (const name of KNOWLEDGE_TABLE_NAMES) {
      if (!hasTable(db, name)) {
        tables[name] = [];
        continue;
      }
      const present = columnsOf(db, name);
      const columns = KNOWLEDGE_TABLES[name].columns.filter((column) => present.has(column));
      const filter =
        name === 'excerpt' && hasTable(db, 'statement')
          ? ' where id in (select excerpt_id from statement)'
          : name === 'source' && hasTable(db, 'excerpt') && hasTable(db, 'statement')
            ? ' where id in (select source_id from excerpt where id in (select excerpt_id from statement))'
            : name === 'meta'
              ? ` where key not in ('${COPY_KEY}', '${COUNTS_KEY}')`
              : '';
      const rows = db
        .prepare(`select ${columns.join(', ')} from ${name}${filter}`)
        .all() as KnowledgeRow[];
      tables[name] = rows.map((row) => {
        const copy: KnowledgeRow = {};
        for (const column of columns) {
          const value = row[column];
          copy[column] =
            typeof value === 'bigint'
              ? Number(value)
              : name === 'excerpt' && column === 'text' && typeof value === 'string'
                ? value.slice(0, KNOWLEDGE_EXCERPT_MAX)
                : (value ?? null);
        }
        return copy;
      });
    }
    const builtAt = hasTable(db, 'run')
      ? ((db.prepare('select max(started) as at from run').get() as { at: string | null }).at ??
        null)
      : null;
    return {
      builtAt,
      counts: {
        files: hasTable(db, 'source')
          ? count(
              columnsOf(db, 'source').has('skip')
                ? 'select count(*) as n from source where skip is null'
                : 'select count(*) as n from source',
            )
          : 0,
        mails: hasTable(db, 'mail') ? count('select count(*) as n from mail') : 0,
        excerpts: hasTable(db, 'excerpt') ? count('select count(*) as n from excerpt') : 0,
      },
      tables,
    };
  } finally {
    db.close();
  }
}

const SCHEMA = `
  create table meta(key text primary key, value text);
  create table run(id integer primary key, stage text, started text);
  create table source(id integer primary key, rel_path text, skip text);
  create table excerpt(id integer primary key, source_id integer, locator text, text text);
  create table mail(source_id integer primary key);
  create table statement(id integer primary key, excerpt_id integer, kind text, party text,
    subject text, content text, said_on text, quote text, quote_ok integer, support_prob real);
  create table party_alias(alias text primary key, party text);
  create table issue(id integer primary key, discipline text, title text, status text,
    summary text, statements integer, note text);
  create table statement_issue(statement_id integer primary key, issue_id integer, discipline text);
  create table brief(scope text primary key, body text);
  create virtual table excerpt_fts using fts5(text, content='excerpt', content_rowid='id', tokenize='trigram');`;

/**
 * Writes the rows received from the site as the project's knowledge DB at `file`, replacing an
 * older copy. Never called over a crawler's own DB (the caller checks {@link copyRevision}).
 */
export function writeKnowledgeCopy(
  file: string,
  revision: number,
  pack: { builtAt: string | null; counts: Record<string, number> },
  tables: Partial<Record<KnowledgeTableName, KnowledgeRow[]>>,
) {
  const temporary = `${file}.copy`;
  mkdirSync(dirname(file), { recursive: true });
  rmSync(temporary, { force: true });
  const db = new DatabaseSync(temporary);
  try {
    db.exec(SCHEMA);
    db.exec('begin');
    for (const name of KNOWLEDGE_TABLE_NAMES) {
      const columns = KNOWLEDGE_TABLES[name].columns;
      const insert = db.prepare(
        `insert or replace into ${name}(${columns.join(', ')}) values(${columns.map(() => '?').join(', ')})`,
      );
      for (const row of tables[name] ?? [])
        insert.run(...columns.map((column) => row[column] ?? null));
    }
    const meta = db.prepare('insert or replace into meta(key, value) values(?, ?)');
    meta.run(COPY_KEY, String(revision));
    meta.run(COUNTS_KEY, JSON.stringify(pack.counts));
    db.prepare("insert into run(stage, started) values('copy', ?)").run(pack.builtAt);
    db.exec("insert into excerpt_fts(excerpt_fts) values('rebuild')");
    db.exec('commit');
  } catch (error) {
    db.close();
    rmSync(temporary, { force: true });
    throw error;
  }
  db.close();
  for (const end of ['-wal', '-shm']) rmSync(file + end, { force: true });
  renameSync(temporary, file);
}

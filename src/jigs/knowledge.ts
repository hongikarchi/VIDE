// Project knowledge jig (trial): read-only views over a project's knowledge DB — issue notes by
// discipline, statement search and the evidence behind each statement. The DB is built outside the
// app for now (tools/spikes/2026-09-29-knowledge-crawl, PLAN-08 K0); one file per project at
// <data>/knowledge/<projectId>.sqlite. Originals stay on the company server; only paths are stored.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { DomainError } from '../contracts/errors.ts';

export const DISCIPLINES: Record<string, string> = {
  structure: '구조',
  civil: '토목·유수지',
  landscape: '조경',
  facade: '파사드·외장',
  mep: '조명·전기·설비',
  fire: '소방·피난·안전',
  permit: '인허가·심의·법규',
  design: '건축 계획·디자인',
  cost: '공사비·계약·업무 범위',
  schedule: '일정·진행',
  other: '기타',
};

export function knowledgeFile(dataDirectory: string, projectId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new DomainError('INVALID_INPUT');
  return join(dataDirectory, 'knowledge', projectId + '.sqlite');
}

function open(file: string) {
  if (!existsSync(file)) throw new DomainError('NOT_FOUND');
  return new DatabaseSync(file, { readOnly: true });
}
function read<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = open(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const hasTable = (db: DatabaseSync, name: string) =>
  !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name);
const meta = (db: DatabaseSync, key: string) =>
  (db.prepare('select value from meta where key = ?').get(key) as { value?: string } | undefined)
    ?.value ?? null;
const count = (db: DatabaseSync, sql: string) => Number((db.prepare(sql).get() as { n: number }).n);

export interface KnowledgeStatement {
  id: number;
  kind: string;
  party: string;
  subject: string;
  content: string;
  saidOn: string | null;
  quote: string;
  sourceId: number;
  path: string;
  locator: string;
}
const STATEMENT = `select st.id, st.kind, coalesce(a.party, st.party) as party, st.subject, st.content,
  st.said_on as saidOn, st.quote, s.id as sourceId, s.rel_path as path, e.locator
  from statement st join excerpt e on e.id = st.excerpt_id join source s on s.id = e.source_id
  left join party_alias a on a.alias = st.party`;
const VERIFIED = 'st.quote_ok = 1 and coalesce(st.support_prob, 1) >= 0.5';

/** What the DB holds and the issue list per discipline. `available: false` when no DB exists. */
export function knowledgeSummary(file: string) {
  if (!existsSync(file)) return { available: false as const };
  return read(file, (db) => {
    const issues = hasTable(db, 'issue')
      ? (db
          .prepare(
            'select id, discipline, title, status, summary, statements, note from issue order by statements desc',
          )
          .all() as {
          id: number;
          discipline: string;
          title: string;
          status: string;
          summary: string;
          statements: number;
          note: string;
        }[])
      : [];
    const disciplines = Object.entries(DISCIPLINES)
      .map(([key, label]) => ({
        key,
        label,
        issues: issues
          .filter((i) => i.discipline === key)
          .map(({ note, ...issue }) => ({
            ...issue,
            open: (JSON.parse(note).open ?? []).length as number,
          })),
      }))
      .filter((d) => d.issues.length);
    const last = db.prepare('select max(started) as at from run').get() as { at: string | null };
    return {
      available: true as const,
      builtAt: last.at,
      sizeBytes: statSync(file).size,
      counts: {
        files: count(db, 'select count(*) as n from source where skip is null'),
        excerpts: count(db, 'select count(*) as n from excerpt'),
        statements: count(db, `select count(*) as n from statement st where ${VERIFIED}`),
        issues: issues.length,
        mails: count(db, 'select count(*) as n from mail'),
      },
      disciplines,
    };
  });
}

/** One issue note with the statements it cites and all member statements. */
export function knowledgeIssue(file: string, issueId: number) {
  return read(file, (db) => {
    const row = db
      .prepare('select id, discipline, title, status, summary, note from issue where id = ?')
      .get(issueId) as
      | {
          id: number;
          discipline: string;
          title: string;
          status: string;
          summary: string;
          note: string;
        }
      | undefined;
    if (!row) throw new DomainError('NOT_FOUND');
    const statements = db
      .prepare(
        `${STATEMENT} join statement_issue si on si.statement_id = st.id where si.issue_id = ? and ${VERIFIED}
         order by coalesce(st.said_on, '9999'), st.id`,
      )
      .all(issueId) as unknown as KnowledgeStatement[];
    return {
      ...row,
      label: DISCIPLINES[row.discipline] ?? row.discipline,
      note: JSON.parse(row.note),
      statements,
    };
  });
}

/** Statements matching words in content, subject, party or the excerpt text; optional filters. */
export function knowledgeSearch(
  file: string,
  query: string,
  { kind, discipline, limit = 100 }: { kind?: string; discipline?: string; limit?: number } = {},
) {
  const words = query.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  return read(file, (db) => {
    const where = [VERIFIED];
    const params: (string | number)[] = [];
    for (const word of words) {
      const like = `%${word.replace(/[%_]/g, '')}%`;
      where.push(
        `(st.content like ? or st.subject like ? or st.party like ? or e.text like ? or s.rel_path like ?)`,
      );
      params.push(like, like, like, like, like);
    }
    if (kind) (where.push('st.kind = ?'), params.push(kind));
    if (discipline && hasTable(db, 'statement_issue'))
      (where.push('st.id in (select statement_id from statement_issue where discipline = ?)'),
        params.push(discipline));
    // Statements whose own text names the words come before those matched only through the excerpt.
    const direct = words.map(() => '(st.content like ? or st.subject like ?)').join(' and ') || '1';
    for (const word of words) {
      const like = `%${word.replace(/[%_]/g, '')}%`;
      params.push(like, like);
    }
    params.push(Math.min(Math.max(limit, 1), 300));
    return db
      .prepare(
        `${STATEMENT} where ${where.join(' and ')}
         order by case when ${direct} then 0 else 1 end, coalesce(st.said_on, '0000') desc, st.id limit ?`,
      )
      .all(...params) as unknown as KnowledgeStatement[];
  });
}

/** The full excerpt behind a statement (the evidence), with its file path and location. */
export function knowledgeEvidence(file: string, statementId: number) {
  return read(file, (db) => {
    const row = db
      .prepare(
        `select st.id, st.content, st.quote, e.text, e.locator, s.id as sourceId, s.rel_path as path
         from statement st join excerpt e on e.id = st.excerpt_id join source s on s.id = e.source_id where st.id = ?`,
      )
      .get(statementId);
    if (!row) throw new DomainError('NOT_FOUND');
    return { ...row, root: meta(db, 'root') };
  });
}

/** Open an original file (company server) with the default program. Only paths recorded in the DB. */
export function openKnowledgeSource(
  file: string,
  sourceId: number,
  launch: (path: string) => void = (path) =>
    spawn('explorer.exe', [path], { detached: true, stdio: 'ignore', windowsHide: false }).unref(),
) {
  const target = read(file, (db) => {
    const root = meta(db, 'root');
    const row = db.prepare('select rel_path from source where id = ?').get(sourceId) as
      | { rel_path: string }
      | undefined;
    if (!root || !row) throw new DomainError('NOT_FOUND');
    const base = resolve(root);
    const path = resolve(base, row.rel_path);
    if (!path.startsWith(base + sep)) throw new DomainError('INVALID_INPUT');
    return path;
  });
  if (!existsSync(target)) throw new DomainError('SOURCE_UNAVAILABLE');
  launch(target);
  return { opened: true };
}

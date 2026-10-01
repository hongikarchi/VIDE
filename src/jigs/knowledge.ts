// Project knowledge jig (trial): read-only views over a project's knowledge DB — issue notes by
// discipline, statement search and the evidence behind each statement. The DB is built outside the
// app for now (tools/spikes/2026-09-29-knowledge-crawl, PLAN-08 K0); one file per project at
// <data>/knowledge/<projectId>.sqlite. Originals stay on the company server; only paths are stored.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { DomainError } from '../contracts/errors.ts';
import {
  verdicts,
  type KnowledgeReview,
  type KnowledgeReviewStore,
} from '../core/knowledge-review-store.ts';

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
    // Status brief (PLAN-08 K0-T2): decided, blocked and recently changed, for the project and each
    // discipline. Older DBs without it show the issue list only.
    const briefs = hasTable(db, 'brief')
      ? Object.fromEntries(
          (
            db.prepare('select scope, body from brief').all() as { scope: string; body: string }[]
          ).map((row) => [row.scope, JSON.parse(row.body)]),
        )
      : {};
    const disciplines = Object.entries(DISCIPLINES)
      .map(([key, label]) => ({
        key,
        label,
        brief: briefs[key] ?? null,
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
      brief: briefs.project ?? null,
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

/** Filters of a statement search; `ids` limits it to those statements (review filters). */
interface SearchFilter {
  kind?: string;
  discipline?: string;
  ids?: number[];
}
export interface SearchPlan {
  /** Whether the DB has the trigram excerpt index. */
  fts: boolean;
  /** How each word is found: the excerpt index (3+ characters) or substring matching. */
  words: { word: string; via: 'fts' | 'like' }[];
}
/** Search words: up to 5, LIKE wildcards and FTS quotes removed. */
const searchWords = (query: string) =>
  query
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[%_"]/g, ''))
    .filter(Boolean)
    .slice(0, 5);
const ftsPhrase = (word: string) => `"${word}"`;
/**
 * Candidate statements for words (SPEC-08.3): every word must match. Words of 3+ characters use the
 * trigram `excerpt_fts` for the excerpt text (the costly part); shorter words, and DBs without the
 * index, use LIKE. Statements naming the words themselves come first, then excerpt rank, newest.
 */
function candidates(db: DatabaseSync, words: string[], filter: SearchFilter, cap: number) {
  const fts = hasTable(db, 'excerpt_fts');
  const plan: SearchPlan = {
    fts,
    words: words.map((word) => ({ word, via: fts && [...word].length >= 3 ? 'fts' : 'like' })),
  };
  const where = [VERIFIED];
  const params: (string | number)[] = [];
  for (const { word, via } of plan.words) {
    const like = `%${word}%`;
    if (via === 'fts') {
      where.push(
        `(st.content like ? or st.subject like ? or st.party like ? or s.rel_path like ?
          or e.id in (select rowid from excerpt_fts where excerpt_fts match ?))`,
      );
      params.push(like, like, like, like, ftsPhrase(word));
    } else {
      where.push(
        `(st.content like ? or st.subject like ? or st.party like ? or e.text like ? or s.rel_path like ?)`,
      );
      params.push(like, like, like, like, like);
    }
  }
  if (filter.kind) (where.push('st.kind = ?'), params.push(filter.kind));
  if (filter.discipline && hasTable(db, 'statement_issue'))
    (where.push('st.id in (select statement_id from statement_issue where discipline = ?)'),
      params.push(filter.discipline));
  if (filter.ids)
    (where.push('st.id in (select value from json_each(?))'),
      params.push(JSON.stringify(filter.ids)));
  const ranked = plan.words.filter((w) => w.via === 'fts').map((w) => ftsPhrase(w.word));
  const rankJoin = ranked.length
    ? `left join (select rowid as xid, bm25(excerpt_fts) as score from excerpt_fts
         where excerpt_fts match ?) r on r.xid = e.id`
    : '';
  const direct = words.map(() => '(st.content like ? or st.subject like ?)').join(' and ') || '1';
  const head: (string | number)[] = ranked.length ? [ranked.join(' OR ')] : [];
  const order: string[] = [];
  for (const word of words) order.push(`%${word}%`, `%${word}%`);
  const sql = `${STATEMENT} ${rankJoin} where ${where.join(' and ')}
    order by case when ${direct} then 0 else 1 end, ${ranked.length ? 'coalesce(r.score, 0),' : ''}
    coalesce(st.said_on, '0000') desc, st.id limit ?`;
  const rows = db
    .prepare(sql)
    .all(...head, ...params, ...order, cap) as unknown as KnowledgeStatement[];
  return { rows: rows.map((row) => ({ ...row })), plan };
}

/** Statements matching words in content, subject, party or the excerpt text; optional filters. */
export function knowledgeSearch(
  file: string,
  query: string,
  { kind, discipline, limit = 100 }: { kind?: string; discipline?: string; limit?: number } = {},
) {
  return read(
    file,
    (db) =>
      candidates(db, searchWords(query), { kind, discipline }, Math.min(Math.max(limit, 1), 300))
        .rows,
  );
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
    // A start that fails emits 'error'; unheard, it would end the engine.
    spawn('explorer.exe', [path], { detached: true, stdio: 'ignore', windowsHide: false })
      .on('error', () => {})
      .unref(),
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

// --- project facts: the VIDE-side review layer over the crawler DB (SPEC-08, PLAN-22 T-065) -------
// Verdicts and source rules live in the workspace DB (knowledge-review-store); the crawler DB is only
// read. Rejected, contaminated and excluded-source statements leave search, tools and basis lookup.

type ReviewSource = Pick<KnowledgeReviewStore, 'reviews' | 'sourceRules'>;
export type FactState =
  | 'confirmed'
  | 'unconfirmed'
  | 'superseded'
  | 'rejected'
  | 'contaminated'
  | 'excluded-source';
export interface FactRule {
  pattern: string;
  reason: string | null;
}
export interface FactLayer {
  reviews: Map<number, KnowledgeReview>;
  rules: (FactRule & { test: (path: string) => boolean })[];
}
export interface FactStatement extends KnowledgeStatement {
  ref: string;
  state: FactState;
  excluded: boolean;
  reason: string | null;
  review: Omit<KnowledgeReview, 'projectId' | 'statementId'> | null;
  /** The crawler's party when a person corrected who said it. */
  originalParty?: string;
}
const EXCLUDED = new Set<FactState>(['rejected', 'contaminated', 'excluded-source']);
const normalPath = (path: string) => path.replace(/\\/g, '/').toLowerCase();
/** A source rule: an exact path, or `*` for any characters (`docs/other/*`). Case-insensitive. */
export function sourceRuleTest(pattern: string) {
  const source = normalPath(pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const rule = new RegExp(`^${source}$`);
  return (path: string) => rule.test(normalPath(path));
}
/** The review layer of one project: its verdicts and source rules. */
export function reviewLayer(store: ReviewSource, projectId: string): FactLayer {
  return {
    reviews: new Map(store.reviews(projectId).map((review) => [review.statementId, review])),
    rules: store
      .sourceRules(projectId)
      .map((rule) => ({ ...rule, test: sourceRuleTest(rule.pattern) })),
  };
}
/**
 * The state of one statement (SPEC-08.5): a person's verdict first; a confirmed or corrected
 * statement stays in even under a source rule; otherwise a matching rule excludes it.
 */
export function factOf(row: KnowledgeStatement, layer: FactLayer): FactStatement {
  const found = layer.reviews.get(row.id);
  const review = found
    ? {
        verdict: found.verdict,
        correction: found.correction,
        supersededBy: found.supersededBy,
        reason: found.reason,
        by: found.by,
        at: found.at,
      }
    : null;
  let state: FactState = 'unconfirmed';
  let reason = review?.reason ?? null;
  if (review?.verdict === 'confirmed' || review?.verdict === 'corrected') state = 'confirmed';
  else if (review?.verdict === 'rejected' || review?.verdict === 'contaminated')
    state = review.verdict;
  else {
    if (review?.verdict === 'superseded') state = 'superseded';
    const rule = layer.rules.find((candidate) => candidate.test(row.path));
    if (rule) {
      state = 'excluded-source';
      reason = rule.reason ?? rule.pattern;
    }
  }
  const correction = review?.verdict === 'corrected' ? review.correction : null;
  return {
    ...row,
    ...(correction ? { party: correction, originalParty: row.party } : {}),
    ref: `S${row.id}`,
    state,
    excluded: EXCLUDED.has(state),
    reason,
    review,
  };
}
function reviewCounts(layer: FactLayer) {
  const counts: Record<string, number> = Object.fromEntries(verdicts.map((v) => [v, 0]));
  for (const review of layer.reviews.values()) counts[review.verdict]++;
  return { ...counts, rules: layer.rules.length };
}

/** The status report of the facts workspace: knowledge summary plus this project's review counts. */
export function factBrief(file: string, layer: FactLayer) {
  const summary = knowledgeSummary(file);
  return summary.available ? { ...summary, reviews: reviewCounts(layer) } : summary;
}

export type FactStatus = 'confirmed' | 'unconfirmed' | 'excluded';
const SEARCH_CAP = 1000;
/**
 * Statement search with the review layer (SPEC-08.3): confirmed first, excluded statements left out
 * and only counted, unless people ask for them (`excluded`, never tools).
 */
export function factSearch(
  file: string,
  layer: FactLayer,
  query: string,
  {
    kind,
    discipline,
    status,
    excluded = false,
    offset = 0,
    limit = 50,
  }: {
    kind?: string;
    discipline?: string;
    status?: FactStatus;
    excluded?: boolean;
    offset?: number;
    limit?: number;
  } = {},
) {
  const ids =
    status === 'confirmed'
      ? [...layer.reviews.values()]
          .filter((r) => r.verdict === 'confirmed' || r.verdict === 'corrected')
          .map((r) => r.statementId)
      : undefined;
  const found = read(file, (db) =>
    candidates(db, searchWords(query), { kind, discipline, ids }, SEARCH_CAP),
  );
  const all = found.rows.map((row) => factOf(row, layer));
  const hidden = all.filter((row) => row.excluded);
  let rows = status === 'excluded' ? hidden : excluded ? all : all.filter((row) => !row.excluded);
  if (status === 'confirmed') rows = rows.filter((row) => row.state === 'confirmed');
  if (status === 'unconfirmed') rows = rows.filter((row) => row.state !== 'confirmed');
  // Stable sort: confirmed statements first; the SQL order stays within each group.
  rows = [...rows].sort(
    (a, b) => Number(b.state === 'confirmed') - Number(a.state === 'confirmed'),
  );
  const start = Math.max(0, Math.trunc(offset));
  const size = Math.min(Math.max(Math.trunc(limit), 1), 300);
  const items = rows.slice(start, start + size);
  const next = start + items.length;
  return {
    items,
    total: rows.length,
    offset: start,
    nextOffset: next < rows.length ? next : null,
    excluded: hidden.length,
    capped: found.rows.length >= SEARCH_CAP,
    plan: found.plan,
  };
}

/** An issue note with its statements under the review layer; excluded ones are only counted. */
export function factIssue(file: string, layer: FactLayer, issueId: number) {
  const issue = knowledgeIssue(file, issueId);
  const statements = issue.statements.map((row) => factOf({ ...row }, layer));
  return {
    ...issue,
    statements: statements.filter((row) => !row.excluded),
    excluded: statements.filter((row) => row.excluded).length,
  };
}

function statementRow(db: DatabaseSync, statementId: number) {
  const row = db.prepare(`${STATEMENT} where st.id = ?`).get(statementId);
  return row ? ({ ...row } as unknown as KnowledgeStatement) : undefined;
}
/**
 * The fact window (SPEC-08.4): statement, review state and the full excerpt. `people: false` (tools)
 * refuses excluded statements with FACT_EXCLUDED instead of returning their content.
 */
export function factStatement(
  file: string,
  layer: FactLayer,
  statementId: number,
  { people = true }: { people?: boolean } = {},
) {
  return read(file, (db) => {
    const row = statementRow(db, statementId);
    if (!row) throw new DomainError('NOT_FOUND');
    const fact = factOf(row, layer);
    if (!people && fact.excluded) throw new DomainError('FACT_EXCLUDED');
    const excerpt = db
      .prepare(
        'select e.text from statement st join excerpt e on e.id = st.excerpt_id where st.id = ?',
      )
      .get(statementId) as { text: string };
    const issue = hasTable(db, 'statement_issue')
      ? (db
          .prepare('select issue_id as id, discipline from statement_issue where statement_id = ?')
          .get(statementId) as { id: number; discipline: string } | undefined)
      : undefined;
    return {
      ...fact,
      text: excerpt.text,
      issue: issue ? { id: issue.id, discipline: issue.discipline } : null,
      root: meta(db, 'root'),
    };
  });
}

/**
 * Statement ids a setting's basis points at: `statementId`, or factRefs `S12` / `12` (also
 * `statement:12`, the same forms the basis chip opens, src/ui/jig-panel/registry.ts).
 */
export function factRefIds(basis: unknown): number[] {
  if (!basis || typeof basis !== 'object') return [];
  const value = basis as { statementId?: unknown; factRefs?: unknown };
  const ids: number[] = [];
  if (Number.isSafeInteger(value.statementId) && (value.statementId as number) >= 0)
    ids.push(value.statementId as number);
  if (Array.isArray(value.factRefs))
    for (const ref of value.factRefs) {
      const match = /^(?:statement|stmt|fact|진술|s)?[:#\s]*(\d{1,12})$/i.exec(String(ref).trim());
      if (match) ids.push(Number(match[1]));
    }
  return [...new Set(ids)];
}
export type FactValidity = 'ok' | 'warn' | 'block';
/** SPEC-08.6 validity of basis statements: confirmed ok, unconfirmed/superseded warn, else block. */
export function factValidity(file: string, layer: FactLayer, ids: number[]) {
  const rows = read(file, (db) => ids.map((id) => [id, statementRow(db, id)] as const));
  return rows.map(([id, row]) => {
    if (!row)
      return {
        ref: `S${id}`,
        statementId: id,
        state: 'missing' as const,
        validity: 'block' as FactValidity,
        content: null,
        reason: null,
      };
    const fact = factOf(row, layer);
    const validity: FactValidity =
      fact.state === 'confirmed' ? 'ok' : fact.excluded ? 'block' : 'warn';
    return {
      ref: fact.ref,
      statementId: id,
      state: fact.state,
      validity,
      content: fact.excluded ? null : fact.content,
      reason: fact.reason,
    };
  });
}

// Numbers in a statement, with a length unit and a bound word when present.
const LENGTH: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1 };
const lengthOf = (unit: string | null | undefined) =>
  unit ? LENGTH[unit.replace('㎜', 'mm').replace('㎝', 'cm').toLowerCase()] : undefined;
export interface FactNumber {
  value: number;
  unit: string | null;
  bound: 'max' | 'min' | 'lt' | 'gt' | null;
  text: string;
}
const BOUNDS: Record<string, FactNumber['bound']> = {
  이하: 'max',
  미만: 'lt',
  이상: 'min',
  초과: 'gt',
};
/** Numbers of a sentence: `13m 이하`, `900`, `12,000mm`, `2.5 kN/㎡ 이상`. */
export function factNumbers(text: string): FactNumber[] {
  const out: FactNumber[] = [];
  const pattern =
    /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(kN\/㎡|kN\/m2|kN\/m²|kN|MPa|mm|cm|m|㎜|㎝|%)?(?![a-zA-Z])\s*(이하|미만|이상|초과)?/g;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    out.push({
      value,
      unit: match[2] ?? null,
      bound: match[3] ? BOUNDS[match[3]] : null,
      text: match[0].trim(),
    });
  }
  return out;
}
export type CheckVerdict = 'match' | 'conflict' | 'no-number' | 'no-basis' | 'invalid-basis';
export interface CheckSetting {
  key: string;
  title?: string;
  value: number | string | boolean;
  unit?: string;
  basis?: unknown;
}
/** One number against a setting value in the setting's unit; undefined when not comparable. */
function compare(number: FactNumber, value: number, unit: string | undefined) {
  let n = number.value;
  if (number.unit) {
    const from = lengthOf(number.unit);
    const to = lengthOf(unit);
    if (from && to) n = (n * from) / to;
    else if (number.unit !== (unit ?? '')) return undefined;
  }
  const near = Math.abs(n - value) <= Math.max(1e-9, Math.abs(value) * 1e-3);
  switch (number.bound) {
    case 'max':
      return value <= n || near;
    case 'lt':
      return value < n;
    case 'min':
      return value >= n || near;
    case 'gt':
      return value > n;
    default:
      return near;
  }
}
/**
 * project_checks (SPEC-08.6): each setting against the numbers of its basis statements. The code
 * compares; the AI only quotes the verdicts.
 */
export function factChecks(file: string, layer: FactLayer, settings: CheckSetting[]) {
  const ids = [...new Set(settings.flatMap((setting) => factRefIds(setting.basis)))];
  const facts = new Map(
    read(file, (db) => ids.map((id) => [id, statementRow(db, id)] as const)).map(([id, row]) => [
      id,
      row ? factOf(row, layer) : null,
    ]),
  );
  return settings.map((setting) => {
    const refs = factRefIds(setting.basis);
    const head = {
      key: setting.key,
      ...(setting.title ? { title: setting.title } : {}),
      value: setting.value,
      unit: setting.unit ?? '',
      refs: refs.map((id) => `S${id}`),
    };
    if (!refs.length) return { ...head, verdict: 'no-basis' as CheckVerdict };
    const basis = refs.map((id) => facts.get(id) ?? null);
    const valid = basis.filter((fact): fact is FactStatement => !!fact && !fact.excluded);
    if (valid.length !== basis.length) return { ...head, verdict: 'invalid-basis' as CheckVerdict };
    const states = valid.map((fact) => fact.state);
    const value = setting.value;
    if (typeof value !== 'number') return { ...head, verdict: 'no-number' as CheckVerdict, states };
    const compared = valid
      .flatMap((fact) =>
        factNumbers(`${fact.content} ${fact.quote ?? ''}`).map((number) => ({
          ref: fact.ref,
          number,
          ok: compare(number, value, setting.unit),
        })),
      )
      .filter((entry) => entry.ok !== undefined);
    const verdict: CheckVerdict = !compared.length
      ? 'no-number'
      : compared.some((entry) => entry.ok)
        ? 'match'
        : 'conflict';
    return {
      ...head,
      verdict,
      states,
      numbers: compared
        .slice(0, 6)
        .map((entry) => ({ ref: entry.ref, text: entry.number.text, ok: !!entry.ok })),
    };
  });
}

/** Only people review (SPEC-08.5): an AI or agent author is refused. */
function personOnly(by: string) {
  if (/^(ai|agent|claude|codex|gemini|jev)\b/i.test(by.trim())) throw new DomainError('FORBIDDEN');
}
export interface ReviewInput {
  verdict: KnowledgeReview['verdict'];
  reason?: string | null;
  correction?: string | null;
  supersededBy?: number | null;
}
/** Record a person's verdict on a statement that exists in the project's crawler DB. */
export function recordFactReview(
  store: Pick<KnowledgeReviewStore, 'setReview'>,
  file: string,
  projectId: string,
  statementId: number,
  input: ReviewInput,
  by: string,
) {
  personOnly(by);
  if (!verdicts.includes(input.verdict)) throw new DomainError('INVALID_INPUT');
  const reason = input.reason?.trim() || null;
  const correction = input.correction?.trim() || null;
  const supersededBy = input.supersededBy ?? null;
  if (input.verdict === 'contaminated' && !reason) throw new DomainError('INVALID_INPUT');
  if (input.verdict === 'corrected' && !correction) throw new DomainError('INVALID_INPUT');
  if (input.verdict === 'superseded' && !Number.isInteger(supersededBy))
    throw new DomainError('INVALID_INPUT');
  read(file, (db) => {
    if (!statementRow(db, statementId)) throw new DomainError('NOT_FOUND');
    if (input.verdict === 'superseded' && !statementRow(db, supersededBy!))
      throw new DomainError('NOT_FOUND');
  });
  return store.setReview(projectId, statementId, {
    verdict: input.verdict,
    reason,
    correction: input.verdict === 'corrected' ? correction : null,
    supersededBy: input.verdict === 'superseded' ? supersededBy : null,
    by,
  });
}
/** Exclude a source (contamination by file): its recorded path, or a `*` pattern. */
export function excludeFactSource(
  store: Pick<KnowledgeReviewStore, 'addSourceRule' | 'sourceRules'>,
  file: string,
  projectId: string,
  target: { sourceId?: number; pattern?: string },
  reason: string | null,
  by: string,
) {
  personOnly(by);
  let pattern = target.pattern?.trim();
  if (target.sourceId !== undefined) {
    const sourceId = target.sourceId;
    pattern = read(file, (db) => {
      const row = db.prepare('select rel_path from source where id = ?').get(sourceId) as
        | { rel_path: string }
        | undefined;
      if (!row) throw new DomainError('NOT_FOUND');
      return row.rel_path;
    });
  }
  if (!pattern) throw new DomainError('INVALID_INPUT');
  store.addSourceRule(projectId, pattern, reason?.trim() || null);
  return store.sourceRules(projectId);
}

/**
 * The citation gate (SPEC-08.7): `[S12]` citations of an answer must be statements a tool returned
 * this turn and not excluded. Unknown and excluded ones are reported for the UI to mark.
 */
export function citationGate(text: string, returned: ReadonlyMap<number, FactState>) {
  const cited = [...new Set([...text.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])))];
  const unknown = cited.filter((id) => !returned.has(id));
  const excluded = cited.filter((id) => {
    const state = returned.get(id);
    return state !== undefined && EXCLUDED.has(state);
  });
  const unconfirmed = cited.filter((id) => {
    const state = returned.get(id);
    return state === 'unconfirmed' || state === 'superseded';
  });
  return { ok: !unknown.length && !excluded.length, cited, unknown, excluded, unconfirmed };
}

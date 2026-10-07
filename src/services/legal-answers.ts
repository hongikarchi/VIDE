import { createHash } from 'node:crypto';
import {
  clawdeAnswerSchema,
  clawdeArticleSchema,
  clawdeProseSchema,
  type ClawdeArticle,
  clawdeWriterSchema,
  type ClawdeAnswer,
  type ClawdeProse,
  type ClawdeWriter,
  type ClawdeModelSummary,
  type ClawdeProfile,
  type ClawdeStageId,
} from '../contracts/clawde.ts';
import { DomainError } from '../contracts/errors.ts';
import type { Store } from '../core/store.ts';
import { checkAnswer } from './clawde-check.ts';
import type { ProseFailure, ProseRecord, ProseStatus } from './legal-writer.ts';

/**
 * The project's legal answer record and cache (SPEC-13.9, ARCH-01 「저장」, PLAN-46 T-218, schema
 * 13). Every answer gets the next number `L<n>` of its project, never reused. The cache key is
 * (normalized question, stage, sent hash): the same question with the same sent information shows
 * the stored answer without a call. An answer is '다시 확인 필요' when a profile value it used
 * changed (`stale`), or when the service announced a newer law DB date than the answer's.
 */

/** What one ask sent: the stage, the profile values and the model summary (numbers and codes). */
export interface LegalSent {
  stage: ClawdeStageId;
  profile: ClawdeProfile;
  model?: ClawdeModelSummary;
}

/** The hash of the sent information (profile and model summary; the stage is its own key). */
export function sentHash(sent: Pick<LegalSent, 'profile' | 'model'>) {
  const profile = Object.fromEntries(
    Object.keys(sent.profile)
      .sort()
      .map((key) => [key, sent.profile[key]]),
  );
  return createHash('sha256')
    .update(JSON.stringify({ profile, model: sent.model ?? null }))
    .digest('hex');
}

/** Spaces collapsed, width and case folded, closing punctuation dropped. */
export function questionKey(question: string) {
  return question
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s?？.!。…~]+$/u, '');
}

export interface LegalAnswerView {
  number: number;
  /** `L<n>`, how the conversation cites it. */
  ref: string;
  question: string;
  stage: string;
  sent: LegalSent;
  fetchedAt: string;
  lawDbDate: string;
  /** '다시 확인 필요' and why. */
  stale: boolean;
  staleReasons: ('profile' | 'law-db')[];
  /** The verdict to show after the engine check (see clawde-check.ts). */
  verdict: ClawdeAnswer['verdict'];
  downgraded: boolean;
  noExcerpt: string[];
  unverifiedReasons: number[];
  /** Constraints a jig may receive: every ref cited. */
  constraints: NonNullable<ClawdeAnswer['constraints']>;
  unverifiedConstraints: string[];
  answer: ClawdeAnswer;
  /**
   * The answer prose (SPEC-13.13): only a prose that passed is here, shown as 'AI 문장(검증됨)'
   * with its recipe version and writer (`verify:'local-only'` when the service could not check it).
   * Otherwise null, and the card shows the deterministic fields.
   */
  prose:
    | (ClawdeProse & {
        recipe: { id: string; version: string };
        writer: ClawdeWriter;
        verify: 'server' | 'local-only';
      })
    | null;
  /** 'failed' → '문장 생성 검증 실패' (reasons in `proseFailures`), 'no-model' → '자격 모델 없음'. */
  proseStatus: ProseStatus;
  proseFailures: ProseFailure[];
}

interface Row {
  number: number;
  question: string;
  stage: string;
  sent_json: string;
  answer_json: string;
  law_db_date: string;
  fetched_at: string;
  stale: number;
  prose_json: string | null;
  recipe_id: string | null;
  recipe_version: string | null;
  writer_provider: string | null;
  writer_model: string | null;
  writer_effort: string | null;
  verify_json: string | null;
}

/** `verify_json`: the status, the failures and the service's answer of the last writing. */
interface VerifyRecord {
  status: ProseStatus;
  failures: ProseFailure[];
  server: ProseRecord['server'];
  at: string;
  raw?: string;
}

function proseOf(row: Row): Pick<LegalAnswerView, 'prose' | 'proseStatus' | 'proseFailures'> {
  if (!row.verify_json) return { prose: null, proseStatus: 'none', proseFailures: [] };
  const verify = JSON.parse(row.verify_json) as VerifyRecord;
  const shown = verify.status === 'verified' || verify.status === 'local-only';
  const parsed =
    shown && row.prose_json ? clawdeProseSchema.safeParse(JSON.parse(row.prose_json)) : undefined;
  const writer = clawdeWriterSchema.safeParse({
    provider: row.writer_provider,
    model: row.writer_model,
    effort: row.writer_effort,
  });
  if (parsed?.success && writer.success && row.recipe_id && row.recipe_version)
    return {
      prose: {
        ...parsed.data,
        recipe: { id: row.recipe_id, version: row.recipe_version },
        writer: writer.data,
        verify: verify.status === 'verified' ? 'server' : 'local-only',
      },
      proseStatus: verify.status,
      proseFailures: [],
    };
  return {
    prose: null,
    proseStatus: shown ? 'failed' : verify.status,
    proseFailures: verify.failures,
  };
}

export class LegalAnswers {
  private readonly store: Store;
  private readonly now: () => Date;
  constructor(store: Store, { now = () => new Date() }: { now?: () => Date } = {}) {
    this.store = store;
    this.now = now;
  }
  private view(row: Row, latestLawDbDate: string | null): LegalAnswerView {
    const answer = clawdeAnswerSchema.parse(JSON.parse(row.answer_json));
    const check = checkAnswer(answer);
    const staleReasons: LegalAnswerView['staleReasons'] = [];
    if (row.stale) staleReasons.push('profile');
    if (latestLawDbDate && latestLawDbDate > row.law_db_date) staleReasons.push('law-db');
    return {
      number: row.number,
      ref: `L${row.number}`,
      question: row.question,
      stage: row.stage,
      sent: JSON.parse(row.sent_json) as LegalSent,
      fetchedAt: row.fetched_at,
      lawDbDate: row.law_db_date,
      stale: staleReasons.length > 0,
      staleReasons,
      verdict: check.verdict,
      downgraded: check.downgraded,
      noExcerpt: check.noExcerpt,
      unverifiedReasons: check.unverifiedReasons,
      constraints: check.constraints,
      unverifiedConstraints: check.unverifiedConstraints,
      answer,
      ...proseOf(row),
    };
  }
  /** The newest stored answer for the same question, stage and sent information. */
  cached(
    projectId: string,
    question: string,
    sent: LegalSent,
    latestLawDbDate: string | null,
  ): LegalAnswerView | undefined {
    this.store.project(projectId);
    const row = this.store
      .db(projectId)
      .prepare(
        'SELECT * FROM legal_answers WHERE projectId=? AND question_key=? AND stage=? AND sent_hash=? ORDER BY number DESC LIMIT 1',
      )
      .get(projectId, questionKey(question), sent.stage, sentHash(sent)) as Row | undefined;
    return row && this.view(row, latestLawDbDate);
  }
  /** Stores a checked, contract-valid answer under the next number; its citations join the cache. */
  add(
    projectId: string,
    question: string,
    sent: LegalSent,
    answer: ClawdeAnswer,
    latestLawDbDate: string | null,
  ): LegalAnswerView {
    this.store.project(projectId);
    const db = this.store.db(projectId);
    const at = this.now().toISOString();
    const row = this.store.tx(db, () => {
      const { next } = db
        .prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM legal_answers WHERE projectId=?')
        .get(projectId) as { next: number };
      db.prepare(
        'INSERT INTO legal_answers(projectId,number,question,question_key,stage,sent_json,sent_hash,answer_json,law_db_date,fetched_at,stale) VALUES(?,?,?,?,?,?,?,?,?,?,0)',
      ).run(
        projectId,
        next,
        question,
        questionKey(question),
        sent.stage,
        JSON.stringify(sent),
        sentHash(sent),
        JSON.stringify(answer),
        answer.lawDbDate,
        at,
      );
      const article = db.prepare(
        'INSERT INTO legal_articles(projectId,ref,article_json,fetched_at) VALUES(?,?,?,?) ON CONFLICT(projectId,ref) DO UPDATE SET article_json=excluded.article_json, fetched_at=excluded.fetched_at',
      );
      for (const cited of answer.citations)
        article.run(projectId, cited.ref, JSON.stringify(cited), at);
      return db
        .prepare('SELECT * FROM legal_answers WHERE projectId=? AND number=?')
        .get(projectId, next) as unknown as Row;
    });
    return this.view(row, latestLawDbDate);
  }
  /**
   * Stores one writing in the audit columns (ARCH-01 「저장」): the output (a failed one too, for
   * the audit; it is never shown), the recipe version, the writer and the check result. A writing
   * that ran nothing ('none') leaves the columns as they were.
   */
  setProse(
    projectId: string,
    number: number,
    record: ProseRecord,
    latestLawDbDate: string | null,
  ): LegalAnswerView {
    this.store.project(projectId);
    const db = this.store.db(projectId);
    if (record.status !== 'none') {
      const verify: VerifyRecord = {
        status: record.status,
        failures: record.failures,
        server: record.server,
        at: record.at,
        ...(record.raw !== undefined ? { raw: record.raw } : {}),
      };
      db.prepare(
        'UPDATE legal_answers SET prose_json=?, recipe_id=?, recipe_version=?, writer_provider=?, writer_model=?, writer_effort=?, verify_json=? WHERE projectId=? AND number=?',
      ).run(
        record.output === undefined ? null : JSON.stringify(record.output),
        record.recipe?.id ?? null,
        record.recipe?.version ?? null,
        record.writer?.provider ?? null,
        record.writer?.model ?? null,
        record.writer?.effort ?? null,
        JSON.stringify(verify),
        projectId,
        number,
      );
    }
    return this.get(projectId, number, latestLawDbDate);
  }
  /** The question an answer was asked with and the stored answer (for [다시 쓰기]). */
  source(projectId: string, number: number) {
    const view = this.get(projectId, number, null);
    return { question: view.question, answer: view.answer };
  }
  list(projectId: string, latestLawDbDate: string | null): LegalAnswerView[] {
    this.store.project(projectId);
    return (
      this.store
        .db(projectId)
        .prepare('SELECT * FROM legal_answers WHERE projectId=? ORDER BY number DESC')
        .all(projectId) as unknown as Row[]
    ).map((row) => this.view(row, latestLawDbDate));
  }
  get(projectId: string, number: number, latestLawDbDate: string | null): LegalAnswerView {
    this.store.project(projectId);
    const row = this.store
      .db(projectId)
      .prepare('SELECT * FROM legal_answers WHERE projectId=? AND number=?')
      .get(projectId, number) as Row | undefined;
    if (!row) throw new DomainError('NOT_FOUND');
    return this.view(row, latestLawDbDate);
  }
  /** A cached article of the project (from an answer's citations or `legal_article`), if any. */
  article(
    projectId: string,
    ref: string,
  ): { article: ClawdeArticle; fetchedAt: string } | undefined {
    this.store.project(projectId);
    const row = this.store
      .db(projectId)
      .prepare('SELECT article_json, fetched_at FROM legal_articles WHERE projectId=? AND ref=?')
      .get(projectId, ref) as { article_json: string; fetched_at: string } | undefined;
    if (!row) return undefined;
    const parsed = clawdeArticleSchema.safeParse(JSON.parse(row.article_json));
    return parsed.success ? { article: parsed.data, fetchedAt: row.fetched_at } : undefined;
  }
  /** Keeps an article the service returned (SPEC-13.9: articles stay in the project's record). */
  saveArticle(projectId: string, article: ClawdeArticle) {
    this.store.project(projectId);
    const at = this.now().toISOString();
    this.store
      .db(projectId)
      .prepare(
        'INSERT INTO legal_articles(projectId,ref,article_json,fetched_at) VALUES(?,?,?,?) ON CONFLICT(projectId,ref) DO UPDATE SET article_json=excluded.article_json, fetched_at=excluded.fetched_at',
      )
      .run(projectId, article.ref, JSON.stringify(article), at);
    return { article, fetchedAt: at };
  }
  /**
   * Profile values changed: the answers that used one of `keys` become '다시 확인 필요'. They are
   * not asked again by themselves. Returns the numbers marked.
   */
  profileChanged(projectId: string, keys: string[]): number[] {
    if (!keys.length) return [];
    this.store.project(projectId);
    const db = this.store.db(projectId);
    const changed = new Set(keys);
    const rows = db
      .prepare('SELECT number, answer_json FROM legal_answers WHERE projectId=? AND stale=0')
      .all(projectId) as { number: number; answer_json: string }[];
    const marked = rows
      .filter((row) =>
        (JSON.parse(row.answer_json) as ClawdeAnswer).usedProfile.some((key) => changed.has(key)),
      )
      .map((row) => row.number);
    const mark = db.prepare('UPDATE legal_answers SET stale=1 WHERE projectId=? AND number=?');
    this.store.tx(db, () => {
      for (const number of marked) mark.run(projectId, number);
    });
    return marked;
  }
}

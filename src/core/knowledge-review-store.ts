import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DomainError } from './store.ts';

// Rows of the project knowledge review layer (ARCH-03 §10.2, schema v5): verdicts on crawler
// statements, source exclusion rules and project roots. The crawler DB stays read-only; these rows
// are VIDE's own. Data access only: who may confirm (people only) is decided by PLAN-22 T-065.

// The verdict list is shared with the app (src/contracts/facts.ts).
export { verdicts } from '../contracts/facts.ts';
import { verdicts } from '../contracts/facts.ts';
const text = z.string().max(4000);
const statementId = z.number().int().nonnegative();
const newReview = z
  .object({
    verdict: z.enum(verdicts),
    correction: text.nullable().optional(),
    supersededBy: statementId.nullable().optional(),
    reason: text.nullable().optional(),
    by: z.string().min(1).max(200),
  })
  .strict();
export interface KnowledgeReview {
  projectId: string;
  statementId: number;
  verdict: (typeof verdicts)[number];
  correction: string | null;
  supersededBy: number | null;
  reason: string | null;
  by: string;
  at: string;
}
export interface ProjectRoots {
  kdbRoot: string | null;
  localRoot: string | null;
}
const roots = z
  .object({ kdbRoot: text.nullable().optional(), localRoot: text.nullable().optional() })
  .strict();

export class KnowledgeReviewStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  /** One verdict per statement; a new verdict replaces the previous one. */
  setReview(
    projectId: string,
    statement: number,
    value: z.input<typeof newReview>,
  ): KnowledgeReview {
    const input = newReview.parse(value);
    this.db
      .prepare(
        `INSERT INTO knowledge_reviews VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(projectId, statementId)
          DO UPDATE SET verdict=excluded.verdict, correction=excluded.correction,
          supersededBy=excluded.supersededBy, reason=excluded.reason, by=excluded.by, at=excluded.at`,
      )
      .run(
        projectId,
        statementId.parse(statement),
        input.verdict,
        input.correction ?? null,
        input.supersededBy ?? null,
        input.reason ?? null,
        input.by,
        new Date().toISOString(),
      );
    return this.review(projectId, statement);
  }
  review(projectId: string, statement: number): KnowledgeReview {
    const row = this.db
      .prepare('SELECT * FROM knowledge_reviews WHERE projectId=? AND statementId=?')
      .get(projectId, statement);
    if (!row) throw new DomainError('NOT_FOUND');
    return { ...row } as unknown as KnowledgeReview;
  }
  reviews(projectId: string, verdict?: KnowledgeReview['verdict']): KnowledgeReview[] {
    return (
      verdict
        ? this.db
            .prepare(
              'SELECT * FROM knowledge_reviews WHERE projectId=? AND verdict=? ORDER BY statementId',
            )
            .all(projectId, verdict)
        : this.db
            .prepare('SELECT * FROM knowledge_reviews WHERE projectId=? ORDER BY statementId')
            .all(projectId)
    ).map((row) => ({ ...row }) as unknown as KnowledgeReview);
  }
  removeReview(projectId: string, statement: number) {
    this.db
      .prepare('DELETE FROM knowledge_reviews WHERE projectId=? AND statementId=?')
      .run(projectId, statement);
  }

  /** Source path patterns left out of search and evidence for this project. */
  addSourceRule(projectId: string, pattern: string, reason: string | null = null) {
    this.db
      .prepare(
        `INSERT INTO knowledge_source_rules VALUES(?,?,?) ON CONFLICT(projectId, pattern)
          DO UPDATE SET reason=excluded.reason`,
      )
      .run(projectId, text.min(1).parse(pattern), text.nullable().parse(reason));
  }
  sourceRules(projectId: string) {
    return this.db
      .prepare(
        'SELECT pattern, reason FROM knowledge_source_rules WHERE projectId=? ORDER BY pattern',
      )
      .all(projectId)
      .map((row) => ({ pattern: String(row.pattern), reason: row.reason as string | null }));
  }
  removeSourceRule(projectId: string, pattern: string) {
    this.db
      .prepare('DELETE FROM knowledge_source_rules WHERE projectId=? AND pattern=?')
      .run(projectId, pattern);
  }

  /** Crawler DB and local file roots of the project; null when not set. */
  roots(projectId: string): ProjectRoots | null {
    const row = this.db
      .prepare('SELECT kdbRoot, localRoot FROM project_roots WHERE projectId=?')
      .get(projectId);
    return row ? ({ ...row } as unknown as ProjectRoots) : null;
  }
  /** Fields left out keep their current value. */
  setRoots(projectId: string, value: z.input<typeof roots>): ProjectRoots {
    const input = roots.parse(value);
    const current = this.roots(projectId) ?? { kdbRoot: null, localRoot: null };
    this.db
      .prepare(
        `INSERT INTO project_roots VALUES(?,?,?) ON CONFLICT(projectId)
          DO UPDATE SET kdbRoot=excluded.kdbRoot, localRoot=excluded.localRoot`,
      )
      .run(
        projectId,
        input.kdbRoot === undefined ? current.kdbRoot : input.kdbRoot,
        input.localRoot === undefined ? current.localRoot : input.localRoot,
      );
    return this.roots(projectId)!;
  }
}

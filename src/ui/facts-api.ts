import { api } from './gateway.ts';
import {
  factEvidenceSchema,
  factIssueSchema,
  factReviewSchema,
  factRulesSchema,
  factSearchSchema,
  factSummarySchema,
  recordedReviewSchema,
  type FactEvidence,
  type FactIssue,
  type FactReview,
  type FactRules,
  type FactStatement,
  type FactSummary,
  type Verdict,
} from '../contracts/facts.ts';

// Typed client of the project facts routes (자료, PLAN-22 T-065, SCR-19). The engine reads the
// crawler DB read-only and keeps VIDE's own review layer (knowledge_reviews, knowledge_source_rules,
// ARCH-03 §10.2). Routes: GET /projects/:id/facts, /facts/search?q, /facts/issues/:n,
// /facts/statements/:n, POST /facts/statements/:n/review, /facts/rules, /facts/sources/:n/open.
// Reply shapes are src/contracts/facts.ts, shared with the engine. Opening an original file is a
// person's action at this PC; the engine refuses it from a remote session.

export { verdicts as VERDICTS, type Verdict, type BriefItem } from '../contracts/facts.ts';
export type Review = FactReview;
export type Statement = FactStatement;
export type Issue = FactIssue;
export type Evidence = FactEvidence;
export type Summary = FactSummary;
export type AvailableSummary = Extract<Summary, { available: true }>;

export interface SearchResult {
  statements: Statement[];
  /** Matches after the filters, all pages. */
  total: number;
  /** Offset of the next page, or null on the last one. */
  nextOffset: number | null;
  /** Statements left out by a review (오염·기각) or a source rule; shown only on request. */
  excluded: number;
}

export interface SearchOptions {
  kind?: string;
  discipline?: string;
  /** Show only the excluded statements instead of the default list. */
  excluded?: boolean;
  /** The next page (`nextOffset` of the previous one). */
  offset?: number;
}
export interface ReviewInput {
  verdict: Verdict;
  reason?: string;
  correction?: string;
  supersededBy?: number;
}

/** Statements per search page. */
const PAGE = 100;

export interface FactsApi {
  /** The summary; read once and kept unless `fresh` (after a review changed the counts). */
  summary(fresh?: boolean): Promise<Summary>;
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
  issue(id: number): Promise<Issue>;
  statement(id: number): Promise<Evidence>;
  review(id: number, input: ReviewInput): Promise<Review>;
  /** Leave one source file out of search and evidence, with the reason. */
  rule(sourceId: number, input: { reason: string }): Promise<FactRules>;
  openSource(sourceId: number): Promise<void>;
}

export function factsApi(projectId: string): FactsApi {
  const facts = `/projects/${projectId}/facts`;
  let cached: Promise<Summary> | undefined;
  const summary = (fresh = false) => {
    if (!cached || fresh) {
      const next = api(facts).then((body) => factSummarySchema.parse(body));
      cached = next;
      // A failed read is tried again next time.
      next.catch(() => {
        if (cached === next) cached = undefined;
      });
    }
    return cached;
  };
  return {
    summary,
    async search(query, options = {}) {
      const params = new URLSearchParams({
        q: query,
        limit: String(PAGE),
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.discipline ? { discipline: options.discipline } : {}),
        // `excluded=1` would list everything; `status=excluded` lists only the left-out ones.
        ...(options.excluded ? { status: 'excluded' } : {}),
        ...(options.offset ? { offset: String(options.offset) } : {}),
      });
      const page = factSearchSchema.parse(await api(`${facts}/search?${params}`));
      return {
        statements: page.items,
        total: page.total,
        nextOffset: page.nextOffset,
        excluded: page.excluded,
      };
    },
    async issue(id) {
      return factIssueSchema.parse(await api(`${facts}/issues/${id}`));
    },
    async statement(id) {
      return factEvidenceSchema.parse(await api(`${facts}/statements/${id}`));
    },
    async review(id, input) {
      const body = {
        verdict: input.verdict,
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        ...(input.correction?.trim() ? { correction: input.correction.trim() } : {}),
        ...(input.supersededBy !== undefined ? { supersededBy: input.supersededBy } : {}),
      };
      const recorded = recordedReviewSchema.parse(
        await api(`${facts}/statements/${id}/review`, 'POST', body),
      );
      return factReviewSchema.parse(recorded);
    },
    async rule(sourceId, input) {
      return factRulesSchema.parse(
        await api(`${facts}/rules`, 'POST', { sourceId, reason: input.reason.trim() }),
      );
    },
    async openSource(sourceId) {
      await api(`${facts}/sources/${sourceId}/open`, 'POST', {});
    },
  };
}

const clients = new Map<string, FactsApi>();
/** One client per project, so the summary is read once. */
export function factsFor(projectId: string): FactsApi {
  let client = clients.get(projectId);
  if (!client) clients.set(projectId, (client = factsApi(projectId)));
  return client;
}

export const KIND: Record<string, string> = {
  decision: '결정',
  request: '요청',
  condition: '조건',
  opinion: '의견',
  info: '정보',
};
export const VERDICT_TEXT: Record<Verdict, string> = {
  confirmed: '확정',
  rejected: '기각',
  contaminated: '오염',
  superseded: '대체됨',
  corrected: '고침',
};
/**
 * Standing of a statement for filters and chips (SPEC-08.5): a person's verdict first; without
 * one, a source rule (`excluded` from the engine) leaves it out; otherwise it is unconfirmed.
 */
export const standingOf = (statement: {
  review?: Review | null;
  excluded?: boolean;
}): 'confirmed' | 'unconfirmed' | 'excluded' => {
  const verdict = statement.review?.verdict;
  if (verdict === 'confirmed' || verdict === 'corrected') return 'confirmed';
  if (verdict === 'rejected' || verdict === 'contaminated' || statement.excluded) return 'excluded';
  return 'unconfirmed';
};

import { z } from 'zod';
import { api } from './gateway.ts';

// Typed client of the project facts routes (자료, PLAN-22 T-065, SCR-19). The engine reads the
// crawler DB read-only and keeps VIDE's own review layer (knowledge_reviews, knowledge_source_rules,
// ARCH-03 §10.2). Routes: GET /projects/:id/facts, /facts/search?q, /facts/issues/:n,
// /facts/statements/:n, POST /facts/statements/:n/review, /facts/sources/:n/rule. An engine
// without them (older build) answers NOT_FOUND to the summary; the client then reads the trial
// knowledge routes (/jigs/knowledge…) and review actions are off. Opening an original file stays on
// the trial route and is a person's action only.

export const VERDICTS = [
  'confirmed',
  'rejected',
  'contaminated',
  'superseded',
  'corrected',
] as const;
export type Verdict = (typeof VERDICTS)[number];
/** Verdicts that leave a statement out of search defaults, tools and basis lookups. */
export const EXCLUDING: readonly Verdict[] = ['rejected', 'contaminated', 'superseded'];

export const reviewSchema = z
  .object({
    verdict: z.enum(VERDICTS),
    reason: z.string().nullish(),
    correction: z.string().nullish(),
    supersededBy: z.number().nullish(),
    by: z.string().nullish(),
    at: z.string().nullish(),
  })
  .passthrough();
export type Review = z.infer<typeof reviewSchema>;

export const statementSchema = z
  .object({
    id: z.number(),
    kind: z.string(),
    party: z.string().nullable(),
    subject: z.string().nullable(),
    content: z.string(),
    saidOn: z.string().nullable(),
    quote: z.string().nullable(),
    sourceId: z.number(),
    path: z.string(),
    locator: z.string(),
    review: reviewSchema.nullish(),
  })
  .passthrough();
export type Statement = z.infer<typeof statementSchema>;

const item = z.object({ text: z.string().default(''), cite: z.array(z.number()).default([]) });
export const issueSchema = z.object({
  id: z.number(),
  title: z.string(),
  label: z.string(),
  status: z.string(),
  summary: z.string(),
  note: z.object({
    conclusions: z.array(item).default([]),
    conditions: z.array(item).default([]),
    open: z.array(item).default([]),
    history: z
      .array(
        item.extend({
          date: z.string().nullable().default(''),
          party: z.string().nullable().default(''),
        }),
      )
      .default([]),
  }),
  statements: z.array(statementSchema),
});
export type Issue = z.infer<typeof issueSchema>;

export const briefItem = z.object({
  text: z.string(),
  issue: z.number(),
  cite: z.array(z.number()).default([]),
  date: z.string().nullish(),
  since: z.string().nullish(),
  waiting: z.string().nullish(),
  discipline: z.string().nullish(),
});
export type BriefItem = z.infer<typeof briefItem>;
const briefLists = {
  decided: z.array(briefItem).default([]),
  blocked: z.array(briefItem).default([]),
  changed: z.array(briefItem).default([]),
};
const projectBrief = z.object({
  overview: z.string().default(''),
  asOf: z.string().nullish(),
  since: z.string().nullish(),
  ...briefLists,
});
const disciplineBrief = z.object({ state: z.string().default(''), ...briefLists });
/** A group of statements that look like they came from elsewhere (another project's folder …). */
export const suspectSchema = z
  .object({
    sourceId: z.number(),
    path: z.string(),
    reason: z.string().default(''),
    statements: z.number().default(0),
    pattern: z.string().nullish(),
  })
  .passthrough();
export type Suspect = z.infer<typeof suspectSchema>;
const count = z.number().int().nonnegative().default(0);
export const summarySchema = z.union([
  z.object({ available: z.literal(false) }).passthrough(),
  z
    .object({
      available: z.literal(true),
      builtAt: z.string().nullable(),
      brief: projectBrief.nullish(),
      counts: z.object({
        files: z.number(),
        excerpts: z.number(),
        statements: z.number(),
        issues: z.number(),
        mails: z.number(),
      }),
      disciplines: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          brief: disciplineBrief.nullish(),
          issues: z.array(
            z.object({
              id: z.number(),
              title: z.string(),
              status: z.string(),
              summary: z.string(),
              statements: z.number(),
              open: z.number(),
            }),
          ),
        }),
      ),
      /** Review counts of the VIDE layer; absent on the trial routes. */
      reviews: z
        .object({
          confirmed: count,
          rejected: count,
          contaminated: count,
          superseded: count,
          corrected: count,
        })
        .partial()
        .nullish(),
      rules: z.array(z.object({ pattern: z.string(), reason: z.string().nullish() })).nullish(),
      suspects: z.array(suspectSchema).nullish(),
    })
    .passthrough(),
]);
export type Summary = z.infer<typeof summarySchema>;
export type AvailableSummary = Extract<Summary, { available: true }>;

export const evidenceSchema = z
  .object({
    id: z.number().optional(),
    text: z.string(),
    locator: z.string(),
    path: z.string(),
    sourceId: z.number(),
    root: z.string().nullable(),
    content: z.string().nullish(),
    quote: z.string().nullish(),
    statement: statementSchema.nullish(),
    review: reviewSchema.nullish(),
  })
  .passthrough();
export type Evidence = z.infer<typeof evidenceSchema>;

export interface SearchResult {
  statements: Statement[];
  /** Statements left out by a review (오염·기각·대체) or a source rule; shown only on request. */
  excluded: number;
}
const searchSchema = z.union([
  z.array(statementSchema).transform((statements) => ({ statements, excluded: 0 })),
  z.object({ statements: z.array(statementSchema), excluded: z.number().default(0) }),
]);

export interface SearchOptions {
  kind?: string;
  discipline?: string;
  /** Show the excluded statements instead of the default list. */
  excluded?: boolean;
}
export interface ReviewInput {
  verdict: Verdict;
  reason?: string;
  correction?: string;
  supersededBy?: number;
}

export interface FactsApi {
  /** `legacy` until the summary has been read from the facts routes. */
  readonly mode: () => 'facts' | 'legacy';
  /** Which routes this engine has (reads the summary once). */
  ready(): Promise<'facts' | 'legacy'>;
  /** The summary; read once and kept unless `fresh` (after a review changed the counts). */
  summary(fresh?: boolean): Promise<Summary>;
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
  issue(id: number): Promise<Issue>;
  statement(id: number): Promise<Evidence>;
  review(id: number, input: ReviewInput): Promise<Review>;
  /** Leave one source (or a path pattern) out of search and evidence, with the reason. */
  rule(sourceId: number, input: { reason: string; pattern?: string }): Promise<unknown>;
  openSource(sourceId: number): Promise<void>;
}

/** GET without the app's error notice, so a missing route can be told from a failure. */
async function probe(path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch('api/v1' + path);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { ok: response.ok, status: response.status, body };
}

export function factsApi(projectId: string): FactsApi {
  const facts = `/projects/${projectId}/facts`;
  const legacy = `/projects/${projectId}/jigs/knowledge`;
  let mode: 'facts' | 'legacy' | undefined;
  const base = () => (mode === 'legacy' ? legacy : facts);
  const needsFacts = async () => {
    if ((await ready()) === 'legacy')
      throw Object.assign(new Error('이 엔진은 자료 검토 기록을 지원하지 않습니다.'), {
        code: 'FACTS_UNAVAILABLE',
      });
  };
  let cached: Promise<Summary> | undefined;
  const read = async (): Promise<Summary> => {
    if (mode !== 'legacy') {
      const answer = await probe(facts);
      if (answer.ok) {
        mode = 'facts';
        return summarySchema.parse(answer.body);
      }
      if (answer.status !== 404) return summarySchema.parse(await api(facts));
      mode = 'legacy';
    }
    return summarySchema.parse(await api(legacy));
  };
  const summary = (fresh = false) => {
    if (!cached || fresh) {
      const next = read();
      cached = next;
      // A failed read is tried again next time.
      next.catch(() => {
        if (cached === next) cached = undefined;
      });
    }
    return cached;
  };
  const ready = async () => {
    if (!mode) await summary().catch(() => undefined);
    return mode ?? 'legacy';
  };
  return {
    mode: () => mode ?? 'legacy',
    ready,
    summary,
    async search(query, options = {}) {
      await ready();
      const params = new URLSearchParams({
        q: query,
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.discipline ? { discipline: options.discipline } : {}),
        ...(options.excluded ? { excluded: '1' } : {}),
      });
      return searchSchema.parse(await api(`${base()}/search?${params}`));
    },
    async issue(id) {
      await ready();
      return issueSchema.parse(await api(`${base()}/issues/${id}`));
    },
    async statement(id) {
      await ready();
      return evidenceSchema.parse(await api(`${base()}/statements/${id}`));
    },
    async review(id, input) {
      await needsFacts();
      const body = {
        verdict: input.verdict,
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        ...(input.correction?.trim() ? { correction: input.correction.trim() } : {}),
        ...(input.supersededBy !== undefined ? { supersededBy: input.supersededBy } : {}),
      };
      const answer = await api(`${facts}/statements/${id}/review`, 'POST', body);
      const parsed = reviewSchema.safeParse(
        answer && typeof answer === 'object' && 'review' in answer
          ? (answer as { review: unknown }).review
          : answer,
      );
      return parsed.success ? parsed.data : { verdict: input.verdict, reason: body.reason };
    },
    async rule(sourceId, input) {
      await needsFacts();
      return api(`${facts}/sources/${sourceId}/rule`, 'POST', {
        reason: input.reason.trim(),
        ...(input.pattern ? { pattern: input.pattern } : {}),
      });
    },
    async openSource(sourceId) {
      await api(`${legacy}/sources/${sourceId}/open`, 'POST', {});
    },
  };
}

const clients = new Map<string, FactsApi>();
/** One client per project, so the facts/legacy probe runs once. */
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
/** Standing of a statement for filters and chips. */
export const standingOf = (statement: {
  review?: Review | null;
}): 'confirmed' | 'unconfirmed' | 'excluded' =>
  !statement.review
    ? 'unconfirmed'
    : statement.review.verdict === 'confirmed' || statement.review.verdict === 'corrected'
      ? 'confirmed'
      : 'excluded';

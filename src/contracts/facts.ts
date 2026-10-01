import { z } from 'zod';

// Response shapes of the project facts routes (SPEC-08, PLAN-22 T-065):
// GET /projects/:id/facts, /facts/search, /facts/issues/:n, /facts/statements/:n,
// POST /facts/statements/:n/review, /facts/rules, /facts/sources/:n/open.
// The engine (src/jigs/knowledge.ts, src/server/facts-routes.ts) checks its replies against these
// types and the app (src/ui/facts-api.ts) parses them, so the two cannot drift apart. The browser
// test's synthetic answers are parsed with the same schemas.

export const verdicts = [
  'confirmed',
  'rejected',
  'contaminated',
  'superseded',
  'corrected',
] as const;
export type Verdict = (typeof verdicts)[number];
/** A statement's state under the review layer (SPEC-08.5). */
export const factStates = [
  'confirmed',
  'unconfirmed',
  'superseded',
  'rejected',
  'contaminated',
  'excluded-source',
] as const;
export type FactState = (typeof factStates)[number];

/** A person's verdict as a statement carries it. */
export const factReviewSchema = z.object({
  verdict: z.enum(verdicts),
  correction: z.string().nullable(),
  supersededBy: z.number().nullable(),
  reason: z.string().nullable(),
  by: z.string(),
  at: z.string(),
});
export type FactReview = z.infer<typeof factReviewSchema>;
/** POST …/statements/:n/review with a verdict: the stored row. */
export const recordedReviewSchema = factReviewSchema.extend({
  projectId: z.string(),
  statementId: z.number(),
});

/** One crawler statement with its state under the review layer. */
export const factStatementSchema = z.object({
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
  /** `S<id>`, the form answers cite. */
  ref: z.string(),
  state: z.enum(factStates),
  /** Rejected, contaminated or under a source rule: out of search defaults and tools. */
  excluded: z.boolean(),
  /** The verdict's reason, or the source rule's. */
  reason: z.string().nullable(),
  review: factReviewSchema.nullable(),
  /** The crawler's party when a person corrected who said it. */
  originalParty: z.string().optional(),
});
export type FactStatement = z.infer<typeof factStatementSchema>;

/** GET …/facts/statements/:n (the fact window) and a review cleared with `verdict: null`. */
export const factEvidenceSchema = factStatementSchema.extend({
  /** The full excerpt the statement quotes. */
  text: z.string(),
  issue: z.object({ id: z.number(), discipline: z.string() }).nullable(),
  /** The crawled folder the paths are relative to. */
  root: z.string().nullable(),
});
export type FactEvidence = z.infer<typeof factEvidenceSchema>;

const noteItem = z.object({ text: z.string().default(''), cite: z.array(z.number()).default([]) });
/** GET …/facts/issues/:n: the note, its statements left after the review layer, excluded counted. */
export const factIssueSchema = z.object({
  id: z.number(),
  discipline: z.string(),
  title: z.string(),
  label: z.string(),
  status: z.string(),
  summary: z.string(),
  note: z.object({
    conclusions: z.array(noteItem).default([]),
    conditions: z.array(noteItem).default([]),
    open: z.array(noteItem).default([]),
    history: z
      .array(
        noteItem.extend({
          date: z.string().nullable().default(''),
          party: z.string().nullable().default(''),
        }),
      )
      .default([]),
  }),
  statements: z.array(factStatementSchema),
  excluded: z.number(),
});
export type FactIssue = z.infer<typeof factIssueSchema>;

/** A line of the crawler's status brief (written by the crawler, read as is). */
export const briefItemSchema = z.object({
  text: z.string(),
  issue: z.number(),
  cite: z.array(z.number()).default([]),
  date: z.string().nullish(),
  since: z.string().nullish(),
  waiting: z.string().nullish(),
  discipline: z.string().nullish(),
});
export type BriefItem = z.infer<typeof briefItemSchema>;
const briefLists = {
  decided: z.array(briefItemSchema).default([]),
  blocked: z.array(briefItemSchema).default([]),
  changed: z.array(briefItemSchema).default([]),
};
const count = z.number().int().nonnegative();
/** GET …/facts: what the DB holds, the status brief and this project's review and rule counts. */
export const factSummarySchema = z.union([
  z.object({ available: z.literal(false) }).strict(),
  z.object({
    available: z.literal(true),
    builtAt: z.string().nullable(),
    sizeBytes: z.number(),
    brief: z
      .object({
        overview: z.string().default(''),
        asOf: z.string().nullish(),
        since: z.string().nullish(),
        ...briefLists,
      })
      .nullable(),
    counts: z.object({
      files: count,
      excerpts: count,
      statements: count,
      issues: count,
      mails: count,
    }),
    disciplines: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        brief: z.object({ state: z.string().default(''), ...briefLists }).nullable(),
        issues: z.array(
          z.object({
            id: z.number(),
            discipline: z.string(),
            title: z.string(),
            status: z.string(),
            summary: z.string(),
            statements: z.number(),
            open: z.number(),
          }),
        ),
      }),
    ),
    /** Verdict counts of this project and the number of source rules (SPEC-08.2). */
    reviews: z.object({
      confirmed: count,
      rejected: count,
      contaminated: count,
      superseded: count,
      corrected: count,
      rules: count,
    }),
  }),
]);
export type FactSummary = z.infer<typeof factSummarySchema>;

/** GET …/facts/search: one page of statements; excluded ones are only counted unless asked for. */
export const factSearchSchema = z.object({
  items: z.array(factStatementSchema),
  /** Matches after the filters (all pages). */
  total: z.number(),
  offset: z.number(),
  /** Offset of the next page, or null on the last one. */
  nextOffset: z.number().nullable(),
  /** Statements left out by a verdict or a source rule. */
  excluded: z.number(),
  /** The search stopped at its candidate limit; narrower words find the rest. */
  capped: z.boolean(),
  plan: z.object({
    fts: z.boolean(),
    words: z.array(z.object({ word: z.string(), via: z.enum(['fts', 'like']) })),
  }),
});
export type FactSearch = z.infer<typeof factSearchSchema>;
/** `status` of a search: confirmed only, unconfirmed only, or the excluded statements only. */
export const factStatusSchema = z.enum(['confirmed', 'unconfirmed', 'excluded']);
export type FactStatus = z.infer<typeof factStatusSchema>;

/** GET/POST …/facts/rules: this project's source exclusion rules. */
export const factRulesSchema = z.object({
  rules: z.array(z.object({ pattern: z.string(), reason: z.string().nullable() })),
});
export type FactRules = z.infer<typeof factRulesSchema>;

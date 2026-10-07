import { z } from 'zod';

/**
 * The cLAWde connection contract (ARCH-01 「cLAWde 연결 계약」, SPEC-13, PLAN-46 T-216). These
 * schemas are the one check the engine connector (T-218) and the fake cLAWde server's contract
 * tests share. Objects strip unknown fields (field additions are backward compatible); a missing
 * required field fails the parse and the engine drops that response (`SERVICE_BAD_RESPONSE`).
 * The engine's own checks (an answer with no citations is lowered to `unknown`, refs missing from
 * `citations` get `unverifiedRef`) are not schema rules: such answers still parse.
 */

/** A cLAWde article ID, e.g. `law:건축법/제61조/①`. */
export const clawdeRefSchema = z.string().regex(/^law:[^/]+(\/[^/]+)+$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nonEmpty = z.string().min(1);

export const clawdeVerdictSchema = z.enum(['applies', 'not-applies', 'conditional', 'unknown']);
export type ClawdeVerdict = z.infer<typeof clawdeVerdictSchema>;

export const clawdeProfileSourceSchema = z.enum(['service', 'model', 'user', 'assumed']);

export const clawdeProfileValueSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().optional(),
  source: clawdeProfileSourceSchema,
  version: z.string().optional(),
});
export const clawdeProfileSchema = z.record(nonEmpty, clawdeProfileValueSchema);
export type ClawdeProfile = z.infer<typeof clawdeProfileSchema>;

/** Numbers and codes only, never geometry (ARCH-01). */
export const clawdeModelSummarySchema = z.object({
  northAngleDeg: z.number(),
  siteArea: z.number().nonnegative(),
  adjacent: z.array(
    z.object({ bearingDeg: z.number(), kind: nonEmpty, roadWidth: z.number().optional() }),
  ),
  surroundingHeights: z.object({ max: z.number(), median: z.number() }),
  shpAttrs: z.record(z.string(), z.union([z.string(), z.number()])),
});

/**
 * `excerpt` and `sourceUrl` may be null: the engine marks such an article '원문 없음' and leaves it
 * out of the conclusion's citation count (SPEC-13.12) instead of dropping the whole answer.
 */
export const clawdeArticleSchema = z.object({
  ref: clawdeRefSchema,
  lawName: nonEmpty,
  article: nonEmpty,
  title: z.string(),
  excerpt: z.string().nullable(),
  effectiveDate: dateSchema,
  sourceUrl: z.url().nullable(),
  lawDbDate: dateSchema,
});
export type ClawdeArticle = z.infer<typeof clawdeArticleSchema>;

export const clawdeArticleSummarySchema = clawdeArticleSchema.pick({
  ref: true,
  lawName: true,
  article: true,
  title: true,
  excerpt: true,
});

export const clawdeAnswerSchema = z.object({
  answerId: nonEmpty,
  verdict: clawdeVerdictSchema,
  conclusion: nonEmpty,
  reasons: z.array(z.object({ text: nonEmpty, refs: z.array(clawdeRefSchema) })),
  citations: z.array(clawdeArticleSchema),
  interpretation: z.array(
    z.object({
      text: nonEmpty,
      refs: z.array(clawdeRefSchema),
      basis: z.enum(['verified', 'draft']),
    }),
  ),
  checks: z.array(z.object({ text: nonEmpty, dependsOn: z.array(nonEmpty).optional() })),
  needs: z.array(
    z.object({
      key: nonEmpty,
      question: nonEmpty,
      options: z.array(nonEmpty),
      recommended: nonEmpty.optional(),
      why: nonEmpty,
    }),
  ),
  usedProfile: z.array(nonEmpty),
  constraints: z
    .array(
      z.object({
        key: nonEmpty,
        value: z.number(),
        unit: nonEmpty,
        refs: z.array(clawdeRefSchema),
      }),
    )
    .optional(),
  figures: z
    .array(
      z.object({
        mime: z.enum(['image/png', 'image/svg+xml']),
        url: z.url(),
        caption: z.string(),
      }),
    )
    .optional(),
  lawDbDate: dateSchema,
  generatedAt: z.iso.datetime({ offset: true }),
});
export type ClawdeAnswer = z.infer<typeof clawdeAnswerSchema>;

/** Stages are ids with the service's own label (e.g. `feasibility` · 규모검토). */
export const clawdeStageSchema = z.object({ id: nonEmpty, label: nonEmpty });

/** The profile key vocabulary; `needs[].key` uses the same keys. */
export const clawdeProfileKeySchema = z.object({
  key: nonEmpty,
  label: nonEmpty,
  unit: z.string().optional(),
});

export const clawdeMetaSchema = z.object({
  service: z.literal('clawde'),
  apiVersion: nonEmpty,
  lawDbDate: dateSchema,
  stages: z.array(clawdeStageSchema).min(1),
  profileKeys: z.array(clawdeProfileKeySchema),
});
export type ClawdeMeta = z.infer<typeof clawdeMetaSchema>;

export const clawdeAskRequestSchema = z.object({
  question: nonEmpty,
  stage: nonEmpty,
  profile: clawdeProfileSchema,
  model: clawdeModelSummarySchema.optional(),
  projectRef: nonEmpty.optional(),
  locale: z.literal('ko'),
});
export type ClawdeAskRequest = z.infer<typeof clawdeAskRequestSchema>;

export const clawdeChecklistRequestSchema = z.object({
  stage: nonEmpty,
  profile: clawdeProfileSchema,
  model: clawdeModelSummarySchema.optional(),
});

/** Items of every stage come back; the engine shows the current stage and folds the rest. */
export const clawdeChecklistSchema = z.object({
  lawDbDate: dateSchema,
  items: z.array(
    z.object({
      topic: nonEmpty,
      stage: nonEmpty,
      status: clawdeVerdictSchema,
      reason: nonEmpty,
      refs: z.array(clawdeRefSchema),
      answerHint: z.string().optional(),
    }),
  ),
});
export type ClawdeChecklist = z.infer<typeof clawdeChecklistSchema>;

export const clawdeSearchSchema = z.object({ hits: z.array(clawdeArticleSummarySchema) });

export const clawdeContributionRequestSchema = z.object({
  projectRef: nonEmpty,
  idempotencyKey: nonEmpty,
  items: z
    .array(
      z.object({
        key: nonEmpty,
        value: z.union([z.string(), z.number(), z.boolean()]),
        unit: z.string().optional(),
        basis: nonEmpty,
        confirmedAt: z.iso.datetime({ offset: true }),
      }),
    )
    .min(1),
});
export type ClawdeContributionRequest = z.infer<typeof clawdeContributionRequestSchema>;

export const clawdeContributionReceiptSchema = z.object({
  receiptId: nonEmpty,
  accepted: z.array(nonEmpty),
  rejected: z.array(z.object({ key: nonEmpty, reason: nonEmpty })),
});
export type ClawdeContributionReceipt = z.infer<typeof clawdeContributionReceiptSchema>;

/** Every non-2xx response: 400 bad request, 401 token, 404 article, 5xx service. */
export const clawdeErrorSchema = z.object({
  error: z.object({ code: nonEmpty, message: z.string() }),
});

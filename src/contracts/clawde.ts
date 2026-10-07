import { z } from 'zod';

/**
 * The cLAWde connection contract (ARCH-01 「cLAWde 연결 계약」, SPEC-13, PLAN-46 T-216). These
 * schemas are the one check the engine connector (T-218) and the fake cLAWde server's contract
 * tests share. Objects strip unknown fields (field additions are backward compatible); a missing
 * required field fails the parse and the engine drops that response (`SERVICE_BAD_RESPONSE`).
 * The engine's own checks (an answer with no citations is lowered to `unknown`, refs missing from
 * `citations` get `unverifiedRef`) are not schema rules: such answers still parse.
 */

/** A cLAWde article ID, e.g. `law:건축법/제61조/①`; local ordinances use `ordin:`. */
export const clawdeRefSchema = z.string().regex(/^(law|ordin):[^/]+(\/[^/]+)+$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nonEmpty = z.string().min(1);

export const clawdeVerdictSchema = z.enum(['applies', 'not-applies', 'conditional', 'unknown']);
export type ClawdeVerdict = z.infer<typeof clawdeVerdictSchema>;

/**
 * Design stages, the checklist's axis (2026-10-07 user decision, SPEC-13.6): 규모검토, 계획설계,
 * 기본설계, 실시설계. Requests carry one of these.
 */
export const CLAWDE_STAGES = [
  'scale-review',
  'schematic',
  'design-development',
  'construction-docs',
] as const;
export const clawdeStageIdSchema = z.enum(CLAWDE_STAGES);
export type ClawdeStageId = z.infer<typeof clawdeStageIdSchema>;
/** Permit phases, a mark on checklist items (심의·허가·착공·사용승인), never the axis. */
export const clawdePermitPhaseIdSchema = z.enum([
  'review',
  'permit',
  'construction-start',
  'occupancy',
]);

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
export type ClawdeModelSummary = z.infer<typeof clawdeModelSummarySchema>;

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

/** A model allowed to write a recipe's prose (the lowest qualifying grade and its effort). */
export const clawdeWriterSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  model: nonEmpty,
  effort: nonEmpty,
});
export type ClawdeWriter = z.infer<typeof clawdeWriterSchema>;

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
  /** The evidence pack: the unit texts the prose may cite (SPEC-13.13). */
  evidence: z
    .array(z.object({ ref: clawdeRefSchema, text: nonEmpty, effectiveDate: dateSchema }))
    .optional(),
  /** Values from the service's safe formula engine, with their articles. */
  computed: z
    .array(
      z.object({
        key: nonEmpty,
        value: z.number(),
        unit: nonEmpty,
        refs: z.array(clawdeRefSchema),
      }),
    )
    .optional(),
  /** How VIDE writes this answer's prose; without it (or evidence/computed) VIDE writes none. */
  recipe: z
    .object({
      id: nonEmpty,
      version: nonEmpty,
      allowedRefs: z.array(clawdeRefSchema),
      /** `from` is the ref of the text holding the number, or `computed:<key>`. */
      numbers: z.array(
        z.object({ value: z.number(), unit: z.string().optional(), from: nonEmpty }),
      ),
      models: z.array(clawdeWriterSchema).min(1),
    })
    .optional(),
  lawDbDate: dateSchema,
  generatedAt: z.iso.datetime({ offset: true }),
});
export type ClawdeAnswer = z.infer<typeof clawdeAnswerSchema>;

/** Stages are fixed ids with the service's own label (e.g. `scale-review` · 규모검토). */
export const clawdeStageSchema = z.object({ id: clawdeStageIdSchema, label: nonEmpty });
export const clawdePermitPhaseSchema = z.object({ id: clawdePermitPhaseIdSchema, label: nonEmpty });

/** The profile key vocabulary; `needs[].key` uses the same keys. */
export const clawdeProfileKeySchema = z.object({
  key: nonEmpty,
  label: nonEmpty,
  unit: z.string().optional(),
});

/**
 * Fields added after the first contract (permit phases, answer models, recipes) default to empty:
 * an older service still parses.
 */
export const clawdeMetaSchema = z.object({
  service: z.literal('clawde'),
  apiVersion: nonEmpty,
  lawDbDate: dateSchema,
  stages: z.array(clawdeStageSchema).min(1),
  permitPhases: z.array(clawdePermitPhaseSchema).default([]),
  profileKeys: z.array(clawdeProfileKeySchema),
  answerModels: z
    .array(
      z.object({
        provider: z.enum(['claude', 'codex']),
        models: z.array(nonEmpty),
        effort: nonEmpty,
      }),
    )
    .default([]),
  recipes: z.array(z.object({ id: nonEmpty, version: nonEmpty })).default([]),
});
export type ClawdeMeta = z.infer<typeof clawdeMetaSchema>;

export const clawdeAskRequestSchema = z.object({
  question: nonEmpty,
  stage: clawdeStageIdSchema,
  profile: clawdeProfileSchema,
  model: clawdeModelSummarySchema.optional(),
  projectRef: nonEmpty.optional(),
  locale: z.literal('ko'),
});
export type ClawdeAskRequest = z.infer<typeof clawdeAskRequestSchema>;

export const clawdeChecklistRequestSchema = z.object({
  stage: clawdeStageIdSchema,
  profile: clawdeProfileSchema,
  model: clawdeModelSummarySchema.optional(),
});

/** Items of every stage come back; the engine shows the current stage and folds the rest. */
export const clawdeChecklistSchema = z.object({
  lawDbDate: dateSchema,
  items: z.array(
    z.object({
      topic: nonEmpty,
      stage: clawdeStageIdSchema,
      permitPhases: z.array(clawdePermitPhaseIdSchema).optional(),
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

/** The prose a writer returns for a recipe (SPEC-13.13): the same shape for every recipe. */
export const clawdeProseSchema = z.object({
  verdict: clawdeVerdictSchema,
  conclusion: nonEmpty,
  reasons: z.array(z.object({ text: nonEmpty, refs: z.array(clawdeRefSchema) })),
  interpretation: z.array(z.object({ text: nonEmpty, refs: z.array(clawdeRefSchema) })),
});
export type ClawdeProse = z.infer<typeof clawdeProseSchema>;

/**
 * `GET /v1/recipes/{id}?version=`. A versioned recipe never changes, so VIDE caches it by
 * `(id, version)`. `promptTemplate` has only the `{{question}}`·`{{verdict}}`·`{{evidence}}`·
 * `{{computed}}`·`{{checks}}` slots.
 */
export const clawdeRecipeSchema = z.object({
  id: nonEmpty,
  version: nonEmpty,
  promptTemplate: nonEmpty,
  outputSchema: z.record(z.string(), z.unknown()),
  rules: z.object({
    refs: z.literal('evidence-only'),
    numbers: z.literal('evidence-or-computed'),
    verdictLock: z.literal(true),
  }),
  models: z.array(clawdeWriterSchema).min(1),
  maxOutputChars: z.number().int().positive(),
});
export type ClawdeRecipe = z.infer<typeof clawdeRecipeSchema>;

export const CLAWDE_PROSE_FAILURES = [
  'SCHEMA',
  'REF_OUTSIDE',
  'NUMBER_UNSUPPORTED',
  'VERDICT_CHANGED',
  'RECIPE_STALE',
  'MODEL_NOT_QUALIFIED',
] as const;

/** `POST /v1/verify`: the service repeats VIDE's prose checks and checks the recipe and writer. */
export const clawdeVerifyRequestSchema = z.object({
  answerId: nonEmpty,
  recipe: z.object({ id: nonEmpty, version: nonEmpty }),
  writer: clawdeWriterSchema,
  output: z.unknown(),
});
export type ClawdeVerifyRequest = z.infer<typeof clawdeVerifyRequestSchema>;
export const clawdeVerifyResultSchema = z.object({
  pass: z.boolean(),
  recipeCurrent: z.boolean(),
  failures: z.array(
    z.object({ code: z.enum(CLAWDE_PROSE_FAILURES), path: z.string(), message: z.string() }),
  ),
});
export type ClawdeVerifyResult = z.infer<typeof clawdeVerifyResultSchema>;

/** `GET /v1/golden?recipe=`: the regression questions with the verdict and the refs to cite. */
export const clawdeGoldenSchema = z.object({
  id: nonEmpty,
  version: nonEmpty,
  recipe: z.object({ id: nonEmpty, version: nonEmpty }),
  items: z
    .array(
      z.object({
        goldenId: nonEmpty,
        question: nonEmpty,
        stage: clawdeStageIdSchema,
        profile: clawdeProfileSchema,
        expectVerdict: clawdeVerdictSchema,
        requiredRefs: z.array(clawdeRefSchema),
      }),
    )
    .min(1),
});
export type ClawdeGolden = z.infer<typeof clawdeGoldenSchema>;

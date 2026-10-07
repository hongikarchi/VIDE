import { z } from 'zod';
import { clawdeStageIdSchema } from './clawde.ts';

/**
 * The engine's legal API inputs (SPEC-13.3·13.4, ARCH-01 「엔진 API」, PLAN-46 T-219). Profile keys
 * are the service's dotted vocabulary (`site.area`, `plan.mainUse`); `vide:` keys are the engine's
 * own state and never accepted here.
 */
export const legalProfileKeySchema = z
  .string()
  .max(100)
  .regex(/^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/);

const profileValueSchema = z.union([z.string().min(1).max(500), z.number(), z.boolean()]);

/** `PUT …/legal/profile`: values the user sets (null removes), items left out of sending, stage. */
export const legalProfileUpdateSchema = z
  .object({
    values: z
      .record(
        legalProfileKeySchema,
        z.object({ value: profileValueSchema, unit: z.string().max(20).optional() }).nullable(),
      )
      .optional(),
    exclude: z.record(legalProfileKeySchema, z.boolean()).optional(),
    stage: clawdeStageIdSchema.optional(),
  })
  .strict();
export type LegalProfileUpdate = z.infer<typeof legalProfileUpdateSchema>;

/**
 * `POST …/legal/ask`. Without a matching `confirmSendHash` a changed send list comes back as
 * `{needsConfirm}`; with it, `exclude` is the final list of keys left out (kept for the project).
 */
export const legalAskInputSchema = z
  .object({
    question: z.string().trim().min(1).max(2000),
    stage: clawdeStageIdSchema.optional(),
    confirmSendHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    exclude: z.array(legalProfileKeySchema).max(200).optional(),
    refresh: z.boolean().optional(),
  })
  .strict();
export type LegalAskInput = z.infer<typeof legalAskInputSchema>;

export const legalProfileSourceSchema = z.enum(['service', 'model', 'user', 'assumed', 'ai']);
export type LegalProfileSource = z.infer<typeof legalProfileSourceSchema>;

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
        z
          .object({
            value: profileValueSchema,
            unit: z.string().max(20).optional(),
            /** [권장값으로 진행] on a back-question: sent marked '가정', not user-confirmed. */
            assumed: z.boolean().optional(),
          })
          .nullable(),
      )
      .optional(),
    exclude: z.record(legalProfileKeySchema, z.boolean()).optional(),
    stage: clawdeStageIdSchema.optional(),
    /**
     * The values are answers to the service's back-questions (SPEC-13.7): answering is the send
     * confirmation for them, so a send list that was confirmed before stays confirmed with them.
     */
    answered: z.boolean().optional(),
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

/** `POST …/legal/confirm`: the '보낼 정보' card confirmed outside an ask (the stage checklist). */
export const legalConfirmInputSchema = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    exclude: z.array(legalProfileKeySchema).max(200).optional(),
    stage: clawdeStageIdSchema.optional(),
  })
  .strict();

/** `GET …/legal/checklist?stage=&refresh=1`. */
export const legalChecklistQuerySchema = z
  .object({
    stage: clawdeStageIdSchema.optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

/**
 * `POST …/legal/contribute {keys[]}` (SPEC-13.10, PLAN-46 T-224): the profile keys the user ticked
 * in the [cLAWde로 보내기] list. Nothing is ticked by default; at least one key goes.
 */
export const legalContributeInputSchema = z
  .object({ keys: z.array(legalProfileKeySchema).min(1).max(200) })
  .strict();

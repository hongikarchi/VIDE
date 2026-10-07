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

/**
 * The legal jig's output `legal.constraints` (SPEC-13.8, ARCH-03 §8.2 「법규 결과 입력」, PLAN-46
 * T-220): the numeric limits of the project's cLAWde answers whose every article is cited with its
 * text and link, newest answer first, one per key. Other jigs (`vide/buildable-mass`) take it as a
 * `jig-output` input `{jig: 'vide/legal', output: 'constraints'}`; VIDE adds no value or formula.
 */
export interface LegalConstraint {
  /** The service's key (e.g. `sunlight.setbackUpTo10m`). */
  key: string;
  value: number;
  unit: string;
  refs: string[];
  /** 근거 조항: each cited article as shown (`건축법 시행령 제86조 제1항`) and its 원문 link. */
  clauses: { ref: string; text: string; link: string | null }[];
  /** 출처 표시 (SPEC-13.5): a person at the service confirmed the value, or not. */
  origin: '서비스 확정' | '서비스 해석';
  /** 적용 여부 from the answer's verdict (applies · not-applies · conditional). */
  applies: '적용' | '미적용' | '판단 필요';
  /** The answer it came from (`L3`), its question, when it was asked and the law DB date. */
  answer: string;
  question: string;
  fetchedAt: string;
  lawDbDate: string;
}
/** A constraint the engine left out of the output, with why. */
export interface LegalConstraintLeft {
  key: string;
  answer: string;
  reason: '근거 미확인' | '원문 없음' | '다시 확인 필요' | '판단 불가';
}
export interface LegalConstraintsOutput {
  schema: 'vide.legal.constraints@1';
  constraints: LegalConstraint[];
  left: LegalConstraintLeft[];
}

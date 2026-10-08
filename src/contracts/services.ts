import { z } from 'zod';

/**
 * External service settings as the engine shows them (SPEC-13.11, ARCH-01 「cLAWde 연결 계약」
 * 설정·비밀, PLAN-46 T-217). The token itself is never part of this view: only whether one is set,
 * where it came from and when an account token expires.
 */
export const serviceStatusSchema = z.enum([
  'connected',
  'unreachable',
  'login-required',
  'off',
  'not-configured',
  'unchecked',
]);
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

/**
 * The cLAWde features VIDE uses, each named by the service endpoint it calls (PLAN-48 T-240):
 * 묻기 `ask`, 단계별 법령 `checklist`, cLAWde로 보내기 `contributions`, 답 문장 검증 `verify`, 모델 인증
 * `golden`, 답 문장 레시피 `recipes`. Article view and search are always on.
 */
export const CLAWDE_FEATURES = {
  ask: 'ask',
  checklist: 'checklist',
  contribute: 'contributions',
  verify: 'verify',
  golden: 'golden',
  recipes: 'recipes',
} as const;
export type ClawdeFeature = keyof typeof CLAWDE_FEATURES;
export const clawdeFeaturesSchema = z.object({
  ask: z.boolean(),
  checklist: z.boolean(),
  contribute: z.boolean(),
  verify: z.boolean(),
  golden: z.boolean(),
  recipes: z.boolean(),
});
export type ClawdeFeatures = z.infer<typeof clawdeFeaturesSchema>;

export const clawdeSettingsViewSchema = z.object({
  baseUrl: z.string().nullable(),
  enabled: z.boolean(),
  projectsOff: z.array(z.string()),
  token: z.object({
    set: z.boolean(),
    source: z.enum(['static', 'account']).nullable(),
    expiresAt: z.string().nullable(),
  }),
  status: serviceStatusSchema,
  /** The law DB date the service announced on the last successful `meta`. */
  lawDbDate: z.string().nullable(),
  checkedAt: z.string().nullable(),
  /** Whether this PC is signed in to the VIDE account ([연결] needs it). */
  accountLinked: z.boolean(),
  /**
   * The service features the last `meta` (and any 501 since) says are answered now (PLAN-48
   * T-240); a feature that is off is never called and its buttons are dimmed.
   */
  features: clawdeFeaturesSchema.optional(),
  /** The last call found the service up but not ready (503 `NO_PUBLICATION`·`PUBLISHING`). */
  notReady: z.boolean().optional(),
});
export type ClawdeSettingsView = z.infer<typeof clawdeSettingsViewSchema>;

export const serviceSettingsViewSchema = z.object({ clawde: clawdeSettingsViewSchema });
export type ServiceSettingsView = z.infer<typeof serviceSettingsViewSchema>;

/**
 * `PUT /api/v1/settings/services`. `token` is the development static token: a string saves it
 * (and drops an account token), `null` removes it. Omitted fields stay as they are.
 */
export const serviceSettingsUpdateSchema = z.object({
  clawde: z
    .object({
      baseUrl: z.url().nullable().optional(),
      enabled: z.boolean().optional(),
      projectsOff: z.array(z.string().min(1).max(100)).max(1000).optional(),
      token: z.string().min(1).max(4096).nullable().optional(),
    })
    .strict(),
});
export type ServiceSettingsUpdate = z.infer<typeof serviceSettingsUpdateSchema>;

/** The account site's answer to `POST /api/hosts/device/services/clawde/token`. */
export const serviceTokenSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type ServiceToken = z.infer<typeof serviceTokenSchema>;

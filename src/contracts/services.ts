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

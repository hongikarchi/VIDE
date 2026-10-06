import { z } from 'zod';
export const providers = ['claude-cli', 'codex-cli'] as const;
export type Provider = (typeof providers)[number];
export const aiSettingsSchema = z
  .object({
    revision: z.number().int().safe(),
    paths: z
      .object({ 'claude-cli': z.string().nullable(), 'codex-cli': z.string().nullable() })
      .strict(),
  })
  .strict();
export type AiConfiguration = z.infer<typeof aiSettingsSchema>;
// Keep path validation after revision checking so stale writes retain their error code.
export const aiSettingsUpdateSchema = z
  .unknown()
  .refine((value) => {
    if (!value || typeof value !== 'object' || !('paths' in value)) return false;
    const paths = value.paths;
    return (
      paths !== null &&
      typeof paths === 'object' &&
      !Array.isArray(paths) &&
      Object.keys(paths).length === 2
    );
  })
  .pipe(
    z
      .object({
        revision: z.number().int().safe(),
        paths: z.record(z.enum(providers), z.unknown()),
      })
      .strict(),
  );

export const aiSettingsResponseSchema = aiSettingsSchema.extend({
  resolved: z.object({ 'claude-cli': z.string().nullable(), 'codex-cli': z.string().nullable() }),
  /** Whether the resolved file is there (the first-run screen's 설치 안 됨, PLAN-38 T-178). */
  found: z.object({ 'claude-cli': z.boolean(), 'codex-cli': z.boolean() }).optional(),
});
export type AiSettingsResponse = z.infer<typeof aiSettingsResponseSchema>;
export const providerStatusSchema = z.array(
  z
    .object({
      id: z.enum(providers),
      available: z.boolean(),
      reason: z.string().optional(),
    })
    .passthrough(),
);
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

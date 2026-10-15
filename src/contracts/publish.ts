import { z } from 'zod';

/**
 * The run a published report came from — the same object `vide export --report` writes into
 * `report.json` (`sourceRun`), so the publish record can be traced back to one jig run.
 */
export const publishSourceRunSchema = z.object({
  instanceId: z.string(),
  jigId: z.string(),
  version: z.number().optional(),
  report: z.string().optional(),
  at: z.string().optional(),
});
export type PublishSourceRun = z.infer<typeof publishSourceRunSchema>;

/**
 * `06_산출물/<이름>/publish.json` (ARCH-01 「게시 템플릿」, SPEC-05.11, PLAN-54 T-343/T-347).
 * One record per output folder: the latest publish wins. The password value is never here —
 * only whether one is set; the value itself lives in the sealed secret store.
 */
export const publishRecordSchema = z.object({
  target: z.enum(['cloudflare', 'vide-site']),
  url: z.string().url(),
  /** Cloudflare only: the Worker script name (lowercase kebab, ≤ 63). */
  workerName: z.string().optional(),
  publishedAt: z.string(),
  passwordSet: z.boolean(),
  sourceRun: publishSourceRunSchema.nullable(),
  /** VIDE site only: the site's publication id (`/r/<id>/`, SPEC-04.14), for 다시 게시·[내리기]. */
  publicationId: z.string().optional(),
  /** Set by [내리기]: the link no longer opens; the record stays as the folder's history. */
  revokedAt: z.string().optional(),
});
export type PublishRecord = z.infer<typeof publishRecordSchema>;

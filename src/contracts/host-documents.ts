import { z } from 'zod';
export const hostTargetSchema = z.object({
  instance: z.string().regex(/^\d+:\d+(?::[a-f0-9-]{36})?$/),
  documentId: z.number().int().positive().max(4294967295),
});
export type HostTarget = z.infer<typeof hostTargetSchema>;
export const hostDocumentsSchema = z.object({
  instance: hostTargetSchema.shape.instance,
  documents: z.array(
    z.object({
      instance: hostTargetSchema.shape.instance.optional(),
      id: z.number().int().positive().max(4294967295),
      name: z.string(),
      units: z.string(),
      objectCount: z.number().int().nonnegative(),
      modified: z.boolean().nullable(),
      host: z.enum(['rhino', 'zwcad']).optional(),
      connection: z.enum(['attached-editor', 'owned-editor']).optional(),
      generation: z.number().int().nonnegative().optional(),
      live: z.boolean().optional(),
      hostBusy: z.boolean().optional(),
    }),
  ),
});
export type HostDocuments = z.infer<typeof hostDocumentsSchema>;
export const hostSelectionSchema = hostTargetSchema.extend({
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  selectedIds: z.array(z.string()),
  observedAt: z.string(),
});
export type HostSelection = z.infer<typeof hostSelectionSchema>;

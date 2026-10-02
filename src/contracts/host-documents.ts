import { z } from 'zod';
/**
 * Auto-mode guard, the one place for every host (ADR-031 7): deleting more objects than this in
 * one execute is undone and waits for the user's confirmation card.
 */
export const DIRECT_MAX_DELETES = 500;
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
      /** Full file path when the document is saved (identifies a project link file). */
      path: z.string().optional(),
      units: z.string(),
      objectCount: z.number().int().nonnegative(),
      modified: z.boolean().nullable(),
      host: z.enum(['rhino', 'zwcad']).optional(),
      connection: z.enum(['attached-editor', 'owned-editor']).optional(),
      generation: z.number().int().nonnegative().optional(),
      live: z.boolean().optional(),
      hostBusy: z.boolean().optional(),
      selectionVersion: z.number().int().nonnegative().optional(),
      selectedIds: z.array(z.string()).optional(),
      pinnedIds: z.array(z.string()).optional(),
      /** VIDE link ids stored in the document (ADR-030), one per project it was linked to. */
      linkIds: z.array(z.string().max(100)).max(50).optional(),
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

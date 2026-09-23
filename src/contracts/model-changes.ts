import { z } from 'zod';
export const modelChangesSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  modified: z.array(
    z.object({
      id: z.string(),
      geometry: z.boolean(),
      attributes: z.boolean(),
      nativeIdentity: z.boolean(),
    }),
  ),
});
export type ModelChanges = z.infer<typeof modelChangesSchema>;

import { z } from 'zod';
export const comparisonSchema = z.object({
  before: z.string(),
  after: z.string(),
  compatible: z.boolean(),
  reason: z.string().nullable(),
  rows: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.enum(['added', 'removed', 'changed', 'unchanged', 'incomparable']),
      delta: z.object({
        length: z.number().nullable(),
        area: z.number().nullable(),
        volume: z.number().nullable(),
      }),
    }),
  ),
});
export type Comparison = z.infer<typeof comparisonSchema>;

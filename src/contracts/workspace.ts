import { z } from 'zod';

export const requestStateSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
]);
export type RequestState = z.infer<typeof requestStateSchema>;
const id = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/);
const coordinate = z.number().finite().min(-100000).max(100000);
export const sketchSchema = z
  .object({
    plane: z.enum(['XY', 'XZ', 'YZ']),
    unit: z.literal('m'),
    role: z.enum(['reference', 'boundary', 'path', 'direction']),
    points: z
      .array(z.tuple([coordinate, coordinate]))
      .min(2)
      .max(1000),
  })
  .passthrough();
export const requestInputSchema = z
  .object({
    id,
    body: z.string().max(20000),
    permission: z.enum(['review', 'candidate']),
    provider: z.enum(['claude-cli', 'codex-cli', 'extension']),
    // Pin identity and basis are checked against project data by Workspace.
    pins: z.array(z.unknown()).max(100),
    sketches: z.array(sketchSchema).max(100),
    files: z
      .array(z.object({ name: z.string(), text: z.string().max(50000) }).passthrough())
      .max(100),
    host: z.enum(['rhino', 'zwcad']).optional(),
    baseRequestId: id.nullable().optional(),
    model: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,100}(?:\[1m\])?$/)
      .optional(),
    effort: z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  })
  .passthrough()
  .superRefine((input, context) => {
    if (
      input.provider === 'extension' &&
      (input.permission !== 'review' ||
        typeof input.extension !== 'string' ||
        !/^[a-z0-9-]{1,80}$/.test(input.extension) ||
        typeof input.extensionVersion !== 'string')
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid extension request' });
    }
    if (!input.body.trim() && !input.pins.length && !input.sketches.length && !input.files.length) {
      context.addIssue({ code: 'custom', message: 'Empty request' });
    }
  });
export type RequestInput = z.infer<typeof requestInputSchema>;

// Only the fields consumed by the work summary, not the full host result.
export interface WorkSummary {
  id: string;
  body: string;
  request?: { state: RequestState; result?: { phase?: string } | null };
}

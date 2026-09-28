import { z } from 'zod';
import { executionLimitsSchema } from './execution-limits.ts';

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
export const linkedTargetSchema = z
  .object({
    baseRequestId: id,
    host: z.enum(['rhino', 'zwcad']),
  })
  .strict();
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
    executionLimits: executionLimitsSchema.optional(),
    body: z.string().max(20000),
    permission: z.enum(['review', 'candidate']),
    applyToSource: z.boolean().optional(),
    provider: z.enum(['claude-cli', 'codex-cli', 'extension']),
    accountProfileId: z
      .string()
      .regex(/^(default|[0-9a-f-]{36})$/)
      .optional(),
    // Pin identity and basis are checked against project data by Workspace.
    pins: z.array(z.unknown()).max(100),
    sketches: z.array(sketchSchema).max(100),
    files: z
      .array(z.object({ name: z.string(), text: z.string().max(50000) }).passthrough())
      .max(100),
    host: z.enum(['rhino', 'zwcad']).optional(),
    baseRequestId: id.nullable().optional(),
    linkedTargets: z.array(linkedTargetSchema).length(2).optional(),
    coordinateBasis: z.literal('shared-metre-axes').optional(),
    model: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,100}(?:\[1m\])?$/)
      .optional(),
    effort: z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  })
  .passthrough()
  .superRefine((input, context) => {
    if (
      input.applyToSource &&
      (input.permission !== 'candidate' ||
        (input.host || 'rhino') !== 'rhino' ||
        !input.baseRequestId ||
        input.linkedTargets ||
        input.provider === 'extension')
    )
      context.addIssue({
        code: 'custom',
        message: 'A single explicit Rhino basis and candidate permission are required',
      });
    if (
      input.linkedTargets &&
      (input.coordinateBasis !== 'shared-metre-axes' ||
        new Set(input.linkedTargets.map((target) => target.baseRequestId)).size !== 2 ||
        input.provider === 'extension')
    )
      context.addIssue({
        code: 'custom',
        message: 'Explicit distinct targets and confirmed coordinates are required',
      });
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

export const executionProgressSchema = z
  .object({
    queries: z.number().int().min(0).max(100),
    attempts: z.number().int().min(0).max(48),
    completed: z.number().int().min(0).max(48),
  })
  .refine((value) => value.completed <= value.attempts);
export type ExecutionProgress = z.infer<typeof executionProgressSchema>;

// Only the fields consumed by the work summary, not the full host result.
export interface WorkSummary {
  id: string;
  body: string;
  request?: {
    input?: {
      executionLimits?: RequestInput['executionLimits'];
      parentRequestId?: unknown;
      linkedTargets?: RequestInput['linkedTargets'];
    };
    state: RequestState;
    result?: { phase?: string; code?: string; progress?: ExecutionProgress } | null;
  };
}

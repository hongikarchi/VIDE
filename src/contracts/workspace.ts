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
  // Auto mode tripped a guard (ADR-022 3): the host undid that execution; the card waits for the
  // user's [진행] (POST …/requests/:rid/confirm), which re-runs it with the guard released.
  'needs-confirmation',
]);
export type RequestState = z.infer<typeof requestStateSchema>;
/**
 * Plan / Auto (ADR-022 2, user decision 2026-09-30). `mode` replaces the old permission; old
 * values map review→plan, candidate|apply→auto. Absent both, a request runs in Auto (the default).
 */
export const requestModeSchema = z.enum(['plan', 'auto']);
export type RequestMode = z.infer<typeof requestModeSchema>;
export function requestMode(input: { mode?: unknown; permission?: unknown }): RequestMode {
  if (input.mode === 'plan' || input.mode === 'auto') return input.mode;
  return input.permission === 'review' ? 'plan' : 'auto';
}
/**
 * A stored input with both fields filled. Stored requests keep their submitted JSON (idempotency
 * compares it), so a row may carry only `mode` or only the old `permission`.
 */
export function withMode<T extends { mode?: unknown; permission?: unknown }>(input: T) {
  const mode = requestMode(input);
  return {
    ...input,
    mode,
    permission: mode === 'plan' ? ('review' as const) : ('candidate' as const),
  };
}
const id = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/);
const coordinate = z.number().finite().min(-100000).max(100000);
export const linkedTargetSchema = z
  .object({
    baseRequestId: id,
    host: z.enum(['rhino', 'zwcad']),
  })
  .strict();
const sketchRole = z.enum(['reference', 'boundary', 'path', 'direction']);
/** Plane polyline: U/V metres on XY/XZ/YZ through the origin (numeric entry, shared comments). */
export const planeSketchSchema = z.object({
  plane: z.enum(['XY', 'XZ', 'YZ']),
  unit: z.literal('m'),
  role: sketchRole,
  points: z
    .array(z.tuple([coordinate, coordinate]))
    .min(2)
    .max(1000),
});
export const sketchStrokeSchema = z
  .object({
    points: z
      .array(z.tuple([coordinate, coordinate, coordinate]))
      .min(2)
      .max(2000),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    width: z.number().min(0.5).max(64),
  })
  .strict();
/** Free brush sketch: world XYZ metre polylines projected onto a surface, the view or a plane. */
export const brushSketchSchema = z
  .object({
    unit: z.literal('m'),
    // What a sketch means (outline, path, direction) comes from the message; older ones name it.
    role: sketchRole.optional(),
    placement: z.enum(['surface', 'view', 'plane']),
    plane: z.enum(['XY', 'XZ', 'YZ']).optional(),
    planeOffset: coordinate.optional(),
    strokes: z.array(sketchStrokeSchema).min(1).max(200),
  })
  .passthrough()
  .refine(
    (value) => value.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0) <= 20000,
    'Sketch has too many points',
  );
export const sketchSchema = z.union([planeSketchSchema.passthrough(), brushSketchSchema]);
/** Images a turn shows the model (PLAN-24): at most 3, each a PNG/JPEG data URL of at most 1 MB. */
export const MAX_TURN_IMAGES = 3;
export const MAX_TURN_IMAGE_BYTES = 1_000_000;
export const imageItemSchema = z
  .object({
    // annotated: the viewport with the turn's sketch strokes and pin markers drawn on it.
    kind: z.enum(['viewport', 'annotated']),
    name: z.string().max(100).optional(),
    dataUrl: z
      .string()
      .max(Math.ceil((MAX_TURN_IMAGE_BYTES * 4) / 3) + 40)
      .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict()
  .refine((image) => {
    // Decoded size without Buffer (the schema also runs in the browser).
    const data = image.dataUrl.slice(image.dataUrl.indexOf(',') + 1);
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    return (data.length / 4) * 3 - padding <= MAX_TURN_IMAGE_BYTES;
  }, 'Image is larger than 1 MB');
export const requestInputSchema = z
  .object({
    id,
    executionLimits: executionLimitsSchema.optional(),
    body: z.string().max(20000),
    // Filled from each other on parse (see overwrite below): `mode` is the contract, `permission`
    // stays for the code paths that still read it (review = plan, candidate = auto).
    mode: requestModeSchema.optional(),
    permission: z.preprocess(
      (value) => (value === 'apply' ? 'candidate' : value),
      z.enum(['review', 'candidate']).default('candidate'),
    ),
    /** Deprecated with the candidate/apply flow (ADR-022); kept so stored requests still parse. */
    applyToSource: z.boolean().optional(),
    provider: z.enum(['claude-cli', 'codex-cli', 'extension']),
    accountProfileId: z
      .string()
      .regex(/^(default|[0-9a-f-]{36})$/)
      .optional(),
    // Pin identity and basis are checked against project data by Workspace.
    pins: z.array(z.unknown()).max(100),
    sketches: z.array(sketchSchema).max(100),
    images: z.array(imageItemSchema).max(MAX_TURN_IMAGES).optional(),
    files: z
      .array(z.object({ name: z.string(), text: z.string().max(50000) }).passthrough())
      .max(100),
    host: z.enum(['rhino', 'zwcad']).optional(),
    baseRequestId: id.nullable().optional(),
    linkedTargets: z.array(linkedTargetSchema).length(2).optional(),
    // shared-metre-axes: the user confirmed one origin and axes; align-by-features: the files are
    // placed differently and the AI establishes the relation from matching features first.
    coordinateBasis: z.enum(['shared-metre-axes', 'align-by-features']).optional(),
    model: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,100}(?:\[1m\])?$/)
      .optional(),
    effort: z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    // The conversation the turn belongs to (SPEC-02.19 1); absent: the project's default
    // conversation. Fixed at submission (ARCH-03 §10.3).
    conversationId: id.optional(),
  })
  .passthrough()
  // Normalize in place (keeps the object schema: `.shape` and `.safeExtend` still work).
  .overwrite((input) => {
    const mode = requestMode(input);
    input.mode = mode;
    input.permission = mode === 'plan' ? 'review' : 'candidate';
    return input;
  })
  .superRefine((input, context) => {
    // A guard is released only by the card's [진행] (POST …/confirm), never by a submitted field.
    if ('guardConfirmed' in input || 'guard' in input)
      context.addIssue({ code: 'custom', message: 'Guard confirmation is not a request field' });
    if (
      input.applyToSource &&
      (input.mode !== 'auto' ||
        (input.host || 'rhino') !== 'rhino' ||
        !input.baseRequestId ||
        input.linkedTargets ||
        input.provider === 'extension')
    )
      context.addIssue({
        code: 'custom',
        message: 'A single explicit Rhino basis and Auto mode are required',
      });
    if (
      input.linkedTargets &&
      (!input.coordinateBasis ||
        new Set(input.linkedTargets.map((target) => target.baseRequestId)).size !== 2 ||
        input.provider === 'extension')
    )
      context.addIssue({
        code: 'custom',
        message: 'Explicit distinct targets and confirmed coordinates are required',
      });
    if (
      input.provider === 'extension' &&
      (input.mode !== 'plan' ||
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
    result?: {
      phase?: string;
      code?: string;
      progress?: ExecutionProgress;
      activity?: unknown;
    } | null;
  };
}

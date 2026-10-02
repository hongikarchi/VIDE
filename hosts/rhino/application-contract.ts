import { z } from 'zod';
import { hostTargetSchema } from '../../src/contracts/host-documents.ts';
const movementSchema = z.object({ id: z.string(), delta: z.array(z.number()).length(3) });
export type Movement = z.infer<typeof movementSchema>;
export const applicationPayloadSchema = hostTargetSchema.extend({
  documentHash: z.string(),
  candidateHash: z.string(),
  movements: z.array(movementSchema).optional(),
});
export const applicationCandidateSchema = z.object({ filename: z.string() }).passthrough();
export const nativeApplicationPayloadSchema = applicationPayloadSchema.extend({
  movements: z.array(movementSchema).min(1).max(500),
});

// Direct mode (2026-09-30): the AI's code runs in the attached document, one undo record per run.
export const directGuardKinds = [
  'bulk-delete',
  'layer-delete',
  'purge',
  'save',
  'save-as',
  'export',
  'publish',
] as const;
export const directExecuteInputSchema = z.object({
  requestId: z.string().min(1).max(100),
  /** C# method body; `doc` (the document, its own units) and `output` (StringBuilder log) are in scope. */
  code: z.string().min(1).max(65536),
  /**
   * ADR-029: how `code` runs. csharp (default) as above; command, a Rhino command macro run by
   * RhinoApp.RunScript; python, a Rhino 8 Python 3 script (scriptcontext.doc is the document).
   */
  language: z.enum(['csharp', 'command', 'python']).optional(),
  label: z.string().max(80).optional(),
  guard: z
    .object({
      confirmed: z.boolean().default(false),
      maxDeletes: z.number().int().min(0).max(100000).default(50),
    })
    .default({ confirmed: false, maxDeletes: 50 }),
});
export type DirectExecuteInput = z.input<typeof directExecuteInputSchema>;
const changedObjectSchema = z.object({
  nativeId: z.string().uuid(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  layer: z.string(),
});
export const directChangesSchema = z.object({
  added: z.array(changedObjectSchema),
  changed: z.array(changedObjectSchema),
  removed: z.array(z.object({ nativeId: z.string().uuid(), layer: z.string() })),
  /** Full counts; the lists stop at 2000 entries each. */
  counts: z
    .object({
      added: z.number().int().nonnegative(),
      changed: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
    })
    .optional(),
  layers: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }).optional(),
});
export type DirectChanges = z.infer<typeof directChangesSchema>;
export const directExecuteResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** Null when the run changed nothing (no undo record to undo). */
    undoId: z.string().regex(/^\d+$/).nullable(),
    changes: directChangesSchema,
    log: z.string(),
    value: z.unknown().optional(),
    units: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    /** Present when a guard tripped: nothing stays applied; confirming re-runs with confirmed:true. */
    guarded: z
      .object({
        kind: z.enum(directGuardKinds),
        detail: z.string(),
        deletes: z.number().int().nonnegative().optional(),
        layers: z.number().int().nonnegative().optional(),
      })
      .optional(),
    code: z.string().optional(),
    reverted: z.boolean().optional(),
    diagnostics: z.array(z.string()).optional(),
    exceptionType: z.string().nullish(),
    message: z.string().optional(),
    log: z.string().optional(),
  }),
]);
export type DirectExecuteResult = z.infer<typeof directExecuteResultSchema>;
export const directUndoResultSchema = z.object({
  ok: z.boolean(),
  already: z.boolean().optional(),
  reason: z.enum(['not-latest', 'unknown', 'undo-failed']).optional(),
});
export const documentFingerprintSchema = z.object({
  ok: z.literal(true),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
});

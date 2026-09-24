import { z } from 'zod';
import { requestStateSchema, executionProgressSchema } from './workspace.ts';
// Fields consumed by the workspace UI. Unknown host metadata is preserved for later adapters.
const scene = z
  .object({
    id: z.string(),
    nativeId: z.string().optional(),
    nativeType: z.string().optional(),
    vertices: z.array(z.number()).optional(),
    indices: z.array(z.number()).optional(),
    line: z.array(z.number()).optional(),
    origin: z.array(z.number()).optional(),
    boundsSize: z.array(z.number()).optional(),
    length: z.number().nullish(),
    area: z.number().nullish(),
    volume: z.number().nullish(),
    layer64: z.string().optional(),
  })
  .passthrough();
export const applicationResultSchema = z
  .object({
    id: z.string(),
    state: z.string(),
    result: z.object({ code: z.string().optional() }).passthrough().nullish(),
  })
  .passthrough();
export const workspaceResultSchema = z
  .object({
    hostExecuted: z.boolean().optional(),
    host: z.enum(['rhino', 'zwcad']).optional(),
    phase: z.string().optional(),
    progress: executionProgressSchema.optional(),
    text: z.string().optional(),
    code: z.string().optional(),
    dwgEditMode: z.string().nullish(),
    sourceHash: z.string().optional(),
    baseRequestId: z.string().optional(),
    targetResults: z
      .array(
        z.object({
          requestId: z.string(),
          host: z.enum(['rhino', 'zwcad']),
          state: requestStateSchema,
          candidate: z.boolean().optional(),
        }),
      )
      .optional(),
    sourceDocument: z
      .object({
        name: z.string(),
        capturedAt: z.string(),
        instance: z.string(),
        documentId: z.number(),
      })
      .passthrough()
      .optional(),
    objects: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            kind: z.string(),
            origin: z.array(z.number()).optional(),
            nativeId: z.string().optional(),
            nativeSourceId: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    scene: z.array(scene).optional(),
    extensionResult: z
      .object({
        rows: z.array(
          z
            .object({
              type: z.string(),
              layer: z.string().nullish(),
              count: z.number(),
              objectIds: z.array(z.string()),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export const workspaceRequestSchema = z
  .object({
    id: z.string(),
    state: requestStateSchema,
    input: z.unknown().optional(),
    result: workspaceResultSchema.nullish(),
    applications: z.array(applicationResultSchema).optional(),
  })
  .passthrough();
export type WorkspaceRequest = z.infer<typeof workspaceRequestSchema>;

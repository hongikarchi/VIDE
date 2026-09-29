import { z } from 'zod';
import { requestStateSchema, executionProgressSchema } from './workspace.ts';
// Fields consumed by the workspace UI. Unknown host metadata is preserved for later adapters.
// CAD per-run/per-annotation display style: resolved ACI, true colour, lineweight (mm), layer colour.
const cadStyle = {
  ci: z.number().int().min(1).max(255).optional(),
  rgb: z.string().optional(),
  lw: z.number().nonnegative().optional(),
  layer: z.string().optional(),
};
const text = z
  .object({
    s: z.string().max(10000),
    p: z.array(z.number()).length(3),
    h: z.number().nonnegative(),
    r: z.number(),
    wf: z.number().positive().optional(),
    ax: z.number().int().min(0).max(2),
    ay: z.number().int().min(0).max(3),
    ...cadStyle,
  })
  .passthrough();
const scene = z
  .object({
    id: z.string(),
    nativeId: z.string().optional(),
    nativeType: z.string().optional(),
    vertices: z.array(z.number()).optional(),
    indices: z.array(z.number()).optional(),
    line: z.array(z.number()).optional(),
    segments: z.array(z.number()).optional(),
    origin: z.array(z.number()).optional(),
    boundsSize: z.array(z.number()).optional(),
    length: z.number().nullish(),
    area: z.number().nullish(),
    volume: z.number().nullish(),
    layer64: z.string().optional(),
    // Host-agnostic display colours: resolved #rrggbb, ACI 1–255, lineweight in mm.
    displayColor: z.string().optional(),
    layerColor: z.string().optional(),
    materialColor: z.string().nullish(),
    colorIndex: z.number().int().min(0).max(256).optional(),
    lineWeight: z.number().nonnegative().optional(),
    segmentStyles: z
      .array(z.object({ n: z.number().int().nonnegative(), ...cadStyle }).passthrough())
      .max(200000)
      .optional(),
    fills: z
      .array(
        z
          .object({ loops: z.array(z.array(z.number()).max(300000)).max(10000), ...cadStyle })
          .passthrough(),
      )
      .max(10000)
      .optional(),
    texts: z.array(text).max(20000).optional(),
    // Rhino block instance: shared definition geometry placed by a row-major 4x4 transform.
    block: z
      .object({ definition: z.string(), transform: z.array(z.number()).length(16) })
      .optional(),
  })
  .passthrough();
/** Rhino block definition display in definition space, shared by its instances. */
const definition = z
  .object({
    hash: z.string(),
    vertices: z.array(z.number()),
    indices: z.array(z.number()),
    segments: z.array(z.number()),
    texts: z.array(text).max(20000).optional(),
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
    displayCoverage: z
      .object({
        total: z.number().int().nonnegative(),
        displayed: z.number().int().nonnegative(),
        omitted: z.number().int().nonnegative(),
        omittedTypes: z.record(z.string(), z.number().int().nonnegative()),
        // Rhino reads (T-043): what the host left out before any row existed.
        omittedHidden: z.number().int().nonnegative().optional(),
        omittedFiltered: z.number().int().nonnegative().optional(),
        omittedBlockInternal: z.number().int().nonnegative().optional(),
        hiddenLayers: z
          .array(z.object({ path: z.string(), count: z.number().int().nonnegative() }))
          .optional(),
      })
      .optional(),
    hostExecuted: z.boolean().optional(),
    applicationId: z.string().optional(),
    applicationState: z.string().optional(),
    syncState: z.string().optional(),
    recovered: z.boolean().optional(),
    unchanged: z.boolean().optional(),
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
    definitions: z.record(z.string(), definition).optional(),
    /** List responses leave display meshes out; fetch the request to show it. */
    sceneOmitted: z.boolean().optional(),
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

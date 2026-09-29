import { z } from 'zod';
const point = z.tuple([z.number(), z.number(), z.number()]);
const hexColor = z.string().regex(/^#[0-9a-f]{6}$/);
export const displayObjectSchema = z.object({
  id: z.string(),
  nativeId: z.string().uuid(),
  kind: z.literal('native'),
  name: z.string(),
  origin: point,
});
/** Display label in display meters (same format as CAD `texts`). */
export const displayTextSchema = z.object({
  s: z.string().max(2000),
  p: point,
  h: z.number().nonnegative(),
  r: z.number(),
  ax: z.number().int().min(0).max(2),
  ay: z.number().int().min(0).max(3),
});
/** Flattened block definition geometry in definition space, shared by its instances. */
export const displayDefinitionSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  vertices: z.array(z.number()),
  indices: z.array(z.number().int().nonnegative()),
  segments: z.array(z.number()),
  texts: z.array(displayTextSchema).max(2000),
});
export const nativeSceneSchema = z.object({
  id: z.string(),
  nativeId: z.string().uuid(),
  nativeType: z.string(),
  geometryHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  name64: z.string(),
  origin: point,
  boundsSize: point,
  vertices: z.array(z.number()),
  indices: z.array(z.number().int().nonnegative()),
  line: z.array(z.number()),
  area: z.number().nonnegative().nullable(),
  volume: z.number().nonnegative().nullable(),
  length: z.number().nonnegative().nullable(),
  layer64: z.string(),
  // Optional display colors (#rrggbb); absent from older captures.
  displayColor: hexColor.optional(),
  layerColor: hexColor.optional(),
  materialColor: hexColor.nullish(),
  attributes64: z.array(z.tuple([z.string(), z.string()])),
  attributesComplete: z.boolean(),
  valid: z.literal(true),
  // Annotations/hatches: wire segments (xyz pairs) and labels. Block instances: definition + transform.
  segments: z.array(z.number()).optional(),
  texts: z.array(displayTextSchema).max(2000).optional(),
  block: z
    .object({ definition: z.string().uuid(), transform: z.array(z.number()).length(16) })
    .optional(),
});
export const displaySceneSchema = nativeSceneSchema.extend({ valid: z.boolean() });
const count = z.number().int().nonnegative();
/**
 * What a read lists (ARCH-03 §8): only the named layers (exact full paths), and hidden objects or
 * objects on hidden layers when asked. Absent: the display Sync (every visible object).
 */
export const readScopeSchema = z
  .object({
    layers: z.array(z.string().min(1).max(1000)).max(2000).optional(),
    includeHidden: z.boolean().optional(),
  })
  .strict();
export type ReadScope = z.infer<typeof readScopeSchema>;
/** The host's own count of what a read left out of the document (every page repeats it). */
export const sourceCoverageSchema = z.object({
  /** Top-level objects in the document (hidden included, block definition geometry excluded). */
  total: count,
  /** Objects the read lists (equals the page total). */
  displayed: count,
  /** Hidden objects and objects on hidden layers that the read did not list. */
  omittedHidden: count,
  /** Objects outside the read's layer filter (0 for a display Sync). */
  omittedFiltered: count,
  /** Objects inside block definitions; they travel with the definitions, never as objects. */
  omittedBlockInternal: count,
  /** Hidden layers with the number of objects each one kept out of the read. */
  hiddenLayers: z.array(z.object({ path: z.string(), count })).max(20000),
});
/** One layer of the document, empty layers included; `order` is the layer panel order. */
export const displayLayerSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  fullPath: z.string(),
  visible: z.boolean(),
  locked: z.boolean(),
  color: hexColor,
  order: z.number().int(),
  objectCount: count,
});
export const displayCoverageSchema = z.object({
  total: count,
  displayed: count,
  omitted: count,
  omittedTypes: z.record(z.string(), count),
  // From the host's read (absent in older captures and on other hosts): what never became a row.
  omittedHidden: count.optional(),
  omittedFiltered: count.optional(),
  omittedBlockInternal: count.optional(),
  hiddenLayers: sourceCoverageSchema.shape.hiddenLayers.optional(),
});
export const displayModelSchema = z
  .object({
    objects: z.array(displayObjectSchema).max(20000),
    scene: z.array(displaySceneSchema).max(20000),
    definitions: z.record(z.string().uuid(), displayDefinitionSchema).optional(),
    layers: z.array(displayLayerSchema).max(20000).optional(),
    measurementVersion: z.literal(1).optional(),
    displayCoverage: displayCoverageSchema.optional(),
    measurementStats: z
      .object({
        measuredObjects: z.number().int().nonnegative(),
        reusedObjects: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .superRefine((model, ctx) => {
    if (
      model.displayCoverage &&
      (model.displayCoverage.total !== model.objects.length ||
        model.displayCoverage.displayed + model.displayCoverage.omitted !==
          model.displayCoverage.total ||
        Object.values(model.displayCoverage.omittedTypes).reduce((sum, count) => sum + count, 0) !==
          model.displayCoverage.omitted ||
        (model.displayCoverage.hiddenLayers ?? []).reduce((sum, layer) => sum + layer.count, 0) >
          (model.displayCoverage.omittedHidden ?? 0))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid display coverage' });
    const objects = new Map(model.objects.map((object) => [object.id, object]));
    if (
      objects.size !== model.objects.length ||
      model.scene.length !== model.objects.length ||
      new Set(model.scene.map((scene) => scene.id)).size !== model.scene.length
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid object identity set' });
    for (const scene of model.scene) {
      if (
        objects.get(scene.id)?.nativeId !== scene.nativeId ||
        scene.vertices.length % 3 ||
        scene.indices.length % 3 ||
        scene.line.length % 3 ||
        (scene.segments?.length ?? 0) % 6 ||
        scene.indices.some((index) => index >= scene.vertices.length / 3) ||
        (scene.block && !model.definitions?.[scene.block.definition])
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid display geometry' });
    }
    for (const definition of Object.values(model.definitions ?? {}))
      if (
        definition.vertices.length % 3 ||
        definition.indices.length % 3 ||
        definition.segments.length % 6 ||
        definition.indices.some((index) => index >= definition.vertices.length / 3)
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid block definition geometry' });
  });
export const nativeModelSchema = displayModelSchema.superRefine((model, ctx) => {
  model.scene.forEach((scene, index) => {
    if (!scene.valid)
      ctx.addIssue({
        code: 'custom',
        path: ['scene', index, 'valid'],
        message: 'Invalid native geometry',
      });
  });
});
export type NativeModel = z.infer<typeof nativeModelSchema>;

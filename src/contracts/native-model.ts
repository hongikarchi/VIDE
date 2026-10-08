import { z } from 'zod';
import { isPacked, type PackedPositions } from './geometry-transfer.ts';
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
const count = z.number().int().nonnegative();
/**
 * What a read lists (ARCH-03 §8): only the named layers (exact full paths), and hidden objects or
 * objects on hidden layers when asked. Absent: the display Sync (every visible object).
 */
export const readScopeSchema = z
  .object({
    layers: z.array(z.string().min(1).max(1000)).optional(),
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
  hiddenLayers: z.array(z.object({ path: z.string(), count })),
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

type Numbers = ArrayLike<number>;
const some = (values: Numbers, test: (value: number) => boolean) => {
  for (let i = 0; i < values.length; i++) if (test(values[i])) return true;
  return false;
};
type Checked = {
  objects: { id: string; nativeId: string }[];
  scene: {
    id: string;
    nativeId: string;
    vertices: Numbers;
    indices: Numbers;
    line: Numbers;
    segments?: Numbers;
    block?: { definition: string };
  }[];
  definitions?: Record<string, { vertices: Numbers; indices: Numbers; segments: Numbers }>;
  displayCoverage?: z.infer<typeof displayCoverageSchema>;
};
function checkModel(model: Checked, ctx: z.RefinementCtx) {
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
      some(scene.indices, (index) => index >= scene.vertices.length / 3) ||
      (scene.block && !model.definitions?.[scene.block.definition])
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid display geometry' });
  }
  for (const definition of Object.values(model.definitions ?? {}))
    if (
      definition.vertices.length % 3 ||
      definition.indices.length % 3 ||
      definition.segments.length % 6 ||
      some(definition.indices, (index) => index >= definition.vertices.length / 3)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid block definition geometry' });
}

/**
 * The display schemas over one kind of coordinate and index array: plain numbers (JSON pages), or
 * also the typed arrays a binary (VGT1) host page arrives as (T-128, `packedDisplayModelSchema`).
 */
function displaySchemas<P extends z.ZodTypeAny, I extends z.ZodTypeAny>(positions: P, indices: I) {
  /** Flattened block definition geometry in definition space, shared by its instances. */
  const definition = z.object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    vertices: positions,
    indices,
    segments: positions,
    texts: z.array(displayTextSchema).max(2000),
    /**
     * Nested blocks expanded only in part (ARCH-01 「Rhino 네이티브 취득의 블록 보존」): a nested
     * definition was missing or the expansion passed its size limit. Counted as not shown in full.
     */
    partial: z.literal(true).optional(),
  });
  const native = z.object({
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
    vertices: positions,
    indices,
    line: positions,
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
    segments: positions.optional(),
    texts: z.array(displayTextSchema).max(2000).optional(),
    block: z
      .object({ definition: z.string().uuid(), transform: z.array(z.number()).length(16) })
      .optional(),
    /**
     * The object alone is larger than a host reply (16 MB, ADR-031 7): the geometry is its bounding
     * box and the coverage counts it as not shown in full.
     */
    oversized: z.literal(true).optional(),
  });
  const scene = native.extend({ valid: z.boolean() });
  const model = z
    .object({
      // No object count cap (ADR-031 7): the host pages its reads.
      objects: z.array(displayObjectSchema),
      scene: z.array(scene),
      definitions: z.record(z.string().uuid(), definition).optional(),
      layers: z.array(displayLayerSchema).optional(),
      measurementVersion: z.literal(1).optional(),
      displayCoverage: displayCoverageSchema.optional(),
      measurementStats: z
        .object({
          measuredObjects: z.number().int().nonnegative(),
          reusedObjects: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .superRefine((model, ctx) => checkModel(model as unknown as Checked, ctx));
  return { definition, native, scene, model };
}
const plain = displaySchemas(z.array(z.number()), z.array(z.number().int().nonnegative()));
/** Flattened block definition geometry in definition space, shared by its instances. */
export const displayDefinitionSchema = plain.definition;
export const nativeSceneSchema = plain.native;
export const displaySceneSchema = plain.scene;
export const displayModelSchema = plain.model;
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
/**
 * A display model whose coordinate and index arrays may stay as the binary page delivered them
 * (T-128): `PackedPositions` and `Uint16Array`/`Uint32Array`, checked by type and never copied. The
 * display Sync keeps them up to ModelStore, which stores their bytes as they are.
 */
export const packedDisplayModelSchema = displaySchemas(
  z.union([z.array(z.number()), z.custom<PackedPositions>(isPacked)]),
  z.union([
    z.array(z.number().int().nonnegative()),
    z.instanceof(Uint16Array),
    z.instanceof(Uint32Array),
  ]),
).model;
export type PackedDisplayModel = z.infer<typeof packedDisplayModelSchema>;

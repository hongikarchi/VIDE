import { z } from 'zod';
const point = z.tuple([z.number(), z.number(), z.number()]);
const object = z.object({
  id: z.string(),
  nativeId: z.string().uuid(),
  kind: z.literal('native'),
  name: z.string(),
  origin: point,
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
  attributes64: z.array(z.tuple([z.string(), z.string()])),
  attributesComplete: z.boolean(),
  valid: z.literal(true),
});
export const nativeModelSchema = z
  .object({
    objects: z.array(object).max(20000),
    scene: z.array(nativeSceneSchema).max(20000),
    measurementVersion: z.literal(1).optional(),
    displayCoverage: z
      .object({
        total: z.number().int().nonnegative(),
        displayed: z.number().int().nonnegative(),
        omitted: z.number().int().nonnegative(),
        omittedTypes: z.record(z.string(), z.number().int().nonnegative()),
      })
      .optional(),
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
          model.displayCoverage.omitted)
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
        scene.indices.some((index) => index >= scene.vertices.length / 3)
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid display geometry' });
    }
  });
export type NativeModel = z.infer<typeof nativeModelSchema>;

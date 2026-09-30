import { z } from 'zod';

/**
 * The AI's eyes on a Rhino document (PLAN-24): a PNG of the model view and measurements of named
 * objects, served by the worker plugin's fixed `captureView`/`measure` methods (ViewTools.cs) on
 * a hidden working copy or an attached editor. Neither runs agent code or changes the document;
 * camera and layer switches for a capture are undone before it returns.
 */
export const MAX_CAPTURE_SIZE = 1600;
export const MAX_IMAGE_BYTES = 1_000_000;
const failure = (code: string) => Object.assign(new Error(code), { code });
const point = z.tuple([z.number(), z.number(), z.number()]);
const objectId = z.string().min(1).max(100);
const layerPath = z.string().min(1).max(1000);

export const captureViewOptionsSchema = z
  .object({
    width: z.number().int().min(64).max(MAX_CAPTURE_SIZE).optional(),
    height: z.number().int().min(64).max(MAX_CAPTURE_SIZE).optional(),
    /** A named view of the document to look through. */
    namedView: z.string().min(1).max(200).optional(),
    /** Frame these objects (VIDE or native ids). */
    fitIds: z.array(objectId).min(1).max(50).optional(),
    showLayers: z.array(layerPath).max(200).optional(),
    hideLayers: z.array(layerPath).max(200).optional(),
  })
  .strict();
export type CaptureViewOptions = z.infer<typeof captureViewOptionsSchema>;
export const capturedViewSchema = z.object({
  ok: z.literal(true),
  mimeType: z.literal('image/png'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  data: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  view: z.string(),
  units: z.string(),
  camera: z.object({ location: point, target: point, parallel: z.boolean() }),
});
export type CapturedView = z.infer<typeof capturedViewSchema>;

const distanceEnd = z.union([objectId, point]);
export const measureOptionsSchema = z
  .object({
    ids: z.array(objectId).max(50).optional(),
    distances: z
      .array(z.object({ a: distanceEnd, b: distanceEnd }).strict())
      .max(20)
      .optional(),
  })
  .strict()
  .refine((value) => value.ids?.length || value.distances?.length, 'Nothing to measure');
export type MeasureOptions = z.infer<typeof measureOptionsSchema>;
const nullableNumber = z.number().nullable().optional();
export const measurementSchema = z.object({
  ok: z.literal(true),
  units: z.string(),
  objects: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      bounds: z.tuple([point, point]),
      size: point,
      length: nullableNumber,
      area: nullableNumber,
      volume: nullableNumber,
    }),
  ),
  distances: z.array(
    z.object({
      distance: z.number(),
      from: point,
      to: point,
      dx: z.number(),
      dy: z.number(),
      dz: z.number(),
      method: z.enum(['exact', 'intersecting', 'edges', 'vertices', 'centers']),
    }),
  ),
});
export type Measurement = z.infer<typeof measurementSchema>;

function reply<T>(schema: z.ZodType<T>, value: unknown): T {
  const error = z.object({ ok: z.literal(false), code: z.string() }).safeParse(value);
  if (error.success) throw failure(error.data.code);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw failure('HOST_INVALID_RESPONSE');
  return parsed.data;
}

/** The two read methods on a worker or editor command channel. */
export function viewMethods(
  call: (method: string, extra?: Record<string, unknown>) => Promise<unknown>,
) {
  return {
    async captureView(options: CaptureViewOptions = {}): Promise<CapturedView> {
      const parsed = captureViewOptionsSchema.safeParse(options);
      if (!parsed.success) throw failure('INVALID_INPUT');
      const image = reply(capturedViewSchema, await call('captureView', parsed.data));
      if (Buffer.byteLength(image.data, 'base64') > MAX_IMAGE_BYTES)
        throw failure('QUERY_RESULT_TOO_LARGE');
      return image;
    },
    async measure(options: MeasureOptions): Promise<Measurement> {
      const parsed = measureOptionsSchema.safeParse(options);
      if (!parsed.success) throw failure('INVALID_INPUT');
      return reply(measurementSchema, await call('measure', parsed.data));
    },
  };
}

import { z } from 'zod';

export const queryPageFields = {
  offset: z.number().int().min(0).max(1000000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  objectIds: z.array(z.string().min(1).max(256)).min(1).max(100).optional(),
  /** `page.cursor` of the previous page: its revision and next offset in one value. */
  cursor: z
    .string()
    .regex(/^\d{1,15}:\d{1,7}$/)
    .optional(),
};
const optionsSchema = z.object(queryPageFields);
export type QueryPageOptions = z.infer<typeof optionsSchema>;
const rowSchema = z.object({ id: z.string() }).passthrough();
const modelSchema = z.object({
  objects: z.array(rowSchema),
  scene: z.array(rowSchema).optional(),
  sourceUnits: z.number().optional(),
  scope: z.string().optional(),
  referenceOnly: z.boolean().optional(),
  dwgEditMode: z.string().nullish(),
  importMode: z.string().optional(),
  verified: z.boolean().optional(),
});
const snapshotSchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  uncertain: z.boolean().optional(),
  units: z.string().optional(),
  objects: z.array(rowSchema).optional(),
  model: modelSchema.optional(),
});
const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};
/** A cursor stands for offset + expectedRevision; giving both forms at once is ambiguous. */
function cursorOptions(input: QueryPageOptions): QueryPageOptions {
  if (input.cursor === undefined) return input;
  if (input.offset !== undefined || input.expectedRevision !== undefined) fail('INVALID_INPUT');
  const [revision, offset] = input.cursor.split(':').map(Number);
  if (offset > 1000000) fail('INVALID_INPUT');
  return { ...input, offset, expectedRevision: revision };
}

/** Bound agent output only; full snapshots remain in the native verification path. */
export function queryPage(raw: unknown, options: QueryPageOptions = {}, revision?: number) {
  const input = cursorOptions(optionsSchema.parse(options));
  const snapshot = snapshotSchema.parse(raw);
  const currentRevision = snapshot.revision ?? revision ?? 0;
  const offset = input.offset ?? 0;
  if (offset > 0 && input.expectedRevision === undefined) fail('INVALID_INPUT');
  if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision)
    fail('STALE_REFERENCE');
  const model = snapshot.model;
  const all = model?.objects ?? snapshot.objects ?? [];
  const ids = input.objectIds && new Set(input.objectIds);
  const filtered = ids ? all.filter((row) => ids.has(row.id)) : all;
  const scene = new Map((model?.scene ?? []).map((row) => [row.id, row]));
  const objects: z.infer<typeof rowSchema>[] = [];
  const measurements: z.infer<typeof rowSchema>[] = [];
  let bytes = 4;
  for (const row of filtered.slice(offset, offset + (input.limit ?? 50))) {
    const measure = scene.get(row.id);
    const size =
      Buffer.byteLength(JSON.stringify(row)) +
      (measure ? Buffer.byteLength(JSON.stringify(measure)) : 0) +
      2;
    if (bytes + size > 64 * 1024) {
      if (!objects.length) fail('QUERY_RESULT_TOO_LARGE');
      break;
    }
    bytes += size;
    objects.push(row);
    if (measure) measurements.push(measure);
  }
  const next = offset + objects.length;
  const metadata = model && (({ objects: _objects, scene: _scene, ...rest }) => rest)(model);
  return {
    ok: true,
    revision: currentRevision,
    uncertain: snapshot.uncertain,
    units: snapshot.units,
    ...(model ? { model: { ...metadata, objects, scene: measurements } } : { objects }),
    page: {
      offset,
      total: filtered.length,
      nextOffset: next < filtered.length ? next : null,
      cursor: next < filtered.length ? `${currentRevision}:${next}` : null,
    },
  };
}

import { z } from 'zod';
import { nativeModelSchema, type NativeModel } from '../../src/contracts/native-model.ts';
import { sceneRepresentation } from '../../src/core/scene-representation.ts';

const pageSchema = z.object({
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(),
  total: z.number().int().min(0).max(20000),
  revision: z.number().int().nonnegative(),
});
const failure = (code: string) => Object.assign(new Error(code), { code });

/** Only explicit oversized read replies may retry; execution is never repeated. */
export async function readScenePages(
  call: (params: Record<string, unknown>) => Promise<unknown>,
  caches: Record<string, unknown> = {},
  maxBytes = 32 * 1024 * 1024,
): Promise<NativeModel> {
  let offset = 0,
    limit = 1000,
    revision: number | undefined,
    total: number | undefined,
    bytes = 0;
  const objects: NativeModel['objects'] = [],
    scene: NativeModel['scene'] = [];
  const ids = new Set<string>(),
    nativeIds = new Set<string>();
  const measurementStats = { measuredObjects: 0, reusedObjects: 0 };
  const cache = Buffer.byteLength(JSON.stringify(caches)) <= 2 * 1024 * 1024 ? caches : {};
  do {
    const raw = await call({
      offset,
      limit,
      ...(revision === undefined ? {} : { revision }),
      ...cache,
    });
    const error = z.object({ ok: z.literal(false), code: z.string() }).safeParse(raw);
    if (error.success) {
      if (error.data.code === 'HOST_RESULT_TOO_LARGE' && limit > 1) {
        limit = Math.max(1, Math.floor(limit / 2));
        continue;
      }
      throw failure(error.data.code);
    }
    bytes += Buffer.byteLength(JSON.stringify(raw));
    if (bytes > maxBytes) throw failure('HOST_RESULT_TOO_LARGE');
    const page = pageSchema.parse(z.object({ page: pageSchema }).parse(raw).page);
    const model = nativeModelSchema.parse(raw);
    if (
      page.offset !== offset ||
      page.nextOffset !== offset + model.objects.length ||
      model.objects.length > limit ||
      page.nextOffset > page.total ||
      (page.total > offset && model.objects.length === 0) ||
      (revision !== undefined && (revision !== page.revision || total !== page.total))
    )
      throw failure('HOST_INVALID_RESPONSE');
    revision = page.revision;
    total = page.total;
    for (const object of model.objects) {
      if (ids.has(object.id) || nativeIds.has(object.nativeId))
        throw failure('HOST_INVALID_RESPONSE');
      ids.add(object.id);
      nativeIds.add(object.nativeId);
    }
    objects.push(...model.objects);
    scene.push(...model.scene);
    measurementStats.measuredObjects += model.measurementStats?.measuredObjects ?? 0;
    measurementStats.reusedObjects += model.measurementStats?.reusedObjects ?? 0;
    offset = page.nextOffset;
  } while (total === undefined || offset < total);
  const omittedTypes: Record<string, number> = Object.create(null);
  let omitted = 0;
  for (const item of scene)
    if (!sceneRepresentation(item)) {
      omitted++;
      omittedTypes[item.nativeType] = (omittedTypes[item.nativeType] ?? 0) + 1;
    }
  return nativeModelSchema.parse({
    objects,
    scene,
    measurementVersion: 1,
    measurementStats,
    displayCoverage: {
      total: objects.length,
      displayed: objects.length - omitted,
      omitted,
      omittedTypes,
    },
  });
}

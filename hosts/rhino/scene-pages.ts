import { z } from 'zod';
import {
  nativeModelSchema,
  displayModelSchema,
  displayLayerSchema,
  sourceCoverageSchema,
  type NativeModel,
  type ReadScope,
} from '../../src/contracts/native-model.ts';
import { displayCoverage } from '../../src/core/display-delta.ts';

const pageSchema = z.object({
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(),
  total: z.number().int().min(0),
  revision: z.number().int().nonnegative(),
});
/** The host's survey of the read (T-043 plugin); absent from an older plugin's pages. */
const surveySchema = z.object({
  coverage: sourceCoverageSchema.optional(),
  layers: z.array(displayLayerSchema).optional(),
});
const failure = (code: string) => Object.assign(new Error(code), { code });

/** The host's omission counts and layer table merged into a finished model's coverage. */
export function withSurvey<
  T extends { scene: NativeModel['scene']; definitions?: NativeModel['definitions'] },
>(model: T, survey: z.infer<typeof surveySchema>) {
  const { coverage, layers } = survey;
  return {
    ...model,
    ...(layers ? { layers } : {}),
    displayCoverage: {
      ...displayCoverage(model.scene, model.definitions),
      ...(coverage
        ? {
            omittedHidden: coverage.omittedHidden,
            omittedFiltered: coverage.omittedFiltered,
            omittedBlockInternal: coverage.omittedBlockInternal,
            hiddenLayers: coverage.hiddenLayers,
          }
        : {}),
    },
  };
}

/**
 * Only explicit oversized read replies may retry; execution is never repeated. A document has no
 * object count or total size cap (ADR-031 7): pages shrink until they fit one host reply (16 MB)
 * and grow back after, and one object larger than a reply is read again as its bounding box
 * (`oversized`, counted in the coverage), so the read continues.
 */
export async function readScenePages(
  call: (params: Record<string, unknown>) => Promise<unknown>,
  caches: Record<string, unknown> = {},
  maxBytes = Infinity,
  displayOnly = false,
  scope: ReadScope = {},
): Promise<NativeModel> {
  const schema = displayOnly ? displayModelSchema : nativeModelSchema;
  let offset = 0,
    limit = 1000,
    revision: number | undefined,
    total: number | undefined,
    bytes = 0,
    boxOnly = false;
  const objects: NativeModel['objects'] = [],
    scene: NativeModel['scene'] = [];
  const definitions: NonNullable<NativeModel['definitions']> = {};
  const ids = new Set<string>(),
    nativeIds = new Set<string>();
  const measurementStats = { measuredObjects: 0, reusedObjects: 0 };
  let survey: z.infer<typeof surveySchema> = {};
  const cache = Buffer.byteLength(JSON.stringify(caches)) <= 2 * 1024 * 1024 ? caches : {};
  do {
    const raw = await call({
      offset,
      limit,
      ...(revision === undefined ? {} : { revision }),
      ...(scope.layers ? { layers: scope.layers } : {}),
      ...(scope.includeHidden ? { includeHidden: true } : {}),
      ...(boxOnly ? { boxOnly: true } : {}),
      ...cache,
    });
    const error = z.object({ ok: z.literal(false), code: z.string() }).safeParse(raw);
    if (error.success) {
      if (error.data.code === 'HOST_RESULT_TOO_LARGE' && limit > 1) {
        limit = Math.max(1, Math.floor(limit / 2));
        continue;
      }
      if (error.data.code === 'HOST_RESULT_TOO_LARGE' && !boxOnly) {
        boxOnly = true;
        continue;
      }
      throw failure(error.data.code);
    }
    bytes += Buffer.byteLength(JSON.stringify(raw));
    if (bytes > maxBytes) throw failure('HOST_RESULT_TOO_LARGE');
    const page = pageSchema.parse(z.object({ page: pageSchema }).parse(raw).page);
    const model = schema.parse(raw);
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
    // Every page repeats the survey; the first one is kept, and its listed count must be the total.
    if (offset === 0) survey = surveySchema.parse(raw);
    if (survey.coverage && survey.coverage.displayed !== page.total)
      throw failure('HOST_INVALID_RESPONSE');
    for (const object of model.objects) {
      if (ids.has(object.id) || nativeIds.has(object.nativeId))
        throw failure('HOST_INVALID_RESPONSE');
      ids.add(object.id);
      nativeIds.add(object.nativeId);
    }
    objects.push(...model.objects);
    scene.push(...model.scene);
    Object.assign(definitions, model.definitions);
    measurementStats.measuredObjects += model.measurementStats?.measuredObjects ?? 0;
    measurementStats.reusedObjects += model.measurementStats?.reusedObjects ?? 0;
    offset = page.nextOffset;
    // After a shrunken page (or one object's box) the next pages grow back.
    boxOnly = false;
    limit = Math.min(1000, limit * 2);
  } while (total === undefined || offset < total);
  return schema.parse(
    withSurvey(
      {
        objects,
        scene,
        ...(Object.keys(definitions).length ? { definitions } : {}),
        measurementVersion: 1,
        measurementStats,
      },
      survey,
    ),
  );
}

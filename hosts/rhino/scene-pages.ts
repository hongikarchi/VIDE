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
import { jsonSafeGeometry, plainGeometry } from '../../src/contracts/geometry-transfer.ts';
import { packedDisplayModelSchema } from '../../src/contracts/native-model.ts';
import { expandNestedDefinitions } from './block-nesting.ts';

/** The scene items and block definitions of a page or model (where geometry arrays live). */
function geometryItems(value: unknown): unknown[] {
  const { scene, definitions } = (value ?? {}) as { scene?: unknown; definitions?: unknown };
  return [
    ...(Array.isArray(scene) ? scene : []),
    ...(definitions && typeof definitions === 'object' ? Object.values(definitions) : []),
  ];
}
/** A binary page's typed arrays as plain numbers (the JSON page an older plugin sends). */
export function plainPage<T>(page: T): T {
  for (const item of geometryItems(page)) plainGeometry(item);
  return page;
}

/**
 * How a read asks for and keeps geometry (T-128). `binary`: ask the plugin for VGT1 pages (an older
 * plugin ignores it and answers JSON). `typed`: a display read keeps the typed arrays up to
 * ModelStore instead of restoring number arrays (each gets a `toJSON`, so JSON of it is unchanged).
 */
export interface PageGeometry {
  binary?: boolean;
  typed?: boolean;
}

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
  geometry: PageGeometry = {},
): Promise<NativeModel> {
  const typed = displayOnly && geometry.typed === true;
  // A typed model's arrays may be typed views (`PackedDisplayModel`); only the display Sync asks
  // for it and hands the model to storage as it is.
  const schema = (
    typed ? packedDisplayModelSchema : displayOnly ? displayModelSchema : nativeModelSchema
  ) as typeof nativeModelSchema;
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
      ...(geometry.binary ? { geometry: 'vgt1' } : {}),
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
    for (const item of geometryItems(raw)) (typed ? jsonSafeGeometry : plainGeometry)(item);
    // Nested blocks arrive as references between definitions; the model keeps them expanded.
    expandNestedDefinitions(raw, { typed });
    // Only a read with a total cap measures its pages (writing them as JSON again costs time).
    if (maxBytes !== Infinity) {
      bytes += Buffer.byteLength(JSON.stringify(raw));
      if (bytes > maxBytes) throw failure('HOST_RESULT_TOO_LARGE');
    }
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

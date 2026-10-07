// VWorld 2D 데이터 API (`req/data GetFeature`), shared by the layer adapters. HTTP 200 carries
// `status` OK / NOT_FOUND (empty, not an error) / ERROR {code}. `size` is 1–1000 (1001 answers
// INVALID_RANGE), `record.total` tells how many match, and a box filter may cover at most 2 km²,
// so box reads are tiled and every page is read until the count is reached (SPIKE §2, 2026-10-08).

import { z } from 'zod';
import {
  SiteDataError,
  VWORLD_LAYERS,
  keyFor,
  numberOf,
  requestJson,
  type SiteDataContext,
  type SourceId,
} from '../http.ts';
import { tilesOf, type Bounds, type Position } from '../geometry.ts';
import type { Recorder } from '../snapshot.ts';

export const VWORLD_DATA = 'https://api.vworld.kr/req/data';
/** Every geometry is asked for in the Korea 2000 central belt (metres). */
export const CRS = 'EPSG:5186';
export const MAX_SIZE = 1000;

const count = z.union([z.string(), z.number()]).transform((value, context) => {
  const parsed = numberOf(value);
  if (parsed === null || parsed < 0) {
    context.addIssue({ code: 'custom', message: 'count' });
    return z.NEVER;
  }
  return parsed;
});

const envelope = z.object({
  response: z.object({
    status: z.string(),
    error: z.object({ code: z.string(), text: z.string().optional() }).passthrough().optional(),
    record: z.object({ total: count, current: count }).passthrough().optional(),
    page: z.object({ total: count, current: count }).passthrough().optional(),
    result: z
      .object({
        featureCollection: z.object({
          features: z.array(
            z
              .object({
                geometry: z.unknown().optional(),
                properties: z.record(z.string(), z.unknown()),
                id: z.union([z.string(), z.number()]).optional(),
              })
              .passthrough(),
          ),
        }),
      })
      .passthrough()
      .optional(),
  }),
});

export interface Feature {
  id: string;
  geometry: unknown;
  properties: Record<string, unknown>;
}

/** VWorld error codes (in a 200 body: INVALID_KEY, INCORRECT_KEY, INVALID_RANGE, …) → failures. */
export const vworldFailure = (source: SourceId, code: string) =>
  new SiteDataError(code === 'OVER_REQUEST_LIMIT' ? 'LIMIT' : 'REJECTED', source, code);

export type Filter = { attr: string } | { point: Position } | { box: Bounds };

function filterParams(filter: Filter): Record<string, string> {
  if ('attr' in filter) return { attrFilter: filter.attr };
  if ('point' in filter) return { geomFilter: `POINT(${filter.point[0]} ${filter.point[1]})` };
  const { minX, minY, maxX, maxY } = filter.box;
  return { geomFilter: `BOX(${minX},${minY},${maxX},${maxY})` };
}

export interface PageRead {
  features: Feature[];
  /** `record.total` of the filter (summed over tiles). */
  total: number;
  /** Features received before de-duplication. */
  received: number;
  /** Stopped at the page cap before the count was reached. */
  truncated: boolean;
}

/** One filter, every page (up to `maxPages`). */
export async function readLayer(
  context: SiteDataContext,
  source: SourceId,
  recorder: Recorder,
  layer: string,
  filter: Filter,
  options: { geometry: boolean; size?: number; maxPages?: number },
): Promise<PageRead> {
  if (!VWORLD_LAYERS.has(layer)) throw new SiteDataError('FORBIDDEN_ENDPOINT', source, layer);
  const size = options.size ?? MAX_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE)
    throw new SiteDataError('BAD_RESPONSE', source, 'size');
  const key = keyFor(context, source);
  const domain = context.keys.VWORLD_DOMAIN?.trim();
  const features: Feature[] = [];
  let total = 0;
  for (let page = 1; page <= (options.maxPages ?? 30); page++) {
    const params = {
      service: 'data',
      request: 'GetFeature',
      data: layer,
      format: 'json',
      crs: CRS,
      geometry: String(options.geometry),
      size: String(size),
      page: String(page),
      ...filterParams(filter),
    };
    recorder.note(VWORLD_DATA, params, layer);
    const reply = await requestJson(context, source, VWORLD_DATA, {
      ...params,
      key,
      ...(domain ? { domain } : {}),
    });
    const parsed = envelope.safeParse(reply.json);
    if (!parsed.success) throw new SiteDataError('BAD_RESPONSE', source, `http-${reply.status}`);
    const { status, error, record, page: pages, result } = parsed.data.response;
    if (status === 'NOT_FOUND')
      return { features, total, received: features.length, truncated: false };
    if (status === 'ERROR') throw vworldFailure(source, error?.code ?? 'ERROR');
    if (status !== 'OK' || !result || !record)
      throw new SiteDataError('BAD_RESPONSE', source, status);
    total = record.total;
    const list = result.featureCollection.features;
    list.forEach((feature, index) =>
      features.push({
        id: String(feature.id ?? `${layer}:${page}:${index}`),
        geometry: feature.geometry,
        properties: feature.properties,
      }),
    );
    if (features.length >= total || !list.length || (pages && page >= pages.total))
      return { features, total, received: features.length, truncated: false };
  }
  return { features, total, received: features.length, truncated: features.length < total };
}

/**
 * A box read split into ≤ 2 km² tiles; features met in two tiles count once (by `keyOf`).
 * `total` is the sum of the tiles' counts, so `received < total` means pages were missed.
 */
export async function readBox(
  context: SiteDataContext,
  source: SourceId,
  recorder: Recorder,
  layer: string,
  box: Bounds,
  options: { geometry: boolean; maxPages?: number; keyOf?: (feature: Feature) => string },
): Promise<PageRead> {
  const seen = new Map<string, Feature>();
  let total = 0;
  let received = 0;
  let truncated = false;
  for (const tile of tilesOf(box)) {
    const read = await readLayer(context, source, recorder, layer, { box: tile }, options);
    total += read.total;
    received += read.received;
    truncated ||= read.truncated;
    for (const feature of read.features) {
      const key = options.keyOf?.(feature) ?? feature.id;
      if (!seen.has(key)) seen.set(key, feature);
    }
  }
  return { features: [...seen.values()], total, received, truncated };
}

/** '확인 필요' lines for a read: nothing at all, or fewer features than the service counted. */
export function readChecks(read: PageRead, what: string) {
  const checks: string[] = [];
  if (read.received === 0) checks.push(`${what}: 응답 0건`);
  if (read.truncated || read.received < read.total)
    checks.push(`${what}: 전체 ${read.total}건 중 ${read.received}건만 받음`);
  return checks;
}

/** Features converted by `of`; the ones it rejects are counted (형식이 다른 응답은 쓰지 않음). */
export function convertFeatures<T>(features: Feature[], of: (feature: Feature) => T | null) {
  const items: T[] = [];
  let malformed = 0;
  for (const feature of features) {
    const item = of(feature);
    if (item) items.push(item);
    else malformed++;
  }
  return { items, malformed };
}

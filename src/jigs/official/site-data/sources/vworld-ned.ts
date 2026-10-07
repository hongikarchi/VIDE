// VWorld NED 속성 API (`ned/data/*`, PNU filter). The body is `{<root>: {field[], totalCount,
// resultCode, …}}`; an empty answer comes under `response` with totalCount 0, and an error as
// `{<root>: {resultCode: 'INVALID_KEY', resultMsg}}` — all in HTTP 200 (2026-10-08 실호출).

import { z } from 'zod';
import {
  SiteDataError,
  keyFor,
  listOf,
  numberOf,
  requestJson,
  type SiteDataContext,
  type SourceId,
} from '../http.ts';
import type { Recorder } from '../snapshot.ts';

const body = z
  .object({
    field: z.unknown().optional(),
    totalCount: z.union([z.string(), z.number()]).optional(),
    resultCode: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export async function readNed(
  context: SiteDataContext,
  source: SourceId,
  recorder: Recorder,
  endpoint: string,
  root: string,
  params: Record<string, string>,
  maxPages = 5,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const key = keyFor(context, source);
  const domain = context.keys.VWORLD_DOMAIN?.trim();
  const rows: Record<string, unknown>[] = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const sent = { ...params, format: 'json', numOfRows: '100', pageNo: String(page) };
    recorder.note(endpoint, sent);
    const reply = await requestJson(context, source, endpoint, {
      ...sent,
      key,
      ...(domain ? { domain } : {}),
    });
    const top =
      reply.json && typeof reply.json === 'object' ? (reply.json as Record<string, unknown>) : null;
    const parsed = body.safeParse(top?.[root] ?? top?.response);
    if (!parsed.success) throw new SiteDataError('BAD_RESPONSE', source, `http-${reply.status}`);
    const code = String(parsed.data.resultCode ?? '').trim();
    if (code === 'OVER_REQUEST_LIMIT') throw new SiteDataError('LIMIT', source, code);
    if (code && code !== '0' && code !== '00' && code !== 'OK')
      throw new SiteDataError('REJECTED', source, code);
    const count = numberOf(parsed.data.totalCount);
    if (count === null) throw new SiteDataError('BAD_RESPONSE', source, 'totalCount');
    total = count;
    const list = listOf(parsed.data.field).filter(
      (row): row is Record<string, unknown> => !!row && typeof row === 'object',
    );
    rows.push(...list);
    if (rows.length >= total || !list.length) break;
  }
  return { rows, total };
}

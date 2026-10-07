// VWorld 검색 API (`req/search type=address`, 2026-10-08 실호출): several candidates whose `id` is a
// PNU, with the parcel and road address and a point. Used for address candidates when this PC has
// no JUSO_KEY. `status` NOT_FOUND is an empty list.

import { z } from 'zod';
import {
  SiteDataError,
  keyFor,
  numberOf,
  requestJson,
  textOf,
  type SiteDataContext,
} from '../http.ts';
import { isPnu, splitPnu } from '../pnu.ts';
import type { Recorder } from '../snapshot.ts';
import type { AddressCandidate } from './juso.ts';
import { CRS, vworldFailure } from './vworld-data.ts';

export const VWORLD_SEARCH = 'https://api.vworld.kr/req/search';
const SOURCE = 'vworld-search' as const;

const envelope = z.object({
  response: z.object({
    status: z.string(),
    error: z.object({ code: z.string() }).passthrough().optional(),
    record: z
      .object({ total: z.union([z.string(), z.number()]) })
      .passthrough()
      .optional(),
    result: z
      .object({
        items: z.array(
          z
            .object({
              id: z.union([z.string(), z.number()]),
              address: z.record(z.string(), z.unknown()).optional(),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .optional(),
  }),
});

/** Candidates for an address; `category` parcel for a 지번 address, road for a 도로명 address. */
export async function searchCandidates(
  context: SiteDataContext,
  recorder: Recorder,
  query: string,
  category: 'parcel' | 'road',
) {
  const key = keyFor(context, SOURCE);
  const params = {
    service: 'search',
    request: 'search',
    version: '2.0',
    crs: CRS,
    size: '100',
    page: '1',
    query,
    type: 'address',
    category,
    format: 'json',
  };
  recorder.note(VWORLD_SEARCH, params);
  const reply = await requestJson(context, SOURCE, VWORLD_SEARCH, { ...params, key });
  const parsed = envelope.safeParse(reply.json);
  if (!parsed.success) throw new SiteDataError('BAD_RESPONSE', SOURCE, `http-${reply.status}`);
  const { status, error, record, result } = parsed.data.response;
  if (status === 'NOT_FOUND') return { candidates: [] as AddressCandidate[], total: 0 };
  if (status === 'ERROR') throw vworldFailure(SOURCE, error?.code ?? 'ERROR');
  if (status !== 'OK' || !result) throw new SiteDataError('BAD_RESPONSE', SOURCE, status);
  const candidates: AddressCandidate[] = [];
  for (const item of result.items) {
    const pnu = String(item.id);
    if (!isPnu(pnu) || candidates.some((known) => known.pnu === pnu)) continue;
    const parts = splitPnu(pnu);
    candidates.push({
      pnu,
      jibunAddress: textOf(item.address?.parcel),
      roadAddress: textOf(item.address?.road),
      buildingName: textOf(item.address?.bldnm),
      ...parts,
      source: 'vworld-search',
    });
  }
  return { candidates, total: numberOf(record?.total) ?? candidates.length };
}

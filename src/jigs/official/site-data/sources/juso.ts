// 주소 검색 API (`addrLinkApi.do`, JUSO_KEY, SPIKE §1): every candidate with 법정동코드 `admCd`,
// 산 여부 `mtYn`, 본번·부번 → PNU. HTTP 200 carries `results.common.errorCode` ('0' = 정상;
// E0001 unapproved key, E0014 expired key, …). `countPerPage` is at most 100.

import { z } from 'zod';
import {
  SiteDataError,
  keyFor,
  numberOf,
  requestJson,
  textOf,
  type SiteDataContext,
} from '../http.ts';
import { buildPnu } from '../pnu.ts';
import type { Recorder } from '../snapshot.ts';

export const JUSO = 'https://business.juso.go.kr/addrlink/addrLinkApi.do';
const SOURCE = 'juso' as const;
const PER_PAGE = 100;

const envelope = z.object({
  results: z.object({
    common: z
      .object({
        errorCode: z.union([z.string(), z.number()]),
        totalCount: z.union([z.string(), z.number()]),
      })
      .passthrough(),
    juso: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  }),
});

export interface AddressCandidate {
  pnu: string;
  jibunAddress: string | null;
  roadAddress: string | null;
  buildingName: string | null;
  legalDong: string;
  mountain: boolean;
  main: number;
  sub: number;
  /** Where the candidate came from ('input': a typed PNU). */
  source: 'juso' | 'vworld-search' | 'input';
}

export function jusoCandidateOf(row: Record<string, unknown>): AddressCandidate | null {
  const legalDong = textOf(row.admCd);
  const main = numberOf(row.lnbrMnnm);
  const sub = numberOf(row.lnbrSlno) ?? 0;
  const mountain = textOf(row.mtYn) === '1';
  if (!legalDong || main === null) return null;
  const pnu = buildPnu(legalDong, mountain, main, sub);
  if (!pnu) return null;
  return {
    pnu,
    jibunAddress: textOf(row.jibunAddr),
    roadAddress: textOf(row.roadAddr),
    buildingName: textOf(row.bdNm),
    legalDong,
    mountain,
    main,
    sub,
    source: 'juso',
  };
}

/** Candidates for `keyword` (up to `limit`), and how many the service counted. */
export async function jusoCandidates(
  context: SiteDataContext,
  recorder: Recorder,
  keyword: string,
  limit = 100,
) {
  const key = keyFor(context, SOURCE);
  const candidates: AddressCandidate[] = [];
  let total = 0;
  for (let page = 1; candidates.length < limit; page++) {
    const params = {
      currentPage: String(page),
      countPerPage: String(PER_PAGE),
      keyword,
      resultType: 'json',
    };
    recorder.note(JUSO, params);
    const reply = await requestJson(context, SOURCE, JUSO, { ...params, confmKey: key });
    const parsed = envelope.safeParse(reply.json);
    if (!parsed.success) throw new SiteDataError('BAD_RESPONSE', SOURCE, `http-${reply.status}`);
    const code = String(parsed.data.results.common.errorCode);
    if (code !== '0') throw new SiteDataError('REJECTED', SOURCE, code);
    const count = numberOf(parsed.data.results.common.totalCount);
    if (count === null) throw new SiteDataError('BAD_RESPONSE', SOURCE, 'totalCount');
    total = count;
    const rows = parsed.data.results.juso ?? [];
    for (const row of rows) {
      const candidate = jusoCandidateOf(row);
      if (candidate && !candidates.some((known) => known.pnu === candidate.pnu))
        candidates.push(candidate);
    }
    if (rows.length < PER_PAGE || page * PER_PAGE >= total) break;
  }
  return { candidates: candidates.slice(0, limit), total };
}

// 건축HUB 건축물대장 표제부 `getBrTitleInfo` (DATA_GO_KR_KEY, SPIKE §4): height `heit` (0 = not
// recorded), 지상/지하 층수, 주용도, 대지·건축·연면적, 건폐율·용적률. The 표제부 holds no owner
// data. `pageNo` is always sent — without it the gateway ignores `numOfRows` and returns one row.
// Key and quota errors come from the gateway (`OpenAPI_ServiceResponse`, HTTP 401/403, JSON or
// XML); service errors in `response.header.resultCode`. '대장 없음' (나대지) is an empty list, not a
// failure (S-19: 인증 실패 ≠ 대장 없음).

import { z } from 'zod';
import {
  SiteDataError,
  keyFor,
  listOf,
  numberOf,
  positive,
  requestJson,
  textOf,
  type SiteDataContext,
} from '../http.ts';
import { registerKeys } from '../pnu.ts';
import type { Recorder } from '../snapshot.ts';

export const BUILDING_REGISTER = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo';
const SOURCE = 'building-register' as const;
const ROWS = 100;

const envelope = z.object({
  response: z.object({
    header: z.object({ resultCode: z.union([z.string(), z.number()]) }).passthrough(),
    body: z
      .object({
        items: z.unknown().optional(),
        totalCount: z.union([z.string(), z.number()]),
      })
      .passthrough()
      .optional(),
  }),
});

export interface RegisterTitle {
  pnu: string;
  /** 관리 건축물대장 PK. */
  pk: string | null;
  name: string | null;
  dongName: string | null;
  /** 주건축물 (mainAtchGbCd 0) or 부속. */
  main: boolean;
  mainUse: string | null;
  height: number | null;
  floorsAbove: number | null;
  floorsBelow: number | null;
  siteArea: number | null;
  buildingArea: number | null;
  totalArea: number | null;
  coverage: number | null;
  floorAreaRatio: number | null;
  approvedOn: string | null;
}

export function registerTitleOf(row: Record<string, unknown>, pnu: string): RegisterTitle {
  return {
    pnu,
    pk: textOf(row.mgmBldrgstPk),
    name: textOf(row.bldNm),
    dongName: textOf(row.dongNm),
    main: textOf(row.mainAtchGbCd) !== '1',
    mainUse: textOf(row.mainPurpsCdNm),
    height: positive(row.heit),
    floorsAbove: numberOf(row.grndFlrCnt),
    floorsBelow: numberOf(row.ugrndFlrCnt),
    siteArea: positive(row.platArea),
    buildingArea: positive(row.archArea),
    totalArea: positive(row.totArea),
    coverage: positive(row.bcRat),
    floorAreaRatio: positive(row.vlRat),
    approvedOn: textOf(row.useAprDay),
  };
}

/** Gateway refusals (key, quota) in JSON or XML. */
function gatewayFailure(json: unknown, text: string | undefined) {
  const header = (json as { OpenAPI_ServiceResponse?: { cmmMsgHeader?: Record<string, unknown> } })
    ?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  const code =
    (header && textOf(header.returnReasonCode)) ??
    /<returnReasonCode>\s*(\d+)\s*</.exec(text ?? '')?.[1];
  const message =
    (header && textOf(header.errMsg)) ?? /<errMsg>\s*([^<]+?)\s*</.exec(text ?? '')?.[1];
  if (!code && !message) return null;
  return new SiteDataError(
    code === '22' ? 'LIMIT' : 'REJECTED',
    SOURCE,
    message ?? code ?? undefined,
  );
}

/** Every title of one parcel (all pages). */
export async function registerTitles(context: SiteDataContext, recorder: Recorder, pnu: string) {
  const key = keyFor(context, SOURCE);
  const titles: RegisterTitle[] = [];
  let total = 0;
  for (let page = 1; page <= 10; page++) {
    const params = {
      ...registerKeys(pnu),
      _type: 'json',
      numOfRows: String(ROWS),
      pageNo: String(page),
    };
    recorder.note(BUILDING_REGISTER, params);
    const reply = await requestJson(context, SOURCE, BUILDING_REGISTER, {
      ...params,
      serviceKey: key,
    });
    const refused = gatewayFailure(reply.json, reply.text);
    if (refused) throw refused;
    const parsed = envelope.safeParse(reply.json);
    if (!parsed.success) throw new SiteDataError('BAD_RESPONSE', SOURCE, `http-${reply.status}`);
    const code = String(parsed.data.response.header.resultCode).padStart(2, '0');
    if (code === '03') return { titles, total: 0, received: 0 };
    if (code === '22') throw new SiteDataError('LIMIT', SOURCE, code);
    if (code !== '00') throw new SiteDataError('REJECTED', SOURCE, code);
    const body = parsed.data.response.body;
    const count = numberOf(body?.totalCount);
    if (!body || count === null) throw new SiteDataError('BAD_RESPONSE', SOURCE, 'totalCount');
    total = count;
    const items =
      body.items && typeof body.items === 'object' ? (body.items as { item?: unknown }).item : [];
    const rows = listOf(items).filter(
      (row): row is Record<string, unknown> => !!row && typeof row === 'object',
    );
    titles.push(...rows.map((row) => registerTitleOf(row, pnu)));
    if (titles.length >= total || rows.length < ROWS) break;
  }
  return { titles, total, received: titles.length };
}

/**
 * Height priority 2 for one building of a parcel: the title whose 동 name matches, else the
 * parcel's only main title, else the main title with the largest 연면적 (S-04 방식).
 */
export function registerHeight(titles: RegisterTitle[], dongName: string | null) {
  const main = titles.filter((title) => title.main);
  const byDong = dongName && titles.find((title) => title.dongName && title.dongName === dongName);
  const chosen =
    byDong ||
    (main.length === 1
      ? main[0]
      : [...main].sort((a, b) => (b.totalArea ?? 0) - (a.totalArea ?? 0))[0]);
  return chosen?.height ? chosen : null;
}

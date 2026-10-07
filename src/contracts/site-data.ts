// 공공 자료 수집의 HTTP 계약 (PLAN-45 T-205, SPEC-12.3·12.4, ARCH-01 「공공 자료 수집」): request
// bodies and the FR-18 send notice shown before a project first sends anything to a public
// service. The notice's `version` is a hash of its content; a changed notice is asked again.

import { z } from 'zod';

export const publicDataKeyInput = z
  .object({
    name: z.enum(['VWORLD_KEY', 'VWORLD_DOMAIN', 'JUSO_KEY', 'DATA_GO_KR_KEY']),
    /** Empty removes the key. */
    value: z.string().max(512),
  })
  .strict();

export const siteNoticeInput = z
  .object({ confirm: z.literal(true).optional(), off: z.boolean().optional() })
  .strict();

export const siteLookupInput = z.object({ query: z.string().trim().min(1).max(200) }).strict();

export const siteCollectInput = z
  .object({
    pnus: z
      .array(z.string().regex(/^\d{10}[12]\d{8}$/))
      .min(1)
      .max(20),
    radius: z.number().min(50).max(600).optional(),
  })
  .strict();

const content = {
  sends: ['입력한 주소 또는 PNU', '대상·주변 필지의 PNU', '좌표 범위(대지 경계 + 주변 반경)'],
  recipients: [
    {
      name: '브이월드 오픈API(국토교통부)',
      host: 'api.vworld.kr',
      for: '필지·용도지역·건물·토지특성',
    },
    {
      name: '주소기반산업지원서비스(행정안전부)',
      host: 'business.juso.go.kr',
      for: '주소 → 후보 필지',
    },
    {
      name: '공공데이터포털 건축HUB(국토교통부)',
      host: 'apis.data.go.kr',
      for: '건축물대장 표제부',
    },
  ],
  notSent: [
    '소유자 이름·주민번호 등 개인정보는 요청하지 않습니다',
    '모델·도면·요청 글은 보내지 않습니다',
  ],
};

/** FNV-1a of the content: a short stable version the browser can compute too. */
function versionOf(value: unknown) {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(value)) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export const SITE_DATA_NOTICE = { ...content, version: versionOf(content) };
export type SiteDataNotice = typeof SITE_DATA_NOTICE;

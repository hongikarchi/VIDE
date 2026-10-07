// vide/site-data (PLAN-45 T-205, SPEC-12.4·12.16): the one place that calls public site-data
// services. Every call goes through `requestJson`, which allows only the endpoints listed here,
// never puts a key in an error or provenance record, and turns transport failures into
// `SiteDataError` codes. The adapters in `sources/*` read the service envelopes (HTTP 200 carries
// errors and empty results too, SPIKE-2026-10-07-public-site-data).

export const KEY_NAMES = ['VWORLD_KEY', 'VWORLD_DOMAIN', 'JUSO_KEY', 'DATA_GO_KR_KEY'] as const;
export type KeyName = (typeof KEY_NAMES)[number];
export type PublicDataKeys = Partial<Record<KeyName, string>>;

/** Why a source gave nothing usable (SPEC-12.16 자료원 실패). */
export type FailureCode =
  | 'NO_KEY'
  | 'REJECTED'
  | 'LIMIT'
  | 'BAD_RESPONSE'
  | 'NETWORK'
  | 'FORBIDDEN_ENDPOINT';

export type SourceId =
  | 'juso'
  | 'vworld-search'
  | 'vworld-cadastral'
  | 'vworld-land-use'
  | 'vworld-land-characteristics'
  | 'vworld-buildings'
  | 'vworld-building-info'
  | 'building-register';

/** Which key each source needs (VWorld calls also send VWORLD_DOMAIN when it is set). */
export const SOURCE_KEYS: Record<SourceId, KeyName> = {
  juso: 'JUSO_KEY',
  'vworld-search': 'VWORLD_KEY',
  'vworld-cadastral': 'VWORLD_KEY',
  'vworld-land-use': 'VWORLD_KEY',
  'vworld-land-characteristics': 'VWORLD_KEY',
  'vworld-buildings': 'VWORLD_KEY',
  'vworld-building-info': 'VWORLD_KEY',
  'building-register': 'DATA_GO_KR_KEY',
};

export class SiteDataError extends Error {
  readonly code: FailureCode;
  readonly source: SourceId;
  /** The service's own code (e.g. `INVALID_KEY`, `E0014`); never a key or URL. */
  readonly detail?: string;
  constructor(code: FailureCode, source: SourceId, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.code = code;
    this.source = source;
    this.detail = detail;
  }
}

export interface SiteDataContext {
  keys: PublicDataKeys;
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

/** The only endpoints the library calls (origin + path). */
export const ALLOWED_ENDPOINTS = [
  'https://business.juso.go.kr/addrlink/addrLinkApi.do',
  'https://api.vworld.kr/req/data',
  'https://api.vworld.kr/req/search',
  'https://api.vworld.kr/ned/data/getLandUseAttr',
  'https://api.vworld.kr/ned/data/getLandCharacteristics',
  'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo',
] as const;

/**
 * Never called (SPIKE §6 금지): endpoints returning owner names or resident numbers, the retired
 * NSDI gateway, and the building WFS that answers only `ServiceExceptionReport`. The allow-list
 * already keeps them out; this list makes the refusal explicit and testable.
 */
export const FORBIDDEN_ENDPOINTS: readonly RegExp[] = [
  /urban\.seoul\.go\.kr\/api\/map\/kras/i,
  /apis\.data\.go\.kr\/1611000\/nsdi/i,
  /api\.vworld\.kr\/ned\/data\/(getPossessionAttr|getLandOwner|possession)/i,
  /api\.vworld\.kr\/ned\/wfs\/getGisGeneralBuildingWFS/i,
];

/** VWorld 2D layers the adapters may ask for. */
export const VWORLD_LAYERS = new Set([
  'LP_PA_CBND_BUBUN',
  'LT_C_SPBD',
  'LT_C_BLDGINFO',
  'LT_C_UQ111',
  'LT_C_UQ112',
  'LT_C_UQ113',
  'LT_C_UQ114',
  'LT_C_UQ121',
  'LT_C_UQ123',
  'LT_C_UQ124',
  'LT_C_UQ125',
  'LT_C_UQ126',
  'LT_C_UQ128',
  'LT_C_UQ129',
  'LT_C_UQ130',
  'LT_C_UQ141',
  'LT_C_UQ162',
  'LT_C_UD801',
  'LT_C_UPISUQ161',
]);

/** Query names that carry a key: dropped from provenance, never logged. */
const SECRET_PARAMS = new Set(['key', 'domain', 'serviceKey', 'confmKey']);

export function endpointAllowed(url: string) {
  if (FORBIDDEN_ENDPOINTS.some((pattern) => pattern.test(url))) return false;
  const parsed = new URL(url);
  return (ALLOWED_ENDPOINTS as readonly string[]).includes(parsed.origin + parsed.pathname);
}

/** The key a source needs, or NO_KEY. */
export function keyFor(context: SiteDataContext, source: SourceId) {
  const value = context.keys[SOURCE_KEYS[source]]?.trim();
  if (!value) throw new SiteDataError('NO_KEY', source);
  return value;
}

export const nowIso = (context: SiteDataContext) =>
  (context.now ?? (() => new Date()))().toISOString();

/** What a provenance record keeps of a request: the endpoint and the non-secret parameters. */
export function describeRequest(endpoint: string, params: Record<string, string>) {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(params))
    if (!SECRET_PARAMS.has(name)) kept[name] = value;
  return { endpoint, params: kept };
}

export interface JsonReply {
  status: number;
  json: unknown;
  /** The first bytes of a non-JSON body (data.go.kr answers key errors in XML). */
  text?: string;
}

/**
 * GET `endpoint?params` and parse JSON. Secret parameters go in the URL only. Errors carry the
 * source and a code, never the URL.
 */
export async function requestJson(
  context: SiteDataContext,
  source: SourceId,
  endpoint: string,
  params: Record<string, string>,
): Promise<JsonReply> {
  // data.go.kr hands out an already-encoded key ("…%2B…%3D%3D") next to the decoded one; encoding
  // the encoded form again makes the gateway answer SERVICE_KEY_IS_NOT_REGISTERED (2026-10-08).
  const query = Object.entries(params)
    .map(([name, value]) => {
      const encoded =
        name === 'serviceKey' && /%[0-9A-Fa-f]{2}/.test(value) ? value : encodeURIComponent(value);
      return `${encodeURIComponent(name)}=${encoded}`;
    })
    .join('&');
  const url = new URL(`${endpoint}?${query}`);
  if (!endpointAllowed(url.href)) throw new SiteDataError('FORBIDDEN_ENDPOINT', source);
  let response: Response;
  let text: string;
  try {
    response = await (context.fetch ?? fetch)(url.href, {
      signal: AbortSignal.timeout(context.timeoutMs ?? 20_000),
      headers: { Accept: 'application/json' },
    });
    text = await response.text();
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    throw new SiteDataError('NETWORK', source, name === 'TimeoutError' ? 'timeout' : undefined);
  }
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch {
    return { status: response.status, json: undefined, text: text.slice(0, 400) };
  }
}

/** A number from a service field ("12709.4", 53.5, " ", ""): finite or null. */
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** A positive measure; 0 means "not recorded" in the registers (SPIKE §4). */
export const positive = (value: unknown) => {
  const parsed = numberOf(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

/** A trimmed string or null (" " is the registers' empty). */
export function textOf(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** One item or a list of them (NED and data.go.kr send a single object for one row). */
export function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

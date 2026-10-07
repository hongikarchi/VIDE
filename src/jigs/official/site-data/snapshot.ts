// The read-copy every adapter result becomes (SPEC-12.4 '조회 사본', SPEC-12.14, PRD §6.3): the
// items, which source and request produced them, when, and whether the copy can be trusted as is.
// The shape follows ARCH-01 §「외부 도메인 서비스」 읽기 응답 (출처 · 조회 시각 · 출처 구분) so a later
// Site Modeling service can replace the collector without changing the jig.

import { SiteDataError, describeRequest, type FailureCode, type SourceId } from './http.ts';

export interface Provenance {
  service: 'vide/site-data';
  source: SourceId;
  /** Endpoints and non-secret parameters of every call (keys never appear). */
  requests: { endpoint: string; params: Record<string, string> }[];
  /** VWorld layers read, if any. */
  layers?: string[];
  /** Coordinate system of the geometry in `items` (requested explicitly). */
  crs?: string;
  /** The services' own ids of the items (PNU, feature id, 대장 PK). */
  ids: string[];
  /** PRD §6.3: public data is '원본에서 읽음'. */
  basis: 'source';
}

/**
 * ok: usable. check: usable but '확인 필요' (empty, partial pages, area gap). failed: the source
 * refused or broke (`reason`); keep the last copy. no-key: this PC has no key for the source.
 */
export type SnapshotStatus = 'ok' | 'check' | 'failed' | 'no-key';

export interface Snapshot<T> {
  source: SourceId;
  items: T[];
  fetchedAt: string;
  provenance: Provenance;
  status: SnapshotStatus;
  /** '확인 필요' reasons, Korean, one per finding. */
  checks: string[];
  reason?: FailureCode;
  /** The service's code behind `reason` (e.g. INVALID_KEY), never a key. */
  detail?: string;
}

/** Collects the request records and ids of one source while it is read. */
export class Recorder {
  readonly source: SourceId;
  readonly requests: Provenance['requests'] = [];
  readonly layers = new Set<string>();
  constructor(source: SourceId) {
    this.source = source;
  }
  note(endpoint: string, params: Record<string, string>, layer?: string) {
    this.requests.push(describeRequest(endpoint, params));
    if (layer) this.layers.add(layer);
  }
  provenance(ids: string[], crs?: string): Provenance {
    return {
      service: 'vide/site-data',
      source: this.source,
      requests: this.requests,
      ...(this.layers.size ? { layers: [...this.layers] } : {}),
      ...(crs ? { crs } : {}),
      ids,
      basis: 'source',
    };
  }
}

export function snapshot<T>(
  recorder: Recorder,
  fetchedAt: string,
  items: T[],
  ids: string[],
  checks: string[],
  crs?: string,
): Snapshot<T> {
  return {
    source: recorder.source,
    items,
    fetchedAt,
    provenance: recorder.provenance(ids, crs),
    status: checks.length ? 'check' : 'ok',
    checks,
  };
}

/** A failed or keyless source as a snapshot; other errors are rethrown. */
export function failedSnapshot<T>(
  recorder: Recorder,
  fetchedAt: string,
  error: unknown,
): Snapshot<T> {
  if (!(error instanceof SiteDataError)) throw error;
  return {
    source: recorder.source,
    items: [],
    fetchedAt,
    provenance: recorder.provenance([]),
    status: error.code === 'NO_KEY' ? 'no-key' : 'failed',
    checks: [],
    reason: error.code,
    ...(error.detail ? { detail: error.detail } : {}),
  };
}

/** The Korean line a failure shows (SPEC-12.16 '가져오지 못함'과 이유). */
export const FAILURE_TEXT: Record<FailureCode, string> = {
  NO_KEY: '키 없음',
  REJECTED: '자료원이 요청을 거절함',
  LIMIT: '자료원 호출 한도 초과',
  BAD_RESPONSE: '응답 형식이 예상과 다름',
  NETWORK: '네트워크 끊김 또는 응답 없음',
  FORBIDDEN_ENDPOINT: '허용되지 않은 자료원',
};

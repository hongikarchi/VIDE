// 주소·PNU → 후보 필지 (SPEC-12.3): every candidate with 주소·지번·지목·공부 면적·PNU and a point for
// the small location map. One candidate that matches the input is proposed; several or none go
// to a question card, and the library never picks among them (SPEC-12.3의 2). A 지번 the address
// service "snapped" to a neighbour (낙착, S-04) is flagged, and the input lot is rebuilt on the
// service's 법정동 and checked against the cadastre.

import { SiteDataError, nowIso, type FailureCode, type SiteDataContext } from './http.ts';
import { interiorPoint, type Position } from './geometry.ts';
import { buildPnu, isPnu, splitPnu, trailingLot } from './pnu.ts';
import { Recorder, type Provenance } from './snapshot.ts';
import { jusoCandidates, type AddressCandidate } from './sources/juso.ts';
import { parcelByPnu } from './sources/vworld-cadastral.ts';
import { landCharacteristics } from './sources/vworld-land-characteristics.ts';
import { searchCandidates } from './sources/vworld-search.ts';

/** How many candidates get 지목·면적·위치 (each costs a cadastre and a land call). */
const ENRICH = 5;

export interface ParcelCandidate extends AddressCandidate {
  landCategory: string | null;
  officialArea: number | null;
  /** A point inside the parcel (EPSG:5186) for the location map. */
  point: Position | null;
  /** The input named a lot and this candidate is that lot (null: the input named none). */
  matchesInput: boolean | null;
  /** Rebuilt from the service's 법정동 and the input lot after a 낙착. */
  assembled: boolean;
  /** Found in the cadastre (null: not checked — no key or beyond the first five). */
  verified: boolean | null;
}

export type LookupStatus = 'ok' | 'ambiguous' | 'none' | 'failed' | 'no-key';

export interface LookupResult {
  query: string;
  kind: 'pnu' | 'jibun' | 'road';
  candidates: ParcelCandidate[];
  /** The PNU to propose when exactly one candidate fits; the person still confirms. */
  proposal: string | null;
  status: LookupStatus;
  checks: string[];
  reason?: FailureCode;
  detail?: string;
  fetchedAt: string;
  provenance: Provenance[];
}

const plain = (candidate: AddressCandidate, matchesInput: boolean | null): ParcelCandidate => ({
  ...candidate,
  landCategory: null,
  officialArea: null,
  point: null,
  matchesInput,
  assembled: false,
  verified: null,
});

export async function lookupParcel(context: SiteDataContext, input: string): Promise<LookupResult> {
  const query = input.trim().replace(/\s+/g, ' ');
  const fetchedAt = nowIso(context);
  const compact = query.replace(/[\s-]/g, '');
  const kind: LookupResult['kind'] = isPnu(compact) ? 'pnu' : trailingLot(query) ? 'jibun' : 'road';
  const recorders: Recorder[] = [];
  const checks: string[] = [];
  const result = (
    candidates: ParcelCandidate[],
    proposal: string | null,
    extra: Partial<LookupResult> = {},
  ): LookupResult => ({
    query,
    kind,
    candidates,
    proposal,
    status: candidates.length === 0 ? 'none' : proposal ? 'ok' : 'ambiguous',
    checks,
    fetchedAt,
    provenance: recorders.filter((r) => r.requests.length).map((r) => r.provenance([])),
    ...extra,
  });
  const recorder = (source: ConstructorParameters<typeof Recorder>[0]) => {
    const made = new Recorder(source);
    recorders.push(made);
    return made;
  };

  let candidates: ParcelCandidate[];
  const lot = kind === 'jibun' ? trailingLot(query) : null;
  if (kind === 'pnu') {
    const typed = { jibunAddress: null, roadAddress: null, buildingName: null };
    candidates = [plain({ pnu: compact, ...typed, ...splitPnu(compact), source: 'input' }, null)];
  } else {
    let found: { candidates: AddressCandidate[]; total: number };
    try {
      found = context.keys.JUSO_KEY?.trim()
        ? await jusoCandidates(context, recorder('juso'), query)
        : await searchCandidates(
            context,
            recorder('vworld-search'),
            query,
            kind === 'jibun' ? 'parcel' : 'road',
          );
    } catch (error) {
      if (!(error instanceof SiteDataError)) throw error;
      if (error.code === 'NO_KEY') checks.push('주소 검색 키가 없습니다. PNU를 직접 입력하세요.');
      return result([], null, {
        status: error.code === 'NO_KEY' ? 'no-key' : 'failed',
        reason: error.code,
        ...(error.detail ? { detail: error.detail } : {}),
      });
    }
    if (found.total > found.candidates.length)
      checks.push(
        `후보 ${found.total}건 중 ${found.candidates.length}건만 보임 — 주소를 더 구체적으로 입력하세요`,
      );
    const matches = (c: AddressCandidate) =>
      !!lot && c.mountain === lot.mountain && c.main === lot.main && c.sub === lot.sub;
    candidates = found.candidates
      .map((c) => plain(c, lot ? matches(c) : null))
      .sort((a, b) => Number(b.matchesInput) - Number(a.matchesInput));
    if (lot && candidates.length && !candidates.some((c) => c.matchesInput)) {
      checks.push(
        '입력한 지번과 다른 지번이 돌아왔습니다(낙착). 입력 지번으로 다시 만든 후보를 확인하세요',
      );
      const pnu = buildPnu(candidates[0].legalDong, lot.mountain, lot.main, lot.sub);
      if (pnu)
        candidates.unshift({
          ...plain(
            {
              ...candidates[0],
              ...splitPnu(pnu),
              pnu,
              jibunAddress: null,
              roadAddress: null,
              buildingName: null,
            },
            true,
          ),
          assembled: true,
        });
    }
  }

  // 지목·공부 면적·위치 for the first candidates, and the cadastre check of rebuilt or typed PNUs.
  if (context.keys.VWORLD_KEY?.trim()) {
    const cadastre = recorder('vworld-cadastral');
    const land = recorder('vworld-land-characteristics');
    const year = new Date(fetchedAt).getUTCFullYear();
    for (const candidate of candidates.slice(0, ENRICH)) {
      try {
        const parcel = await parcelByPnu(context, cadastre, candidate.pnu);
        candidate.verified = !!parcel;
        if (parcel) {
          candidate.landCategory = parcel.landCategory;
          candidate.point = interiorPoint(parcel.polygons);
          candidate.jibunAddress ??= parcel.address;
          const characteristics = await landCharacteristics(context, land, candidate.pnu, year);
          candidate.officialArea = characteristics?.officialArea ?? null;
          candidate.landCategory ??= characteristics?.landCategory ?? null;
        }
      } catch (error) {
        if (!(error instanceof SiteDataError)) throw error;
        checks.push(`후보 ${candidate.pnu}의 지목·면적을 가져오지 못함(${error.code})`);
        break;
      }
    }
    const gone = candidates.filter((c) => (c.assembled || kind === 'pnu') && c.verified === false);
    if (gone.length) {
      checks.push(`연속지적에 없는 PNU: ${gone.map((c) => c.pnu).join(', ')}`);
      candidates = candidates.filter((c) => !gone.includes(c));
    }
  } else if (kind === 'pnu') checks.push('VWorld 키가 없어 PNU의 실재를 확인하지 못했습니다');

  const fitting = kind === 'jibun' ? candidates.filter((c) => c.matchesInput) : candidates;
  const proposal =
    fitting.length === 1 && fitting[0].verified !== false && !fitting[0].assembled
      ? fitting[0].pnu
      : null;
  return result(candidates, proposal);
}

// ① 필지 후보 (SPEC-12.3): the candidate parcels of the address — the engine's lookup copy
// (`vide/site-data` lookupParcel) or, when public data is off or keyless, the parcels of the
// 연속지적도 SHP put in — and the chosen target parcels. Several candidates or none become a question
// card (ADR-026, SPEC-02.19의 6) with [PNU 직접 입력]; this step never chooses among them.

import { interiorPoint } from '../../../site-data/geometry.ts';
import { isPnu, trailingLot } from '../../../site-data/pnu.ts';
import { lotOf, round, type XY } from './common.ts';
import type { ShpCopy, SiteInput } from './inputs.ts';

export interface Candidate {
  key: string;
  pnu: string;
  label: string;
  jibunAddress: string | null;
  roadAddress: string | null;
  landCategory: string | null;
  officialArea: number | null;
  /** A point inside the parcel (EPSG:5186) for the location map, when known. */
  point: XY | null;
  matchesInput: boolean | null;
  verified: boolean | null;
  source: 'public' | 'shp' | 'input';
  note: string;
}
export interface Question {
  title: string;
  options: { id: string; label: string; hint?: string; recommended?: boolean }[];
  allowFree: true;
  blocks: string;
}
export interface CandidatesOutput {
  query: string | null;
  source: 'public' | 'shp' | 'none';
  status: 'ok' | 'ambiguous' | 'none' | 'no-key' | 'failed' | 'waiting';
  candidates: Candidate[];
  proposal: string | null;
  targets: string[];
  targetsBy: 'proposal' | 'user' | null;
  /** Targets that are not among the candidates (typed PNUs, parcels added for 합필). */
  added: string[];
  question: Question | null;
  checks: string[];
  fetchedAt: string | null;
}

const FAILED: Record<string, string> = {
  NO_KEY: '키 없음',
  REJECTED: '자료원이 요청을 거절함',
  LIMIT: '자료원 호출 한도 초과',
  BAD_RESPONSE: '응답 형식이 예상과 다름',
  NETWORK: '네트워크 끊김 또는 응답 없음',
};

/** Parcels of the 연속지적도 SHP whose PNU or 지번 matches the query. */
function shpCandidates(shp: ShpCopy, query: string): Candidate[] {
  const compact = query.replace(/[\s-]/g, '');
  const lot = trailingLot(query) ?? trailingLot(`가동 ${query.trim()}`);
  const origin = shp.frame?.origin ?? [0, 0, 0];
  const out: Candidate[] = [];
  for (const layer of shp.layers) {
    if (layer.role !== 'parcel') continue;
    for (const feature of layer.features) {
      const pnu = feature.parcel?.pnu ?? '';
      if (!isPnu(pnu) || feature.geometry.kind !== 'polygon') continue;
      const lotMatches =
        !!lot &&
        (pnu[10] === '2') === lot.mountain &&
        Number(pnu.slice(11, 15)) === lot.main &&
        Number(pnu.slice(15, 19)) === lot.sub;
      if (pnu !== compact && !lotMatches) continue;
      const polygons = feature.geometry.polygons.map((p) =>
        [p.outer, ...p.holes].map((r) =>
          r.map(([x, y]): [number, number] => [x + origin[0], y + origin[1]]),
        ),
      );
      const point = polygons.length ? interiorPoint(polygons) : null;
      const jibun = feature.parcel?.jibun ?? null;
      out.push({
        key: pnu,
        pnu,
        label: `${lotOf(pnu)}${jibun ? ` (${jibun})` : ''}`,
        jibunAddress: jibun,
        roadAddress: null,
        landCategory: jibun ? (/[가-힣]+$/.exec(jibun)?.[0] ?? null) : null,
        officialArea: null,
        point: point ? [round(point[0]), round(point[1])] : null,
        matchesInput: pnu === compact || lotMatches,
        verified: true,
        source: 'shp',
        note: `넣은 연속지적도 SHP(${layer.file})`,
      });
    }
  }
  return out;
}

export function candidates(inputs: {
  site: Pick<SiteInput, 'query' | 'lookup' | 'shp' | 'targets'>;
}) {
  const { query, lookup, shp } = inputs.site;
  const targets = inputs.site.targets?.pnus ?? [];
  const checks: string[] = [];
  let list: Candidate[] = [];
  let source: CandidatesOutput['source'] = 'none';
  let status: CandidatesOutput['status'] = query ? 'none' : 'waiting';
  let proposal: string | null = null;
  if (lookup && lookup.query === query) {
    source = 'public';
    status = lookup.status;
    proposal = lookup.proposal;
    checks.push(...lookup.checks);
    if (lookup.reason) checks.push(`주소 검색: ${FAILED[lookup.reason] ?? lookup.reason}`);
    list = lookup.candidates.map((c) => ({
      key: c.pnu,
      pnu: c.pnu,
      label: c.jibunAddress ?? c.roadAddress ?? lotOf(c.pnu),
      jibunAddress: c.jibunAddress,
      roadAddress: c.roadAddress,
      landCategory: c.landCategory,
      officialArea: c.officialArea,
      point: c.point ? [round(c.point[0]), round(c.point[1])] : null,
      matchesInput: c.matchesInput,
      verified: c.verified,
      source: c.source === 'input' ? 'input' : 'public',
      note: c.assembled
        ? '입력 지번으로 다시 만든 후보(낙착)'
        : c.verified === false
          ? '연속지적에 없음'
          : '',
    }));
  }
  // SHP: when there is no usable public answer (off, no key, failed, none).
  if (query && shp && !list.length) {
    const found = shpCandidates(shp, query);
    if (found.length) {
      source = 'shp';
      list = found;
      const fitting = found.filter((c) => c.matchesInput);
      proposal = fitting.length === 1 ? fitting[0].pnu : null;
      status = proposal ? 'ok' : 'ambiguous';
    } else if (!lookup) checks.push('넣은 SHP에서 이 지번·PNU를 찾지 못했습니다');
  }
  if (query && !lookup && !shp)
    checks.push(
      '공공 자료를 쓰지 않거나 아직 조회하지 않았습니다. 확인 후 찾기를 누르거나 SHP를 넣으세요',
    );
  if (query && isPnu(query.replace(/[\s-]/g, '')) && !list.length) {
    // A typed PNU is a candidate by itself; whether it exists is checked when collecting.
    const pnu = query.replace(/[\s-]/g, '');
    list = [
      {
        key: pnu,
        pnu,
        label: `PNU ${pnu} (${lotOf(pnu)})`,
        jibunAddress: null,
        roadAddress: null,
        landCategory: null,
        officialArea: null,
        point: null,
        matchesInput: true,
        verified: null,
        source: 'input',
        note: '직접 입력한 PNU',
      },
    ];
    proposal = pnu;
    status = 'ok';
  }
  const added = targets.filter((pnu) => !list.some((c) => c.pnu === pnu));
  // Ask while no parcel is chosen (SPEC-12.3의 2): several candidates, none, or one to confirm.
  // Nothing asked yet (the notice waits, or public data is off with no SHP): no question.
  const searched = !!lookup || !!shp || list.length > 0;
  const ask = !!query && !targets.length && searched;
  if (query && !searched) status = 'waiting';
  const question: Question | null = ask
    ? {
        title: list.length
          ? `‘${query}’의 대상 필지를 고르세요 — 후보 ${list.length}개`
          : `‘${query}’에서 필지를 찾지 못했습니다. PNU를 직접 입력하세요`,
        options: list.map((c) => ({
          id: c.pnu,
          label: c.label,
          hint: [
            c.landCategory ? `지목 ${c.landCategory}` : '',
            c.officialArea ? `공부 ${c.officialArea} m²` : '',
            `PNU ${c.pnu}`,
            c.note,
          ]
            .filter(Boolean)
            .join(' · '),
          ...(c.pnu === proposal ? { recommended: true } : {}),
        })),
        allowFree: true,
        blocks: '대상 필지 확정',
      }
    : null;
  return {
    query,
    source,
    status,
    candidates: list,
    proposal,
    targets,
    targetsBy: inputs.site.targets?.by ?? null,
    added,
    question,
    checks,
    fetchedAt: lookup?.fetchedAt ?? null,
  } satisfies CandidatesOutput;
}

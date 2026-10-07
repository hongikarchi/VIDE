// ① 앞 결과 (SPEC-12.2 다른 jig의 출력, SPEC-12.13 1): which earlier instances the 건축개요 reads —
// 작업본 · jig 버전 · 대안 · 계산 시각 — kept with the result. Without a confirmed 고른 대안 there is
// nothing to summarise and the step stops with the reason; a missing 대지 요약 only leaves the site
// cells '사람 입력 필요'.

import type { JigOutputInput, MassInput, SiteInput } from './common.ts';

export interface SourceRow {
  key: string;
  input: string;
  instance: string;
  jig: string;
  item: string;
  at: string;
  state: string;
}
export interface SourcesOutput {
  rows: SourceRow[];
  mass: { instanceId: string; title: string; alternative: string; at: string | null };
  site: { instanceId: string; title: string; at: string | null; fetchedAt: string | null } | null;
  siteReason: string | null;
}

const rowOf = (
  key: string,
  input: string,
  i: JigOutputInput<unknown>,
  item: string,
): SourceRow => ({
  key,
  input,
  instance: i.source?.title ?? '—',
  jig: i.source ? `${i.source.jig} ${i.source.version}` : '—',
  item,
  at: i.source?.at ?? '',
  state: i.value ? '받음' : (i.reason ?? i.source?.reason ?? '없음'),
});

export function sources(inputs: { mass?: MassInput; site?: SiteInput }): SourcesOutput {
  const mass = inputs.mass;
  const site = inputs.site;
  if (!mass?.value || !mass.source)
    throw new Error(
      `고른 대안을 받지 못했습니다: ${mass?.reason ?? '건축 가능 영역·매스 작업본이 없습니다'} — 그 jig에서 대안을 고르고 [고른 대안 확정]을 하세요`,
    );
  const alt = mass.value.alternative;
  const rows = [
    rowOf('mass', '고른 대안', mass, alt.title),
    rowOf(
      'site',
      '대지 요약',
      site ?? { source: null, value: null, reason: '사이트 모델링 작업본이 없습니다' },
      site?.value ? site.value.addresses.join(', ') || site.value.pnus.join(', ') : '',
    ),
  ];
  return {
    rows,
    mass: {
      instanceId: mass.source.instanceId,
      title: mass.source.title,
      alternative: alt.title,
      at: mass.source.at,
    },
    site:
      site?.value && site.source
        ? {
            instanceId: site.source.instanceId,
            title: site.source.title,
            at: site.source.at,
            fetchedAt: site.value.fetchedAt,
          }
        : null,
    siteReason: site?.value ? null : (site?.reason ?? '사이트 모델링 작업본이 없습니다'),
  };
}

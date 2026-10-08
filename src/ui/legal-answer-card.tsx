import { useState, type ReactNode } from 'react';
import type { ClawdeAnswer, ClawdeVerdict } from '../contracts/clawde.ts';
import { selectNative } from './legal-target.ts';

// 법규 답 카드 (SPEC-13.5, Design SCR-29, PLAN-46 T-221): one cLAWde answer in the fixed order 결론
// → 이유 → 근거 조항(링크·발췌·시행일) → 그림 → 해석 → 확인 필요 사항 → 쓴 정보, each part with its
// provenance label (원문 · 서비스 확정 · 서비스 해석 · AI 문장(검증됨) · 프로젝트 정보). The verdict is
// the engine's checked one (a conclusion without citations is '판단 불가(근거 없음)'). Prose written
// by the user's CLI with the service's recipe (T-236) replaces the conclusion, reasons and
// interpretation only when it passed verification; otherwise the deterministic service sentences
// show with the failure note. Figures are images only. Target chips (T-220) name the site-model
// objects the answer is about and select them in the viewport. The legal jig panel and the
// conversation (T-223) use the same card.

/** One stored answer as `GET …/legal/answers` gives it (ARCH-01 「엔진 API」). */
export interface LegalAnswerView {
  number: number;
  ref: string;
  question: string;
  stage: string;
  sent: {
    stage: string;
    profile: Record<string, { value: string | number | boolean; unit?: string; source: string }>;
  };
  fetchedAt: string;
  lawDbDate: string;
  stale: boolean;
  staleReasons: ('profile' | 'law-db')[];
  verdict: ClawdeVerdict;
  downgraded: boolean;
  noExcerpt: string[];
  unverifiedReasons: number[];
  answer: ClawdeAnswer;
  /** Verified prose (T-236); null or absent unless written and verified. */
  prose?: LegalProse | null;
  proseStatus?: 'verified' | 'local-only' | 'failed' | 'no-model' | 'none';
  proseFailures?: { code: string; path?: string; message?: string }[];
  /** Target chips resolved against the site model (SPEC-13.8, T-220). */
  targets?: LegalTargetChip[];
}
/** One target of an answer: the site-model objects by linked file (Link ID) and host id. */
export interface LegalTargetChip {
  kind: 'site' | 'adjacent' | 'road';
  label: string;
  found: boolean;
  objects: { linkId: string; nativeIds: string[] }[];
}

export interface LegalProse {
  conclusion: string;
  reasons: { text: string; refs: string[] }[];
  interpretation: { text: string; refs: string[] }[];
  recipe?: { id: string; version: string };
  writer?: { provider: string; model: string; effort?: string };
  verify?: 'server' | 'local-only';
}

export const VERDICT_TEXT: Record<ClawdeVerdict, string> = {
  applies: '적용',
  'not-applies': '적용 안 됨',
  conditional: '조건부',
  unknown: '판단 불가',
};
export const STAGE_TEXT: Record<string, string> = {
  'scale-review': '규모검토',
  schematic: '계획설계',
  'design-development': '기본설계',
  'construction-docs': '실시설계',
};
/** Where a profile value came from (SPEC-13.4). */
export const SOURCE_TEXT: Record<string, string> = {
  service: '서비스에서 받음',
  model: '모델에서 읽음',
  user: '사용자 확정',
  assumed: '가정',
  ai: 'AI 추정',
};
type Provenance = 'original' | 'service-confirmed' | 'service' | 'ai-verified' | 'project';
const PROVENANCE_TEXT: Record<Provenance, string> = {
  original: '원문',
  'service-confirmed': '서비스 확정',
  service: '서비스 해석',
  'ai-verified': 'AI 문장(검증됨)',
  project: '프로젝트 정보',
};
export function ProvenanceTag({ kind, detail }: { kind: Provenance; detail?: string }) {
  return (
    <span className="legal-prov" data-prov={kind} title={detail}>
      {PROVENANCE_TEXT[kind]}
      {detail ? <small> · {detail}</small> : null}
    </span>
  );
}

/** `제61조 제1항` from the answer's citations, or the ref's last parts when not cited. */
function refLabel(answer: ClawdeAnswer, ref: string) {
  const cited = answer.citations.find((c) => c.ref === ref);
  if (cited) return `${cited.lawName} ${cited.article}`;
  return ref.replace(/^(law|ordin):/, '').replaceAll('/', ' ');
}
const dateText = (iso: string) => iso.slice(0, 10);
const timeText = (iso: string) =>
  new Date(iso).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
/** '오늘 조회' or 'n일 전 조회'. */
export function agoText(iso: string, now = Date.now()) {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? '오늘 조회' : `${days}일 전 조회`;
}
const valueText = (entry: { value: string | number | boolean; unit?: string }) =>
  `${typeof entry.value === 'boolean' ? (entry.value ? '예' : '아니오') : String(entry.value)}${
    entry.unit ? ` ${entry.unit}` : ''
  }`;

/** The verdict as a pill: 판단 불가(근거 없음) when the engine lowered it. */
export function VerdictPill({
  verdict,
  downgraded,
}: {
  verdict: ClawdeVerdict;
  downgraded?: boolean;
}) {
  return (
    <span className="legal-verdict" data-verdict={verdict}>
      {downgraded ? '판단 불가(근거 없음)' : VERDICT_TEXT[verdict]}
    </span>
  );
}

function Section({
  title,
  tag,
  children,
}: {
  title: string;
  tag?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="legal-part" aria-label={title}>
      <h4>
        {title}
        {tag}
      </h4>
      {children}
    </section>
  );
}

export interface LegalAnswerCardProps {
  view: LegalAnswerView;
  /** The service was unreachable at the last call: cached answers show '오프라인'. */
  offline?: boolean;
  /** Profile key labels (`site.area` → 대지 면적). */
  labels?: Record<string, string>;
  /** [다시 묻기]: a new answer on top of this one. */
  onReask?: () => void;
  /** [다시 쓰기] after a failed prose check (T-236). */
  onRewrite?: () => void;
  busy?: boolean;
  /** The back-question cards, under the card (SPEC-13.7). */
  children?: ReactNode;
}

export function LegalAnswerCard({
  view,
  offline,
  labels = {},
  onReask,
  onRewrite,
  busy,
  children,
}: LegalAnswerCardProps) {
  const { answer } = view;
  const [showSent, setShowSent] = useState(false);
  const prose = view.prose && view.proseStatus !== 'failed' ? view.prose : undefined;
  const writer = prose?.writer
    ? `${prose.writer.model}${prose.writer.effort ? ` · ${prose.writer.effort}` : ''}`
    : undefined;
  const proseDetail = prose
    ? [prose.recipe ? `레시피 ${prose.recipe.version}` : '', writer ?? '']
        .filter(Boolean)
        .join(' · ')
    : undefined;
  const partTag = (fallback: Provenance) =>
    prose ? (
      <ProvenanceTag kind="ai-verified" detail={proseDetail} />
    ) : (
      <ProvenanceTag kind={fallback} />
    );
  const reasons = prose ? prose.reasons : answer.reasons;
  const interpretation = prose
    ? prose.interpretation.map((part) => ({ ...part, basis: 'ai' as const }))
    : answer.interpretation;
  const unverified = new Set(prose ? [] : view.unverifiedReasons);
  const cited = new Set(answer.citations.map((c) => c.ref));
  const used = new Set(answer.usedProfile);
  const sent = Object.entries(view.sent.profile);
  const usedRows = sent.filter(([key]) => used.has(key));
  return (
    <article className="legal-answer" aria-label={`답 ${view.ref}`} data-verdict={view.verdict}>
      <header className="legal-answer-head">
        <VerdictPill verdict={view.verdict} downgraded={view.downgraded} />
        <span className="legal-ref">{view.ref}</span>
        <span className="legal-faint">
          {STAGE_TEXT[view.stage] ?? view.stage} · {timeText(view.fetchedAt)} 조회
        </span>
        {offline ? (
          <span className="legal-mark" data-mark="offline">
            오프라인 · {agoText(view.fetchedAt)}
          </span>
        ) : null}
        {view.stale ? (
          <span
            className="legal-mark"
            data-mark="stale"
            title={
              view.staleReasons.includes('law-db')
                ? '서비스의 법령 DB가 이 답 뒤에 갱신되었습니다'
                : '이 답이 쓴 프로젝트 정보가 바뀌었습니다'
            }
          >
            다시 확인 필요
          </span>
        ) : null}
        <button
          type="button"
          className="legal-chip"
          aria-expanded={showSent}
          onClick={() => setShowSent((v) => !v)}
        >
          보낸 정보
        </button>
        {view.targets?.length ? (
          <span className="legal-targets" role="group" aria-label="대상">
            {view.targets.map((target) => (
              <button
                key={target.kind}
                type="button"
                className="legal-target"
                data-found={String(target.found)}
                disabled={!target.found}
                title={
                  target.found
                    ? `뷰포트에서 ${target.label} 객체를 강조합니다`
                    : '대지 모델에서 이 대상을 찾지 못했습니다'
                }
                onClick={() => selectNative({ label: target.label, objects: target.objects })}
              >
                {target.label}
                {target.found ? null : <small> · 모델에 없음</small>}
              </button>
            ))}
          </span>
        ) : null}
      </header>
      {showSent ? (
        <ul className="legal-sent" aria-label="보낸 정보">
          <li>
            <span>설계 단계</span>
            <strong>{STAGE_TEXT[view.sent.stage] ?? view.sent.stage}</strong>
          </li>
          {sent.length ? (
            sent.map(([key, entry]) => (
              <li key={key}>
                <span>{labels[key] ?? key}</span>
                <strong>{valueText(entry)}</strong>
                <small>{SOURCE_TEXT[entry.source] ?? entry.source}</small>
              </li>
            ))
          ) : (
            <li className="legal-faint">프로젝트 정보 없이 질문과 단계만 보냈습니다.</li>
          )}
        </ul>
      ) : null}

      <Section
        title="결론"
        tag={view.downgraded ? <ProvenanceTag kind="service" /> : partTag('service')}
      >
        {view.downgraded ? (
          <p className="legal-conclusion">
            원문이 확인된 근거 조항이 없는 결론이라 판단 불가로 보입니다.
          </p>
        ) : (
          <p className="legal-conclusion">{prose ? prose.conclusion : answer.conclusion}</p>
        )}
        {view.proseStatus === 'failed' ? (
          <div className="legal-prose-note" data-state="failed">
            <span>문장 생성 검증 실패 · 서비스 판정과 근거만 보입니다</span>
            {view.proseFailures?.length ? (
              <details>
                <summary>이유</summary>
                <ul>
                  {view.proseFailures.map((f, i) => (
                    <li key={i}>
                      {f.code}
                      {f.message ? ` — ${f.message}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {onRewrite ? (
              <button type="button" disabled={busy} onClick={onRewrite}>
                다시 쓰기
              </button>
            ) : null}
          </div>
        ) : view.proseStatus === 'no-model' ? (
          <div className="legal-prose-note" data-state="no-model">
            문장 생성 안 함 · 자격 모델 없음
          </div>
        ) : prose && view.proseStatus === 'local-only' ? (
          <div className="legal-prose-note" data-state="local">
            로컬 검증만 · 서비스 검증을 하지 못했습니다
          </div>
        ) : null}
      </Section>

      {reasons.length ? (
        <Section title="이유" tag={partTag('service')}>
          <ol className="legal-reasons">
            {reasons.map((reason, i) => (
              <li key={i}>
                <span>{reason.text}</span>
                {reason.refs.map((ref) => (
                  <span key={ref} className="legal-refchip" data-cited={String(cited.has(ref))}>
                    {refLabel(answer, ref)}
                  </span>
                ))}
                {unverified.has(i) ? (
                  <span className="legal-mark" data-mark="unverified">
                    근거 미확인
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      <Section title="근거 조항" tag={<ProvenanceTag kind="original" />}>
        {answer.citations.length ? (
          <ul className="legal-citations">
            {answer.citations.map((c) => {
              const missing = view.noExcerpt.includes(c.ref);
              return (
                <li key={c.ref} data-missing={missing ? 'true' : undefined}>
                  <div className="legal-citation-head">
                    <strong>
                      {c.lawName} {c.article}
                    </strong>
                    {c.title ? <span>{c.title}</span> : null}
                    <span className="legal-faint">시행 {c.effectiveDate}</span>
                    {c.sourceUrl ? (
                      <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">
                        원문 보기
                      </a>
                    ) : null}
                  </div>
                  {missing ? (
                    <p className="legal-mark" data-mark="unverified">
                      원문 없음 · 근거 수에서 뺐습니다
                    </p>
                  ) : (
                    <blockquote className="legal-excerpt">{c.excerpt}</blockquote>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="legal-faint">근거 조항이 없습니다.</p>
        )}
      </Section>

      {answer.figures?.length ? (
        <Section title="그림">
          {answer.figures.map((figure, i) => (
            <figure key={i} className="legal-figure">
              {/* Images only: never inline SVG markup (SPEC-13.5). */}
              <img src={figure.url} alt={figure.caption} />
              <figcaption>{figure.caption}</figcaption>
            </figure>
          ))}
        </Section>
      ) : null}

      {interpretation.length ? (
        <Section title="해석">
          <ul className="legal-interpretation">
            {interpretation.map((part, i) => (
              <li key={i}>
                {part.basis === 'ai' ? (
                  <ProvenanceTag kind="ai-verified" detail={proseDetail} />
                ) : part.basis === 'verified' ? (
                  <ProvenanceTag kind="service-confirmed" />
                ) : (
                  <ProvenanceTag kind="service" />
                )}
                <span>{part.text}</span>
                {part.refs.map((ref) => (
                  <span key={ref} className="legal-refchip" data-cited={String(cited.has(ref))}>
                    {refLabel(answer, ref)}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {answer.checks.length ? (
        <Section title="확인 필요 사항" tag={<ProvenanceTag kind="service" />}>
          <ul className="legal-checks">
            {answer.checks.map((check, i) => (
              <li key={i}>
                {check.text}
                {check.dependsOn?.length ? (
                  <small className="legal-faint">
                    {' '}
                    · 달린 정보: {check.dependsOn.map((k) => labels[k] ?? k).join(', ')}
                  </small>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {children}

      <Section title="쓴 정보" tag={<ProvenanceTag kind="project" />}>
        <ul className="legal-used">
          {usedRows.map(([key, entry]) => (
            <li key={key}>
              <span>{labels[key] ?? key}</span>
              <strong>{valueText(entry)}</strong>
              <small data-source={entry.source}>{SOURCE_TEXT[entry.source] ?? entry.source}</small>
            </li>
          ))}
          {answer.usedProfile
            .filter((key) => !view.sent.profile[key])
            .map((key) => (
              <li key={key}>
                <span>{labels[key] ?? key}</span>
                <strong className="legal-faint">보내지 않음</strong>
              </li>
            ))}
          <li>
            <span>설계 단계</span>
            <strong>{STAGE_TEXT[view.stage] ?? view.stage}</strong>
          </li>
          <li>
            <span>법령 DB 기준일</span>
            <strong>{dateText(view.lawDbDate)}</strong>
          </li>
          <li>
            <span>조회 시각</span>
            <strong>{timeText(view.fetchedAt)}</strong>
          </li>
        </ul>
      </Section>

      {onReask ? (
        <footer className="legal-answer-foot">
          <button type="button" disabled={busy} onClick={onReask}>
            다시 묻기
          </button>
        </footer>
      ) : null}
    </article>
  );
}

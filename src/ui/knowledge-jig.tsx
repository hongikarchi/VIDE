import { useEffect, useState } from 'react';
import {
  KIND,
  VERDICT_TEXT,
  factsFor,
  standingOf,
  type AvailableSummary,
  type BriefItem,
  type Evidence,
  type Issue,
  type Review,
  type Statement,
  type Summary,
  type Verdict,
} from './facts-api.ts';
import './facts-tab.css';

// Project knowledge views (PLAN-08 K0, PLAN-22 T-065, SCR-19): a status report first (decided,
// blocked, recently changed — project page, then each discipline), issue notes like meeting minutes
// behind it, evidence only on request. The pieces are shared by the 자료 workspace tab
// (src/ui/facts-tab.tsx), the fact window of a basis chip (src/ui/jig-panel/basis-parts.tsx) and the
// older JIG-list entry (`KnowledgeJig`). Review actions (확정·기각·오염) are a person's actions and
// only show when the engine keeps the review layer (facts routes); the crawler DB is never written.

export { KIND };
const base = (path: string) => path.split('/').at(-1);

/** The review state of a statement as a chip: 확정 · 기각 · 오염 (with the reason) or 미확정. */
export function ReviewChip({ review }: { review?: Review | null }) {
  if (!review)
    return (
      <span className="fact-standing" data-standing="unconfirmed">
        미확정
      </span>
    );
  const standing = standingOf({ review });
  return (
    <span
      className="fact-standing"
      data-standing={standing}
      data-verdict={review.verdict}
      title={[review.reason, review.by, review.at?.slice(0, 10)].filter(Boolean).join(' · ')}
    >
      {standing === 'excluded' ? '⚠ ' : ''}
      {VERDICT_TEXT[review.verdict] ?? review.verdict}
      {review.reason && standing === 'excluded' ? ` · ${review.reason}` : ''}
    </span>
  );
}

export function highlight(text: string, quote: string) {
  const at = quote ? text.indexOf(quote) : -1;
  if (at < 0) return <p>{text}</p>;
  return (
    <p>
      {text.slice(0, at)}
      <mark>{quote}</mark>
      {text.slice(at + quote.length)}
    </p>
  );
}

const ACTIONS: { verdict: Verdict; label: string; needsReason: boolean }[] = [
  { verdict: 'confirmed', label: '확정', needsReason: false },
  { verdict: 'rejected', label: '기각', needsReason: true },
  { verdict: 'contaminated', label: '오염 표시', needsReason: true },
];

/** 확정 · 기각 · 오염 표시 with a reason; 오염 may leave the whole source file out. */
export function ReviewActions({
  projectId,
  statementId,
  sourceId,
  path,
  onReviewed,
}: {
  projectId: string;
  statementId: number;
  sourceId: number;
  path: string;
  onReviewed: (review: Review) => void;
}) {
  const client = factsFor(projectId);
  const [pending, setPending] = useState<Verdict>();
  const [reason, setReason] = useState('');
  const [wholeSource, setWholeSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState(client.mode());
  useEffect(() => {
    let live = true;
    void client.ready().then((value) => live && setMode(value));
    return () => {
      live = false;
    };
  }, [client]);
  if (mode !== 'facts')
    return (
      <small className="knowledge-meta">
        이 엔진은 검토 기록을 지원하지 않습니다. 앱을 업데이트하면 확정·오염 표시를 쓸 수 있습니다.
      </small>
    );
  // Confirming is a person's act: the engine records who from the session, not from this form.
  const action = ACTIONS.find((entry) => entry.verdict === pending);
  const submit = async (verdict: Verdict) => {
    setBusy(true);
    setMessage('');
    try {
      const review = await client.review(statementId, { verdict, reason });
      if (verdict === 'contaminated' && wholeSource)
        await client.rule(sourceId, { reason: reason || '오염 표시' });
      setPending(undefined);
      setReason('');
      setWholeSource(false);
      onReviewed(review);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '기록하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fact-review" role="group" aria-label="검토">
      <div className="fact-review-buttons">
        {ACTIONS.map((entry) => (
          <button
            key={entry.verdict}
            type="button"
            data-verdict={entry.verdict}
            aria-pressed={pending === entry.verdict}
            disabled={busy}
            onClick={() =>
              entry.needsReason
                ? setPending(pending === entry.verdict ? undefined : entry.verdict)
                : void submit(entry.verdict)
            }
          >
            {entry.label}
          </button>
        ))}
      </div>
      {action ? (
        <form
          className="fact-review-reason"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim()) void submit(action.verdict);
          }}
        >
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={
              action.verdict === 'contaminated'
                ? '이유 (예: 다른 프로젝트 폴더의 파일)'
                : '이유 (예: 이후 회의에서 철회)'
            }
            aria-label={`${action.label} 이유`}
            maxLength={400}
            autoFocus
          />
          {action.verdict === 'contaminated' ? (
            <label title={path}>
              <input
                type="checkbox"
                checked={wholeSource}
                onChange={(event) => setWholeSource(event.target.checked)}
              />{' '}
              이 파일({base(path)})의 진술 모두 제외
            </label>
          ) : null}
          <button type="submit" disabled={busy || !reason.trim()}>
            {action.label} 기록
          </button>
        </form>
      ) : null}
      {message ? (
        <small className="knowledge-meta" role="alert">
          {message}
        </small>
      ) : null}
    </div>
  );
}

/**
 * One statement in full: the words, who said it and when, its review, the excerpt with the quoted
 * passage marked, the file, [원본 열기] (a person's action) and the review actions.
 */
export function FactDetail({
  projectId,
  statementId,
  statement: known,
  onReviewed,
}: {
  projectId: string;
  statementId: number;
  statement?: Statement;
  onReviewed?: (statementId: number, review: Review) => void;
}) {
  const client = factsFor(projectId);
  const [evidence, setEvidence] = useState<Evidence>();
  const [error, setError] = useState('');
  const [review, setReview] = useState<Review | null | undefined>(known?.review);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let live = true;
    setEvidence(undefined);
    setError('');
    client
      .statement(statementId)
      .then((value) => {
        if (!live) return;
        setEvidence(value);
        const found = value.review ?? value.statement?.review;
        if (found !== undefined) setReview(found);
      })
      .catch(() => live && setError('진술을 읽지 못했습니다.'));
    return () => {
      live = false;
    };
  }, [client, statementId]);
  const statement = known ?? evidence?.statement ?? undefined;
  const content = statement?.content ?? evidence?.content ?? '';
  const quote = statement?.quote ?? evidence?.quote ?? '';
  const path = evidence?.path ?? statement?.path ?? '';
  const sourceId = evidence?.sourceId ?? statement?.sourceId;
  return (
    <article className="fact-detail" data-statement={statementId}>
      <header>
        {statement ? <span className="pill">{KIND[statement.kind] ?? statement.kind}</span> : null}{' '}
        <ReviewChip review={review} />{' '}
        <small className="knowledge-meta">
          진술 {statementId}
          {statement
            ? ` · ${statement.saidOn ?? '날짜 없음'} · ${statement.party || '주체 미상'}`
            : ''}
        </small>
      </header>
      {content ? <p className="fact-content">{content}</p> : null}
      {error ? <p className="knowledge-meta">{error}</p> : null}
      {evidence ? (
        <>
          <blockquote className="knowledge-evidence">
            <small className="knowledge-meta">
              {evidence.path} · {evidence.locator}
            </small>
            {highlight(evidence.text, quote)}
          </blockquote>
          <div className="fact-actions">
            <button
              type="button"
              onClick={async () => {
                try {
                  await client.openSource(evidence.sourceId);
                  setMessage('');
                } catch {
                  setMessage('원본을 열 수 없습니다(서버 연결·경로 확인).');
                }
              }}
            >
              원본 열기
            </button>
            {message ? <small className="knowledge-meta">{message}</small> : null}
          </div>
        </>
      ) : !error ? (
        <p className="knowledge-meta">원문을 읽는 중…</p>
      ) : null}
      {sourceId !== undefined ? (
        <ReviewActions
          projectId={projectId}
          statementId={statementId}
          sourceId={sourceId}
          path={path}
          onReviewed={(value) => {
            setReview(value);
            onReviewed?.(statementId, value);
          }}
        />
      ) : null}
    </article>
  );
}

/** A statement row; its evidence opens inline, or in the caller's place with `onSelect`. */
export function StatementRow({
  projectId,
  statement,
  selected,
  onSelect,
}: {
  projectId: string;
  statement: Statement;
  selected?: boolean;
  onSelect?: (statement: Statement) => void;
}) {
  const [open, setOpen] = useState(false);
  const standing = standingOf(statement);
  return (
    <li
      className="knowledge-statement"
      data-standing={standing}
      aria-current={selected || undefined}
    >
      <div>
        <span className="pill">{KIND[statement.kind] ?? statement.kind}</span>{' '}
        <ReviewChip review={statement.review} />{' '}
        <small className="knowledge-meta">
          {statement.saidOn ?? '날짜 없음'} · {statement.party || '주체 미상'}
        </small>
      </div>
      <p>{statement.content}</p>
      <small className="knowledge-meta" title={statement.path}>
        {base(statement.path)} · {statement.locator}{' '}
        <button
          type="button"
          className="link-button"
          onClick={() => (onSelect ? onSelect(statement) : setOpen(!open))}
        >
          {onSelect ? '근거 원문' : open ? '원문 닫기' : '원문'}
        </button>
      </small>
      {open && !onSelect ? (
        <FactDetail projectId={projectId} statementId={statement.id} statement={statement} />
      ) : null}
    </li>
  );
}

function NoteSection({
  projectId,
  title,
  items,
  statements,
  folded = false,
  onSelect,
}: {
  projectId: string;
  title: string;
  folded?: boolean;
  items: { text: string; cite: number[]; date?: string | null; party?: string | null }[];
  statements: Map<number, Statement>;
  onSelect?: (statement: Statement) => void;
}) {
  const [open, setOpen] = useState<number>();
  if (!items.length) return null;
  const list = (
    <ul>
      {items.map((entry, index) => (
        <li key={index}>
          {entry.date ? (
            <small className="knowledge-meta">
              {entry.date} · {entry.party || ''}{' '}
            </small>
          ) : null}
          {entry.text}{' '}
          {entry.cite.length ? (
            <button
              type="button"
              className="link-button fact-cite"
              onClick={() => setOpen(open === index ? undefined : index)}
            >
              근거 {entry.cite.length}
            </button>
          ) : null}
          {open === index ? (
            <ul className="knowledge-cites">
              {entry.cite
                .map((id) => statements.get(id))
                .filter((s): s is Statement => !!s)
                .map((s) => (
                  <StatementRow
                    key={s.id}
                    projectId={projectId}
                    statement={s}
                    onSelect={onSelect}
                  />
                ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
  return (
    <section className="knowledge-section">
      {folded ? (
        <details>
          <summary>
            {title} <small className="knowledge-meta">{items.length}</small>
          </summary>
          {list}
        </details>
      ) : (
        <>
          <h4>{title}</h4>
          {list}
        </>
      )}
    </section>
  );
}

/** The issue note: 결론 → 미결 → 조건 → 경과, each line with its basis. */
export function IssueNote({
  projectId,
  issue,
  onSelect,
}: {
  projectId: string;
  issue: Issue;
  onSelect?: (statement: Statement) => void;
}) {
  const statements = new Map(issue.statements.map((s) => [s.id, s]));
  const [all, setAll] = useState(false);
  const section = (title: string, items: Issue['note']['open'], folded = false) => (
    <NoteSection
      projectId={projectId}
      title={title}
      items={items}
      statements={statements}
      folded={folded}
      onSelect={onSelect}
    />
  );
  return (
    <article className="knowledge-note">
      <h3>
        {issue.label} · {issue.title}{' '}
        <span className="pill" data-ok={String(issue.status === 'settled')}>
          {issue.status === 'settled' ? '정리됨' : '진행 중'}
        </span>
      </h3>
      {issue.summary ? <p className="knowledge-summary">{issue.summary}</p> : null}
      {section('현재 결론', issue.note.conclusions)}
      {section('미결·확인 필요', issue.note.open)}
      {section('조건', issue.note.conditions, true)}
      {section('경과', issue.note.history, true)}
      <button type="button" className="link-button" onClick={() => setAll(!all)}>
        {all ? '관련 진술 닫기' : `관련 진술 ${issue.statements.length}개 모두 보기`}
      </button>
      {all ? (
        <ul className="knowledge-cites">
          {issue.statements.map((s) => (
            <StatementRow key={s.id} projectId={projectId} statement={s} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
      <small className="knowledge-meta">
        AI가 자료에서 정리한 초안입니다. 확정 전에는 근거로 확인하세요.
      </small>
    </article>
  );
}

export const LISTS = [
  ['decided', '정해진 것'],
  ['blocked', '막힌 것'],
  ['changed', '최근 바뀐 것'],
] as const;
export type ListKey = (typeof LISTS)[number][0];
type Lists = Record<ListKey, BriefItem[]>;

/** One brief line; the issue note behind it opens on click. */
function BriefLine({
  item,
  label,
  onOpen,
}: {
  item: BriefItem;
  label?: string;
  onOpen: (issue: number) => void;
}) {
  const meta = [item.date || item.since, label, item.waiting ? '기다리는 곳: ' + item.waiting : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <li>
      <button type="button" className="knowledge-brief-item" onClick={() => onOpen(item.issue)}>
        {meta ? <small className="knowledge-meta">{meta}</small> : null}
        <span>{item.text}</span>
      </button>
    </li>
  );
}

export function BriefLists({
  brief,
  labels,
  only,
  onOpen,
}: {
  brief: Lists;
  labels?: Map<string, string>;
  /** Show one list only (the left column's 보기). */
  only?: ListKey;
  onOpen: (issue: number) => void;
}) {
  return (
    <div className="knowledge-brief-lists">
      {LISTS.filter(([key]) => !only || key === only).map(([key, title]) =>
        brief[key].length ? (
          <section key={key} className="knowledge-section" data-list={key}>
            <h4>{title}</h4>
            <ul>
              {brief[key].map((item, index) => (
                <BriefLine
                  key={index}
                  item={item}
                  label={item.discipline ? labels?.get(item.discipline) : undefined}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}

/** Status report: the project page, then one folded status per discipline. */
export function Report({
  summary,
  only,
  discipline,
  onOpen,
}: {
  summary: AvailableSummary;
  only?: ListKey;
  /** Show one discipline's status only. */
  discipline?: string;
  onOpen: (issue: number) => void;
}) {
  const labels = new Map(summary.disciplines.map((d) => [d.key, d.label]));
  const brief = summary.brief;
  if (!brief)
    return (
      <p className="jig-intro">
        이 DB에는 현황 요약이 없습니다. “이슈 전체”에서 분야별 이슈를 보세요.
      </p>
    );
  const disciplines = summary.disciplines.filter((d) => !discipline || d.key === discipline);
  return (
    <article className="knowledge-report">
      <p className="knowledge-meta">
        자료의 마지막 날짜 {brief.asOf ?? '미상'} 기준
        {brief.since ? ' · 최근 = ' + brief.since + ' 이후' : ''} · 항목을 누르면 이슈 노트와 근거가
        열립니다.
      </p>
      {discipline ? null : (
        <>
          {brief.overview ? <p className="knowledge-summary">{brief.overview}</p> : null}
          <BriefLists brief={brief} labels={labels} only={only} onOpen={onOpen} />
        </>
      )}
      <h3>분야별 현황</h3>
      {disciplines.map((d) =>
        d.brief ? (
          <details key={d.key} className="knowledge-discipline" open={!!discipline}>
            <summary>
              <strong>{d.label}</strong>
              {d.brief.blocked.length ? (
                <span className="pill">막힘 {d.brief.blocked.length}</span>
              ) : null}
              <span className="knowledge-meta">{d.brief.state}</span>
            </summary>
            <BriefLists brief={d.brief} only={only} onOpen={onOpen} />
          </details>
        ) : null,
      )}
    </article>
  );
}

/** The DB's size line: files · mails · statements · issues · built. */
export const countsLine = (summary: AvailableSummary) =>
  `파일 ${summary.counts.files.toLocaleString()}개 · 메일 ${summary.counts.mails}통 · 진술 ${summary.counts.statements.toLocaleString()}개 · 이슈 ${summary.counts.issues}개${summary.builtAt ? ` · 정리 ${summary.builtAt.slice(0, 10)}` : ''}`;

export const NO_DB =
  '이 프로젝트에는 아직 자료 DB가 없습니다. 시험판에서는 수집을 앱 밖에서 실행합니다(PLAN-08 K0).';

/** The older JIG-list entry: the same views in the jig dialog. */
export function KnowledgeJig({ projectId }: { projectId: string }) {
  const client = factsFor(projectId);
  const [summary, setSummary] = useState<Summary>();
  const [error, setError] = useState('');
  const [issue, setIssue] = useState<Issue>();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [results, setResults] = useState<Statement[]>();
  const [view, setView] = useState<'report' | 'issues'>('report');
  useEffect(() => {
    client
      .summary()
      .then(setSummary)
      .catch(() => setError('자료 DB를 읽지 못했습니다.'));
  }, [client]);
  const openIssue = async (id: number) => {
    setResults(undefined);
    setView('issues');
    setIssue(await client.issue(id));
  };
  const search = async () => {
    setIssue(undefined);
    setView('issues');
    setResults((await client.search(query, { kind })).statements);
  };
  if (error) return <p className="jig-intro">{error}</p>;
  if (!summary) return <p className="jig-intro">불러오는 중…</p>;
  if (!summary.available) return <p className="jig-intro">{NO_DB}</p>;
  return (
    <div className="knowledge-jig">
      <p className="jig-intro">{countsLine(summary)}</p>
      <form
        className="knowledge-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="검색 (예: 스팬, 허용하중, 소방차)"
          aria-label="자료 검색"
        />
        <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="종류">
          <option value="">모든 종류</option>
          {Object.entries(KIND).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!query.trim()}>
          검색
        </button>
      </form>
      <div className="knowledge-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'report'}
          onClick={() => setView('report')}
        >
          현황 보고서
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'issues'}
          onClick={() => setView('issues')}
        >
          이슈 전체
        </button>
      </div>
      {view === 'report' ? (
        <Report summary={summary} onOpen={(id) => void openIssue(id)} />
      ) : (
        <div className="knowledge-body">
          <nav className="knowledge-issues" aria-label="분야별 이슈">
            {summary.disciplines.map((discipline) => (
              <details
                key={discipline.key}
                open={issue ? discipline.label === issue.label : discipline.key === 'structure'}
              >
                <summary>
                  {discipline.label} <small>{discipline.issues.length}</small>
                </summary>
                <ul>
                  {discipline.issues.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        aria-pressed={issue?.id === entry.id}
                        title={entry.summary}
                        onClick={() => void openIssue(entry.id)}
                      >
                        {entry.title}
                        <small>
                          {entry.statements}
                          {entry.open ? ` · 미결 ${entry.open}` : ''}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </nav>
          <div className="knowledge-main">
            {results ? (
              <>
                <h3>
                  검색 결과 {results.length}개{' '}
                  <small className="knowledge-meta">
                    (내용에 검색어가 있는 것 먼저, 최신순, 최대 100개)
                  </small>
                </h3>
                <ul className="knowledge-cites">
                  {results.map((s) => (
                    <StatementRow key={s.id} projectId={projectId} statement={s} />
                  ))}
                </ul>
              </>
            ) : issue ? (
              <IssueNote key={issue.id} projectId={projectId} issue={issue} />
            ) : (
              <p className="jig-intro">왼쪽에서 이슈를 고르거나 검색하세요.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// The 자료 workspace tab (PLAN-22 T-065, Design SCR-19, PRD C-02, ADR-018): the left column holds
// search (`/`), the 보기 (정해진 것 · 막힌 것 · 바뀐 것), the disciplines with their issue counts,
// the status filter (확정 · 미확정 · 제외) and the cards of suspected contamination; the centre shows
// the KPI strip, the status report, an issue note or the search results; the drawer below shows the
// chosen statement's excerpt, [원본 열기] and the review actions. The views are the ones of the
// knowledge jig (src/ui/knowledge-jig.tsx); the data comes from the facts routes (src/ui/facts-api.ts).
// Excluded statements (오염 · 기각 · 대체) stay out of the default search and show only on request.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  factsFor,
  standingOf,
  type AvailableSummary,
  type Issue,
  type Review,
  type Statement,
  type Summary,
  type Suspect,
} from './facts-api.ts';
import {
  FactDetail,
  IssueNote,
  KIND,
  LISTS,
  NO_DB,
  Report,
  StatementRow,
  countsLine,
  type ListKey,
} from './knowledge-jig.tsx';
import { KpiStrip } from './kit/status.tsx';
import './facts-tab.css';

type Standing = '' | 'confirmed' | 'unconfirmed' | 'excluded';
type View =
  | { kind: 'report'; only?: ListKey }
  | { kind: 'discipline'; key: string }
  | { kind: 'issue'; issue: Issue }
  | {
      kind: 'search';
      query: string;
      excludedOnly: boolean;
      statements: Statement[];
      excluded: number;
    };

const SHOW_STATEMENT = 'vide:facts-statement';
const REVIEWED = 'vide:facts-reviewed';

const withReview = (statements: Statement[], id: number, review: Review) =>
  statements.map((s) => (s.id === id ? { ...s, review } : s));

/** Cards of statements that look like they came from elsewhere; recorded only when confirmed. */
function SuspectCards({
  projectId,
  suspects,
  onRecorded,
}: {
  projectId: string;
  suspects: readonly Suspect[];
  onRecorded: () => void;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState<number>();
  const [message, setMessage] = useState('');
  const shown = suspects.filter((s) => !dismissed.has(s.sourceId));
  if (!shown.length) return null;
  return (
    <section className="facts-suspects" aria-label="오염 의심 묶음">
      <h4>⚠ 오염 의심 묶음</h4>
      {shown.map((suspect) => (
        <article key={suspect.sourceId} className="facts-suspect" data-source={suspect.sourceId}>
          <strong title={suspect.path}>{suspect.path.split('/').at(-1)}</strong>
          <small className="knowledge-meta">
            진술 {suspect.statements}개{suspect.reason ? ` · ${suspect.reason}` : ''}
          </small>
          <div className="fact-actions">
            <button
              type="button"
              disabled={busy !== undefined}
              onClick={async () => {
                setBusy(suspect.sourceId);
                setMessage('');
                try {
                  await factsFor(projectId).rule(suspect.sourceId, {
                    reason: suspect.reason || '오염 의심 묶음 확인',
                    ...(suspect.pattern ? { pattern: suspect.pattern } : {}),
                  });
                  setDismissed(new Set([...dismissed, suspect.sourceId]));
                  onRecorded();
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : '기록하지 못했습니다.');
                } finally {
                  setBusy(undefined);
                }
              }}
            >
              오염으로 제외
            </button>
            <button
              type="button"
              className="link-button"
              title="기록하지 않고 이 카드만 닫습니다"
              onClick={() => setDismissed(new Set([...dismissed, suspect.sourceId]))}
            >
              아님
            </button>
          </div>
        </article>
      ))}
      {message ? (
        <small className="knowledge-meta" role="alert">
          {message}
        </small>
      ) : null}
    </section>
  );
}

function FactsTab({ projectId }: { projectId: string }) {
  const client = factsFor(projectId);
  const [summary, setSummary] = useState<Summary>();
  const [error, setError] = useState('');
  const [view, setView] = useState<View>({ kind: 'report' });
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [standing, setStanding] = useState<Standing>('');
  const [selected, setSelected] = useState<{ id: number; statement?: Statement } | undefined>(() =>
    takePending(projectId),
  );
  const [loading, setLoading] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);

  const load = useCallback(
    (fresh = false) =>
      client
        .summary(fresh)
        .then((value) => {
          setSummary(value);
          setError('');
        })
        .catch(() => setError('자료 DB를 읽지 못했습니다.')),
    [client],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const reviewed = useCallback(
    (id: number, review: Review) => {
      setView((current) =>
        current.kind === 'search'
          ? { ...current, statements: withReview(current.statements, id, review) }
          : current.kind === 'issue'
            ? {
                ...current,
                issue: {
                  ...current.issue,
                  statements: withReview(current.issue.statements, id, review),
                },
              }
            : current,
      );
      setSelected((current) =>
        current?.id === id && current.statement
          ? { id, statement: { ...current.statement, review } }
          : current,
      );
      void load(true);
    },
    [load],
  );

  // The fact window of a basis chip hands over a statement or a review made there.
  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; statementId: number }>).detail;
      if (detail?.projectId === projectId) setSelected({ id: detail.statementId });
    };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; id: number; review: Review }>)
        .detail;
      if (detail?.projectId === projectId) reviewed(detail.id, detail.review);
    };
    addEventListener(SHOW_STATEMENT, show);
    addEventListener(REVIEWED, changed);
    return () => {
      removeEventListener(SHOW_STATEMENT, show);
      removeEventListener(REVIEWED, changed);
    };
  }, [projectId, reviewed]);

  // `/` focuses the search while the tab shows and no field has the focus.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== '/' || document.body.dataset.workspace !== 'data') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      searchBox.current?.focus();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);

  const openIssue = async (id: number) => {
    setLoading(true);
    try {
      setView({ kind: 'issue', issue: await client.issue(id) });
    } catch {
      setError('이슈를 읽지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };
  const search = async (excludedOnly = false) => {
    const text = query.trim();
    if (!text) return;
    setLoading(true);
    try {
      const result = await client.search(text, { kind, excluded: excludedOnly });
      setView({ kind: 'search', query: text, excludedOnly, ...result });
    } catch {
      setError('검색하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };
  const select = (statement: Statement) => setSelected({ id: statement.id, statement });

  if (error && !summary) return <p className="jig-intro">{error}</p>;
  if (!summary) return <p className="jig-intro">불러오는 중…</p>;
  if (!summary.available) return <p className="jig-intro">{NO_DB}</p>;
  const reviews = summary.reviews ?? {};
  const legacy = client.mode() !== 'facts';

  return (
    <>
      <aside className="facts-left" aria-label="자료 찾기">
        <form
          className="knowledge-search facts-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <input
            ref={searchBox}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="검색 (/) 예: 스팬, 허용하중"
            aria-label="자료 검색"
            aria-keyshortcuts="/"
          />
          <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="종류">
            <option value="">모든 종류</option>
            {Object.entries(KIND).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <button type="submit" disabled={!query.trim() || loading}>
            검색
          </button>
        </form>
        <h4>보기</h4>
        <ul className="facts-nav">
          <li>
            <button
              type="button"
              aria-pressed={view.kind === 'report' && !view.only}
              onClick={() => setView({ kind: 'report' })}
            >
              현황 보고서
            </button>
          </li>
          {LISTS.map(([key, title]) => (
            <li key={key}>
              <button
                type="button"
                aria-pressed={view.kind === 'report' && view.only === key}
                onClick={() => setView({ kind: 'report', only: key })}
              >
                {title}
                <small>{summary.brief?.[key].length ?? 0}</small>
              </button>
            </li>
          ))}
        </ul>
        <h4>분야</h4>
        <ul className="facts-nav" aria-label="분야">
          {summary.disciplines.map((d) => (
            <li key={d.key}>
              <button
                type="button"
                aria-pressed={view.kind === 'discipline' && view.key === d.key}
                onClick={() => setView({ kind: 'discipline', key: d.key })}
              >
                {d.label}
                <small>{d.issues.length}</small>
              </button>
            </li>
          ))}
        </ul>
        <h4>상태</h4>
        <div className="kit-chips facts-status" role="group" aria-label="상태 필터">
          {(
            [
              ['', '전체'],
              ['confirmed', '확정'],
              ['unconfirmed', '미확정'],
              ['excluded', '오염·기각'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value || 'all'}
              type="button"
              aria-pressed={standing === value}
              onClick={() => setStanding(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {summary.rules?.length ? (
          <small className="knowledge-meta">제외 규칙 {summary.rules.length}개 적용 중</small>
        ) : null}
        <SuspectCards
          projectId={projectId}
          suspects={summary.suspects ?? []}
          onRecorded={() => void load(true)}
        />
        {legacy ? (
          <small className="knowledge-meta">
            이 엔진은 검토 기록을 지원하지 않아 확정·오염 표시는 쓸 수 없습니다.
          </small>
        ) : null}
      </aside>
      <div className="facts-main">
        <p className="knowledge-meta">{countsLine(summary)}</p>
        <KpiStrip
          items={[
            { label: '진술', value: summary.counts.statements.toLocaleString() },
            {
              label: '확정',
              value: legacy ? undefined : String(reviews.confirmed ?? 0),
              empty: '기록 없음',
            },
            { label: '이슈', value: String(summary.counts.issues) },
            {
              label: '오염 표시',
              value: legacy ? undefined : String(reviews.contaminated ?? 0),
              empty: '기록 없음',
              note: reviews.rejected ? `기각 ${reviews.rejected}` : undefined,
            },
          ]}
        />
        {error ? (
          <p className="knowledge-meta" role="alert">
            {error}
          </p>
        ) : null}
        {loading ? <p className="knowledge-meta">읽는 중…</p> : null}
        <Centre
          projectId={projectId}
          summary={summary}
          view={view}
          standing={standing}
          selected={selected?.id}
          onOpenIssue={(id) => void openIssue(id)}
          onSelect={select}
          onShowExcluded={() => void search(true)}
          onBack={() => void search(false)}
        />
      </div>
      <section className="facts-drawer" aria-label="근거 원문" hidden={!selected}>
        {selected ? (
          <>
            <header>
              <strong>근거 원문</strong>
              <button type="button" aria-label="근거 닫기" onClick={() => setSelected(undefined)}>
                ×
              </button>
            </header>
            <FactDetail
              key={selected.id}
              projectId={projectId}
              statementId={selected.id}
              statement={selected.statement}
              onReviewed={reviewed}
            />
          </>
        ) : null}
      </section>
    </>
  );
}

function Centre({
  projectId,
  summary,
  view,
  standing,
  selected,
  onOpenIssue,
  onSelect,
  onShowExcluded,
  onBack,
}: {
  projectId: string;
  summary: AvailableSummary;
  view: View;
  standing: Standing;
  selected?: number;
  onOpenIssue: (id: number) => void;
  onSelect: (statement: Statement) => void;
  onShowExcluded: () => void;
  onBack: () => void;
}) {
  if (view.kind === 'report')
    return <Report summary={summary} only={view.only} onOpen={onOpenIssue} />;
  if (view.kind === 'discipline') {
    const discipline = summary.disciplines.find((d) => d.key === view.key);
    if (!discipline) return null;
    return (
      <div className="facts-discipline">
        {discipline.brief ? (
          <Report summary={summary} discipline={discipline.key} onOpen={onOpenIssue} />
        ) : null}
        <h3>
          {discipline.label} 이슈{' '}
          <small className="knowledge-meta">{discipline.issues.length}</small>
        </h3>
        <ul className="facts-issues">
          {discipline.issues.map((entry) => (
            <li key={entry.id}>
              <button type="button" title={entry.summary} onClick={() => onOpenIssue(entry.id)}>
                <span>{entry.title}</span>
                <small className="knowledge-meta">
                  {entry.status === 'settled' ? '정리됨' : '진행 중'} · 진술 {entry.statements}
                  {entry.open ? ` · 미결 ${entry.open}` : ''}
                </small>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (view.kind === 'issue')
    return (
      <IssueNote key={view.issue.id} projectId={projectId} issue={view.issue} onSelect={onSelect} />
    );
  const shown = view.statements.filter((s) => !standing || standingOf(s) === standing);
  return (
    <section className="facts-results" aria-label="검색 결과">
      <h3>
        {view.excludedOnly ? '제외된 진술' : '검색 결과'} {shown.length}개{' '}
        <small className="knowledge-meta">
          ‘{view.query}’ · 내용에 검색어가 있는 것 먼저, 최신순
          {standing ? ` · 상태 필터 적용(전체 ${view.statements.length})` : ''}
        </small>
      </h3>
      {view.excludedOnly ? (
        <button type="button" className="link-button" onClick={onBack}>
          기본 결과로 돌아가기
        </button>
      ) : view.excluded ? (
        <button type="button" className="link-button facts-excluded" onClick={onShowExcluded}>
          제외된 {view.excluded}건 보기
        </button>
      ) : null}
      {shown.length ? (
        <ul className="knowledge-cites">
          {shown.map((s) => (
            <StatementRow
              key={s.id}
              projectId={projectId}
              statement={s}
              selected={s.id === selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : (
        <p className="jig-intro">맞는 진술이 없습니다.</p>
      )}
    </section>
  );
}

let root: Root | undefined;
let shownFor: string | undefined;
let pending: { projectId: string; statementId: number } | undefined;
function takePending(projectId: string) {
  const value = pending?.projectId === projectId ? { id: pending.statementId } : undefined;
  pending = undefined;
  return value;
}

/** Show one statement in the drawer (the fact window's 자료 탭에서 보기), mounted or not yet. */
export function showStatement(projectId: string, statementId: number) {
  if (shownFor === projectId)
    dispatchEvent(new CustomEvent(SHOW_STATEMENT, { detail: { projectId, statementId } }));
  else pending = { projectId, statementId };
}

/** Show the 자료 tab of a project (mounts once; later calls keep what is open). */
export function showFacts(projectId: string) {
  const workspace = document.querySelector<HTMLElement>('.workspace');
  if (!workspace) return;
  if (!root) {
    const host = document.createElement('section');
    host.className = 'facts-workspace';
    host.setAttribute('aria-label', '자료');
    workspace.append(host);
    root = createRoot(host);
  }
  if (shownFor !== projectId) {
    shownFor = projectId;
    root.render(<FactsTab key={projectId} projectId={projectId} />);
  }
}

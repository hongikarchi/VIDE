import { useEffect, useState } from 'react';
import { z } from 'zod';
import { api } from './gateway.ts';

// Project knowledge jig (trial): a status report first (decided, blocked, recently changed — project
// page, then each discipline), issue notes like meeting minutes behind it, evidence only on request.
// Read-only; the DB is built outside the app for now (PLAN-08 K0, K0-T2).
const statementSchema = z.object({
  id: z.number(),
  kind: z.string(),
  party: z.string().nullable(),
  subject: z.string().nullable(),
  content: z.string(),
  saidOn: z.string().nullable(),
  quote: z.string().nullable(),
  sourceId: z.number(),
  path: z.string(),
  locator: z.string(),
});
type Statement = z.infer<typeof statementSchema>;
const item = z.object({ text: z.string().default(''), cite: z.array(z.number()).default([]) });
const issueSchema = z.object({
  id: z.number(),
  title: z.string(),
  label: z.string(),
  status: z.string(),
  summary: z.string(),
  note: z.object({
    conclusions: z.array(item).default([]),
    conditions: z.array(item).default([]),
    open: z.array(item).default([]),
    history: z
      .array(
        item.extend({
          date: z.string().nullable().default(''),
          party: z.string().nullable().default(''),
        }),
      )
      .default([]),
  }),
  statements: z.array(statementSchema),
});
type Issue = z.infer<typeof issueSchema>;
const briefItem = z.object({
  text: z.string(),
  issue: z.number(),
  cite: z.array(z.number()).default([]),
  date: z.string().nullish(),
  since: z.string().nullish(),
  waiting: z.string().nullish(),
  discipline: z.string().nullish(),
});
type BriefItem = z.infer<typeof briefItem>;
const briefLists = {
  decided: z.array(briefItem).default([]),
  blocked: z.array(briefItem).default([]),
  changed: z.array(briefItem).default([]),
};
const projectBrief = z.object({
  overview: z.string().default(''),
  asOf: z.string().nullish(),
  since: z.string().nullish(),
  ...briefLists,
});
const disciplineBrief = z.object({ state: z.string().default(''), ...briefLists });
const summarySchema = z.union([
  z.object({ available: z.literal(false) }),
  z.object({
    available: z.literal(true),
    builtAt: z.string().nullable(),
    brief: projectBrief.nullish(),
    counts: z.object({
      files: z.number(),
      excerpts: z.number(),
      statements: z.number(),
      issues: z.number(),
      mails: z.number(),
    }),
    disciplines: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        brief: disciplineBrief.nullish(),
        issues: z.array(
          z.object({
            id: z.number(),
            title: z.string(),
            status: z.string(),
            summary: z.string(),
            statements: z.number(),
            open: z.number(),
          }),
        ),
      }),
    ),
  }),
]);
type Summary = z.infer<typeof summarySchema>;
const evidenceSchema = z.object({
  text: z.string(),
  locator: z.string(),
  path: z.string(),
  sourceId: z.number(),
  root: z.string().nullable(),
});
const KIND: Record<string, string> = {
  decision: '결정',
  request: '요청',
  condition: '조건',
  opinion: '의견',
  info: '정보',
};

/** A statement with its evidence behind a button: excerpt text and the original file. */
function StatementRow({ projectId, statement }: { projectId: string; statement: Statement }) {
  const [evidence, setEvidence] = useState<z.infer<typeof evidenceSchema>>();
  const [message, setMessage] = useState('');
  const base = (path: string) => path.split('/').at(-1);
  return (
    <li className="knowledge-statement">
      <div>
        <span className="pill">{KIND[statement.kind] ?? statement.kind}</span>{' '}
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
          onClick={async () =>
            setEvidence(
              evidence
                ? undefined
                : evidenceSchema.parse(
                    await api(`/projects/${projectId}/jigs/knowledge/statements/${statement.id}`),
                  ),
            )
          }
        >
          {evidence ? '원문 닫기' : '원문'}
        </button>{' '}
        <button
          type="button"
          className="link-button"
          onClick={async () => {
            try {
              await api(
                `/projects/${projectId}/jigs/knowledge/sources/${statement.sourceId}/open`,
                'POST',
                {},
              );
              setMessage('');
            } catch {
              setMessage('원본을 열 수 없습니다(서버 연결·경로 확인).');
            }
          }}
        >
          원본 열기
        </button>
      </small>
      {message ? <small className="knowledge-meta">{message}</small> : null}
      {evidence ? (
        <blockquote className="knowledge-evidence">
          <small className="knowledge-meta">{evidence.path}</small>
          {highlight(evidence.text, statement.quote ?? '')}
        </blockquote>
      ) : null}
    </li>
  );
}

function highlight(text: string, quote: string) {
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

function NoteSection({
  projectId,
  title,
  items,
  statements,
  folded = false,
}: {
  projectId: string;
  title: string;
  folded?: boolean;
  items: { text: string; cite: number[]; date?: string | null; party?: string | null }[];
  statements: Map<number, Statement>;
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
              className="link-button"
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
                  <StatementRow key={s.id} projectId={projectId} statement={s} />
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

function IssueNote({ projectId, issue }: { projectId: string; issue: Issue }) {
  const statements = new Map(issue.statements.map((s) => [s.id, s]));
  const [all, setAll] = useState(false);
  return (
    <article className="knowledge-note">
      <h3>
        {issue.label} · {issue.title}{' '}
        <span className="pill" data-ok={String(issue.status === 'settled')}>
          {issue.status === 'settled' ? '정리됨' : '진행 중'}
        </span>
      </h3>
      {issue.summary ? <p className="knowledge-summary">{issue.summary}</p> : null}
      <NoteSection
        projectId={projectId}
        title="현재 결론"
        items={issue.note.conclusions}
        statements={statements}
      />
      <NoteSection
        projectId={projectId}
        title="미결·확인 필요"
        items={issue.note.open}
        statements={statements}
      />
      <NoteSection
        projectId={projectId}
        title="조건"
        items={issue.note.conditions}
        statements={statements}
        folded
      />
      <NoteSection
        projectId={projectId}
        title="경과"
        items={issue.note.history}
        statements={statements}
        folded
      />
      <button type="button" className="link-button" onClick={() => setAll(!all)}>
        {all ? '관련 진술 닫기' : `관련 진술 ${issue.statements.length}개 모두 보기`}
      </button>
      {all ? (
        <ul className="knowledge-cites">
          {issue.statements.map((s) => (
            <StatementRow key={s.id} projectId={projectId} statement={s} />
          ))}
        </ul>
      ) : null}
      <small className="knowledge-meta">
        AI가 자료에서 정리한 초안입니다. 확정 전에는 근거로 확인하세요.
      </small>
    </article>
  );
}

const LISTS = [
  ['decided', '정해진 것'],
  ['blocked', '막힌 것'],
  ['changed', '최근 바뀐 것'],
] as const;
type Lists = Record<(typeof LISTS)[number][0], BriefItem[]>;

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

function BriefLists({
  brief,
  labels,
  onOpen,
}: {
  brief: Lists;
  labels?: Map<string, string>;
  onOpen: (issue: number) => void;
}) {
  return (
    <div className="knowledge-brief-lists">
      {LISTS.map(([key, title]) =>
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
function Report({
  summary,
  onOpen,
}: {
  summary: Extract<Summary, { available: true }>;
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
  return (
    <article className="knowledge-report">
      <p className="knowledge-meta">
        자료의 마지막 날짜 {brief.asOf ?? '미상'} 기준
        {brief.since ? ' · 최근 = ' + brief.since + ' 이후' : ''} · 항목을 누르면 이슈 노트와 근거가
        열립니다.
      </p>
      {brief.overview ? <p className="knowledge-summary">{brief.overview}</p> : null}
      <BriefLists brief={brief} labels={labels} onOpen={onOpen} />
      <h3>분야별 현황</h3>
      {summary.disciplines.map((d) =>
        d.brief ? (
          <details key={d.key} className="knowledge-discipline">
            <summary>
              <strong>{d.label}</strong>
              {d.brief.blocked.length ? (
                <span className="pill">막힘 {d.brief.blocked.length}</span>
              ) : null}
              <span className="knowledge-meta">{d.brief.state}</span>
            </summary>
            <BriefLists brief={d.brief} onOpen={onOpen} />
          </details>
        ) : null,
      )}
    </article>
  );
}

export function KnowledgeJig({ projectId }: { projectId: string }) {
  const [summary, setSummary] = useState<Summary>();
  const [error, setError] = useState('');
  const [issue, setIssue] = useState<Issue>();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [results, setResults] = useState<Statement[]>();
  const [view, setView] = useState<'report' | 'issues'>('report');
  useEffect(() => {
    api(`/projects/${projectId}/jigs/knowledge`)
      .then((value) => setSummary(summarySchema.parse(value)))
      .catch(() => setError('자료 DB를 읽지 못했습니다.'));
  }, [projectId]);
  const openIssue = async (id: number) => {
    setResults(undefined);
    setView('issues');
    setIssue(issueSchema.parse(await api(`/projects/${projectId}/jigs/knowledge/issues/${id}`)));
  };
  const search = async () => {
    const params = new URLSearchParams({ q: query, ...(kind ? { kind } : {}) });
    setIssue(undefined);
    setView('issues');
    setResults(
      z
        .array(statementSchema)
        .parse(await api(`/projects/${projectId}/jigs/knowledge/search?${params}`)),
    );
  };
  if (error) return <p className="jig-intro">{error}</p>;
  if (!summary) return <p className="jig-intro">불러오는 중…</p>;
  if (!summary.available)
    return (
      <p className="jig-intro">
        이 프로젝트에는 아직 자료 DB가 없습니다. 시험판에서는 수집을 앱 밖에서 실행합니다(PLAN-08
        K0).
      </p>
    );
  return (
    <div className="knowledge-jig">
      <p className="jig-intro">
        파일 {summary.counts.files.toLocaleString()}개 · 메일 {summary.counts.mails}통 · 진술{' '}
        {summary.counts.statements.toLocaleString()}개 · 이슈 {summary.counts.issues}개
        {summary.builtAt ? ` · 정리 ${summary.builtAt.slice(0, 10)}` : ''}
      </p>
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

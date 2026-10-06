// LeftPanel (PLAN-26 T-113, region A): the left panel: its section tabs (below 850 px, where the
// rail is gone), project heading, linked files, layers and the work history. It renders from the
// layout slice (src/ui/store/layout.ts); src/ui/app/left.ts fills the slice. Kept imperative:
// #project-heading and #host-document-controls (their own React roots), #objects (the object list
// adapter), the import button and the hidden host select and file input (wired in app/left.ts).
// The three status lines live in the settings dialog's status tab (shell/status-lines.tsx).
import { memo } from 'react';
import { useStore } from '../store/core.ts';
import { layoutState, selectSection, type HistoryRow, type Section } from '../store/layout.ts';
import { sessionState } from '../store/session.ts';
import { SharedHistory } from '../shared-history.tsx';

const SECTIONS: [Section, string][] = [
  ['document-tree', '작업 문서'],
  ['task-list', '작업 이력'],
];

/** Below 850 px the rail is gone; the left panel names its two sections itself. */
function SectionTabs({ section }: { section: Section }) {
  return (
    <nav className="left-panel-tabs" aria-label="문서 패널 탭">
      {SECTIONS.map(([id, label]) => (
        <button
          key={id}
          data-tab={id}
          aria-pressed={section === id}
          onClick={() => selectSection(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function CoverageBadge() {
  const coverage = useStore(layoutState, (s) => s.coverage);
  if (!coverage) return null;
  return (
    <small
      id="sync-coverage"
      className="coverage-badge"
      hidden={!coverage.text}
      title={coverage.title}
    >
      {coverage.text}
    </small>
  );
}

function HistoryRowView({ row }: { row: HistoryRow }) {
  return (
    <div className="task-row" data-task-id={row.id} aria-current={row.current ? 'true' : undefined}>
      <button className="task-open" type="button" onClick={row.open}>
        <span className="task-title">{row.title}</span>
        <span className="task-meta">
          {row.time !== undefined ? <span>{row.time}</span> : null}
          <span>{row.host}</span>
          {row.state ? (
            <span className="card-state" data-state={row.state.value}>
              {row.state.label}
            </span>
          ) : null}
        </span>
      </button>
      {row.remove ? (
        <button
          className="task-remove"
          type="button"
          title="목록에서 지우기 (모델과 작업 기록은 보존)"
          aria-label="목록에서 지우기"
          onClick={row.remove}
        >
          ×
        </button>
      ) : null}
      {/* The 검토본 saved from this request (T-109): listed in 산출물; the row links them. After ×
          so the title and × share the first line and the link wraps below. */}
      {row.review ? (
        <button
          className="link-button task-review"
          type="button"
          title={row.review.title}
          onClick={row.review.open}
        >
          {row.review.text}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Work history: every request, newest first, with its state; opens it in the conversation. Below
 * it, other members' shared conversations (PLAN-36), read-only.
 */
function TaskHistory() {
  const history = useStore(layoutState, (s) => s.history);
  const projectId = useStore(sessionState, (s) => s.project?.id);
  return (
    <>
      <div id="task-list">
        {history.empty ? <small>아직 요청이 없습니다.</small> : null}
        {history.rows.map((row) => (
          <HistoryRowView key={row.id} row={row} />
        ))}
      </div>
      <SharedHistory projectId={projectId} />
    </>
  );
}

export const LeftPanel = memo(function LeftPanel() {
  const ready = useStore(layoutState, (s) => s.ready);
  const section = useStore(layoutState, (s) => s.section);
  const hidden = useStore(layoutState, (s) => s.leftHidden);
  const documentHost = useStore(layoutState, (s) => s.documentHost);
  // Before the panels are set up every section shows, as the static markup did.
  const shows = (id: Section) => !ready || section === id;
  return (
    <>
      <aside id="left" hidden={hidden}>
        {ready ? <SectionTabs section={section} /> : null}
        <div className="project-heading" id="project-heading" />
        <section
          className="connection-card"
          id="connection-card"
          aria-label="연결 파일"
          hidden={!shows('document-tree')}
        >
          <div className="card-head">
            <h3 className="panel-heading">연결 파일</h3>
            <select id="host-target" className="visually-hidden" aria-label="작업 호스트">
              <option value="rhino">Rhino · 3D</option>
              <option value="zwcad">ZWCAD · 도면</option>
            </select>
          </div>
          <div id="host-document-controls" />
          <button
            id="import-model"
            className="link-button"
            title="열린 호스트 대신 3DM·DWG 파일을 작업 사본으로 엽니다"
          >
            파일에서 열기 · 3DM/DWG
          </button>
          <input id="model-file" type="file" accept=".3dm,.dwg" hidden />
        </section>
        <details
          className="nav-section model-tree"
          id="document-tree"
          open
          hidden={!shows('document-tree')}
        >
          <summary className="panel-heading">
            {'레이어 '}
            <small id="document-host">{documentHost}</small>
            <CoverageBadge />
          </summary>
          <div id="objects" />
        </details>
        <details className="nav-section" open hidden={!shows('task-list')}>
          <summary>작업 이력</summary>
          <TaskHistory />
        </details>
      </aside>
    </>
  );
});

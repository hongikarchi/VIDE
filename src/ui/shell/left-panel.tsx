// LeftPanel (PLAN-26 T-113, region A): the left panel: project heading, linked files, layers and
// the work history. Static markup moved from index.html; it has no state or props and never
// re-renders until its region makes it stateful.
import { memo } from 'react';
import { StatusLines } from './status-lines.tsx';

export const LeftPanel = memo(function LeftPanel() {
  return (
    <>
      <aside id="left">
        <div className="project-heading" id="project-heading" />
        <section className="connection-card" id="connection-card" aria-label="연결 파일">
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
        <details className="nav-section model-tree" id="document-tree" open>
          <summary className="panel-heading">
            {'레이어 '}
            <small id="document-host">Rhino</small>
          </summary>
          <div id="objects" />
        </details>
        <details className="nav-section" open>
          <summary>작업 이력</summary>
          <div id="task-list">
            <small>아직 요청이 없습니다.</small>
          </div>
        </details>
        <StatusLines />
      </aside>
    </>
  );
});

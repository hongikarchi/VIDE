// 산출물 workspace tab (PLAN-26 T-081, user request 2026-10-01): one tab where outputs are made,
// with three views switched at its top — 도면 (sheets like Revit's), 보고서 (the report screen of
// PLAN-22 T-057, src/ui/report-tab.tsx, unchanged) and 렌더링 (generated images through a node
// flow like ComfyUI). Only the page is built now: 도면 and 렌더링 are placeholders whose controls
// are disabled ('준비 중'); no server call is made for them. The last view is remembered per
// project in this browser's storage, like the workspace tab.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { showReports } from './report-tab.tsx';
import type { OutputView } from './workspaces.ts';
import './output-tab.css';

const VIEWS: { id: OutputView; label: string }[] = [
  { id: 'sheet', label: '도면' },
  { id: 'report', label: '보고서' },
  { id: 'render', label: '렌더링' },
];
const isView = (value: unknown): value is OutputView => VIEWS.some((view) => view.id === value);
const storageKey = (projectId: string) => `vide:output-view:${projectId}`;
function recallView(projectId: string): OutputView {
  try {
    const saved = localStorage.getItem(storageKey(projectId));
    return isView(saved) ? saved : 'sheet';
  } catch {
    return 'sheet';
  }
}
function rememberView(projectId: string, view: OutputView) {
  try {
    localStorage.setItem(storageKey(projectId), view);
  } catch {
    /* A viewer convenience only; the views work without it. */
  }
}

/** The view asked for with the tab (a report link, a stored former tab id). */
const ASKED = 'vide:output-view';
/** The tab was shown again: the report view reads its list again. */
const SHOWN = 'vide:output-shown';

function Sheets() {
  return (
    <>
      <nav className="output-side" aria-label="시트">
        <div className="output-side-head">
          <p className="caption">시트</p>
          <button type="button" disabled title="준비 중">
            새 시트
          </button>
        </div>
        <p className="output-empty">아직 시트가 없습니다</p>
      </nav>
      <div className="output-stage">
        <p className="output-note">
          모델 뷰를 시트에 배치하고 표제란·축척·도면 번호를 붙여 PDF/DWG로 내보냅니다.
        </p>
        <div className="output-sheet-wrap">
          <div className="output-sheet" role="img" aria-label="빈 A1 가로 시트">
            <div className="output-sheet-area" />
            <div className="output-title-block" aria-hidden="true">
              <span>프로젝트</span>
              <span>도면명</span>
              <span>축척</span>
              <span>날짜</span>
              <span className="output-sheet-no">도면 번호</span>
            </div>
          </div>
          <p className="output-sheet-caption">A1 가로 · 841 × 594</p>
        </div>
      </div>
    </>
  );
}

const FLOW = [
  { title: '뷰 캡처', detail: '현재 3D 뷰' },
  { title: '깊이·선화', detail: '형태를 고정할 입력' },
  { title: '이미지 생성', detail: '프롬프트·스타일' },
  { title: '결과', detail: '이미지 저장' },
];
function Rendering() {
  return (
    <>
      <aside className="output-side" aria-label="입력">
        <p className="caption">입력</p>
        <div className="output-capture">뷰 캡처 자리</div>
        <label className="output-field">
          프롬프트
          <textarea disabled rows={4} placeholder="예: 저녁 햇빛, 노출 콘크리트와 목재 외장" />
        </label>
        <label className="output-field">
          스타일
          <select disabled defaultValue="photo">
            <option value="photo">사실적</option>
            <option value="sketch">스케치</option>
            <option value="diagram">다이어그램</option>
          </select>
        </label>
        <button type="button" disabled title="준비 중">
          생성
        </button>
      </aside>
      <div className="output-stage">
        <p className="output-note">
          모델 뷰를 캡처해 깊이·선화를 뽑고, 프롬프트와 함께 이미지 생성 모델에 넣는 노드
          흐름(ComfyUI 방식)으로 렌더링을 만듭니다.
        </p>
        <ol className="output-flow" aria-label="노드 흐름 (예시)">
          {FLOW.map((node) => (
            <li key={node.title} className="output-node">
              <span className="output-port" data-side="in" aria-hidden="true" />
              <strong>{node.title}</strong>
              <span>{node.detail}</span>
              <span className="output-port" data-side="out" aria-hidden="true" />
            </li>
          ))}
        </ol>
      </div>
      <aside className="output-results" aria-label="결과">
        <p className="caption">결과</p>
        <p className="output-empty">아직 생성한 이미지가 없습니다</p>
        <div className="output-gallery" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      </aside>
    </>
  );
}

function OutputTab({ projectId, first }: { projectId: string; first?: OutputView }) {
  const [view, setView] = useState<OutputView>(() => first ?? recallView(projectId));
  const [shown, setShown] = useState(0);
  const reportMount = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);

  useEffect(() => rememberView(projectId, view), [projectId, view]);
  useEffect(() => {
    const asked = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail;
      if (isView(next)) setView(next);
    };
    const again = () => setShown((n) => n + 1);
    addEventListener(ASKED, asked);
    addEventListener(SHOWN, again);
    return () => {
      removeEventListener(ASKED, asked);
      removeEventListener(SHOWN, again);
    };
  }, []);
  // The report view is the report screen mounted here; showing it again reads the list again.
  useEffect(() => {
    if (view === 'report' && reportMount.current) showReports(projectId, reportMount.current);
  }, [projectId, view, shown]);

  const keys = (event: KeyboardEvent) => {
    const at = VIEWS.findIndex((entry) => entry.id === view);
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : undefined;
    if (step === undefined) return;
    event.preventDefault();
    const next = VIEWS[(at + step + VIEWS.length) % VIEWS.length].id;
    setView(next);
    requestAnimationFrame(() =>
      tabs.current?.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus(),
    );
  };

  return (
    <div className="output-page" data-view={view}>
      <div className="output-head">
        <div
          className="output-views"
          role="tablist"
          aria-label="산출물 종류"
          ref={tabs}
          onKeyDown={keys}
        >
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              data-view={entry.id}
              aria-selected={entry.id === view}
              tabIndex={entry.id === view ? 0 : -1}
              onClick={() => setView(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      <section
        className="output-pane output-pane-sheet"
        role="tabpanel"
        aria-label="도면"
        hidden={view !== 'sheet'}
      >
        <Sheets />
      </section>
      <div
        className="output-pane output-pane-report"
        role="tabpanel"
        aria-label="보고서 보기"
        hidden={view !== 'report'}
        ref={reportMount}
      />
      <section
        className="output-pane output-pane-render"
        role="tabpanel"
        aria-label="렌더링"
        hidden={view !== 'render'}
      >
        <Rendering />
      </section>
    </div>
  );
}

let root: Root | undefined;
let shownFor: string | undefined;

/**
 * Show the 산출물 tab of a project (mounts once; later calls show `view` when given, else read
 * the shown view again).
 */
export function showOutput(projectId: string, view?: OutputView) {
  const workspace = document.querySelector<HTMLElement>('.workspace');
  if (!workspace) return;
  if (!root) {
    const host = document.createElement('section');
    host.className = 'output-workspace';
    host.setAttribute('aria-label', '산출물');
    workspace.append(host);
    root = createRoot(host);
  }
  if (shownFor !== projectId) {
    shownFor = projectId;
    root.render(<OutputTab key={projectId} projectId={projectId} first={view} />);
  } else {
    if (view) dispatchEvent(new CustomEvent(ASKED, { detail: view }));
    dispatchEvent(new Event(SHOWN));
  }
}

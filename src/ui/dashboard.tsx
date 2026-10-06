// 대시보드 workspace tab (Design SCR-20, user requests 2026-10-01 and 2026-10-06): the project's
// name, then its 할 일 column and the large month (SPEC-01.14, dashboard-agenda.tsx; layout '안 A',
// PLAN-39), and below them one folded line for the linked files and its folders on this PC
// (SPEC-01.13). The jigs and the latest requests are not here (2026-10-06, '대시보드에서는 Jig,
// 최근 작업 필요없을 듯': the JIG screen and the work history have them). Apart from the 할 일 and
// the folders it reads only existing state (app.ts gives it through `provideDashboard`).
import { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectFolders } from './project-folders.tsx';
import { useStore } from './store/core.ts';
import { layoutState, togglePanel } from './store/layout.ts';
import { AgendaBoard } from './dashboard-agenda.tsx';
import './dashboard.css';

export interface DashboardLink {
  id: string;
  name: string;
  host: 'rhino' | 'zwcad';
  state: 'live' | 'connected' | 'closed' | 'file';
  lastSync?: string;
}
export interface DashboardData {
  projectName: string;
  links: DashboardLink[];
  linksLoaded: boolean;
}
interface DashboardSource {
  data: () => DashboardData;
}

let source: DashboardSource | undefined;
let root: Root | undefined;
let shownFor: string | undefined;
const REFRESH = 'vide:dashboard-refresh';
/** The tab was shown again: read the 할 일 again too. */
const SHOWN = 'vide:dashboard-shown';
/** Whether the folded line of files and folders is open (a viewer convenience). */
const MORE_KEY = 'vide:dashboard-more';

/** app.ts registers where the dashboard reads the project's state. */
export function provideDashboard(next: DashboardSource) {
  source = next;
}
/** The state changed (links, requests): redraw when the dashboard is mounted. */
export function refreshDashboard() {
  if (root && document.body.dataset.workspace === 'dashboard') dispatchEvent(new Event(REFRESH));
}

const STATE_TEXT: Record<DashboardLink['state'], string> = {
  live: 'Live',
  connected: '연결',
  closed: '닫힘',
  file: '파일 사본',
};
const when = (value?: string) =>
  value
    ? new Date(value).toLocaleString('ko-KR', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

function Links({ data }: { data: DashboardData }) {
  return (
    <section className="dash-section" aria-label="연결 파일">
      <h3>연결 파일</h3>
      {!data.links.length ? (
        <p className="dash-empty">
          {data.linksLoaded
            ? '연결한 파일이 없습니다. Rhino·ZWCAD 플러그인에서 Link를 누르세요.'
            : '연결 파일을 읽는 중…'}
        </p>
      ) : (
        <div className="dash-grid">
          {data.links.map((link) => (
            <div className="dash-tile" key={link.id} data-state={link.state}>
              <span className="dash-k">
                {link.host === 'zwcad' ? 'ZWCAD' : 'Rhino'} · {STATE_TEXT[link.state]}
              </span>
              <span className="dash-t">{link.name}</span>
              <span className="dash-d">
                {link.lastSync ? `마지막 Sync ${when(link.lastSync)}` : 'Sync 전'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The AI column's edge toggle on the dashboard (Design §03 「대시보드의 AI 열」): the work screens'
 * toggle sits over the 3D view, which the dashboard hides, so the page has its own at its right.
 */
function AiToggle() {
  const folded = useStore(layoutState, (slice) => slice.rightFolded);
  return (
    <button
      type="button"
      className="dash-ai-toggle"
      aria-label="작업 패널 접기/펼치기"
      aria-expanded={!folded}
      title={folded ? 'AI 열 펼치기 · Alt+Shift+R' : 'AI 열 접기 · Alt+Shift+R'}
      onClick={() => togglePanel('right')}
    >
      {folded ? '‹' : '›'}
    </button>
  );
}

/**
 * The linked files and the project folders as one folded line under the 할 일 and the month
 * (Design §03 「대시보드의 아래 줄」); opened, the tiles and the folder list as before. The folders
 * stay mounted while folded, so the line can say how many there are.
 */
function More({ projectId, data }: { projectId: string; data: DashboardData }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(MORE_KEY) === 'open';
    } catch {
      return false;
    }
  });
  const [folders, setFolders] = useState<number | undefined>();
  return (
    <details
      className="dash-more"
      open={open}
      onToggle={(event) => {
        const next = (event.currentTarget as HTMLDetailsElement).open;
        setOpen(next);
        try {
          localStorage.setItem(MORE_KEY, next ? 'open' : 'closed');
        } catch {
          /* Kept for this session only. */
        }
      }}
    >
      <summary>
        연결 파일 {data.linksLoaded ? data.links.length : '…'} · 프로젝트 폴더 {folders ?? '…'}
      </summary>
      <div className="dash-more-body">
        <Links data={data} />
        <ProjectFolders projectId={projectId} onCount={setFolders} />
      </div>
    </details>
  );
}

function Dashboard({ projectId }: { projectId: string }) {
  const [, setTick] = useState(0);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const redraw = () => setTick((n) => n + 1);
    const again = () => setShown((n) => n + 1);
    addEventListener(REFRESH, redraw);
    addEventListener(SHOWN, again);
    return () => {
      removeEventListener(REFRESH, redraw);
      removeEventListener(SHOWN, again);
    };
  }, []);
  const data = source?.data();
  if (!data) return null;
  const live = data.links.filter((link) => link.state === 'live').length;
  return (
    <div className="dash-page">
      <header className="dash-head">
        <div>
          <h2>{data.projectName}</h2>
          <p className="dash-lead">
            {data.linksLoaded ? `연결 파일 ${data.links.length}` : '연결 파일 읽는 중'}
            {live ? ` · Live ${live}` : ''}
          </p>
        </div>
        <AiToggle />
      </header>
      <AgendaBoard projectId={projectId} shown={shown} />
      <More projectId={projectId} data={data} />
    </div>
  );
}

/** Show the 대시보드 tab of a project (mounts once; later calls redraw it). */
export function showDashboard(projectId: string) {
  const workspace = document.querySelector<HTMLElement>('.workspace');
  if (!workspace) return;
  if (!root) {
    const host = document.createElement('section');
    host.className = 'dashboard-workspace';
    host.setAttribute('aria-label', '대시보드');
    workspace.append(host);
    root = createRoot(host);
  }
  if (shownFor !== projectId) {
    shownFor = projectId;
    root.render(<Dashboard key={projectId} projectId={projectId} />);
  } else dispatchEvent(new Event(SHOWN));
}

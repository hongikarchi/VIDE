// 대시보드 workspace tab (Design SCR-20, user requests 2026-10-01): the project's 할 일 and 일정
// as two areas (SPEC-01.14, dashboard-agenda.tsx) first, then its name, the linked files, its
// folders on this PC (SPEC-01.13), this project's jigs and the latest finished requests.
// Apart from the 할 일 and the folders it reads only existing state (app.ts gives it through
// `provideDashboard`) and the skill catalog; a jig starts through startSkill like the JIG list's
// [열기]. Each section is one small component, easy to drop or replace.
import { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api } from './gateway.ts';
import { JigIconMark } from './jig-icons.ts';
import type { SkillEntry } from './skill-catalog.ts';
import { openSkill } from './skill-start.ts';
import { setWorkspace } from './workspaces.ts';
import { ProjectFolders } from './project-folders.tsx';
import { AgendaBoard } from './dashboard-agenda.tsx';
import './dashboard.css';

export interface DashboardLink {
  id: string;
  name: string;
  host: 'rhino' | 'zwcad';
  state: 'live' | 'connected' | 'closed' | 'file';
  lastSync?: string;
}
export interface DashboardRequest {
  id: string;
  title: string;
  state: string;
  stateLabel: string;
  at?: string;
}
export interface DashboardData {
  projectName: string;
  links: DashboardLink[];
  linksLoaded: boolean;
  /** Finished requests, newest first. */
  recent: DashboardRequest[];
}
interface DashboardSource {
  data: () => DashboardData;
  /** Show a request in the conversation column. */
  openRequest: (id: string) => void;
  /** A jig that did not open: say why. */
  notice: (text: string) => void;
}

let source: DashboardSource | undefined;
let root: Root | undefined;
let shownFor: string | undefined;
const REFRESH = 'vide:dashboard-refresh';
/** The tab was shown again: read the jig list again too. */
const SHOWN = 'vide:dashboard-shown';

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

function Jigs({ projectId, shown }: { projectId: string; shown: number }) {
  const [jigs, setJigs] = useState<SkillEntry[] | undefined>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api(`/projects/${encodeURIComponent(projectId)}/skills`)
      .then((value) => {
        if (!live) return;
        const list = ((value as { skills?: SkillEntry[] } | null)?.skills ?? []) as SkillEntry[];
        setJigs(list.filter((entry) => entry.scope === 'project'));
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [projectId, shown]);
  const start = (entry: SkillEntry) =>
    void (
      openSkill(entry.id, { mode: 'auto', by: 'user', openOnly: true }) ??
      Promise.reject(new Error('NOT_READY'))
    ).catch(() => {
      source?.notice(`'${entry.name}'을(를) 열지 못했습니다. JIG 목록에서 여세요.`);
      setWorkspace('jig');
    });
  return (
    <section className="dash-section" aria-label="이 프로젝트의 jig">
      <h3>이 프로젝트의 jig</h3>
      {failed ? (
        <p className="dash-empty">jig 목록을 읽지 못했습니다.</p>
      ) : !jigs ? (
        <p className="dash-empty">읽는 중…</p>
      ) : !jigs.length ? (
        <p className="dash-empty">
          이 프로젝트에서 쓴 jig가 없습니다.{' '}
          <button type="button" className="link-button" onClick={() => setWorkspace('jig')}>
            JIG 목록 열기
          </button>
        </p>
      ) : (
        <div className="dash-grid">
          {jigs.map((entry) => (
            <button
              type="button"
              className="dash-tile"
              key={entry.id}
              title={entry.description || entry.name}
              onClick={() => start(entry)}
            >
              <span className="dash-k">
                <JigIconMark icon={entry.icon} />
                jig{entry.version ? ` · 버전 ${entry.version}` : ''}
              </span>
              <span className="dash-t">{entry.name}</span>
              {entry.description ? <span className="dash-d">{entry.description}</span> : null}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Recent({ data }: { data: DashboardData }) {
  return (
    <section className="dash-section" aria-label="최근 작업">
      <h3>최근 작업</h3>
      {!data.recent.length ? (
        <p className="dash-empty">끝난 요청이 아직 없습니다.</p>
      ) : (
        <ul className="dash-rows">
          {data.recent.map((row) => (
            <li key={row.id}>
              <button type="button" onClick={() => source?.openRequest(row.id)}>
                <span className="dash-row-title">{row.title}</span>
                <span className="dash-row-meta" data-state={row.state}>
                  {row.stateLabel}
                  {row.at ? ` · ${when(row.at)}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
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
      <header>
        <h2>{data.projectName}</h2>
        <p className="dash-lead">
          {data.linksLoaded ? `연결 파일 ${data.links.length}` : '연결 파일 읽는 중'}
          {live ? ` · Live ${live}` : ''}
          {data.recent[0]?.at ? ` · 최근 작업 ${when(data.recent[0].at)}` : ''}
        </p>
      </header>
      <AgendaBoard projectId={projectId} shown={shown} />
      <Links data={data} />
      <ProjectFolders projectId={projectId} />
      <Jigs projectId={projectId} shown={shown} />
      <Recent data={data} />
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

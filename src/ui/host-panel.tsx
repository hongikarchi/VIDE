import { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Host panel (Design SCR-12): the Rhino panel and the ZWCAD palette show this web page. The header
// carries the document, its connection and the actions; the plugin only hosts the page and runs
// the actions the page asks for ("vide://<action>" navigations it intercepts).

export type PanelHost = 'rhino' | 'zwcad';
export type PanelState = 'checking' | 'unlinked' | 'connected' | 'live' | 'lost';
export type HostAction = 'link' | 'unlink' | 'live' | 'reload' | 'open-vide';

/** Ask the plugin hosting this page to act (Link dialog, Live toggle, …). */
export function hostAction(action: HostAction) {
  window.dispatchEvent(new CustomEvent('vide-host-action', { detail: action }));
  // The plugin cancels this navigation and runs the action; a plain browser ignores the scheme.
  location.href = 'vide://' + action;
}

const hostLabel = (host: PanelHost) => (host === 'zwcad' ? 'CAD' : 'R');
const hostName = (host: PanelHost) => (host === 'zwcad' ? 'ZWCAD' : 'Rhino');

export interface HeaderProps {
  host: PanelHost;
  file: string;
  state: PanelState;
  /** "Sync 3:19 · 531개" */
  detail: string;
  project?: string;
  syncing: boolean;
  onSync: () => void;
}

function Header(props: HeaderProps) {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setMenu(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);
  const linked = props.state === 'connected' || props.state === 'live';
  const status =
    props.state === 'checking'
      ? '연결 확인 중'
      : props.state === 'unlinked'
        ? '아직 VIDE 프로젝트에 연결되지 않음'
        : props.state === 'lost'
          ? `${hostName(props.host)} 연결이 끊겼습니다 · 파일이 열려 있는지 확인하세요`
          : [props.state === 'live' ? 'Live' : '연결됨', props.detail].filter(Boolean).join(' · ');
  const act = (action: HostAction) => {
    setMenu(false);
    hostAction(action);
  };
  return (
    <div className="host-panel-head" ref={box} data-state={props.state}>
      <div className="host-panel-file">
        <span className="host-badge" data-host={props.host}>
          {hostLabel(props.host)}
        </span>
        <strong title={props.file}>{props.file || '제목 없는 문서'}</strong>
        <button
          type="button"
          className="host-panel-more"
          aria-label="패널 메뉴"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          ⋯
        </button>
      </div>
      <div className="host-panel-status">
        <span className="host-dot" aria-hidden="true" />
        <small>{status}</small>
      </div>
      {linked ? (
        <div className="host-panel-actions">
          <span className="host-panel-project" title="연결된 VIDE 프로젝트">
            {props.project ?? ''}
          </span>
          <button
            type="button"
            className="host-sync"
            disabled={props.syncing}
            onClick={props.onSync}
            title={`지금 ${hostName(props.host)} 파일을 VIDE로 가져옵니다`}
          >
            {props.syncing ? 'Sync 중…' : 'Sync'}
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={props.state === 'live'}
            className="host-live"
            title="Live Sync: 편집이 멈추면 바뀐 객체만 자동으로 가져옵니다"
            onClick={() => hostAction('live')}
          >
            <span className="host-live-track" aria-hidden="true">
              <span />
            </span>
            Live
          </button>
        </div>
      ) : null}
      {menu ? (
        <div className="host-panel-menu" role="menu">
          <button role="menuitem" onClick={() => act('open-vide')}>
            VIDE에서 크게 열기
          </button>
          <button role="menuitem" onClick={() => act('link')}>
            {linked ? '다른 프로젝트에 연결…' : '이 파일 연결하기…'}
          </button>
          {linked ? (
            <button role="menuitem" onClick={() => act('unlink')}>
              연결 해제
            </button>
          ) : null}
          <button role="menuitem" onClick={() => act('reload')}>
            다시 불러오기
          </button>
        </div>
      ) : null}
    </div>
  );
}

function LinkCard({ host, file }: { host: PanelHost; file: string }) {
  return (
    <section className="host-panel-card" aria-label="파일 연결">
      <span className="host-badge" data-host={host}>
        {hostLabel(host)}
      </span>
      <strong>이 파일을 VIDE 프로젝트에 연결하세요</strong>
      <p>
        연결하면 {file ? <b>{file}</b> : '이 파일'}이(가) 바로 Sync되고, 이 패널에서 AI에게 작업을
        맡기고 결과를 볼 수 있습니다.
      </p>
      <button type="button" className="host-panel-primary" onClick={() => hostAction('link')}>
        이 파일 연결하기
      </button>
      <small>프로젝트를 고르는 창이 열립니다. 원본 파일은 바뀌지 않습니다.</small>
    </section>
  );
}

let headerRoot: Root | undefined, cardRoot: Root | undefined;
export function renderPanelHeader(element: HTMLElement, props: HeaderProps) {
  headerRoot ??= createRoot(element);
  headerRoot.render(<Header {...props} />);
}
export function renderLinkCard(element: HTMLElement, host: PanelHost, file: string) {
  cardRoot ??= createRoot(element);
  cardRoot.render(<LinkCard host={host} file={file} />);
}

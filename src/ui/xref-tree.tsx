// 대시보드 › 프로젝트 폴더 › 도면 관계 (SPEC-01.11 11, Design SCR-20, PLAN-43 T-200): the xref
// relations of the drawings in the project folders as a tree — root drawings, their references
// nested, missing/cycle/duplicate marks, the stored path as the tooltip. [다시 읽기] reads the
// folders again (only when pressed); [모델에 반영] on a root shows it and its references as linked
// files in the root's coordinates. Remote sessions only see the tree.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './gateway.ts';
import { remoteSession } from './remote-panel.ts';
import './xref-tree.css';

interface TreeNode {
  path: string | null;
  name: string;
  stored: string | null;
  how: 'absolute' | 'relative' | 'folder' | null;
  overlay: boolean;
  missing: boolean;
  cycle: boolean;
  duplicate: boolean;
  outside: boolean;
  error: string | null;
  unitsAssumed: boolean;
  inserts: { model: number; paper: number; block: number };
  children: TreeNode[];
}
interface XrefState {
  state: 'idle' | 'reading' | 'applying' | 'done' | 'failed';
  done: number;
  total: number;
  error: string | null;
  readAt: string | null;
  roots: TreeNode[];
  standalone: number;
  unread: { path: string; error: string }[];
  applied: {
    root: string;
    links: number;
    read: number;
    failed: { name: string; error: string }[];
  } | null;
}

const REASONS: Record<string, string> = {
  NO_ZWCAD: '이 PC에 ZWCAD 2023이 없어 도면을 읽지 못합니다.',
  NO_PROJECT_FOLDER: '읽을 프로젝트 폴더가 없습니다.',
  PROJECT_BUSY: '이 프로젝트의 도면을 읽는 중입니다. 끝난 뒤 다시 누르세요.',
  FORBIDDEN: '도면 관계는 작업 PC에서 읽습니다.',
  NOT_FOUND: '그 도면을 찾지 못했습니다. [다시 읽기]를 누르세요.',
};
const reasonOf = (code: string) => REASONS[code] ?? code;
const HOW: Record<string, string> = {
  absolute: '저장된 경로',
  relative: '상위 도면 기준 상대 경로',
  folder: '상위 도면과 같은 폴더',
};
const when = (iso: string) => {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
};
const POLL_MS = 1000;

function tooltip(node: TreeNode) {
  const lines = [];
  if (node.stored !== null) lines.push(`저장된 경로: ${node.stored}`);
  if (node.path) lines.push(`찾은 파일: ${node.path}${node.how ? ` (${HOW[node.how]})` : ''}`);
  if (node.error) lines.push(`읽지 못함: ${node.error}`);
  return lines.join('\n') || undefined;
}
function Badges({ node }: { node: TreeNode }) {
  const marks: [string, string, boolean][] = [
    ['누락', 'warn', node.missing],
    ['순환', 'warn', node.cycle],
    ['중복', 'plain', node.duplicate],
    ['오버레이', 'plain', node.overlay],
    ['폴더 밖', 'plain', node.outside],
    ['읽지 못함', 'warn', !!node.error],
    ['단위 없음(mm)', 'plain', node.unitsAssumed],
    ['배치에만', 'plain', node.stored !== null && !node.inserts.model && node.inserts.paper > 0],
  ];
  return (
    <>
      {marks
        .filter(([, , on]) => on)
        .map(([label, tone]) => (
          <span key={label} className="dash-xref-badge" data-tone={tone}>
            {label}
          </span>
        ))}
    </>
  );
}
function Branch({ nodes }: { nodes: TreeNode[] }) {
  return (
    <ul role="group">
      {nodes.map((node, index) => (
        <li key={`${node.stored}-${index}`} role="treeitem" aria-label={node.name}>
          <div className="dash-xref-row">
            <span className="dash-xref-name" title={tooltip(node)}>
              {node.name}
            </span>
            {node.inserts.model > 1 ? (
              <span className="dash-xref-count">×{node.inserts.model}</span>
            ) : null}
            <Badges node={node} />
          </div>
          {node.children.length ? <Branch nodes={node.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function XrefTree({ projectId }: { projectId: string }) {
  const [state, setState] = useState<XrefState | undefined>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const remote = remoteSession();
  const base = `/projects/${encodeURIComponent(projectId)}/xref`;
  const running = useRef(false);
  const take = useCallback((next: XrefState) => {
    running.current = next.state === 'reading' || next.state === 'applying';
    setState(next);
  }, []);
  useEffect(() => {
    let live = true;
    const read = () =>
      api(base)
        .then((value) => live && take(value as XrefState))
        .catch(() => {});
    void read();
    const timer = setInterval(() => {
      if (running.current) void read();
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [base, take]);

  const act = async (path: string, value: Record<string, unknown> = {}) => {
    setBusy(true);
    setReason('');
    try {
      take((await api(path, 'POST', value)) as XrefState);
    } catch (error) {
      setReason(reasonOf((error as { code?: string }).code ?? (error as Error).message));
    } finally {
      setBusy(false);
    }
  };
  if (!state) return null;
  const working = state.state === 'reading' || state.state === 'applying';
  const related = state.roots.length;
  return (
    <div className="dash-xref" role="group" aria-label="도면 관계">
      <div className="dash-collect-row">
        {working ? (
          <span className="dash-collect-progress" role="status">
            {state.state === 'reading' ? '도면 읽는 중' : '모델에 반영 중'}
            {state.total ? ` ${state.done}/${state.total}` : ''}
          </span>
        ) : state.readAt ? (
          <span className="dash-collect-last">도면 관계 · 마지막 읽기 {when(state.readAt)}</span>
        ) : (
          <span className="dash-collect-last">
            폴더의 DWG가 서로 참조하는 외부 참조(xref)를 읽어 도면 관계를 보입니다.
          </span>
        )}
        {remote ? null : (
          <button type="button" disabled={busy || working} onClick={() => void act(`${base}/read`)}>
            다시 읽기
          </button>
        )}
      </div>
      {reason || (state.state === 'failed' && state.error) ? (
        <p className="dash-xref-reason" role="alert">
          {reason || reasonOf(state.error!)}
        </p>
      ) : null}
      {state.readAt && !working ? (
        <p className="dash-collect-counts">
          관계 있는 도면 {related} · 관계 없는 도면 {state.standalone}
          {state.unread.length ? ` · 읽지 못함 ${state.unread.length}` : ''}
        </p>
      ) : null}
      {related ? (
        <ul className="dash-xref-tree" role="tree" aria-label="도면 관계 트리">
          {state.roots.map((root) => (
            <li key={root.path} role="treeitem" aria-label={root.name}>
              <div className="dash-xref-row" data-root="">
                <span className="dash-xref-name" title={root.path ?? undefined}>
                  {root.name}
                </span>
                <Badges node={root} />
                {remote ? null : (
                  <button
                    type="button"
                    className="link-button"
                    aria-label={`${root.name} 모델에 반영`}
                    disabled={busy || working}
                    onClick={() => void act(`${base}/apply`, { root: root.path })}
                  >
                    모델에 반영
                  </button>
                )}
              </div>
              {root.children.length ? <Branch nodes={root.children} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {state.applied && !working ? (
        <p className="dash-collect-counts" role="note">
          모델에 반영함 · {state.applied.root.split(/[\\/]/).pop()} 포함 연결 파일{' '}
          {state.applied.links}개
          {state.applied.failed.length
            ? ` · 읽지 못함: ${state.applied.failed.map((f) => f.name).join(', ')}`
            : ''}
        </p>
      ) : null}
    </div>
  );
}

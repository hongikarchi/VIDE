// 대시보드 › 프로젝트 폴더 › 자료 정리 (SPEC-08.9, Design SCR-20, PLAN-42 T-195): [자료 정리하기]
// for the first collection, [자료 업데이트] afterwards — runs only when pressed. While it runs:
// the stage, n/m and [중단]; then the last collection's time, what was read and what was not.
// Remote sessions only see the state. A finished run tells the 자료 tab and the proposals card to
// read again (`vide:knowledge-collected`). The row never hides itself (2026-10-08 user report "DB 정리도
// 지금 vide에서는 안 보이는데"): without a project folder it says how to start, and a failed state
// read shows the reason with [다시 읽기]. The 자료 tab shows the same row while it has no DB
// (`KnowledgeStart`).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './gateway.ts';
import { remoteSession } from './remote-panel.ts';
import './knowledge-collect.css';

export const KNOWLEDGE_COLLECTED = 'vide:knowledge-collected';

interface CollectState {
  state: 'idle' | 'running' | 'done' | 'failed' | 'stopped';
  stage: string | null;
  done: number;
  total: number;
  collectedAt: string | null;
  collected: boolean;
  error: string | null;
  counts: {
    files: number;
    read: number;
    unread: Record<string, number>;
    statements: number;
    issues: number;
    proposals: number;
  } | null;
}

const STAGES: Record<string, string> = {
  list: '파일 목록 확인',
  read: '문서 읽기',
  drawings: '도면 읽기',
  filter: '걸러내기',
  statements: '진술 뽑기',
  issues: '이슈 정리',
  proposals: '할 일·일정 찾기',
};
const UNREAD: Record<string, string> = {
  size: '크기 초과',
  encrypted: '암호',
  distribution: '배포용',
  'no-text': '글자 없음(스캔)',
  unsupported: '옛 형식',
  'no-reader': 'PDF 모듈 없음',
  'no-zwcad': 'ZWCAD 없음',
  timeout: '시간 초과',
  error: '오류',
};
const REASONS: Record<string, string> = {
  NO_PROJECT_FOLDER: '정리할 프로젝트 폴더가 없습니다.',
  AI_NOT_SIGNED_IN: 'Claude나 ChatGPT(Codex) 로그인이 필요합니다.',
  KNOWLEDGE_IS_COPY: '이 PC의 자료는 다른 PC가 정리해 받은 사본이라 여기서 정리하지 않습니다.',
  AI_CALLS_FAILED: 'AI 호출이 모두 실패했습니다. 로그인과 사용 한도를 확인하세요.',
  FORBIDDEN: '자료 정리는 작업 PC에서 시작합니다.',
};
const reasonOf = (code: string) => REASONS[code] ?? code;
const POLL_MS = 1000;

const when = (iso: string) => {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

const NO_FOLDER = '프로젝트 폴더를 정하면 [자료 정리하기]를 쓸 수 있습니다.';

export function KnowledgeCollect({
  projectId,
  hasFolder = true,
  onNeedFolder,
  needFolderLabel = '폴더 정하기',
}: {
  projectId: string;
  /** Whether the project has a project folder (only those are collected, SPEC-08.9 1). */
  hasFolder?: boolean;
  /** Where to set a folder: the folder picker on the dashboard, the dashboard from the 자료 tab. */
  onNeedFolder?: () => void;
  needFolderLabel?: string;
}) {
  const [state, setState] = useState<CollectState | undefined>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const remote = remoteSession();
  const base = `/projects/${encodeURIComponent(projectId)}/knowledge/collect`;
  const running = useRef(false);

  const take = useCallback(
    (next: CollectState) => {
      if (running.current && next.state !== 'running')
        dispatchEvent(new CustomEvent(KNOWLEDGE_COLLECTED, { detail: { projectId } }));
      running.current = next.state === 'running';
      setState(next);
    },
    [projectId],
  );
  useEffect(() => {
    let live = true;
    const read = () =>
      api(base)
        .then((value) => {
          if (!live) return;
          setFailed(false);
          take(value as CollectState);
        })
        .catch(() => live && setFailed(true));
    void read();
    const timer = setInterval(() => {
      if (running.current) void read();
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [base, take, attempt]);

  const act = async (path: string) => {
    setBusy(true);
    setReason('');
    try {
      take((await api(path, 'POST', {})) as CollectState);
    } catch (error) {
      setReason(reasonOf((error as { code?: string }).code ?? (error as Error).message));
    } finally {
      setBusy(false);
    }
  };
  if (!hasFolder)
    return (
      <div className="dash-collect" role="group" aria-label="자료 정리">
        <div className="dash-collect-row">
          <span className="dash-collect-last">{NO_FOLDER}</span>
          {remote || !onNeedFolder ? null : (
            <button type="button" onClick={onNeedFolder}>
              {needFolderLabel}
            </button>
          )}
        </div>
      </div>
    );
  if (!state)
    return (
      <div className="dash-collect" role="group" aria-label="자료 정리">
        <div className="dash-collect-row">
          {failed ? (
            <>
              <span className="dash-collect-reason" role="alert">
                자료 정리 상태를 읽지 못했습니다.
              </span>
              <button
                type="button"
                className="link-button"
                onClick={() => setAttempt((n) => n + 1)}
              >
                다시 읽기
              </button>
            </>
          ) : (
            <span className="dash-collect-last">자료 정리 상태를 읽는 중…</span>
          )}
        </div>
      </div>
    );
  const isRunning = state.state === 'running';
  const unread = Object.entries(state.counts?.unread ?? {})
    .map(([status, n]) => `${UNREAD[status] ?? status} ${n}`)
    .join(' · ');
  return (
    <div className="dash-collect" role="group" aria-label="자료 정리">
      <div className="dash-collect-row">
        {isRunning ? (
          <span className="dash-collect-progress" role="status">
            정리 중 · {STAGES[state.stage ?? ''] ?? '준비'}
            {state.total ? ` ${state.done}/${state.total}` : ''}
          </span>
        ) : state.collectedAt ? (
          <span className="dash-collect-last">마지막 정리 {when(state.collectedAt)}</span>
        ) : (
          <span className="dash-collect-last">
            폴더의 문서·메일·도면을 읽어 자료 DB를 만듭니다.
          </span>
        )}
        {remote ? null : isRunning ? (
          <button type="button" disabled={busy} onClick={() => void act(`${base}/stop`)}>
            중단
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void act(base)}>
            {state.collected ? '자료 업데이트' : '자료 정리하기'}
          </button>
        )}
      </div>
      {state.counts && !isRunning ? (
        <p className="dash-collect-counts">
          문서 {state.counts.read}/{state.counts.files} · 진술 {state.counts.statements} · 이슈{' '}
          {state.counts.issues}
          {unread ? ` · 읽지 못함: ${unread}` : ''}
        </p>
      ) : null}
      {state.state === 'stopped' ? <p className="dash-collect-counts">중단했습니다.</p> : null}
      {reason || (state.state === 'failed' && state.error) ? (
        <p className="dash-collect-reason" role="alert">
          {reason || reasonOf(state.error ?? '')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The 자료 tab (and the 자료 jig) without a DB: the same 자료 정리 row, so a collection starts where
 * the user looks for the DB. Without a project folder its button goes to the dashboard's folders.
 */
export function KnowledgeStart({ projectId }: { projectId: string }) {
  const [hasFolder, setHasFolder] = useState<boolean | undefined>();
  useEffect(() => {
    let live = true;
    api(`/projects/${encodeURIComponent(projectId)}/folders`)
      .then(
        (value) =>
          live &&
          setHasFolder(
            ((value as { folders?: { kind: string }[] }).folders ?? []).some(
              (folder) => folder.kind === 'project',
            ),
          ),
      )
      // The folders could not be read: the row still shows; a start then says why.
      .catch(() => live && setHasFolder(true));
    return () => {
      live = false;
    };
  }, [projectId]);
  if (hasFolder === undefined) return null;
  return (
    <KnowledgeCollect
      projectId={projectId}
      hasFolder={hasFolder}
      needFolderLabel="대시보드에서 폴더 정하기"
      onNeedFolder={() =>
        void import('./workspaces.ts').then((tabs) => tabs.setWorkspace('dashboard'))
      }
    />
  );
}

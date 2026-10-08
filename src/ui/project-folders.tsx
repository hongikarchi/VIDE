// 대시보드 › 프로젝트 폴더 (SPEC-01.13, Design §03 「대시보드의 프로젝트 폴더」): the folders of this
// PC the project points at, and the folders the user let the AI read with [이 폴더는 항상]. In the
// VIDE program window [폴더 추가] opens the Windows folder picker (WebView2 message `folder:pick`);
// in a browser, or a program window whose shell does not offer the picker, a path field opens.
// The engine checks every path (exists, a folder, not a drive root, VIDE data or a key folder).
// 자료 정리 (knowledge-collect.tsx, SPEC-08.9) always shows (without a folder it says how to start);
// with a project folder 도면 관계 (xref-tree.tsx,
// SPEC-01.11 11) sit under the list, then 도곽 미리보기 (drawing-sheets.tsx, SPEC-14.15) once
// 도면 관계 has read drawings.
import { useEffect, useRef, useState } from 'react';
import { api } from './gateway.ts';
import { remoteSession } from './remote-panel.ts';
import { KnowledgeCollect } from './knowledge-collect.tsx';
import { XrefTree } from './xref-tree.tsx';
import { DrawingSheets } from './drawing-sheets.tsx';

interface Folder {
  path: string;
  kind: 'project' | 'read';
  addedAt: string;
  exists: boolean;
}
interface WebView {
  postMessage(value: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
const webview = () => (window as unknown as { chrome?: { webview?: WebView } }).chrome?.webview;

/** Whether the program window's shell answers `folder:pick` (its state says `folderPick`). */
function useFolderPicker() {
  const [picker, setPicker] = useState(false);
  useEffect(() => {
    const view = webview();
    if (!view) return;
    const listen = (event: MessageEvent) => {
      const data = event.data as { type?: string; folderPick?: unknown } | undefined;
      if (data?.type === 'desktop:state') setPicker(data.folderPick === true);
    };
    view.addEventListener('message', listen);
    view.postMessage({ type: 'desktop:get' });
    return () => view.removeEventListener('message', listen);
  }, []);
  return picker;
}
/** The Windows folder picker of the program window; null when cancelled. */
function pickFolder(): Promise<string | null> {
  const view = webview()!;
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const listen = (event: MessageEvent) => {
      const data = event.data as { type?: string; id?: string; path?: unknown } | undefined;
      if (data?.type !== 'folder:picked' || data.id !== id) return;
      view.removeEventListener('message', listen);
      resolve(typeof data.path === 'string' && data.path ? data.path : null);
    };
    view.addEventListener('message', listen);
    view.postMessage({ type: 'folder:pick', id });
  });
}

const reasons: Record<string, string> = {
  FOLDER_NOT_FOUND: '이 PC에 그 폴더가 없습니다.',
  FOLDER_NOT_ALLOWED: '드라이브 맨 위, VIDE 데이터 폴더, 키·로그인 폴더는 정할 수 없습니다.',
  INVALID_INPUT: '전체 경로를 넣으세요(예: C:\\Users\\…\\프로젝트 폴더).',
};

export function ProjectFolders({
  projectId,
  onCount,
}: {
  projectId: string;
  /** Told how many project folders there are (the dashboard's folded line, PLAN-39). */
  onCount?: (count: number) => void;
}) {
  const [folders, setFolders] = useState<Folder[] | undefined>();
  const [failed, setFailed] = useState(false);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const picker = useFolderPicker();
  const field = useRef<HTMLInputElement>(null);
  const remote = remoteSession();
  const base = `/projects/${encodeURIComponent(projectId)}/folders`;
  useEffect(() => {
    let live = true;
    api(base)
      .then((value) => live && setFolders((value as { folders: Folder[] }).folders))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [base]);
  useEffect(() => {
    if (typing) field.current?.focus();
  }, [typing]);
  useEffect(() => {
    if (folders) onCount?.(folders.filter((folder) => folder.kind === 'project').length);
  }, [folders, onCount]);

  const change = async (action: 'add' | 'remove', value: string) => {
    setBusy(true);
    setReason('');
    try {
      const next = (await api(action === 'add' ? base : `${base}/remove`, 'POST', {
        path: value,
      })) as { folders: Folder[] };
      setFolders(next.folders);
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      setReason(reasons[code] ?? (error as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    if (!picker) return setTyping(true);
    const chosen = await pickFolder();
    if (chosen) await change('add', chosen);
  };
  const submit = async () => {
    if (!path.trim()) return;
    if (await change('add', path.trim())) {
      setPath('');
      setTyping(false);
    }
  };
  const row = (folder: Folder) => (
    <li key={folder.path} data-kind={folder.kind}>
      <span className="dash-folder-path" title={folder.path}>
        {folder.path}
      </span>
      {!folder.exists ? <span className="dash-folder-missing">없음</span> : null}
      {remote ? null : (
        <button
          type="button"
          className="dash-folder-remove"
          aria-label={`${folder.path} 빼기`}
          disabled={busy}
          onClick={() => void change('remove', folder.path)}
        >
          빼기
        </button>
      )}
    </li>
  );
  const own = folders?.filter((folder) => folder.kind === 'project') ?? [];
  const allowed = folders?.filter((folder) => folder.kind === 'read') ?? [];
  return (
    <section className="dash-section" aria-label="프로젝트 폴더">
      <div className="dash-section-head">
        <h3>프로젝트 폴더</h3>
        {remote ? null : (
          <button
            type="button"
            className="link-button"
            disabled={busy || typing}
            onClick={() => void add()}
          >
            폴더 추가
          </button>
        )}
      </div>
      {typing ? (
        <form
          className="dash-folder-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            ref={field}
            type="text"
            aria-label="폴더 경로"
            placeholder="C:\Users\…\프로젝트 폴더"
            value={path}
            disabled={busy}
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="submit" disabled={busy || !path.trim()}>
            추가
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setTyping(false);
              setPath('');
              setReason('');
            }}
          >
            취소
          </button>
        </form>
      ) : null}
      {reason ? (
        <p className="dash-folder-reason" role="alert">
          {reason}
        </p>
      ) : null}
      {failed ? (
        <p className="dash-empty">폴더 목록을 읽지 못했습니다.</p>
      ) : !folders ? (
        <p className="dash-empty">읽는 중…</p>
      ) : !own.length ? (
        <>
          <p className="dash-empty">프로젝트 폴더를 정하면 AI가 그 안의 파일을 직접 읽습니다.</p>
          {/* 자료 정리 stays visible and says how to start (SPEC-08.9 1, 2026-10-08). */}
          <KnowledgeCollect
            projectId={projectId}
            hasFolder={false}
            onNeedFolder={busy || typing ? undefined : () => void add()}
          />
        </>
      ) : (
        <>
          <ul className="dash-folders" aria-label="프로젝트 폴더 목록">
            {own.map(row)}
          </ul>
          <KnowledgeCollect projectId={projectId} />
          <XrefTree projectId={projectId} />
          <DrawingSheets projectId={projectId} />
        </>
      )}
      {allowed.length ? (
        <>
          <h4 className="dash-folder-sub">읽기 허용 폴더</h4>
          <ul className="dash-folders" aria-label="읽기 허용 폴더 목록">
            {allowed.map(row)}
          </ul>
        </>
      ) : null}
    </section>
  );
}

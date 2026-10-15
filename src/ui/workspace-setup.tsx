// 작업 폴더 만들기·열기 (SPEC-01.13 7, Design SCR-35, PLAN-52 T-308·T-314): [폴더로 만들기] picks a
// folder (the program window's Explorer-style dialog, or a path field), shows the tree it will make
// with the template's names as editable first values (empty = that role is not made), the
// '이력 관리(git)' box (dim when git is missing) and makes it; the new project opens. [폴더 열기]
// picks a folder: with a project settings file it confirms '이 폴더의 프로젝트를 다시 엽니다' and
// opens (a project that is not here is made again with the same id and 자료 정리 starts — shown as
// three progress lines with [중단]); without one it offers to make it here or just add the folder.
// Blocked states are one warning line in the panel (no colored bars). Hidden in a remote session.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './gateway.ts';
import { remoteSession } from './remote-panel.ts';
import { pickFolder, useFolderPicker } from './project-folders.tsx';
import './workspace-setup.css';

export type SetupMode = 'create' | 'open';

/** Asked for from elsewhere (the project heading): the dashboard's panel opens in this mode. */
export const WORKSPACE_SETUP_EVENT = 'vide:workspace-setup';
let pending: SetupMode | null = null;
export function requestWorkspaceSetup(mode: SetupMode) {
  pending = mode;
  dispatchEvent(new CustomEvent(WORKSPACE_SETUP_EVENT, { detail: mode }));
}

const ROLES = [
  ['ops', '일지·회의록·할 일'],
  ['raw', '원본 자료 · 읽기만'],
  ['rhino', 'Rhino 모델'],
  ['cad', 'CAD 도면'],
  ['review', 'jig 결과·검토용 보고서'],
  ['output', '보고용 산출물'],
  ['snapshots', '검토본'],
  ['references', '레퍼런스'],
  ['tools', '프로젝트 jig·스크립트'],
  ['archive', '이전 판 보관'],
] as const;
type Role = (typeof ROLES)[number][0];

interface Inspected {
  path: string;
  name: string;
  state: 'none' | 'config' | 'invalid' | 'denied';
  empty?: boolean;
  owner?: { id: string; name: string } | null;
  line?: number | null;
  schema?: string;
  title?: string | null;
  projectId?: string | null;
  createdAt?: string | null;
  roles?: number;
  here?: { id: string; name: string } | null;
}
interface CollectState {
  state: 'idle' | 'running' | 'done' | 'failed' | 'stopped';
  stage: string | null;
  done: number;
  total: number;
  error: string | null;
}
type Step =
  | { kind: 'idle' }
  | { kind: 'typing'; mode: SetupMode }
  | { kind: 'create'; folder: Inspected }
  | { kind: 'confirm'; folder: Inspected }
  | { kind: 'no-config'; folder: Inspected }
  | { kind: 'has-config'; folder: Inspected }
  | {
      kind: 'progress';
      project: { id: string; name: string };
      collectError?: string;
    };

const QUIET = [
  'FOLDER_NOT_FOUND',
  'FOLDER_NOT_ALLOWED',
  'INVALID_INPUT',
  'WORKSPACE_ACCESS_DENIED',
  'WORKSPACE_PROJECT_CONFLICT',
  'WORKSPACE_CONFIG_INVALID',
  'WORKSPACE_EXISTS',
  'WORKSPACE_PROMOTE_REQUIRED',
  'NO_WORKSPACE',
];
const reasons: Record<string, string> = {
  FOLDER_NOT_FOUND: '이 PC에 그 폴더가 없습니다.',
  FOLDER_NOT_ALLOWED: '드라이브 맨 위·VIDE 데이터 폴더는 고를 수 없습니다.',
  INVALID_INPUT: '폴더 이름을 확인하세요 — 쓸 수 없는 글자나 겹치는 이름이 있습니다.',
  WORKSPACE_ACCESS_DENIED: '이 폴더를 읽거나 쓸 권한이 없습니다.',
  WORKSPACE_PROJECT_CONFLICT: '이미 다른 프로젝트의 폴더입니다.',
  WORKSPACE_CONFIG_INVALID: '설정 파일이 손상되었습니다.',
  WORKSPACE_EXISTS: '이 폴더에는 이미 프로젝트 설정 파일이 있습니다.',
  NO_WORKSPACE: '이 폴더에는 프로젝트 설정 파일이 없습니다.',
};
const reasonOf = (error: unknown) =>
  reasons[(error as { code?: string }).code ?? ''] ?? (error as Error).message;

/** The blocked line for a folder that cannot be used either way, or ''. */
function blocked(folder: Inspected) {
  if (folder.state === 'denied') return reasons.WORKSPACE_ACCESS_DENIED;
  if (folder.state === 'invalid')
    return `설정 파일이 손상되었습니다${folder.line ? ` · ${folder.line}번째 줄` : ''}`;
  if (folder.owner) return `이미 다른 프로젝트의 폴더입니다 — ${folder.owner.name}`;
  return '';
}
const day = (value: string | null | undefined) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const go = (projectId: string) => {
  location.search = '?project=' + encodeURIComponent(projectId);
};

export function WorkspaceSetup({
  onAddFolder,
}: {
  /** [그냥 프로젝트 폴더로 추가]: the folder added to the current project as before. */
  onAddFolder?: (path: string) => Promise<boolean>;
}) {
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [path, setPath] = useState('');
  const picker = useFolderPicker();
  const picking = useRef(false);
  const remote = remoteSession();

  const inspect = useCallback(async (mode: SetupMode, dir: string) => {
    setBusy(true);
    setReason('');
    try {
      const folder = (await api(
        '/workspace/inspect',
        'POST',
        { dir },
        { quiet: QUIET },
      )) as Inspected;
      const stop = blocked(folder);
      if (stop) {
        setStep({ kind: 'idle' });
        setReason(stop);
      } else if (mode === 'create')
        setStep(
          folder.state === 'config' ? { kind: 'has-config', folder } : { kind: 'create', folder },
        );
      else
        setStep(
          folder.state === 'config' ? { kind: 'confirm', folder } : { kind: 'no-config', folder },
        );
      return true;
    } catch (error) {
      setReason(reasonOf(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const start = useCallback(
    async (mode: SetupMode) => {
      setReason('');
      if (!picker) return setStep({ kind: 'typing', mode });
      if (picking.current) return;
      picking.current = true;
      setBusy(true);
      let chosen: Awaited<ReturnType<typeof pickFolder>>;
      try {
        chosen = await pickFolder();
      } finally {
        picking.current = false;
        setBusy(false);
      }
      if (chosen.path) await inspect(mode, chosen.path);
      else if (chosen.error) {
        setStep({ kind: 'typing', mode });
        setReason(chosen.error);
      }
    },
    [picker, inspect],
  );

  // The project heading's [폴더로 만들기]·[폴더 열기] open this panel.
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    const listen = (event: Event) => {
      pending = null;
      void startRef.current((event as CustomEvent<SetupMode>).detail);
    };
    addEventListener(WORKSPACE_SETUP_EVENT, listen);
    if (pending) {
      const mode = pending;
      pending = null;
      void startRef.current(mode);
    }
    return () => removeEventListener(WORKSPACE_SETUP_EVENT, listen);
  }, []);

  if (remote) return null;
  const close = () => {
    setStep({ kind: 'idle' });
    setReason('');
    setPath('');
  };
  const open = async (folder: Inspected) => {
    setBusy(true);
    setReason('');
    try {
      const opened = (await api(
        '/workspace/open',
        'POST',
        { dir: folder.path, ...(folder.schema === 'vide-workspace/1' ? {} : { promote: true }) },
        { quiet: QUIET },
      )) as {
        project: { id: string; name: string };
        created: boolean;
        collect: { requested: boolean; error?: string };
      };
      if (!opened.created) return go(opened.project.id);
      setStep({ kind: 'progress', project: opened.project, collectError: opened.collect.error });
    } catch (error) {
      setReason(reasonOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ws-setup">
      <div className="ws-setup-actions">
        <button
          type="button"
          className="link-button"
          disabled={busy || step.kind !== 'idle'}
          onClick={() => void start('create')}
        >
          폴더로 만들기
        </button>
        <button
          type="button"
          className="link-button"
          disabled={busy || step.kind !== 'idle'}
          onClick={() => void start('open')}
        >
          폴더 열기
        </button>
      </div>
      {step.kind === 'typing' ? (
        <form
          className="dash-folder-form"
          aria-label={step.mode === 'create' ? '만들 폴더 경로' : '열 폴더 경로'}
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim()) void inspect(step.mode, path.trim().replace(/^"(.*)"$/, '$1'));
          }}
        >
          <input
            type="text"
            autoFocus
            aria-label="프로젝트 폴더 경로"
            placeholder="C:\Users\…\프로젝트 폴더"
            value={path}
            disabled={busy}
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="submit" disabled={busy || !path.trim()}>
            고르기
          </button>
          <button type="button" className="link-button" onClick={close}>
            취소
          </button>
        </form>
      ) : null}
      {reason ? (
        <p className="ws-setup-reason" role="alert">
          {reason}
        </p>
      ) : null}
      {step.kind === 'create' ? (
        <CreatePanel folder={step.folder} onCancel={close} onReason={setReason} />
      ) : step.kind === 'has-config' ? (
        <div className="ws-setup-panel" role="group" aria-label="폴더로 만들기">
          <p>이 폴더에는 이미 프로젝트 설정 파일이 있습니다.</p>
          <div className="ws-setup-buttons">
            <button
              type="button"
              className="primary-button"
              onClick={() => setStep({ kind: 'confirm', folder: step.folder })}
            >
              이 폴더 열기
            </button>
            <button type="button" onClick={close}>
              취소
            </button>
          </div>
        </div>
      ) : step.kind === 'confirm' ? (
        <div className="ws-setup-panel" role="group" aria-label="폴더 열기 확인">
          <h4>이 폴더의 프로젝트를 다시 엽니다</h4>
          <p className="ws-setup-path" title={step.folder.path}>
            {step.folder.path}
          </p>
          <p>
            {[
              step.folder.here?.name ?? step.folder.title ?? step.folder.name,
              day(step.folder.createdAt) ? `${day(step.folder.createdAt)} 만듦` : '',
              `역할 폴더 ${step.folder.roles ?? 0}개`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <p className="ws-setup-note">
            {step.folder.here
              ? '이미 열려 있는 프로젝트입니다 — 그 프로젝트로 이동합니다.'
              : '이 PC에 같은 프로젝트가 없어 새로 만들고, 자료 색인과 정리를 다시 돌립니다.'}
          </p>
          {step.folder.schema && step.folder.schema !== 'vide-workspace/1' ? (
            <p className="ws-setup-note">
              규모검토 형식의 설정 파일입니다. 열면 VIDE 형식으로 바꿔 같은 파일에 적고, 원래 항목은
              그대로 둡니다.
            </p>
          ) : null}
          <div className="ws-setup-buttons">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void open(step.folder)}
            >
              {busy ? '여는 중…' : '열기'}
            </button>
            <button type="button" disabled={busy} onClick={close}>
              취소
            </button>
          </div>
        </div>
      ) : step.kind === 'no-config' ? (
        <div className="ws-setup-panel" role="group" aria-label="폴더 열기">
          <p>이 폴더에는 프로젝트 설정 파일이 없습니다.</p>
          <p className="ws-setup-path" title={step.folder.path}>
            {step.folder.path}
          </p>
          <div className="ws-setup-buttons">
            <button
              type="button"
              className="primary-button"
              onClick={() => setStep({ kind: 'create', folder: step.folder })}
            >
              이 폴더로 새로 만들기
            </button>
            {onAddFolder ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onAddFolder(step.folder.path)
                    .then((added) => added && close())
                    .finally(() => setBusy(false));
                }}
              >
                그냥 프로젝트 폴더로 추가
              </button>
            ) : null}
            <button type="button" className="link-button" onClick={close}>
              취소
            </button>
          </div>
        </div>
      ) : step.kind === 'progress' ? (
        <OpenProgress project={step.project} collectError={step.collectError} />
      ) : null}
    </div>
  );
}

function CreatePanel({
  folder,
  onCancel,
  onReason,
}: {
  folder: Inspected;
  onCancel: () => void;
  onReason: (reason: string) => void;
}) {
  const [names, setNames] = useState<Record<Role, string> | null>(null);
  const [name, setName] = useState(folder.name);
  const [git, setGit] = useState<{ available: boolean } | null>(null);
  const [useGit, setUseGit] = useState(false);
  const [making, setMaking] = useState(false);
  useEffect(() => {
    let live = true;
    api('/settings/workspace-template')
      .then((value) => {
        if (!live) return;
        const folders = (value as { template: { folders: Record<Role, string> } }).template.folders;
        setNames({ ...folders });
      })
      .catch(() => live && onReason('기본 폴더 구성을 읽지 못했습니다.'));
    api('/workspace/git')
      .then((value) => live && setGit(value as { available: boolean }))
      .catch(() => live && setGit({ available: false }));
    return () => {
      live = false;
    };
  }, [onReason]);

  const counts = new Map<string, number>();
  for (const role of ROLES) {
    const key = names?.[role[0]].trim().toLowerCase();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicate = (role: Role) => {
    const key = names?.[role].trim().toLowerCase();
    return !!key && (counts.get(key) ?? 0) > 1;
  };
  const anyDuplicate = ROLES.some(([role]) => duplicate(role));
  const make = async () => {
    if (!names) return;
    setMaking(true);
    onReason('');
    try {
      const folders: Record<string, string | null> = {};
      for (const [role] of ROLES) folders[role] = names[role].trim() || null;
      const made = (await api(
        '/workspace/create',
        'POST',
        { dir: folder.path, name: name.trim() || folder.name, folders, git: useGit },
        { quiet: QUIET },
      )) as { project: { id: string } };
      go(made.project.id);
    } catch (error) {
      onReason(reasonOf(error));
      setMaking(false);
    }
  };
  return (
    <div className="ws-setup-panel" role="group" aria-label="폴더로 만들기">
      <p className="ws-setup-path" title={folder.path}>
        {folder.path}
      </p>
      <label className="ws-setup-name">
        <span>프로젝트 이름</span>
        <input
          type="text"
          maxLength={200}
          value={name}
          disabled={making}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <p className="ws-setup-note">이 폴더 안에 아래 구조를 만듭니다. 이름은 바꿀 수 있습니다.</p>
      <ul className="ws-tree" aria-label="만들 폴더 구조">
        <li className="ws-tree-fixed">
          <span className="ws-tree-files">project.config.json · README.md · AGENTS.md</span>
          <span className="ws-tree-use">설정과 안내 파일 · 자동으로 만듭니다</span>
        </li>
        {ROLES.map(([role, use]) => (
          <li key={role}>
            <input
              type="text"
              className="ws-tree-name"
              aria-label={`${use} 폴더 이름`}
              value={names?.[role] ?? ''}
              disabled={!names || making}
              onChange={(event) =>
                setNames((current) =>
                  current ? { ...current, [role]: event.target.value } : current,
                )
              }
            />
            <span className="ws-tree-use">
              {names && !names[role].trim() ? '만들지 않음' : use}
            </span>
            {duplicate(role) ? <span className="ws-tree-warn">같은 이름이 있습니다</span> : null}
          </li>
        ))}
      </ul>
      <label className="ws-setup-git" data-disabled={git && !git.available ? '' : undefined}>
        <input
          type="checkbox"
          checked={useGit && !!git?.available}
          disabled={!git?.available || making}
          onChange={(event) => setUseGit(event.target.checked)}
        />
        <span>
          이력 관리(git) 켜기 — 설정·분석·문서 파일만 기록하고 모델·도면·원본은 제외합니다
        </span>
        {git && !git.available ? (
          <span className="ws-tree-use">git이 설치되어 있지 않습니다</span>
        ) : null}
      </label>
      <p className="ws-setup-note">
        안내 파일은 VIDE가 갱신하고, 사람이 덧쓴 부분은 그대로 둡니다.
      </p>
      <div className="ws-setup-buttons">
        <button
          type="button"
          className="primary-button"
          disabled={!names || making || anyDuplicate}
          onClick={() => void make()}
        >
          {making ? '만드는 중…' : '만들기'}
        </button>
        <button type="button" disabled={making} onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}

const STAGES: Record<string, string> = {
  list: '파일 색인',
  read: '자료 읽기',
  drawings: '도면 읽기',
};

function OpenProgress({
  project,
  collectError,
}: {
  project: { id: string; name: string };
  collectError?: string;
}) {
  const [state, setState] = useState<CollectState | null>(null);
  const [stopping, setStopping] = useState(false);
  const base = `/projects/${encodeURIComponent(project.id)}/knowledge/collect`;
  useEffect(() => {
    if (collectError) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = (await api(base)) as CollectState;
        if (!live) return;
        setState(next);
        if (next.state === 'running') timer = setTimeout(() => void poll(), 1500);
      } catch {
        /* The project page shows the state; this card only follows it while open. */
      }
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [base, collectError]);
  const running = state?.state === 'running';
  const indexing = collectError
    ? collectError === 'AI_NOT_SIGNED_IN'
      ? '파일 색인 · AI에 로그인하면 시작합니다'
      : '파일 색인 · 시작하지 못했습니다'
    : !state
      ? '파일 색인 …'
      : running && state.stage === 'list'
        ? `파일 색인 … (${state.total || state.done}개)`
        : state.state === 'idle'
          ? '파일 색인 대기'
          : '파일 색인 ✓';
  const sorting = collectError
    ? '자료 정리 대기'
    : !state || (running && state.stage === 'list')
      ? '자료 정리 대기'
      : running
        ? `${STAGES[state.stage ?? ''] ?? '자료 정리'} … ${state.done}/${state.total}`
        : state.state === 'done'
          ? '자료 정리 ✓'
          : state.state === 'stopped'
            ? '자료 정리 멈춤'
            : state.state === 'failed'
              ? '자료 정리 · 마치지 못했습니다'
              : '자료 정리 대기';
  return (
    <div className="ws-setup-panel" role="group" aria-label="프로젝트 여는 중">
      <h4>{project.name}</h4>
      <ul className="ws-progress" aria-label="여는 단계">
        <li>프로젝트 만들기 ✓</li>
        <li>{indexing}</li>
        <li>{sorting}</li>
      </ul>
      <div className="ws-setup-buttons">
        <button type="button" className="primary-button" onClick={() => go(project.id)}>
          프로젝트로 이동
        </button>
        {running ? (
          <button
            type="button"
            disabled={stopping}
            title="색인·정리만 멈추고 프로젝트는 남깁니다"
            onClick={() => {
              setStopping(true);
              void api(`${base}/stop`, 'POST', {})
                .then((value) => setState(value as CollectState))
                .catch(() => undefined)
                .finally(() => setStopping(false));
            }}
          >
            중단
          </button>
        ) : null}
      </div>
    </div>
  );
}

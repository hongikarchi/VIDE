// 체크아웃 · 서버에 반영 · 작업 중 (Design SCR-37, SPEC-01.13 9, PLAN-52 T-310~T-312): the 서버 파일
// part of the 프로젝트 폴더 section. Model files of the remembered server folder are taken to this
// PC ([체크아웃]) and written back only when the person presses [서버에 반영]; drawings stay on the
// server with a daily backup unless the project takes them out too. A remote session sees the rows
// without the buttons.
import { useCallback, useEffect, useState } from 'react';
import { api } from './gateway.ts';
import { pickFolder, useFolderPicker } from './project-folders.tsx';
import './workspace-checkout.css';

type Role = 'rhino' | 'cad';
interface Holder {
  user: string;
  at: string;
  here: boolean;
}
interface Changes {
  added: number;
  modified: number;
  removed: number;
}
interface Mine {
  id: string;
  role: Role;
  serverPath: string;
  localPath: string;
  userId: string;
  checkedOutAt: string;
  changed: Changes | null;
  localExists: boolean;
}
interface FileRow {
  path: string;
  relative: string;
  name: string;
  size: number;
  serverAt: string;
  mine: Mine | null;
  others: Holder[];
  backup?: { at: string; path: string } | null;
}
interface RoleFiles {
  role: Role;
  mode: 'local' | 'server';
  folder: string;
  status: 'ok' | 'empty' | 'no-access' | 'unreachable';
  files: FileRow[];
  truncated?: boolean;
}
interface Listing {
  server: { root: string; targets: Partial<Record<string, string | null>> } | null;
  roles: RoleFiles[];
}
interface Summary {
  checkout: Mine;
  changed: Changes | null;
  syncMismatch: number | null;
  server: { at: string | null; hash: string | null; changedSinceCheckout: boolean; error?: string };
  target: string | null;
  remembered: boolean;
  suggestion: string;
}

const ROLE_TITLE: Record<Role, string> = { rhino: '모델', cad: '도면' };
/** What a refusal means, in the words of Design SCR-37. */
const REASONS: Record<string, string> = {
  SERVER_FILE_LOCKED: '파일이 잠겨 있어 쓰지 못했습니다(다른 프로그램에서 열림).',
  SERVER_ACCESS_DENIED: '쓸 권한이 없습니다.',
  SERVER_CHANGED_SINCE_CHECKOUT: '서버 판이 바뀌어 반영을 멈췄습니다 — 확인한 뒤 다시 시도하세요.',
  SERVER_UNREACHABLE: '서버 폴더에 지금 닿지 않습니다.',
  NEEDS_TARGET: '둘 곳을 고르세요.',
  LOCAL_COPY_MISSING: '로컬 사본이 없습니다. 옮겼거나 지웠는지 확인하세요.',
  CHECKOUT_RELEASED: '이미 체크아웃을 풀었습니다.',
  CHECKED_OUT_ELSEWHERE: '다른 사람이 작업 중입니다. 읽기 전용으로 열 수 있습니다.',
  WORKSPACE_ROLE_MISSING: '작업 폴더에 이 종류를 둘 폴더가 없습니다.',
  CAD_SERVER_DIRECT: '도면은 서버에서 직접 엽니다.',
  OUTSIDE_WORKSPACE: '서버 폴더 밖은 고를 수 없습니다.',
  INVALID_INPUT: '경로를 확인하세요.',
  SERVER_WRITE_UNVERIFIED: '서버 파일을 썼지만 확인하지 못했습니다.',
  NOT_A_SERVER_FILE: '서버 폴더의 모델·도면 파일이 아닙니다.',
  NO_SERVER_MEMORY: '아직 기억한 서버 폴더가 없습니다.',
  WORKSPACE_CONFIG_INVALID: '설정 파일이 손상되었습니다.',
  FORBIDDEN: '이 PC에서만 할 수 있습니다.',
  NOT_FOUND: '찾지 못했습니다. 목록을 다시 읽어 보세요.',
};
const reasonOf = (code: string) => REASONS[code] ?? '처리하지 못했습니다. 다시 시도하세요.';

const pad = (n: number) => String(n).padStart(2, '0');
/** 'MM-DD HH:mm'. */
const stamp = (iso: string | null | undefined) => {
  if (!iso) return '';
  const at = new Date(iso);
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
};
const clock = (iso: string) => {
  const at = new Date(iso);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
};
/** The badge's time: '10:20' today, '어제', else 'MM-DD'. */
const when = (iso: string) => {
  const at = new Date(iso);
  const today = new Date();
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (day(at) === day(today)) return clock(iso);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day(at) === day(yesterday)) return '어제';
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};
const megabytes = (size: number) =>
  size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
const changesLine = (changes: Changes | null) => {
  if (!changes) return '바뀐 객체 기록 없음';
  const total = changes.added + changes.modified + changes.removed;
  return `바뀐 객체 ${total}`;
};

/** A POST whose refusal details the screen needs (the holder, a suggestion, the server version). */
async function post(path: string, data: unknown) {
  let response: Response;
  try {
    response = await fetch('api/v1' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch {
    return { ok: false, value: { code: 'SERVER_UNREACHABLE' } as Record<string, unknown> };
  }
  const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, value };
}

export function ServerFiles({ projectId, remote }: { projectId: string; remote: boolean }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<FileRow | null>(null);
  const [publishing, setPublishing] = useState<FileRow | null>(null);
  const base = `/projects/${encodeURIComponent(projectId)}/workspace`;
  const load = useCallback(
    () =>
      api(`${base}/server-files`, 'GET', undefined, {
        quiet: ['NO_WORKSPACE', 'WORKSPACE_CONFIG_INVALID', 'WORKSPACE_PROJECT_CONFLICT'],
      })
        .then((value) => setListing(value as Listing))
        .catch(() => setListing(null)),
    [base],
  );
  useEffect(() => {
    void load();
    // Another member may have taken a file meanwhile: read again when the window comes back.
    const again = () => void load();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [load]);
  if (!listing?.server || !listing.roles.length) return null;
  const note = (path: string, text: string) => setNotes((all) => ({ ...all, [path]: text }));

  const checkout = async (file: FileRow, options: { overwrite?: boolean; readOnly?: boolean }) => {
    setBusy(file.path);
    setConfirm(null);
    note(file.path, `복사 중 … ${megabytes(file.size)}`);
    const reply = await post(`${base}/checkout`, { serverPath: file.path, ...options });
    setBusy(null);
    if (reply.ok) {
      const value = reply.value as { readOnly?: boolean; localPath?: string };
      note(
        file.path,
        value.readOnly ? `읽기 전용 사본을 만들었습니다 · ${value.localPath ?? ''}` : '',
      );
      await load();
      return;
    }
    const code = String(reply.value.code ?? '');
    if (code === 'LOCAL_COPY_EXISTS') {
      note(file.path, '');
      setConfirm(file);
      return;
    }
    note(file.path, reasonOf(code));
    if (code === 'CHECKED_OUT_ELSEWHERE') await load();
  };
  const release = async (file: FileRow) => {
    if (!file.mine) return;
    setBusy(file.path);
    const reply = await post(`${base}/release`, { checkoutId: file.mine.id });
    setBusy(null);
    note(file.path, reply.ok ? '' : reasonOf(String(reply.value.code ?? '')));
    await load();
  };

  return (
    <div className="wsco" aria-label="서버 파일">
      <h4 className="dash-folder-sub">서버 파일</h4>
      {listing.roles.map((group) => (
        <div key={group.role} className="wsco-role">
          <h5>{ROLE_TITLE[group.role]}</h5>
          {group.status === 'no-access' ? (
            <p className="wsco-warn">읽을 권한이 없습니다.</p>
          ) : group.status === 'unreachable' ? (
            <p className="wsco-warn">서버 폴더에 지금 닿지 않습니다.</p>
          ) : group.status === 'empty' ? (
            <p className="wsco-muted">파일이 없습니다.</p>
          ) : null}
          <ul className="wsco-files">
            {group.files.map((file) => {
              const other = file.others[0];
              return (
                <li
                  key={file.path}
                  className="wsco-file"
                  data-checked={file.mine ? 'mine' : other ? 'other' : 'none'}
                >
                  <div className="wsco-row">
                    <span className="wsco-name" title={file.path}>
                      {file.name}
                    </span>
                    <span className="wsco-muted">서버 판 {stamp(file.serverAt)}</span>
                    <span className="wsco-state">
                      {group.mode === 'server' ? (
                        <span className="wsco-muted">
                          서버에서 직접 ·{' '}
                          {file.backup
                            ? `오늘 백업 있음(${clock(file.backup.at)})`
                            : '오늘 백업 없음'}
                        </span>
                      ) : file.mine ? (
                        <span className="wsco-badge">
                          {file.mine.userId} · {when(file.mine.checkedOutAt)} · 이 PC
                        </span>
                      ) : other ? (
                        <>
                          <span className="wsco-badge">
                            {other.user} · {when(other.at)} · 다른 PC
                          </span>
                          {remote ? null : (
                            <>
                              <button type="button" disabled>
                                체크아웃
                              </button>
                              <button
                                type="button"
                                className="link-button wsco-muted"
                                disabled={!!busy}
                                onClick={() => void checkout(file, { readOnly: true })}
                              >
                                읽기 전용으로 열기
                              </button>
                            </>
                          )}
                        </>
                      ) : remote ? null : (
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() => void checkout(file, {})}
                        >
                          체크아웃
                        </button>
                      )}
                    </span>
                  </div>
                  {file.mine ? (
                    <div className="wsco-row wsco-local">
                      <span className="wsco-name" title={file.mine.localPath}>
                        {file.mine.localPath.split('\\').pop()}
                      </span>
                      <span className="wsco-muted">
                        {file.mine.localExists
                          ? `로컬 사본 · ${changesLine(file.mine.changed)}`
                          : '로컬 사본이 없습니다'}
                      </span>
                      {remote ? null : (
                        <span className="wsco-state">
                          <button
                            type="button"
                            className="primary"
                            disabled={!!busy || !file.mine.localExists}
                            onClick={() => setPublishing(file)}
                          >
                            서버에 반영
                          </button>
                          <button
                            type="button"
                            className="link-button"
                            disabled={!!busy}
                            onClick={() => void release(file)}
                          >
                            체크아웃 풀기
                          </button>
                        </span>
                      )}
                    </div>
                  ) : null}
                  {confirm?.path === file.path ? (
                    <div className="wsco-confirm" role="alert">
                      <span>로컬에 같은 이름의 사본이 있습니다 — 덮어쓸까요?</span>
                      <button
                        type="button"
                        onClick={() => void checkout(file, { overwrite: true })}
                      >
                        덮어쓰기
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setConfirm(null)}
                      >
                        취소
                      </button>
                    </div>
                  ) : null}
                  {notes[file.path] ? (
                    <p className="wsco-note" role="status">
                      {notes[file.path]}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {group.truncated ? <p className="wsco-muted">앞의 파일만 보입니다.</p> : null}
        </div>
      ))}
      {publishing?.mine ? (
        <PublishDialog
          base={base}
          file={publishing}
          checkoutId={publishing.mine.id}
          onClose={async (done) => {
            const file = publishing;
            setPublishing(null);
            if (done) note(file.path, done);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

/** [서버에 반영] (Design SCR-37): the summary, where it goes, the archive line, keep or release. */
function PublishDialog({
  base,
  file,
  checkoutId,
  onClose,
}: {
  base: string;
  file: FileRow;
  checkoutId: string;
  onClose: (done?: string) => void;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failure, setFailure] = useState('');
  /** After a failed [반영]: the server file was not touched (false once it was written). */
  const [untouched, setUntouched] = useState(true);
  const [archivedNote, setArchivedNote] = useState(false);
  const [target, setTarget] = useState('');
  const [keep, setKeep] = useState(true);
  const [phase, setPhase] = useState<'idle' | 'working'>('idle');
  const [seen, setSeen] = useState<string | undefined>();
  const picker = useFolderPicker();
  useEffect(() => {
    let live = true;
    api(`${base}/publish-summary?checkoutId=${encodeURIComponent(checkoutId)}`)
      .then((value) => {
        if (!live) return;
        const read = value as Summary;
        setSummary(read);
        setTarget(read.target ?? '');
      })
      .catch((error) => live && setFailure((error as Error).message));
    return () => {
      live = false;
    };
  }, [base, checkoutId]);
  const changed = summary?.server.changedSinceCheckout;
  const submit = async () => {
    setPhase('working');
    setFailure('');
    setUntouched(true);
    setArchivedNote(false);
    const reply = await post(`${base}/publish`, {
      checkoutId,
      target: target.trim() || undefined,
      keepCheckout: keep,
      ...(seen ? { seenServerHash: seen } : {}),
    });
    setPhase('idle');
    if (reply.ok) {
      const value = reply.value as { serverAt: string; archived: string | null };
      onClose(
        `서버에 반영했습니다 · 서버 판 ${clock(value.serverAt)}${value.archived ? ' · 이전 판 보관됨' : ''}`,
      );
      return;
    }
    const code = String(reply.value.code ?? '');
    if (code === 'SERVER_CHANGED_SINCE_CHECKOUT') {
      // The person has now seen the changed server version; the next [반영] may replace it.
      const server = reply.value.server as { at: string; hash: string } | undefined;
      if (server && summary)
        setSummary({ ...summary, server: { ...server, changedSinceCheckout: true } });
      setSeen(server?.hash);
    }
    if (code === 'NEEDS_TARGET' && typeof reply.value.suggestion === 'string' && summary)
      setSummary({ ...summary, suggestion: reply.value.suggestion });
    // Only a write that was not read back the same changed the server file.
    setUntouched(code !== 'SERVER_WRITE_UNVERIFIED');
    setArchivedNote(!!reply.value.archived);
    setFailure(reasonOf(code));
  };
  const choose = async () => {
    const chosen = await pickFolder();
    if (chosen.path) setTarget(chosen.path);
  };
  return (
    <div className="wsco-backdrop">
      <div className="wsco-dialog" role="dialog" aria-modal="true" aria-label="서버에 반영">
        <h3>서버에 반영</h3>
        <p className="wsco-mono">{file.name}</p>
        {!summary && !failure ? <p className="wsco-muted">읽는 중…</p> : null}
        {summary ? (
          <>
            <ul className="wsco-summary">
              <li>
                {summary.changed
                  ? `바뀐 객체 ${summary.changed.added + summary.changed.modified + summary.changed.removed}(추가 ${summary.changed.added} · 변경 ${summary.changed.modified} · 삭제 ${summary.changed.removed})`
                  : '바뀐 객체 기록 없음'}
              </li>
              <li>
                {summary.syncMismatch === null
                  ? 'Sync 비교 기록 없음'
                  : summary.syncMismatch
                    ? `동기화 어긋남 ${summary.syncMismatch}`
                    : '어긋남 없음'}
              </li>
              <li className={changed ? 'wsco-warn' : undefined}>
                {changed
                  ? '체크아웃 뒤 서버 판이 바뀌었습니다'
                  : `서버 판 ${stamp(summary.server.at)} · 체크아웃 ${stamp(summary.checkout.checkedOutAt)}`}
              </li>
            </ul>
            <label className="wsco-target">
              <span>대상 경로</span>
              <input
                type="text"
                className="wsco-mono"
                aria-label="대상 경로"
                value={target}
                disabled={phase === 'working'}
                onChange={(event) => setTarget(event.target.value)}
              />
              {picker ? (
                <button type="button" className="link-button" onClick={() => void choose()}>
                  바꾸기
                </button>
              ) : null}
            </label>
            {!summary.remembered ? (
              <p className="wsco-muted">
                둘 곳을 고르면 이 종류는 앞으로 여기로 기억합니다.
                {summary.suggestion !== undefined ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setTarget(summary.suggestion)}
                    >
                      가져온 폴더로
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
            <p className="wsco-muted">서버의 이전 판은 이 PC의 아카이브에 보관됩니다.</p>
            <fieldset className="wsco-keep">
              <label>
                <input
                  type="radio"
                  name="wsco-keep"
                  checked={keep}
                  onChange={() => setKeep(true)}
                />
                반영 뒤 체크아웃 유지(계속 작업)
              </label>
              <label>
                <input
                  type="radio"
                  name="wsco-keep"
                  checked={!keep}
                  onChange={() => setKeep(false)}
                />
                체크아웃 풀기
              </label>
            </fieldset>
          </>
        ) : null}
        {failure ? (
          <div className="wsco-failure" role="alert">
            <p>{failure}</p>
            <p className="wsco-muted">
              {untouched
                ? '반영 전이라 서버 파일은 바뀌지 않았습니다.'
                : `서버 파일이 바뀌었을 수 있습니다${archivedNote ? ' · 이전 판은 보관됨' : ''}.`}
            </p>
          </div>
        ) : null}
        <div className="wsco-actions">
          <button
            type="button"
            className="primary"
            disabled={!summary || phase === 'working'}
            onClick={() => void submit()}
          >
            {phase === 'working' ? '보관 중… → 복사 중…' : '반영'}
          </button>
          <button type="button" disabled={phase === 'working'} onClick={() => onClose()}>
            취소
          </button>
        </div>
      </div>
    </div>
  );
}

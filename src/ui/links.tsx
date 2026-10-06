import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { iconSvg } from './inspector.ts';

// The project's linked files (SPEC-01.11, Design §03): files linked from the Rhino/ZWCAD plugins,
// shown together in one space. Each row: visibility, status, last Sync, forced Sync, removal.
// Row look (2026-10-01, from the chat-stage mockup): bold name with a green dot only while Live,
// a small meta line under it and small icon buttons.
export const linkRowSchema = z.object({
  id: z.string(),
  host: z.enum(['rhino', 'zwcad']),
  name: z.string(),
  path: z.string().nullable(),
  /** The window it was linked from (the host panel finds its own file by these). */
  instance: z.string().optional(),
  documentId: z.number().optional(),
  hidden: z.boolean(),
  /** "file": opened in VIDE from a 3DM/DWG file; "host": linked from a Rhino/ZWCAD window. */
  kind: z.enum(['host', 'file']).default('host'),
  connection: z
    .object({
      instance: z.string(),
      documentId: z.number(),
      live: z.boolean(),
      generation: z.number(),
      objectCount: z.number(),
      units: z.string(),
      modified: z.boolean().nullable(),
      hostBusy: z.boolean(),
    })
    .nullable(),
  lastSync: z.object({ requestId: z.string(), at: z.string().optional() }).nullable(),
  lastError: z.string().optional(),
  /** The engine's Sync of this file (T-084): it Syncs; the page only shows it. */
  sync: z
    .object({
      state: z.enum(['idle', 'syncing', 'held', 'waiting', 'failed']),
      code: z.string().optional(),
      at: z.string(),
    })
    .optional(),
  /** The stored display to show: its revision rises with each Live Sync in place. */
  display: z.object({ requestId: z.string(), revision: z.number() }).nullable().optional(),
  /** A one-time note (SPEC-01.11 1, T-107): the row followed its window, or the id was stored. */
  notice: z
    .union([
      z.object({
        kind: z.literal('followed'),
        reason: z.enum(['renamed', 'reopened']),
        from: z.string(),
        to: z.string(),
      }),
      z.object({ kind: z.literal('stored') }),
    ])
    .optional(),
  /** Cleanup offered for a closed row: merge into the open row of its window, or take it out. */
  cleanup: z
    .union([
      z.object({ kind: z.literal('merge'), into: z.string(), intoName: z.string() }),
      z.object({ kind: z.literal('empty') }),
    ])
    .optional(),
});
export type LinkRow = z.infer<typeof linkRowSchema>;
/** PLAN-20: saved views on the account site and requests left there. */
export const offlineStatusSchema = z.object({
  enabled: z.boolean(),
  linked: z.boolean(),
  files: z.array(
    z.object({
      linkId: z.string(),
      name: z.string(),
      uploadedAt: z.string().nullable(),
      size: z.number().nullable(),
      upToDate: z.boolean(),
      synced: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
  inbox: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      linkId: z.string().nullable(),
      body: z.string(),
      createdAt: z.string(),
      receivedAt: z.string(),
    }),
  ),
});
export type OfflineStatus = z.infer<typeof offlineStatusSchema>;
export type InboxItem = OfflineStatus['inbox'][number];

interface Props {
  links: LinkRow[];
  /** The current project's name, shown in the connection steps. */
  projectName?: string;
  /** The file the composer targets. */
  active?: string;
  /** Per-link notes of the Sync driver (syncing, held, failed). */
  notes: Map<string, string>;
  /** Links whose shown result is a candidate instead of their latest Sync. */
  candidates: Set<string>;
  loaded: boolean;
  /** Shown results that belong to no linked file (SPEC-01.11 4): "작업 결과 · <이름>". */
  results: { key: string; name: string }[];
  onCloseResult: (key: string) => void;
  onFocusResult: (key: string) => void;
  onToggle: (link: LinkRow) => void;
  /** ⟳; `full`: read the whole document even when a Live Sync could continue the shown one. */
  onSync: (link: LinkRow, full?: boolean) => void;
  onRemove: (link: LinkRow) => void;
  onFocus: (link: LinkRow) => void;
  onBackToSync: (link: LinkRow) => void;
  /** [새 항목으로 분리]: the window gets a new row, this one keeps its history (T-107). */
  onSplit: (link: LinkRow) => void;
  /** Closes the row's one-time note. */
  onDismiss: (link: LinkRow) => void;
  /** [합치기]: this closed duplicate's records go to the open row of the same window. */
  onMerge: (link: LinkRow, into: string) => void;
  offline?: OfflineStatus;
  onOffline: (enabled: boolean) => void;
  onInboxUse: (item: InboxItem) => void;
  onInboxDismiss: (item: InboxItem) => void;
}
const time = (value?: string) =>
  value ? new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';

const OFFLINE_ERRORS: Record<string, string> = {
  SNAPSHOT_QUOTA: '계정 저장 용량 초과',
  SNAPSHOT_SITE_FULL: '사이트 저장 용량 초과',
  SNAPSHOT_TOO_LARGE: '모델이 너무 큼(95 MB)',
  SNAPSHOTS_DISABLED: '사이트에서 꺼짐',
  PROJECT_NOT_FOUND: '계정 목록에 없는 프로젝트',
  NOT_FOUND: '사이트 업데이트 전',
};
const size = (bytes: number) =>
  bytes < 1048576
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;

/** Requests left on the account site while this PC was off; the user reads and sends them. */
function Inbox(props: Props) {
  const items = props.offline?.inbox ?? [];
  if (!items.length) return null;
  return (
    <section className="link-inbox" aria-label="사이트에서 남긴 요청">
      <strong>사이트에서 남긴 요청 {items.length}</strong>
      {items.map((item) => (
        <div key={item.id} className="link-inbox-item">
          <span className="link-inbox-body">{item.body}</span>
          <small>
            {new Date(item.createdAt).toLocaleString('ko-KR', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {item.linkId
              ? ` · ${props.links.find((link) => link.id === item.linkId)?.name ?? '연결 파일'}`
              : ''}
          </small>
          <span className="link-inbox-actions">
            <button type="button" className="link-button" onClick={() => props.onInboxUse(item)}>
              작성기로
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => props.onInboxDismiss(item)}
            >
              지우기
            </button>
          </span>
        </div>
      ))}
    </section>
  );
}

/** The per-project switch for the saved view on the account site, with its state. */
function OfflineSwitch(props: Props) {
  const offline = props.offline;
  if (!offline?.linked || !props.links.length) return null;
  const files = offline.files;
  const failed = files.find((file) => file.error);
  const saved = files.filter((file) => file.uploadedAt);
  const waiting = files.some((file) => file.synced && !file.upToDate && !file.error);
  const total = saved.reduce((sum, file) => sum + (file.size ?? 0), 0);
  return (
    <label
      className="link-offline"
      title="켜면 각 연결 파일의 마지막 Sync를 보기 전용 모델(형상·레이어·문자, 원본 파일 아님)로 계정 사이트에 저장합니다. 끄면 사이트의 저장본을 지웁니다."
    >
      <input
        type="checkbox"
        checked={offline.enabled}
        onChange={(event) => props.onOffline(event.target.checked)}
      />
      PC가 꺼져도 사이트에서 보기
      {offline.enabled ? (
        <small>
          {failed
            ? `저장 실패: ${OFFLINE_ERRORS[failed.error!] ?? failed.error}`
            : waiting
              ? '저장 대기'
              : saved.length
                ? `${saved.length}개 저장 · ${size(total)}`
                : 'Sync 후 저장'}
        </small>
      ) : null}
    </label>
  );
}

function Links(props: Props) {
  return (
    <>
      <Inbox {...props} />
      <LinkList {...props} />
      <OfflineSwitch {...props} />
    </>
  );
}
/**
 * A result opened from the work history that no linked file owns (an older import, a Sync from
 * before links, an AI result of a removed file): drawn beside the files until it is closed.
 */
function ResultRow({ result, ...props }: Props & { result: Props['results'][number] }) {
  return (
    <li
      className="link-row link-result"
      data-state="result"
      data-result-key={result.key}
      aria-current={props.active === result.key ? 'true' : undefined}
    >
      <span
        className="link-mini link-result-mark"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: iconSvg('history') }}
      />
      <button
        type="button"
        className="link-open"
        title="작업 이력에서 연 결과 · 연결 파일을 숨겨도 남습니다. 닫으면 화면에서 내려갑니다."
        onClick={() => props.onFocusResult(result.key)}
      >
        <span className="link-name">{result.name}</span>
        <span className="link-meta">연결 파일 밖의 결과</span>
      </button>
      <span />
      <button
        type="button"
        className="link-mini link-remove"
        title="닫기 (작업 이력의 기록은 그대로)"
        aria-label={`${result.name} 닫기`}
        onClick={() => props.onCloseResult(result.key)}
        dangerouslySetInnerHTML={{ __html: iconSvg('x') }}
      />
    </li>
  );
}
function LinkList(props: Props) {
  // The row menu (right click on a connected file's row): 지금 Sync · 전체 다시 읽기 (T-123).
  const [menu, setMenu] = useState<string>();
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (!(event.target as Element | null)?.closest?.('.link-menu')) setMenu(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(undefined);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [menu]);
  if (!props.loaded) return <small className="link-empty">연결 파일 확인 중…</small>;
  const results = props.results.map((result) => (
    <ResultRow key={result.key} {...props} result={result} />
  ));
  if (!props.links.length)
    return (
      <>
        {results.length ? (
          <ul className="link-list" aria-label="작업 결과">
            {results}
          </ul>
        ) : null}
        <section className="link-start" aria-label="파일 연결 방법">
          <strong>아직 연결된 파일이 없습니다</strong>
          <p>
            작업 중인 Rhino 모델이나 CAD 도면을 연결하면 여기서 함께 보고 AI에게 작업을 맡길 수
            있습니다.
          </p>
          <ol className="link-steps">
            <li>
              <span className="link-step-no">1</span>
              <span>
                <b>Rhino</b> 또는 <b>ZWCAD</b>에서 파일을 엽니다
              </span>
            </li>
            <li>
              <span className="link-step-no">2</span>
              <span>
                VIDE 패널에서 <b>Link</b>를 누르고{' '}
                {props.projectName ? (
                  <b className="link-project">{props.projectName}</b>
                ) : (
                  '이 프로젝트'
                )}
                를 고릅니다
              </span>
            </li>
            <li>
              <span className="link-step-no">3</span>
              <span>첫 Sync가 끝나면 이 목록과 화면에 나타납니다</span>
            </li>
          </ol>
          <p className="link-hint">
            패널이 보이지 않으면 명령창에 <code>VIDELink</code>(Rhino) · <code>VIDECADLink</code>
            (ZWCAD)를 입력하세요. 파일만 볼 때는 아래 <b>파일에서 열기</b>를 쓰면 됩니다.
          </p>
        </section>
      </>
    );
  return (
    <ul className="link-list" aria-label="연결 파일">
      {props.links.map((link) => {
        const connection = link.connection;
        const file = link.kind === 'file';
        const state = file
          ? 'file'
          : connection
            ? connection.live
              ? 'live'
              : 'connected'
            : 'closed';
        const note = props.notes.get(link.id);
        return (
          <li
            key={link.id}
            className="link-row"
            data-state={state}
            data-hidden={String(link.hidden)}
            aria-current={props.active === link.id ? 'true' : undefined}
            data-link-id={link.id}
            onContextMenu={(event) => {
              if (!connection || file) return;
              event.preventDefault();
              setMenu(link.id);
            }}
          >
            <button
              type="button"
              className="link-mini link-eye"
              aria-pressed={!link.hidden}
              aria-label={`${link.name} ${link.hidden ? '보이기' : '숨기기'}`}
              title={link.hidden ? '보이기' : '숨기기'}
              onClick={() => props.onToggle(link)}
              dangerouslySetInnerHTML={{ __html: iconSvg(link.hidden ? 'eye-off' : 'eye') }}
            />
            <button
              type="button"
              className="link-open"
              title={(link.path || link.name) + ' · 이 파일을 요청 대상으로'}
              onClick={() => props.onFocus(link)}
            >
              <span className="link-name">
                {state === 'live' ? <span className="dot" aria-hidden="true" /> : null}
                {link.name}
              </span>
              <span className="link-meta">
                {link.host === 'zwcad' ? 'ZWCAD' : 'Rhino'}
                {' · '}
                {file
                  ? '파일에서 연 사본'
                  : state === 'live'
                    ? 'Live'
                    : state === 'connected'
                      ? '연결됨'
                      : '닫힘'}
                {file
                  ? link.lastSync
                    ? ` · ${time(link.lastSync.at)}`
                    : ''
                  : link.lastSync
                    ? ` · Sync ${time(link.lastSync.at)}`
                    : ' · Sync 전'}
                {connection ? ` · ${connection.objectCount.toLocaleString()}개` : ''}
                {note ? ` · ${note}` : link.lastError ? ` · Sync 실패` : ''}
              </span>
            </button>
            <button
              type="button"
              className="link-mini link-sync"
              disabled={!connection}
              tabIndex={file ? -1 : undefined}
              aria-hidden={file || undefined}
              title={
                connection
                  ? '지금 Sync (Shift: 전체 다시 읽기 · 행 오른쪽 클릭: 메뉴)'
                  : '파일이 열려 있지 않습니다'
              }
              aria-label={`${link.name} Sync`}
              onClick={(event) => props.onSync(link, event.shiftKey)}
              dangerouslySetInnerHTML={{ __html: iconSvg('refresh') }}
            />
            <button
              type="button"
              className="link-mini link-remove"
              title={
                file
                  ? '목록에서 빼기 (VIDE의 사본과 기록을 지움, 원본 파일은 그대로)'
                  : '연결 해제 · 목록에서 빼기 (VIDE의 Sync 기록을 지움, 파일과 객체는 그대로)'
              }
              aria-label={`${link.name} ${file ? '목록에서 빼기' : '연결 해제'}`}
              onClick={() => props.onRemove(link)}
              dangerouslySetInnerHTML={{ __html: iconSvg('x') }}
            />
            {menu === link.id && connection && !file ? (
              <div className="link-menu" role="menu" aria-label={`${link.name} 메뉴`}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(undefined);
                    props.onSync(link);
                  }}
                >
                  지금 Sync
                </button>
                <button
                  type="button"
                  role="menuitem"
                  title="바뀐 객체만 묻지 않고 문서 전체를 다시 읽습니다"
                  onClick={() => {
                    setMenu(undefined);
                    props.onSync(link, true);
                  }}
                >
                  전체 다시 읽기
                </button>
              </div>
            ) : null}
            <LinkNote {...props} link={link} />
            {props.candidates.has(link.id) ? (
              <button
                type="button"
                className="link-button link-back"
                onClick={() => props.onBackToSync(link)}
              >
                후보 표시 중 · Sync 결과로 돌아가기
              </button>
            ) : null}
          </li>
        );
      })}
      {results}
    </ul>
  );
}
/**
 * The row's one-time note and cleanup offer (SPEC-01.11 1, Design §03): "'A' → 'B'로 따라감" with
 * [새 항목으로 분리], the stored link id, or a closed duplicate's [합치기] and an empty row's [빼기].
 */
function LinkNote({ link, ...props }: Props & { link: LinkRow }) {
  const notice = link.notice;
  const cleanup = link.cleanup;
  if (!notice && !cleanup) return null;
  return (
    <div className="link-note" data-note={notice?.kind ?? cleanup?.kind}>
      {notice?.kind === 'followed' ? (
        <>
          <span>
            {notice.reason === 'renamed'
              ? `'${notice.from}' → '${notice.to}'로 따라감`
              : `'${notice.from}'을(를) 다시 연 창으로 따라감`}
          </span>
          <button type="button" className="link-button" onClick={() => props.onSplit(link)}>
            새 항목으로 분리
          </button>
          <button type="button" className="link-button" onClick={() => props.onDismiss(link)}>
            확인
          </button>
        </>
      ) : notice?.kind === 'stored' ? (
        <>
          <span>연결 ID를 문서에 저장했습니다. 저장하면 다음에도 이어집니다</span>
          <button type="button" className="link-button" onClick={() => props.onDismiss(link)}>
            확인
          </button>
        </>
      ) : cleanup?.kind === 'merge' ? (
        <>
          <span>같은 창의 중복 항목</span>
          <button
            type="button"
            className="link-button"
            title={`이 항목의 Sync 기록을 '${cleanup.intoName}'(으)로 옮기고 이 항목을 뺍니다`}
            onClick={() => props.onMerge(link, cleanup.into)}
          >
            합치기
          </button>
        </>
      ) : cleanup?.kind === 'empty' ? (
        <>
          <span>기록 없음</span>
          <button type="button" className="link-button" onClick={() => props.onRemove(link)}>
            빼기
          </button>
        </>
      ) : null}
    </div>
  );
}
let root: ReturnType<typeof createRoot> | undefined;
export function renderLinks(element: HTMLElement, props: Props) {
  root ??= createRoot(element);
  root.render(<Links {...props} />);
}

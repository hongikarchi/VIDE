import { createRoot } from 'react-dom/client';
import { z } from 'zod';

// The project's linked files (SPEC-01.11, Design §03): files linked from the Rhino/ZWCAD plugins,
// shown together in one space. Each row: visibility, status, last Sync, forced Sync, removal.
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
  onToggle: (link: LinkRow) => void;
  onSync: (link: LinkRow) => void;
  onRemove: (link: LinkRow) => void;
  onFocus: (link: LinkRow) => void;
  onBackToSync: (link: LinkRow) => void;
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
  SNAPSHOT_TOO_LARGE: '모델이 너무 큼(50 MB)',
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
function LinkList(props: Props) {
  if (!props.loaded) return <small className="link-empty">연결 파일 확인 중…</small>;
  if (!props.links.length)
    return (
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
          >
            <button
              type="button"
              className="link-eye"
              aria-pressed={!link.hidden}
              aria-label={`${link.name} ${link.hidden ? '보이기' : '숨기기'}`}
              title={link.hidden ? '보이기' : '숨기기'}
              onClick={() => props.onToggle(link)}
            >
              {link.hidden ? '◌' : '◉'}
            </button>
            <button
              type="button"
              className="link-open"
              title={(link.path || link.name) + ' · 이 파일을 요청 대상으로'}
              onClick={() => props.onFocus(link)}
            >
              <span className="link-name">
                <span className="link-host">{link.host === 'zwcad' ? 'CAD' : 'R'}</span>
                {link.name}
              </span>
              <span className="link-meta">
                <span className="dot" aria-hidden="true" />
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
              className="icon-button link-sync"
              disabled={!connection}
              tabIndex={file ? -1 : undefined}
              aria-hidden={file || undefined}
              title={connection ? '지금 Sync' : '파일이 열려 있지 않습니다'}
              aria-label={`${link.name} Sync`}
              onClick={() => props.onSync(link)}
            >
              ⟳
            </button>
            <button
              type="button"
              className="icon-button link-remove"
              title={
                file
                  ? '목록에서 빼기 (VIDE의 사본과 기록을 지움, 원본 파일은 그대로)'
                  : '연결 해제 · 목록에서 빼기 (VIDE의 Sync 기록을 지움, 파일과 객체는 그대로)'
              }
              aria-label={`${link.name} ${file ? '목록에서 빼기' : '연결 해제'}`}
              onClick={() => props.onRemove(link)}
            >
              ×
            </button>
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
    </ul>
  );
}
let root: ReturnType<typeof createRoot> | undefined;
export function renderLinks(element: HTMLElement, props: Props) {
  root ??= createRoot(element);
  root.render(<Links {...props} />);
}

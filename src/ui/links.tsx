import { createRoot } from 'react-dom/client';
import { z } from 'zod';

// The project's linked files (SPEC-01.9, Design §03): files linked from the Rhino/ZWCAD plugins,
// shown together in one space. Each row: visibility, status, last Sync, forced Sync, removal.
export const linkRowSchema = z.object({
  id: z.string(),
  host: z.enum(['rhino', 'zwcad']),
  name: z.string(),
  path: z.string().nullable(),
  hidden: z.boolean(),
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

interface Props {
  links: LinkRow[];
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
}
const time = (value?: string) =>
  value ? new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';

function Links(props: Props) {
  if (!props.loaded) return <small className="link-empty">연결 파일 확인 중…</small>;
  if (!props.links.length)
    return (
      <p className="link-empty">
        Rhino·ZWCAD 플러그인 패널에서 <b>Link</b>를 누르고 이 프로젝트를 고르면 여기에 연결됩니다.
        (명령: Rhino <code>VIDELink</code>, ZWCAD <code>VIDECADLink</code>)
      </p>
    );
  return (
    <ul className="link-list" aria-label="연결 파일">
      {props.links.map((link) => {
        const connection = link.connection;
        const state = connection ? (connection.live ? 'live' : 'connected') : 'closed';
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
                {state === 'live' ? 'Live' : state === 'connected' ? '연결됨' : '닫힘'}
                {link.lastSync ? ` · Sync ${time(link.lastSync.at)}` : ' · Sync 전'}
                {connection ? ` · ${connection.objectCount.toLocaleString()}개` : ''}
                {note ? ` · ${note}` : link.lastError ? ` · Sync 실패` : ''}
              </span>
            </button>
            <button
              type="button"
              className="icon-button link-sync"
              disabled={!connection}
              title={connection ? '지금 Sync' : '파일이 열려 있지 않습니다'}
              aria-label={`${link.name} Sync`}
              onClick={() => props.onSync(link)}
            >
              ⟳
            </button>
            <button
              type="button"
              className="icon-button link-remove"
              title="프로젝트 목록에서 빼기 (Sync 기록과 파일은 그대로)"
              aria-label={`${link.name} 목록에서 빼기`}
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

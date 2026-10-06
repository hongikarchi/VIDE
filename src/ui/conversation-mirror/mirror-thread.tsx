import {
  mirrorStateLabel,
  type MirroredConversation,
  type MirroredThread,
} from '../../contracts/conversation-mirror.ts';

// A project's conversation records from another member's PC (ADR-037 4, Design SCR-25), read-only.
// The same components run on the account site (src/sharing/web/conversations.tsx) and in VIDE's
// 작업 이력 (src/ui/shared-history.tsx); a remote project's screen can show them as they are.

export type MirrorListItem = MirroredConversation & { preview?: string; lastState?: string };

const when = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString('ko-KR', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
/** Who ran it: the account and the PC. */
export const originLabel = (conversation: Pick<MirroredConversation, 'originName' | 'originPc'>) =>
  conversation.originPc
    ? `${conversation.originName} · ${conversation.originPc}`
    : conversation.originName;
export const conversationKey = (conversation: { originHost: string; id: string }) =>
  `${conversation.originHost}:${conversation.id}`;

export function MirrorConversationList({
  conversations,
  selected,
  onOpen,
  empty = '다른 구성원이 공유한 대화 기록이 없습니다.',
}: {
  conversations: MirrorListItem[];
  selected?: string;
  onOpen: (conversation: MirrorListItem) => void;
  empty?: string;
}) {
  if (!conversations.length) return <p className="mirror-empty">{empty}</p>;
  return (
    <ul className="mirror-list" aria-label="공유된 대화 기록">
      {conversations.map((conversation) => (
        <li key={conversationKey(conversation)}>
          <button
            type="button"
            className="mirror-row"
            aria-current={selected === conversationKey(conversation) ? 'true' : undefined}
            onClick={() => onOpen(conversation)}
          >
            <span className="mirror-row-title">{conversation.title || '대화'}</span>
            {conversation.preview ? (
              <span className="mirror-row-preview">{conversation.preview}</span>
            ) : null}
            <span className="mirror-row-meta">
              <span className="mirror-origin">{originLabel(conversation)}</span>
              <span>요청 {conversation.requests}</span>
              {conversation.lastAt ? <span>{when(conversation.lastAt)}</span> : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One conversation: every request with its full answer, activity lines, code and file names. */
export function MirrorThreadView({
  thread,
  highlight,
}: {
  thread: MirroredThread;
  /** A request to scroll to (a search match). */
  highlight?: string;
}) {
  const { conversation, requests } = thread;
  return (
    <article className="mirror-thread" aria-label={`${conversation.title || '대화'} 대화 기록`}>
      <header className="mirror-thread-head">
        <h2>{conversation.title || '대화'}</h2>
        <p>
          <span className="mirror-origin">{originLabel(conversation)}</span>
          {conversation.model ? <span>{conversation.model}</span> : null}
          <span className="mirror-readonly">보기 전용</span>
        </p>
      </header>
      <ol className="mirror-requests">
        {requests.map((request) => (
          <li
            key={request.id}
            className="mirror-request"
            data-state={request.state}
            data-highlight={highlight === request.id ? 'true' : undefined}
            ref={
              highlight === request.id
                ? (node) => node?.scrollIntoView({ block: 'center' })
                : undefined
            }
          >
            <div className="mirror-request-meta">
              <time dateTime={request.createdAt}>{when(request.createdAt)}</time>
              <span className="mirror-state">{mirrorStateLabel(request.state)}</span>
              {request.files.length ? (
                <span className="mirror-files" aria-label="파일">
                  {request.files.map((file) => (
                    <span key={file} className="mirror-file">
                      {file}
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
            <div className="mirror-body" aria-label="요청">
              {request.body.trim() || '(글 없는 요청)'}
            </div>
            {request.answer?.trim() ? (
              <div className="mirror-answer" aria-label="답">
                {request.answer.trim()}
              </div>
            ) : null}
            {request.activity.length ? (
              <details className="mirror-activity">
                <summary>활동 {request.activity.length}줄</summary>
                <ol>
                  {request.activity.map((entry, index) => (
                    <li key={index} data-kind={entry.kind}>
                      <span>{entry.text}</span>
                      {entry.detail ? (
                        <pre className="mirror-code">
                          <code>{entry.detail}</code>
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
            {request.executions.map((execution, index) => (
              <section key={index} className="mirror-execution" aria-label="실행한 코드">
                <p>
                  {execution.label}
                  {execution.file ? ` · ${execution.file}` : ''} · {execution.state}
                </p>
                {execution.code ? (
                  <pre className="mirror-code">
                    <code>{execution.code}</code>
                  </pre>
                ) : null}
              </section>
            ))}
          </li>
        ))}
      </ol>
    </article>
  );
}

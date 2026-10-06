import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MirroredThread } from '../contracts/conversation-mirror.ts';
import {
  conversationKey,
  MirrorConversationList,
  MirrorThreadView,
  originLabel,
  type MirrorListItem,
} from './conversation-mirror/mirror-thread.tsx';
import { api } from './gateway.ts';

// 작업 이력 › 다른 구성원의 대화 (ADR-037 4, PLAN-36, Design SCR-25): the project's conversations
// another member ran on their own PC, read-only, from the engine's copy of the account site's
// records (src/server/conversation-mirror.ts). Only conversations without a host document are
// shared. The same list and thread components run on the site and in a remote project's screen.

interface ListReply {
  online: boolean;
  error?: string;
  conversations: MirrorListItem[];
}

/** The list under 작업 이력 and a read-only thread dialog. Hidden when nothing is shared. */
export function SharedHistory({ projectId }: { projectId: string | undefined }) {
  const [reply, setReply] = useState<ListReply | null>(null),
    [open, setOpen] = useState<MirrorListItem | null>(null),
    [thread, setThread] = useState<MirroredThread | null>(null),
    [status, setStatus] = useState('');
  const refresh = useCallback(async () => {
    if (!projectId) return;
    const value = (await api(
      `/projects/${encodeURIComponent(projectId)}/shared-conversations`,
      'GET',
      undefined,
      { quiet: ['NOT_FOUND'] },
    )) as ListReply;
    setReply(value);
  }, [projectId]);
  useEffect(() => {
    setReply(null);
    setOpen(null);
    if (!projectId) return;
    void refresh().catch(() => setReply(null));
    const timer = setInterval(() => void refresh().catch(() => {}), 60_000);
    return () => clearInterval(timer);
  }, [projectId, refresh]);
  useEffect(() => {
    setThread(null);
    setStatus('');
    if (!open || !projectId) return;
    let live = true;
    void api(
      `/projects/${encodeURIComponent(projectId)}/shared-conversations/${encodeURIComponent(open.originHost)}/${encodeURIComponent(open.id)}`,
    )
      .then((value) => live && setThread(value as MirroredThread))
      .catch((error: unknown) =>
        setStatus(error instanceof Error ? error.message : '대화 기록을 열지 못했습니다.'),
      );
    return () => {
      live = false;
    };
  }, [open, projectId]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  if (!reply?.conversations.length) return null;
  return (
    <div className="shared-history" aria-label="다른 구성원의 대화">
      <h4 className="shared-history-head">
        다른 구성원의 대화
        <small title="호스트 문서 없이 한 대화만 공유됩니다. 모델링 대화는 그 PC에만 남습니다.">
          {reply.online ? '보기 전용' : '보기 전용 · 사이트 연결 안 됨'}
        </small>
      </h4>
      <MirrorConversationList
        conversations={reply.conversations}
        selected={open ? conversationKey(open) : undefined}
        onOpen={setOpen}
      />
      {open
        ? createPortal(
            <div
              className="shared-history-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={`${originLabel(open)}의 대화 기록`}
            >
              <div className="shared-history-sheet">
                <div className="shared-history-bar">
                  <span>다른 구성원의 대화 기록</span>
                  <button type="button" aria-label="닫기" onClick={() => setOpen(null)}>
                    ×
                  </button>
                </div>
                {thread ? <MirrorThreadView thread={thread} /> : null}
                {!thread && !status ? <p className="mirror-empty">불러오는 중…</p> : null}
                {status ? <p className="mirror-empty">{status}</p> : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

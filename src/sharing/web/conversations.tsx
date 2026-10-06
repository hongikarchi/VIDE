import { useCallback, useEffect, useState } from 'react';
import type { MirroredThread } from '../../contracts/conversation-mirror';
import {
  conversationKey,
  MirrorConversationList,
  MirrorThreadView,
  originLabel,
  type MirrorListItem,
} from '../../ui/conversation-mirror/mirror-thread';
import { api, message, type Project } from './api';
import '../../ui/conversation-mirror/mirror-thread.css';

// ADR-037 4 (PLAN-36, Design SCR-25): a project's conversation records on the account site. Each
// member's VIDE uploads the text of its conversations without a host document (modeling
// conversations stay on that PC); every member reads them here, searches their text, and opens a
// conversation with its full answers, activity lines, code and file names. Read-only.

interface Match {
  id: string;
  conversationId: string;
  originHost: string;
  state: string;
  createdAt: string;
  files: string[];
  preview: string;
}
interface ListReply {
  conversations: MirrorListItem[];
  matches?: Match[];
}

const when = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const param = (name: string) => new URL(location.href).searchParams.get(name) ?? '';

export function ProjectConversations({ project }: { project: Project }) {
  const base = `/projects/${encodeURIComponent(project.id)}/conversations`;
  const [list, setList] = useState<ListReply | null>(null),
    [query, setQuery] = useState(''),
    [searched, setSearched] = useState(''),
    [selected, setSelected] = useState(() => param('c')),
    [highlight, setHighlight] = useState(() => param('r')),
    [thread, setThread] = useState<MirroredThread | null>(null),
    [status, setStatus] = useState('');
  const load = useCallback(
    async (q: string) => {
      setList((await api(q ? `${base}?q=${encodeURIComponent(q)}` : base)) as ListReply);
      setSearched(q);
    },
    [base],
  );
  useEffect(() => {
    void load('').catch((error) => setStatus(message(error)));
  }, [load]);
  useEffect(() => {
    setThread(null);
    if (!selected) return;
    const [host, id] = selected.split(':');
    let live = true;
    void api(`${base}/${encodeURIComponent(host)}/${encodeURIComponent(id)}`)
      .then((value) => live && setThread(value as MirroredThread))
      .catch((error) => live && setStatus(message(error)));
    return () => {
      live = false;
    };
  }, [base, selected]);
  const open = (key: string, request = '') => {
    setSelected(key);
    setHighlight(request);
    const url = new URL(location.href);
    url.searchParams.set('c', key);
    if (request) url.searchParams.set('r', request);
    else url.searchParams.delete('r');
    history.replaceState(null, '', url);
  };
  const titleOf = (match: Match) =>
    list?.conversations.find(
      (row) => row.originHost === match.originHost && row.id === match.conversationId,
    );
  return (
    <main className="conversations-page">
      <aside className="conversations-side">
        <form
          className="conversations-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            void load(query.trim()).catch((error) => setStatus(message(error)));
          }}
        >
          <input
            aria-label="대화 기록 검색"
            placeholder="요청·답·코드에서 찾기"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button>찾기</button>
        </form>
        <p className="muted conversations-note">
          구성원이 VIDE에서 호스트 문서 없이 한 대화의 사본입니다. 모델링 대화는 그 PC에만 남습니다.
        </p>
        {list === null ? <p className="muted">불러오는 중…</p> : null}
        {searched && list?.matches ? (
          <section aria-label="검색 결과">
            <h3>
              ‘{searched}’ 결과 {list.matches.length}
            </h3>
            <ul className="conversations-matches">
              {list.matches.map((match) => {
                const conversation = titleOf(match);
                return (
                  <li key={match.id}>
                    <button
                      onClick={() => open(`${match.originHost}:${match.conversationId}`, match.id)}
                    >
                      <strong>{match.preview || '(글 없는 요청)'}</strong>
                      <small className="muted">
                        {conversation
                          ? `${conversation.title} · ${originLabel(conversation)} · `
                          : ''}
                        {when(match.createdAt)}
                      </small>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        {list ? (
          <MirrorConversationList
            conversations={list.conversations}
            selected={selected}
            onOpen={(conversation) => open(conversationKey(conversation))}
            empty="아직 공유된 대화 기록이 없습니다. 구성원의 VIDE가 켜져 있고 ‘할 일·대화 기록을 사이트에 올리기’가 켜져 있으면 여기에 나타납니다."
          />
        ) : null}
      </aside>
      <section className="conversations-main">
        {thread ? (
          <MirrorThreadView thread={thread} highlight={highlight} />
        ) : selected ? (
          <p className="muted">불러오는 중…</p>
        ) : (
          <p className="muted">왼쪽에서 대화를 고르세요.</p>
        )}
        {status ? (
          <p className="status" role="status">
            {status}
          </p>
        ) : null}
      </section>
    </main>
  );
}

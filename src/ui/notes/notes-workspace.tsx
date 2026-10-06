import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { NOTE_KIND_LABEL, type NoteKind } from '../../contracts/note-doc';
import { NoteEditor, userColor } from './note-editor';
import './notes.css';

/**
 * 노트·일지 (SPEC-10, Design SCR-23): the list of a project's shared notes, 협의 사항 and daily
 * journal, and the open note's live editor. The same screen on the account site and in VIDE; each
 * passes its own backend (site API and socket, or the PC engine and its local stream).
 */
export interface NoteItem {
  id: string;
  title: string;
  kind: NoteKind;
  journalDate: string | null;
  updatedAt: number;
  updatedByName?: string | null;
  excerpt?: string;
}
export interface NoteLinkStatus {
  connected: boolean;
  synced: boolean;
  /** Edits made here that the site has not received yet (the PC's offline queue). */
  pending?: boolean;
  error?: string;
}
export interface NotesBackend {
  user: string;
  list(): Promise<{ notes: NoteItem[]; online: boolean }>;
  create(kind: 'note' | 'discussion'): Promise<NoteItem>;
  journal(date: string): Promise<NoteItem>;
  update(id: string, input: { title?: string; kind?: NoteKind }): Promise<NoteItem>;
  remove(id: string): Promise<void>;
  /** Connects `doc` to the note; returns the disconnect. */
  connect(
    id: string,
    doc: Y.Doc,
    awareness: Awareness,
    onStatus: (status: NoteLinkStatus) => void,
  ): () => void;
  /** VIDE only: the note's open check-list items → the project's 할 일. */
  toAgenda?(id: string): Promise<{ added: number; skipped: number }>;
  /** Where 할 일 sending happens when this screen cannot (the account site). */
  agendaHint?: string;
}
type Filter = 'all' | NoteKind;
const FILTERS: [Filter, string][] = [
  ['all', '전체'],
  ['note', '노트'],
  ['discussion', '협의 사항'],
  ['journal', '일지'],
];
const pad = (n: number) => String(n).padStart(2, '0');
export const todayLocal = (at = new Date()) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const ago = (at: number) => {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}시간 전`;
  const date = new Date(at);
  return `${date.getMonth() + 1}/${date.getDate()}`;
};
const errorText = (error: unknown) => {
  const code = (error as { code?: string; message?: string })?.code ?? (error as Error)?.message;
  return code === 'SITE_UNREACHABLE' || code === 'ACCOUNT_NOT_LINKED'
    ? '계정 사이트에 연결되지 않았습니다. 연결되면 다시 시도하세요.'
    : code === 'NOTE_OWNER_REQUIRED'
      ? '만든 사람이나 프로젝트 소유자만 지울 수 있습니다.'
      : code || '요청을 처리하지 못했습니다.';
};

function OpenNote({
  backend,
  note,
  onChanged,
  onRemoved,
}: {
  backend: NotesBackend;
  note: NoteItem;
  onChanged: (note: NoteItem) => void;
  onRemoved: () => void;
}) {
  const { doc, awareness } = useMemo(() => {
    const doc = new Y.Doc();
    return { doc, awareness: new Awareness(doc) };
  }, [note.id]);
  const [status, setStatus] = useState<NoteLinkStatus>({ connected: false, synced: false });
  const [people, setPeople] = useState<string[]>([]);
  const [title, setTitle] = useState(note.title);
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState(false);
  // The editor is made once the note's content is here (or after 2 s offline): an editor made on
  // an empty document would write its own empty first paragraph into the shared note.
  const [ready, setReady] = useState(false);
  useEffect(() => setTitle(note.title), [note.title]);
  useEffect(() => {
    const stop = backend.connect(note.id, doc, awareness, (next) => {
      setStatus(next);
      if (next.synced) setReady(true);
    });
    const fallback = setTimeout(() => setReady(true), 2000);
    const seen = () =>
      setPeople(
        [...awareness.getStates().entries()]
          .filter(([id, state]) => id !== doc.clientID && state.user?.name)
          .map(([, state]) => String(state.user.name)),
      );
    awareness.on('change', seen);
    return () => {
      awareness.off('change', seen);
      clearTimeout(fallback);
      stop();
    };
  }, [backend, note.id, doc, awareness]);
  const user = useMemo(
    () => ({ name: backend.user, color: userColor(backend.user) }),
    [backend.user],
  );
  async function save(input: { title?: string; kind?: NoteKind }) {
    try {
      onChanged(await backend.update(note.id, input));
    } catch (error) {
      setMessage(errorText(error));
    }
  }
  const state = status.error
    ? '열 수 없음'
    : status.synced
      ? status.pending
        ? '보내는 중…'
        : '실시간 연결됨'
      : status.pending
        ? '오프라인 — 연결되면 합쳐집니다'
        : status.connected
          ? '맞추는 중…'
          : '연결 중…';
  return (
    <section className="note-open" aria-label={note.title}>
      <header className="note-head">
        {note.kind === 'journal' ? (
          <h2 className="note-title-fixed">{note.title}</h2>
        ) : (
          <input
            className="note-title"
            aria-label="노트 제목"
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => title.trim() !== note.title && void save({ title: title.trim() })}
            onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          />
        )}
        <div className="note-meta">
          {note.kind === 'journal' ? (
            <span className="note-kind">일지</span>
          ) : (
            <select
              aria-label="종류"
              value={note.kind}
              onChange={(event) => void save({ kind: event.target.value as NoteKind })}
            >
              <option value="note">노트</option>
              <option value="discussion">협의 사항</option>
            </select>
          )}
          <span
            className={`note-status ${status.synced && !status.pending ? 'ok' : ''}`}
            role="status"
          >
            {state}
          </span>
          {people.length ? (
            <span className="note-people" title={people.join(', ')}>
              {people.slice(0, 3).join(', ')}
              {people.length > 3 ? ` 외 ${people.length - 3}` : ''} 함께 보는 중
            </span>
          ) : null}
          <span className="spacer" />
          {note.kind === 'discussion' ? (
            backend.toAgenda ? (
              <button
                type="button"
                className="note-action"
                onClick={async () => {
                  try {
                    const result = await backend.toAgenda!(note.id);
                    setMessage(
                      result.added
                        ? `할 일 ${result.added}개를 보냈습니다.${result.skipped ? ` 이미 있는 ${result.skipped}개는 건너뜀.` : ''}`
                        : result.skipped
                          ? '보낼 새 할 일이 없습니다(모두 이미 할 일에 있음).'
                          : '체크 목록(☐)에 적은 항목이 없습니다.',
                    );
                  } catch (error) {
                    setMessage(errorText(error));
                  }
                }}
              >
                할 일로 보내기
              </button>
            ) : backend.agendaHint ? (
              <span className="note-hint">{backend.agendaHint}</span>
            ) : null
          ) : null}
          {confirm ? (
            <button
              type="button"
              className="note-danger"
              onClick={async () => {
                try {
                  await backend.remove(note.id);
                  onRemoved();
                } catch (error) {
                  setConfirm(false);
                  setMessage(errorText(error));
                }
              }}
            >
              삭제 확인
            </button>
          ) : (
            <button type="button" className="note-quiet" onClick={() => setConfirm(true)}>
              삭제…
            </button>
          )}
        </div>
        {message ? (
          <p className="note-message" role="status">
            {message}
          </p>
        ) : null}
        {note.kind === 'discussion' ? (
          <p className="note-tip">
            협의할 일은 체크 목록(☐)으로 적으면 [할 일로 보내기]로 프로젝트 할 일에 넣을 수
            있습니다.
          </p>
        ) : null}
      </header>
      {ready ? (
        <NoteEditor key={note.id} doc={doc} awareness={awareness} user={user} />
      ) : (
        <p className="notes-empty">불러오는 중…</p>
      )}
    </section>
  );
}

export function NotesWorkspace({
  backend,
  initial,
  onOpen,
}: {
  backend: NotesBackend;
  initial?: string;
  onOpen?: (id: string) => void;
}) {
  const [notes, setNotes] = useState<NoteItem[] | null>(null);
  const [online, setOnline] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(initial ?? '');
  const [message, setMessage] = useState('');
  const refresh = useCallback(async () => {
    try {
      const value = await backend.list();
      setNotes(value.notes);
      setOnline(value.online);
    } catch (error) {
      setMessage(errorText(error));
    }
  }, [backend]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const open = (note: NoteItem) => {
    setNotes((all) => (all?.some((n) => n.id === note.id) ? all : [note, ...(all ?? [])]));
    setOpenId(note.id);
    onOpen?.(note.id);
  };
  const run = (task: () => Promise<NoteItem>) => async () => {
    try {
      setMessage('');
      open(await task());
    } catch (error) {
      setMessage(errorText(error));
    }
  };
  const words = query.trim().toLowerCase();
  const shown = (notes ?? [])
    .filter((note) => filter === 'all' || note.kind === filter)
    .filter(
      (note) =>
        !words ||
        note.title.toLowerCase().includes(words) ||
        (note.excerpt ?? '').toLowerCase().includes(words),
    )
    .sort((a, b) =>
      a.kind === 'journal' && b.kind === 'journal'
        ? (b.journalDate ?? '').localeCompare(a.journalDate ?? '')
        : b.updatedAt - a.updatedAt,
    );
  const current = notes?.find((note) => note.id === openId);
  return (
    <div className="notes-workspace">
      <aside className="notes-side" aria-label="노트 목록">
        <div className="notes-new">
          <button
            type="button"
            className="notes-today"
            onClick={run(() => backend.journal(todayLocal()))}
          >
            오늘 일지
          </button>
          <button type="button" onClick={run(() => backend.create('note'))}>
            새 노트
          </button>
          <button type="button" onClick={run(() => backend.create('discussion'))}>
            새 협의 사항
          </button>
        </div>
        <input
          className="notes-search"
          type="search"
          aria-label="노트 찾기"
          placeholder="노트 찾기"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="notes-filter" role="tablist" aria-label="종류">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              className={filter === value ? 'active' : ''}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {!online ? (
          <p className="notes-offline" role="status">
            계정 사이트에 연결되지 않아 마지막 사본을 보입니다.
          </p>
        ) : null}
        {message ? (
          <p className="notes-offline" role="alert">
            {message}
          </p>
        ) : null}
        <ul className="notes-list">
          {notes === null ? <li className="notes-empty">불러오는 중…</li> : null}
          {notes && !shown.length ? (
            <li className="notes-empty">
              {notes.length ? '맞는 노트가 없습니다.' : '아직 노트가 없습니다. 위에서 만드세요.'}
            </li>
          ) : null}
          {shown.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                className={note.id === openId ? 'selected' : ''}
                aria-current={note.id === openId}
                onClick={() => open(note)}
              >
                <span className="notes-row-head">
                  <strong>{note.title}</strong>
                  {note.kind !== 'note' ? (
                    <small className={`notes-kind ${note.kind}`}>
                      {NOTE_KIND_LABEL[note.kind]}
                    </small>
                  ) : null}
                </span>
                <small className="notes-row-meta">
                  {ago(note.updatedAt)}
                  {note.updatedByName ? ` · ${note.updatedByName}` : ''}
                  {note.excerpt ? ` · ${note.excerpt}` : ''}
                </small>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="notes-main">
        {current ? (
          <OpenNote
            key={current.id}
            backend={backend}
            note={current}
            onChanged={(changed) =>
              setNotes(
                (all) => all?.map((n) => (n.id === changed.id ? { ...n, ...changed } : n)) ?? all,
              )
            }
            onRemoved={() => {
              setOpenId('');
              void refresh();
            }}
          />
        ) : (
          <p className="notes-placeholder">
            왼쪽에서 노트를 고르거나 [오늘 일지]로 오늘의 작업 기록을 시작하세요. 프로젝트 구성원
            모두가 같은 노트를 동시에 고칠 수 있습니다.
          </p>
        )}
      </div>
    </div>
  );
}

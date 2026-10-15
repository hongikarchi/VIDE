import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import {
  meetingTitle,
  noteKindMark,
  noteTitle,
  SCHEDULE_KIND,
  seedMeeting,
  type NoteKind,
} from '../../contracts/note-doc';
import { NoteEditor, userColor } from './note-editor';
import './notes.css';

/**
 * 노트·일지 (SPEC-10, Design SCR-23): the list of a project's shared notes and the open note's
 * live editor. The same screen on the account site and in VIDE; each passes its own backend (site
 * API and socket, or the PC engine and its local stream). Every note looks the same here
 * (2026-10-06 사용자 결정 "노트로 통일"): no kind to pick or filter; a journal — the dated note
 * [퇴근하기] writes to — only carries a small '퇴근 기록' mark. A 회의록 ([새 회의록], SPEC-10.9 1)
 * is marked '회의록'; VIDE adds the project's '일정' row on top (SPEC-10.9 4) and the work folder
 * copies' '폴더에서 바뀜' with [버리기] (SPEC-10.10 3).
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
/** A work folder copy's state (VIDE): key `note:<id>` or `schedule:<YYYY-MM>`. */
export interface FolderCopy {
  key: string;
  state: 'written' | 'changed-in-folder' | 'not-written';
  path?: string | null;
}
export interface NotesBackend {
  user: string;
  list(): Promise<{ notes: NoteItem[]; online: boolean }>;
  /** A new note; `meeting` is a 회의록 ([새 회의록]). */
  create(input?: { kind?: 'note' | 'meeting'; title?: string }): Promise<NoteItem>;
  update(id: string, input: { title?: string }): Promise<NoteItem>;
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
  /** VIDE only: the work folder copies (none: no work folder). */
  folderCopies?(): Promise<FolderCopy[]>;
  /** VIDE only: [버리기] — the folder copy written again from its source. */
  discardCopy?(key: string): Promise<void>;
  /** VIDE only: the 일정 view (the dashboard's month calendar); absent, no 일정 row. */
  schedule?: () => ReactNode;
}
/** This screen's local date, 'YYYY-MM-DD' (a meeting's 날짜 절). */
const localToday = () => {
  const at = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
};
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

/**
 * '폴더에서 바뀜' (SPEC-10.10 3, Design SCR-23): one warning line with [버리기] (one confirm), or
 * '폴더에 아직 안 씀' (SPEC-10.10 4). Nothing when the copy is as written.
 */
function FolderNotice({
  copy,
  what,
  onDiscard,
}: {
  copy?: FolderCopy;
  what: string;
  onDiscard: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!copy || copy.state === 'written') return null;
  if (copy.state === 'not-written')
    return (
      <p className="note-folder" role="status">
        폴더에 아직 안 씀 — 작업 폴더에 쓰지 못했습니다. 다음에 다시 씁니다.
      </p>
    );
  return (
    <div className="note-folder changed" role="status">
      <span className="note-folder-text">
        폴더의 사본이 이 {what}
        {what === '일정' ? '과' : '와'} 다릅니다. 폴더에서 고친 글은 여기로 들어오지 않습니다.
        {error ? ` ${error}` : ''}
      </span>
      {confirm ? (
        <>
          <span className="note-folder-ask">폴더 사본을 이 {what} 내용으로 다시 씁니다</span>
          <button
            type="button"
            className="note-danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onDiscard();
                setConfirm(false);
              } catch (failure) {
                setError(errorText(failure));
              } finally {
                setBusy(false);
              }
            }}
          >
            버리기
          </button>
          <button type="button" className="note-quiet" onClick={() => setConfirm(false)}>
            취소
          </button>
        </>
      ) : (
        <button type="button" className="note-action" onClick={() => setConfirm(true)}>
          버리기
        </button>
      )}
    </div>
  );
}

function OpenNote({
  backend,
  note,
  seed,
  folder,
  onDiscard,
  onChanged,
  onRemoved,
}: {
  backend: NotesBackend;
  note: NoteItem;
  /** A 회의록 this screen just made: its template goes in once, with this date (SPEC-10.9 1). */
  seed?: string;
  folder?: FolderCopy;
  onDiscard: () => Promise<void>;
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
  // Only the screen that made the 회의록 fills its template, once the server's content is here,
  // so two screens never both put it in.
  const seeded = useRef(false);
  useEffect(() => {
    const begin = () => {
      if (seed && !seeded.current) {
        seeded.current = true;
        seedMeeting(doc, seed);
      }
      setReady(true);
    };
    const stop = backend.connect(note.id, doc, awareness, (next) => {
      setStatus(next);
      if (next.synced) begin();
    });
    const fallback = setTimeout(begin, 2000);
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
  }, [backend, note.id, doc, awareness, seed]);
  const user = useMemo(
    () => ({ name: backend.user, color: userColor(backend.user) }),
    [backend.user],
  );
  async function save(input: { title?: string }) {
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
    <section className="note-open" aria-label={noteTitle(note)}>
      <header className="note-head">
        <input
          className="note-title"
          aria-label="노트 제목"
          placeholder={noteTitle({ ...note, title: '' })}
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => title.trim() !== note.title && void save({ title: title.trim() })}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        />
        <div className="note-meta">
          {noteKindMark(note.kind) ? (
            <span className="note-kind">{noteKindMark(note.kind)}</span>
          ) : null}
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
          {backend.toAgenda ? (
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
        <FolderNotice copy={folder} what="노트" onDiscard={onDiscard} />
        {message ? (
          <p className="note-message" role="status">
            {message}
          </p>
        ) : null}
        <p className="note-tip">
          할 일은 체크 목록(☐)으로 적으면 [할 일로 보내기]로 프로젝트 할 일에 넣을 수 있습니다.
        </p>
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
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(initial ?? '');
  const [message, setMessage] = useState('');
  const [copies, setCopies] = useState<Map<string, FolderCopy>>(new Map());
  const [seed, setSeed] = useState<{ id: string; date: string } | undefined>();
  const readCopies = useCallback(async () => {
    if (!backend.folderCopies) return;
    // No work folder (or no reply): no folder marks.
    const rows = await backend.folderCopies().catch(() => [] as FolderCopy[]);
    setCopies(new Map(rows.map((row) => [row.key, row])));
  }, [backend]);
  const refresh = useCallback(async () => {
    try {
      const value = await backend.list();
      setNotes(value.notes);
      setOnline(value.online);
    } catch (error) {
      setMessage(errorText(error));
    }
    await readCopies();
  }, [backend, readCopies]);
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
  const create = async (kind: 'note' | 'meeting' = 'note') => {
    try {
      setMessage('');
      if (kind === 'note') return open(await backend.create());
      const date = localToday();
      const note = await backend.create({ kind, title: meetingTitle(date) });
      setSeed({ id: note.id, date });
      open(note);
    } catch (error) {
      setMessage(errorText(error));
    }
  };
  const discard = async (keys: string[]) => {
    for (const key of keys) await backend.discardCopy?.(key);
    await readCopies();
  };
  /** The 일정 row's copies: every month whose copy is not as written. */
  const scheduleCopies = [...copies.values()].filter(
    (copy) => copy.key.startsWith('schedule:') && copy.state !== 'written',
  );
  const scheduleCopy =
    scheduleCopies.find((copy) => copy.state === 'changed-in-folder') ?? scheduleCopies[0];
  const folderMark = (copy?: FolderCopy) =>
    copy?.state === 'changed-in-folder' ? (
      <small className="notes-folder changed">폴더에서 바뀜</small>
    ) : copy?.state === 'not-written' ? (
      <small className="notes-folder">폴더에 아직 안 씀</small>
    ) : null;
  const words = query.trim().toLowerCase();
  const shown = (notes ?? [])
    .filter(
      (note) =>
        !words ||
        noteTitle(note).toLowerCase().includes(words) ||
        (note.excerpt ?? '').toLowerCase().includes(words),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const current = notes?.find((note) => note.id === openId);
  return (
    <div className="notes-workspace">
      <aside className="notes-side" aria-label="노트 목록">
        <div className="notes-new">
          <button type="button" className="notes-create" onClick={() => void create()}>
            새 노트
          </button>
          <button
            type="button"
            className="notes-create-meeting"
            onClick={() => void create('meeting')}
          >
            새 회의록
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
          {backend.schedule ? (
            <li className="notes-pinned">
              <button
                type="button"
                className={openId === SCHEDULE_KIND ? 'selected' : ''}
                aria-current={openId === SCHEDULE_KIND}
                onClick={() => {
                  setOpenId(SCHEDULE_KIND);
                  onOpen?.(SCHEDULE_KIND);
                }}
              >
                <span className="notes-row-head">
                  <strong>프로젝트 일정</strong>
                  <small className="notes-kind">일정</small>
                  {folderMark(scheduleCopy)}
                </span>
                <small className="notes-row-meta">할 일·일정 항목을 달마다 봅니다</small>
              </button>
            </li>
          ) : null}
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
                  <strong className={note.title.trim() ? '' : 'untitled'}>{noteTitle(note)}</strong>
                  {noteKindMark(note.kind) ? (
                    <small className="notes-kind">{noteKindMark(note.kind)}</small>
                  ) : null}
                  {folderMark(copies.get(`note:${note.id}`))}
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
        {openId === SCHEDULE_KIND && backend.schedule ? (
          <div className="notes-schedule-wrap">
            <FolderNotice
              copy={scheduleCopy}
              what="일정"
              onDiscard={() => discard(scheduleCopies.map((copy) => copy.key))}
            />
            {backend.schedule()}
          </div>
        ) : current ? (
          <OpenNote
            key={current.id}
            backend={backend}
            note={current}
            seed={seed?.id === current.id ? seed.date : undefined}
            folder={copies.get(`note:${current.id}`)}
            onDiscard={() => discard([`note:${current.id}`])}
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
            왼쪽에서 노트를 고르거나 [새 노트]·[새 회의록]으로 시작하세요. 프로젝트 구성원 모두가
            같은 노트를 동시에 고칠 수 있습니다.
          </p>
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { ApiError, api, message } from './api';

// PLAN-33: the project's 할 일 (read and written here; the PC applies the changes when it is on)
// and a read-only summary of its work history, as the PC last shared them (SPEC-04.10).
const agendaSchema = z.object({
  sharedAt: z.number().nullable(),
  pending: z.number(),
  items: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      date: z.string().nullable(),
      time: z.string().nullable(),
      kind: z.enum(['task', 'meeting', 'deadline']),
      done: z.boolean(),
      revision: z.number(),
      pending: z.boolean(),
    }),
  ),
});
type AgendaItem = z.infer<typeof agendaSchema>['items'][number];
const historySchema = z.object({
  sharedAt: z.number().nullable(),
  items: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      answer: z.string().nullable(),
      state: z.string(),
      files: z.array(z.string()),
      createdAt: z.string(),
    }),
  ),
});

const when = (time: number | string) =>
  new Date(time).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const KIND: Record<AgendaItem['kind'], string> = { task: '', meeting: '회의', deadline: '마감' };
const STATE: Record<string, string> = {
  succeeded: '완료',
  failed: '실패',
  cancelled: '취소',
  interrupted: '중단',
  running: '진행 중',
  queued: '대기',
};

export function OfflineAgenda({ projectId }: { projectId: string }) {
  const [data, setData] = useState<z.infer<typeof agendaSchema> | null>(null),
    [text, setText] = useState(''),
    [date, setDate] = useState(''),
    [editing, setEditing] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setData(agendaSchema.parse(await api(`/projects/${projectId}/agenda`)));
  }, [projectId]);
  useEffect(() => {
    void refresh().catch((error) => setStatus(message(error)));
    const timer = setInterval(() => void refresh().catch(() => {}), 20_000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function change(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setStatus('');
    try {
      await work();
    } catch (error) {
      setStatus(message(error));
    } finally {
      await refresh().catch(() => {});
      setBusy(false);
    }
  }
  const edit = (item: AgendaItem, fields: Partial<AgendaItem>) => {
    // Shown at once; the answer below then brings the list as the site keeps it.
    setData(
      (current) =>
        current && {
          ...current,
          items: current.items.map((row) =>
            row.id === item.id ? { ...row, ...fields, pending: true } : row,
          ),
        },
    );
    return change(() =>
      api(`/projects/${projectId}/agenda/${encodeURIComponent(item.id)}`, 'PATCH', {
        ...fields,
        ...(item.revision ? { revision: item.revision } : {}),
      }),
    );
  };
  const shared = !!data?.sharedAt;
  return (
    <section className="offline-section offline-agenda" aria-label="할 일">
      <div className="offline-section-head">
        <h2>할 일</h2>
        {data?.sharedAt ? (
          <small className="muted">
            PC 기준 {when(data.sharedAt)}
            {data.pending ? ` · PC 반영 대기 ${data.pending}` : ''}
          </small>
        ) : null}
      </div>
      {data && !shared ? (
        <p className="muted">
          작업 PC가 아직 할 일을 올리지 않았습니다. PC의 VIDE를 업데이트하고 켜면 여기에 나타나고,
          그 뒤에는 PC가 꺼져 있어도 여기서 고칠 수 있습니다.
        </p>
      ) : null}
      {shared ? (
        <form
          className="offline-agenda-add"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim()) return;
            void change(async () => {
              await api(`/projects/${projectId}/agenda`, 'POST', {
                text: text.trim(),
                ...(date ? { date } : {}),
              });
              setText('');
              setDate('');
            });
          }}
        >
          <input
            aria-label="새 할 일"
            placeholder="할 일 추가"
            maxLength={500}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <input
            type="date"
            aria-label="새 할 일 날짜"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <button className="primary" disabled={busy || !text.trim()}>
            추가
          </button>
        </form>
      ) : null}
      <ul className="offline-agenda-list">
        {data?.items.map((item) => (
          <li key={item.id} data-done={String(item.done)}>
            <input
              type="checkbox"
              aria-label={`${item.text} 완료`}
              checked={item.done}
              disabled={busy}
              onChange={(event) => void edit(item, { done: event.target.checked })}
            />
            {editing === item.id ? (
              <input
                autoFocus
                aria-label="할 일 내용"
                defaultValue={item.text}
                maxLength={500}
                onBlur={(event) => {
                  setEditing('');
                  const value = event.target.value.trim();
                  if (value && value !== item.text) void edit(item, { text: value });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') setEditing('');
                }}
              />
            ) : (
              <button
                className="offline-agenda-text"
                title="눌러서 고치기"
                onClick={() => setEditing(item.id)}
              >
                {KIND[item.kind] ? <span className="badge">{KIND[item.kind]}</span> : null}
                {item.text}
              </button>
            )}
            <input
              type="date"
              aria-label={`${item.text} 날짜`}
              value={item.date ?? ''}
              disabled={busy}
              onChange={(event) => void edit(item, { date: event.target.value || null })}
            />
            {item.time ? <small className="muted">{item.time}</small> : null}
            {item.pending ? <small className="offline-pending">PC 반영 대기</small> : null}
            <button
              className="ghost"
              aria-label={`${item.text} 삭제`}
              disabled={busy}
              onClick={() =>
                void change(() =>
                  api(`/projects/${projectId}/agenda/${encodeURIComponent(item.id)}`, 'DELETE'),
                )
              }
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {shared && data?.items.length === 0 ? <p className="muted">할 일이 없습니다.</p> : null}
      {status ? (
        <p className="status" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}

export function OfflineHistory({
  projectId,
  openConversations,
}: {
  projectId: string;
  /** The full text of the hostless conversations (PLAN-36), on its own page. */
  openConversations?: () => void;
}) {
  const [data, setData] = useState<z.infer<typeof historySchema> | null>(null),
    [status, setStatus] = useState('');
  useEffect(() => {
    void api(`/projects/${projectId}/history`)
      .then((value) => setData(historySchema.parse(value)))
      .catch((error) =>
        setStatus(error instanceof ApiError ? error.message : '이력을 불러오지 못했습니다.'),
      );
  }, [projectId]);
  return (
    <section className="offline-section offline-history" aria-label="작업 이력">
      <div className="offline-section-head">
        <h2>작업 이력</h2>
        {data?.sharedAt ? (
          <small className="muted">요약 · PC 기준 {when(data.sharedAt)} · 보기 전용</small>
        ) : null}
        {openConversations ? (
          <button className="ghost" onClick={openConversations}>
            대화 기록 전문
          </button>
        ) : null}
      </div>
      {data && !data.sharedAt ? (
        <p className="muted">작업 PC가 아직 작업 이력 요약을 올리지 않았습니다.</p>
      ) : null}
      {data?.sharedAt && !data.items.length ? <p className="muted">작업 이력이 없습니다.</p> : null}
      <ol className="offline-history-list">
        {data?.items.map((item) => (
          <li key={item.id} data-state={item.state}>
            <strong>{item.body || '(글 없는 요청)'}</strong>
            {item.answer ? <p>{item.answer}</p> : null}
            <small className="muted">
              {STATE[item.state] ?? item.state} · {when(item.createdAt)}
              {item.files.length ? ` · ${item.files.join(', ')}` : ''}
            </small>
          </li>
        ))}
      </ol>
      {status ? <p className="status">{status}</p> : null}
    </section>
  );
}

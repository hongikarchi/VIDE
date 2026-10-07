// 대시보드 › 할 일 › 자료에서 찾은 할 일·일정 (SPEC-01.14 11, Design SCR-20, PLAN-42 T-196): what
// 자료 정리 proposed from minutes, schedules and mail. Nothing is on the agenda until the person
// picks it: each row is chosen (and may be edited) and [고른 것 추가] adds the chosen ones through the
// normal agenda add (source 'ai'); [버리기] dismisses them for good. 근거 opens the statement.
import { useCallback, useEffect, useState } from 'react';
import { api } from './gateway.ts';
import { AGENDA_CHANGED } from './agenda-text.ts';
import { KNOWLEDGE_COLLECTED } from './knowledge-collect.tsx';
import './knowledge-collect.css';

type Kind = 'task' | 'meeting' | 'receipt' | 'deadline';
interface Proposal {
  id: number;
  text: string;
  kind: Kind;
  date: string;
  time: string | null;
  endDate: string | null;
  endTime: string | null;
  location: string | null;
  attendees: string | null;
  evidence: { id: number; content: string; path: string }[];
}
type Edit = Pick<Proposal, 'text' | 'kind' | 'date' | 'time'>;

const KINDS: Record<Kind, string> = {
  task: '할 일',
  meeting: '협의',
  receipt: '접수',
  deadline: '마감',
};
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const dayLabel = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return `${m}/${d}(${DAYS[new Date(y, m - 1, d).getDay()]})`;
};

export function AgendaProposals({ projectId }: { projectId: string }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<Record<number, Edit>>({});
  const [editing, setEditing] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const base = `/projects/${encodeURIComponent(projectId)}/agenda-proposals`;

  const load = useCallback(
    () =>
      api(base)
        .then((value) => setProposals((value as { proposals: Proposal[] }).proposals))
        .catch(() => {}),
    [base],
  );
  useEffect(() => {
    void load();
    const again = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === projectId) void load();
    };
    addEventListener(KNOWLEDGE_COLLECTED, again);
    addEventListener('focus', again);
    return () => {
      removeEventListener(KNOWLEDGE_COLLECTED, again);
      removeEventListener('focus', again);
    };
  }, [load, projectId]);

  const decided = (next: Proposal[]) => {
    setProposals(next);
    setChosen(new Set());
    setEditing(undefined);
  };
  const add = async () => {
    setBusy(true);
    setReason('');
    try {
      const items = [...chosen].map((id) => ({ id, ...edits[id] }));
      const result = (await api(`${base}/add`, 'POST', { items })) as {
        added: number;
        proposals: Proposal[];
      };
      decided(result.proposals);
      dispatchEvent(new CustomEvent(AGENDA_CHANGED));
    } catch (error) {
      setReason((error as Error).message || '더하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    setBusy(true);
    setReason('');
    try {
      const result = (await api(`${base}/dismiss`, 'POST', { ids: [...chosen] })) as {
        proposals: Proposal[];
      };
      decided(result.proposals);
    } catch (error) {
      setReason((error as Error).message || '버리지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: number) =>
    setChosen((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const evidence = (statementId: number) =>
    void import('./jig-panel/basis-parts.tsx').then((parts) =>
      parts.openFactWindow(projectId, statementId),
    );

  if (!proposals.length) return null;
  const row = (p: Proposal) => {
    const value = { ...p, ...edits[p.id] };
    const edit = edits[p.id] ?? { text: p.text, kind: p.kind, date: p.date, time: p.time };
    const set = (change: Partial<Edit>) =>
      setEdits((now) => ({ ...now, [p.id]: { ...edit, ...change } }));
    return (
      <li key={p.id} data-chosen={chosen.has(p.id) ? '' : undefined}>
        <input
          type="checkbox"
          aria-label={`${value.text} 고르기`}
          checked={chosen.has(p.id)}
          onChange={() => toggle(p.id)}
        />
        {editing === p.id ? (
          <span className="dash-proposal-edit">
            <input
              aria-label="내용"
              value={edit.text}
              onChange={(event) => set({ text: event.target.value })}
            />
            <select
              aria-label="종류"
              value={edit.kind}
              onChange={(event) => set({ kind: event.target.value as Kind })}
            >
              {Object.entries(KINDS).map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
            <input
              type="date"
              aria-label="날짜"
              value={edit.date}
              onChange={(event) => event.target.value && set({ date: event.target.value })}
            />
            <input
              type="time"
              aria-label="시각"
              step={900}
              value={edit.time ?? ''}
              onChange={(event) => set({ time: event.target.value || null })}
            />
            <button type="button" className="link-button" onClick={() => setEditing(undefined)}>
              닫기
            </button>
          </span>
        ) : (
          <span className="dash-proposal-body">
            <span className="dash-proposal-when">
              {dayLabel(value.date)}
              {value.time ? ` ${value.time}${value.endTime ? `~${value.endTime}` : ''}` : ''}
            </span>
            {value.kind !== 'task' ? (
              <span className="dash-proposal-kind">{KINDS[value.kind]}</span>
            ) : null}
            <span className="dash-proposal-text">{value.text}</span>
            {value.location ? <span className="dash-proposal-meta">{value.location}</span> : null}
            {p.evidence.length ? (
              <button
                type="button"
                className="link-button dash-proposal-meta"
                title={p.evidence.map((e) => e.content).join('\n')}
                onClick={() => evidence(p.evidence[0].id)}
              >
                근거
              </button>
            ) : null}
            <button
              type="button"
              className="link-button dash-proposal-meta"
              aria-label={`${value.text} 고치기`}
              onClick={() => setEditing(p.id)}
            >
              고치기
            </button>
          </span>
        )}
      </li>
    );
  };
  return (
    <div className="dash-proposals" role="group" aria-label="자료에서 찾은 할 일·일정">
      <button
        type="button"
        className="link-button dash-proposals-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        자료에서 찾은 할 일·일정 {proposals.length}건
      </button>
      {open ? (
        <>
          <ul className="dash-proposal-list" aria-label="찾은 할 일·일정">
            {proposals.map(row)}
          </ul>
          <div className="dash-proposal-actions">
            <button type="button" disabled={busy || !chosen.size} onClick={() => void add()}>
              고른 것 추가
            </button>
            <button type="button" disabled={busy || !chosen.size} onClick={() => void dismiss()}>
              버리기
            </button>
          </div>
          {reason ? (
            <p className="dash-folder-reason" role="alert">
              {reason}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

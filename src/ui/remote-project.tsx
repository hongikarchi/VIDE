import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { api } from './gateway.ts';
import { Markdown } from './kit/markdown.tsx';
import { SharedHistory } from './shared-history.tsx';
import { Avatar } from './shell/avatar.tsx';
import { authorLine } from '../contracts/account-avatar.ts';
import './remote-project.css';

// A shared project opened on this PC as a remote project (SPEC-04.11 3, Design SCR-24): the
// project runs on another member's PC, so the page shows what the account site has (할 일, the
// work history summary, notes, saved models, knowledge counts) and the project's AI instructions,
// which any member edits. No model, Sync, composer or host action.

export interface ProjectChoice {
  id: string;
  name: string;
  ownerName?: string | null;
  hostOnline?: boolean;
}
const projectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    ownerName: z.string().nullable(),
    hostName: z.string().nullable(),
    hostOnline: z.boolean(),
  })
  .passthrough();
const instructionsSchema = z
  .object({
    text: z.string(),
    revision: z.number().optional(),
    shared: z.enum(['unlinked', 'synced', 'pending']).optional(),
    updatedByName: z.string().nullable().optional(),
    conflict: z
      .object({ text: z.string(), updatedByName: z.string().nullable() })
      .nullable()
      .optional(),
  })
  .passthrough();
const agendaSchema = z.object({
  items: z.array(
    z
      .object({
        id: z.string(),
        text: z.string(),
        date: z.string().nullable(),
        done: z.boolean(),
        pending: z.boolean().optional(),
        // The author and last editor (SPEC-01.14 12); none from an older site or earlier items.
        createdBy: z
          .object({ id: z.string().nullable(), name: z.string() })
          .nullable()
          .optional()
          .catch(null),
        updatedBy: z
          .object({ id: z.string().nullable(), name: z.string() })
          .nullable()
          .optional()
          .catch(null),
      })
      .passthrough(),
  ),
});
const historySchema = z.object({
  items: z.array(
    z
      .object({
        id: z.string(),
        body: z.string(),
        answer: z.string().nullable(),
        state: z.string(),
        createdAt: z.string(),
      })
      .passthrough(),
  ),
});
const notesSchema = z.object({
  notes: z.array(z.object({ id: z.string(), title: z.string(), kind: z.string() }).passthrough()),
});
const snapshotsSchema = z.object({
  snapshots: z.array(
    z.object({ linkId: z.string(), name: z.string(), objectCount: z.number() }).passthrough(),
  ),
});
const knowledgeSchema = z.object({
  revision: z.number(),
  builtAt: z.string().nullable(),
  counts: z.record(z.string(), z.number()),
});
const viewSchema = z.object({
  project: projectSchema,
  online: z.boolean(),
  agenda: z.unknown().nullable(),
  history: z.unknown().nullable(),
  notes: z.unknown().nullable(),
  snapshots: z.unknown().nullable(),
  knowledge: z.unknown().nullable(),
  instructions: instructionsSchema,
  site: z.string().nullable(),
});
type View = z.infer<typeof viewSchema>;
const parse = <T,>(schema: z.ZodType<T>, value: unknown): T | null => {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
};
const STATE: Record<string, string> = {
  succeeded: '완료',
  failed: '실패',
  cancelled: '취소',
  interrupted: '중단',
  running: '진행 중',
  queued: '대기',
};
const INSTRUCTIONS_MAX_BYTES = 8 * 1024;

function Instructions({
  projectId,
  initial,
}: {
  projectId: string;
  initial: View['instructions'];
}) {
  const [row, setRow] = useState(initial);
  const [text, setText] = useState(initial.text);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const size = new TextEncoder().encode(text).length;
  const save = async () => {
    setBusy(true);
    try {
      const next = instructionsSchema.parse(
        await api(`/shared-projects/${encodeURIComponent(projectId)}/instructions`, 'PUT', {
          text,
        }),
      );
      setRow(next);
      setText(next.text);
      setMessage(
        next.shared === 'pending'
          ? '이 PC에 저장했습니다. 사이트에 연결되면 보냅니다.'
          : '저장했습니다. 프로젝트를 돌리는 PC가 다음 연결 때 받습니다.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '저장하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="remote-section" aria-label="AI 지시">
      <h2>AI 지시</h2>
      <p className="remote-muted">
        이 프로젝트의 AI 요청마다 함께 보내는 참고 사항입니다. 구성원 누구나 고칠 수 있습니다.
      </p>
      {row.conflict ? (
        <div className="remote-conflict" role="status">
          다른 구성원의 수정과 겹쳤습니다. 더 나중에 고친 지시가 남았습니다.
          <pre>{row.conflict.text}</pre>
        </div>
      ) : null}
      <textarea
        aria-label="프로젝트 AI 지시"
        rows={6}
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="remote-row">
        <small className="remote-muted">
          {size.toLocaleString()} / {INSTRUCTIONS_MAX_BYTES.toLocaleString()} 바이트
          {row.shared === 'pending'
            ? ' · 사이트 반영 대기'
            : row.updatedByName
              ? ` · 마지막 수정 ${row.updatedByName}`
              : ''}
        </small>
        <button
          type="button"
          disabled={busy || size > INSTRUCTIONS_MAX_BYTES || text === row.text}
          onClick={() => void save()}
        >
          지침 저장
        </button>
      </div>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

function RemoteProject({
  projectId,
  choices,
  shared,
}: {
  projectId: string;
  choices: ProjectChoice[];
  shared: ProjectChoice[];
}) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api(`/shared-projects/${encodeURIComponent(projectId)}`)
      .then((value) => live && setView(viewSchema.parse(value)))
      .catch((cause: unknown) => {
        if (live)
          setError(cause instanceof Error ? cause.message : '공유받은 프로젝트를 열지 못했습니다.');
      });
    return () => {
      live = false;
    };
  }, [projectId]);
  const project = view?.project;
  const agenda = parse(agendaSchema, view?.agenda);
  const history = parse(historySchema, view?.history);
  const notes = parse(notesSchema, view?.notes);
  const snapshots = parse(snapshotsSchema, view?.snapshots);
  const knowledge = parse(knowledgeSchema, view?.knowledge);
  const owner = project?.ownerName ?? '다른 구성원';
  return (
    <div className="remote-project" role="main" aria-label="원격 프로젝트">
      <header className="remote-head">
        <select
          id="remote-project-picker"
          aria-label="프로젝트"
          value={projectId}
          onChange={(event) => {
            location.search = '?project=' + encodeURIComponent(event.target.value);
          }}
        >
          {choices.length ? (
            <optgroup label="이 PC의 프로젝트">
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label="공유받은 프로젝트">
            {shared.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name}
                {choice.ownerName ? ` · ${choice.ownerName}` : ''}
                {choice.hostOnline === false ? ' (PC 꺼짐)' : ''}
              </option>
            ))}
          </optgroup>
        </select>
        {view?.site ? (
          <a href={view.site} target="_blank" rel="noreferrer">
            사이트에서 열기
          </a>
        ) : null}
      </header>
      <p className="remote-banner" role="status">
        이 프로젝트는 {owner}의 PC{project?.hostName ? `(${project.hostName})` : ''}에서 돌아갑니다.
        모델·Sync·AI 작업은 그 PC에서만 할 수 있고, 여기서는 사이트에 올라간 자료를 봅니다.
        {project && !project.hostOnline ? ' 지금 그 PC는 꺼져 있습니다.' : ''}
      </p>
      {error ? <p className="remote-error">{error}</p> : null}
      {view && !view.online ? (
        <p className="remote-muted">사이트에 연결하지 못해 마지막으로 받은 내용을 보입니다.</p>
      ) : null}
      {view ? (
        <div className="remote-body">
          <div className="remote-column">
            <section className="remote-section" aria-label="할 일">
              <h2>할 일</h2>
              {agenda?.items.length ? (
                <ul className="remote-list">
                  {agenda.items.map((item) => (
                    <li key={item.id} className={item.done ? 'done' : undefined}>
                      <span>{item.done ? '☑' : '☐'}</span> {item.text}
                      {item.date ? <small> · {item.date}</small> : null}
                      {item.pending ? <small> · PC 반영 대기</small> : null}
                      {item.createdBy ? (
                        <>
                          {' '}
                          <Avatar
                            name={item.createdBy.name}
                            id={item.createdBy.id}
                            size={16}
                            title={authorLine(item.createdBy, item.updatedBy)}
                          />
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="remote-muted">사이트에 올라간 할 일이 없습니다.</p>
              )}
            </section>
            <section className="remote-section" aria-label="작업 이력 요약">
              <h2>작업 이력 요약</h2>
              {history?.items.length ? (
                <ul className="remote-list">
                  {history.items.slice(0, 30).map((item) => (
                    <li key={item.id}>
                      <strong>{item.body}</strong>
                      <small>
                        {' '}
                        · {STATE[item.state] ?? item.state} ·{' '}
                        {item.createdAt.slice(0, 16).replace('T', ' ')}
                      </small>
                      {item.answer ? (
                        <Markdown className="remote-muted" text={item.answer} />
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="remote-muted">사이트에 올라간 작업 이력이 없습니다.</p>
              )}
            </section>
            {/* Members' shared conversations (PLAN-36, SPEC-04.12), read-only; hidden when none. */}
            <SharedHistory projectId={projectId} />
          </div>
          <div className="remote-column">
            <Instructions projectId={projectId} initial={view.instructions} />
            <section className="remote-section" aria-label="노트">
              <h2>노트·일지</h2>
              {notes?.notes.length ? (
                <ul className="remote-list">
                  {notes.notes.slice(0, 6).map((note) => (
                    <li key={note.id}>
                      {note.title.trim() || '제목 없음'}
                      {/* One kind on screen (SPEC-10.2): only a journal is marked. */}
                      {note.kind === 'journal' ? <small> · 퇴근 기록</small> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="remote-muted">노트가 없습니다.</p>
              )}
            </section>
            <section className="remote-section" aria-label="저장된 모델">
              <h2>저장된 모델</h2>
              {snapshots?.snapshots.length ? (
                <ul className="remote-list">
                  {snapshots.snapshots.map((item) => (
                    <li key={item.linkId}>
                      {item.name} <small>· 객체 {item.objectCount.toLocaleString()}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="remote-muted">저장된 모델이 없습니다. 모델은 사이트에서 봅니다.</p>
              )}
            </section>
            <section className="remote-section" aria-label="정리된 자료">
              <h2>정리된 자료</h2>
              {knowledge?.revision ? (
                <p>
                  파일 {(knowledge.counts.files ?? 0).toLocaleString()} · 발췌{' '}
                  {(knowledge.counts.excerpts ?? 0).toLocaleString()}
                  {knowledge.builtAt ? <small> · {knowledge.builtAt.slice(0, 10)}</small> : null}
                </p>
              ) : (
                <p className="remote-muted">올라간 자료 없음</p>
              )}
            </section>
          </div>
        </div>
      ) : error ? null : (
        <p className="remote-muted">불러오는 중…</p>
      )}
    </div>
  );
}

/** Shows the remote project page over the work screen (the work screen stays unloaded). */
export function mountRemoteProject(
  projectId: string,
  choices: ProjectChoice[],
  shared: ProjectChoice[],
) {
  const element = document.createElement('div');
  element.id = 'remote-project';
  document.body.appendChild(element);
  document.body.classList.add('remote-project-open');
  createRoot(element).render(
    <RemoteProject projectId={projectId} choices={choices} shared={shared} />,
  );
}

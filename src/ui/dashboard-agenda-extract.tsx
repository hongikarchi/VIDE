// 대시보드 › 할 일 › 글·파일에서 할 일 만들기 (SPEC-01.14 9, Design SCR-20, PLAN-30 T-136): notes,
// minutes or an e-mail pasted or typed, and files dropped, pasted or picked, go as one hostless
// Auto turn of the project's 기본 대화. Its AI adds the 할 일, 회의 and 마감 it finds (agenda_add)
// straight away — no preview to choose from (ADR-031). The panel follows that request: the count
// added so far (the list is read again on every new write), then 'n개를 더했습니다' with one
// [되돌리기] for all of the turn's writes (`agenda/undo {ledgerIds}`). Files are kept as the
// composer keeps attachments (SPEC-01.12).
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { api } from './gateway.ts';
import { uploadAttachments } from './attachments.ts';
import { AGENDA_CHANGED, dashboardAgendaRequests, extractionBody } from './agenda-text.ts';

type Phase =
  | { state: 'edit' }
  | { state: 'running'; added: number }
  | {
      state: 'done';
      added: number;
      conversationId: string;
      ledgerIds: string[];
      reply?: string;
    }
  | { state: 'undone' }
  | { state: 'failed'; reason: string };

interface LedgerEntry {
  id: string;
  requestId?: string | null;
  supersededBy?: string | null;
  body?: { appAction?: unknown; by?: unknown; changes?: { op?: unknown }[] } | null;
}
const POLL_MS = 1200;
const ENDED = ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown', 'needs-confirmation'];
const reasons: Record<string, string> = {
  NETWORK_UNAVAILABLE: '엔진에 닿지 못했습니다.',
  CONVERSATION_CLOSED: '기본 대화가 닫혀 있습니다.',
  EXECUTOR_NOT_READY: 'AI 실행기가 준비되지 않았습니다.',
};
const failure = (error: unknown) => {
  const code = (error as { code?: string }).code ?? '';
  return reasons[code] ?? ((error as Error).message || '보내지 못했습니다.');
};
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The AI's 할 일 writes of one request, in the order made, and how many items they added. */
function writesOf(ledger: readonly LedgerEntry[], requestId: string) {
  const writes = ledger.filter(
    (item) =>
      item.requestId === requestId && item.body?.appAction === 'agenda' && item.body.by === 'ai',
  );
  const added = writes.reduce(
    (sum, item) => sum + (item.body?.changes ?? []).filter((change) => change?.op === 'add').length,
    0,
  );
  return { ledgerIds: writes.map((item) => item.id), added };
}

export function AgendaFromText({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [phase, setPhase] = useState<Phase>({ state: 'edit' });
  const picker = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const project = `/projects/${encodeURIComponent(projectId)}`;

  const addFiles = (list: FileList | File[] | null | undefined) => {
    const next = [...(list ?? [])];
    if (next.length) setFiles((now) => [...now, ...next]);
  };
  const close = () => {
    setOpen(false);
    setPhase({ state: 'edit' });
  };
  const reset = () => {
    setText('');
    setFiles([]);
  };

  const send = async () => {
    if (!text.trim() && !files.length) return;
    setPhase({ state: 'running', added: 0 });
    let requestId: string, conversationId: string;
    try {
      const kept = await uploadAttachments(projectId, files);
      requestId = crypto.randomUUID();
      dashboardAgendaRequests.add(requestId);
      const request = (await api(`${project}/requests`, 'POST', {
        id: requestId,
        conversationId: 'default',
        hostUse: 'none',
        mode: 'auto',
        permission: 'candidate',
        provider: 'claude-cli',
        model: 'auto',
        effort: 'default',
        body: extractionBody(
          text,
          new Date(),
          kept.map((file) => file.name),
        ),
        pins: [],
        sketches: [],
        files: kept,
      })) as { input?: { conversationId?: string } };
      conversationId = request.input?.conversationId ?? 'default';
      reset();
    } catch (error) {
      if (alive.current) setPhase({ state: 'failed', reason: failure(error) });
      return;
    }
    // Follow the turn: its state, and its 할 일 writes in the conversation's ledger.
    let seen = 0;
    for (;;) {
      await wait(POLL_MS);
      if (!alive.current) return;
      let state = 'running',
        result: { message?: unknown } | null = null,
        ledger: LedgerEntry[] = [];
      try {
        const request = (await api(`${project}/requests/${requestId}?view=summary`)) as {
          state: string;
          result?: { message?: unknown } | null;
        };
        state = request.state;
        result = request.result ?? null;
        ledger =
          (
            (await api(`${project}/conversations/${encodeURIComponent(conversationId)}`)) as {
              ledger?: LedgerEntry[];
            }
          ).ledger ?? [];
      } catch {
        continue;
      }
      if (!alive.current) return;
      const { ledgerIds, added } = writesOf(ledger, requestId);
      if (ledgerIds.length !== seen) {
        seen = ledgerIds.length;
        dispatchEvent(new Event(AGENDA_CHANGED));
      }
      if (!ENDED.includes(state)) {
        setPhase({ state: 'running', added });
        continue;
      }
      if (state !== 'succeeded' && !added) {
        setPhase({
          state: 'failed',
          reason:
            typeof result?.message === 'string' && result.message
              ? result.message
              : '할 일을 만들지 못했습니다. 기본 대화에서 이유를 보세요.',
        });
        return;
      }
      setPhase({
        state: 'done',
        added,
        conversationId,
        ledgerIds,
        ...(typeof result?.message === 'string' ? { reply: result.message } : {}),
      });
      return;
    }
  };
  const undo = (done: Extract<Phase, { state: 'done' }>) =>
    void api(`${project}/agenda/undo`, 'POST', {
      conversationId: done.conversationId,
      ledgerIds: done.ledgerIds,
    })
      .then(() => {
        dispatchEvent(new Event(AGENDA_CHANGED));
        if (alive.current) setPhase({ state: 'undone' });
      })
      .catch((error) => {
        const code = (error as { code?: string }).code;
        if (alive.current)
          setPhase(
            code === 'AGENDA_UNDONE'
              ? { state: 'undone' }
              : { state: 'failed', reason: failure(error) },
          );
      });

  if (!open && phase.state === 'edit')
    return (
      <button type="button" className="link-button dash-extract-open" onClick={() => setOpen(true)}>
        글·파일에서 할 일 만들기
      </button>
    );
  if (phase.state !== 'edit')
    return (
      <div className="dash-extract-status" role="status" aria-label="글·파일에서 할 일 만들기">
        {phase.state === 'running' ? (
          <span>할 일을 뽑는 중… {phase.added ? `${phase.added}개 더함` : ''}</span>
        ) : phase.state === 'done' ? (
          phase.added ? (
            <>
              <span>{phase.added}개를 더했습니다.</span>
              <button type="button" className="link-button" onClick={() => undo(phase)}>
                되돌리기
              </button>
            </>
          ) : (
            <span title={phase.reply}>더할 할 일을 찾지 못했습니다.</span>
          )
        ) : phase.state === 'undone' ? (
          <span>되돌렸습니다.</span>
        ) : (
          <span className="dash-extract-failed">{phase.reason}</span>
        )}
        {phase.state !== 'running' ? (
          <button type="button" className="link-button" onClick={close}>
            닫기
          </button>
        ) : null}
      </div>
    );
  return (
    <div
      className="dash-extract"
      role="group"
      aria-label="글·파일에서 할 일 만들기"
      data-over={over || undefined}
      onDragOver={(event: DragEvent) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event: DragEvent) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setOver(false);
        addFiles(event.dataTransfer.files);
      }}
    >
      <textarea
        aria-label="할 일을 뽑을 글"
        rows={4}
        autoFocus
        placeholder="회의록·협의 내용·이메일을 붙여 넣거나 적으세요. 파일은 여기로 끌어 놓거나 붙여 넣기."
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event: ClipboardEvent) => {
          if (!event.clipboardData.files.length) return;
          event.preventDefault();
          addFiles(event.clipboardData.files);
        }}
      />
      <div className="dash-extract-foot">
        <button type="button" className="link-button" onClick={() => picker.current?.click()}>
          파일 고르기
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label="할 일을 뽑을 파일"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <span className="dash-extract-files">
          {files.map((file, index) => (
            <span key={`${file.name}-${index}`} className="dash-extract-file">
              {file.name}
              <button
                type="button"
                aria-label={`${file.name} 빼기`}
                onClick={() => setFiles((now) => now.filter((_, at) => at !== index))}
              >
                ×
              </button>
            </span>
          ))}
        </span>
        <span className="dash-extract-actions">
          <button type="button" className="link-button" onClick={close}>
            닫기
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!text.trim() && !files.length}
            onClick={() => void send()}
          >
            할 일 만들기
          </button>
        </span>
      </div>
    </div>
  );
}

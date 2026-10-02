import { useEffect, useState } from 'react';
import { z } from 'zod';
import { isDwgSdkEditMode } from '../contracts/dwg-edit-mode.ts';
import { requestMode, storedAttachments } from '../contracts/workspace.ts';
import { attachmentPreview } from './attachments.ts';
import { executionLimits } from '../contracts/execution-limits.ts';
import { undoReason } from '../contracts/direct-refusal.ts';
import { ActivityLog, activityEntries } from './activity.tsx';
import { inConversation } from './conversations.tsx';
import { api } from './gateway.ts';
import { executeWaitOf, guardOpen, heldRowLabel, waitingText } from './request-scope.ts';
import {
  Action,
  Candidate,
  errorLabels,
  legacyModels,
  stateLabels,
  type Actions,
} from './history.tsx';
import { formatElapsed, workStages, type Stage } from './work-stages.ts';
import { uiRequestSchema as workspaceRequestSchema } from './workspace-data.ts';
import type { UiMessage as Message } from './workspace-data.ts';

// The work view (Design §06 SCR-03): one request's conditions, progress stages with the
// interventions possible now, the latest real result, and what the user still has to check.
// The list of requests lives in the left work history.

const hostName = (host?: string) => (host === 'zwcad' ? 'ZWCAD' : 'Rhino');
const roleLabel = { target: '변경', preserve: '유지', reference: '참고' } as const;
/** The request's work mode (the contract maps an older permission: review → 계획). */
export const workMode = (message: Message) =>
  requestMode((message.request?.input ?? message) as { mode?: unknown; permission?: unknown });
const modeLabel = (message: Message) =>
  workMode(message) === 'plan'
    ? '계획 · 읽고 계획만'
    : (message.request?.input as { hostUse?: unknown } | undefined)?.hostUse === 'none'
      ? '자동 · 호스트 문서를 쓰지 않음'
      : '자동 · 열린 문서에 바로 적용';

// Direct mode (user decision 2026-09-30): each execution is one host undo record. The result
// lists them with their changes; a guarded one (bulk deletion, layer deletion, purge, save, save-as,
// export, publishing) was undone by the host and waits for [진행]. A 계획 turn returns a plan.
const changeSchema = z
  .object({
    nativeId: z.string().optional(),
    layer: z.string().nullish(),
    hash: z.string().nullish(),
  })
  .passthrough();
const guardSchema = z.object({ kind: z.string(), detail: z.string().nullish() }).passthrough();
const executionSchema = z
  .object({
    // The host's undo record id doubles as the execution id (`executionId`) on some paths.
    id: z.string().optional(),
    executionId: z.string().optional(),
    label: z.string().nullish(),
    state: z.string().nullish(),
    undoId: z.string().nullish(),
    host: z.string().nullish(),
    changes: z
      .object({
        added: z.array(changeSchema),
        changed: z.array(changeSchema),
        removed: z.array(changeSchema),
      })
      .partial()
      .nullish(),
    guarded: guardSchema.nullish(),
    undone: z.boolean().nullish(),
    // The linked file it ran in (ADR-027): a multi-file request groups its rows by file.
    file: z.object({ linkId: z.string().optional(), name: z.string() }).passthrough().nullish(),
    target: z.object({ instance: z.string(), documentId: z.number() }).passthrough().nullish(),
  })
  .passthrough()
  .transform((row) => ({
    ...row,
    id: row.id ?? row.executionId ?? row.undoId ?? '',
    state: row.state ?? (row.undone ? 'undone' : row.guarded ? 'guarded' : 'applied'),
  }))
  .refine((row) => row.id !== '');
const planSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            title: z.string(),
            objects: z.array(z.string()).nullish(),
            risk: z.string().nullish(),
          })
          .passthrough(),
      )
      .default([]),
    questions: z
      .array(z.union([z.string(), z.object({ text: z.string() }).passthrough()]))
      .nullish(),
  })
  .passthrough();
export type DirectExecution = z.infer<typeof executionSchema>;
type Change = z.infer<typeof changeSchema>;
/** The executions recorded on a request result (`result.executions`), malformed rows left out. */
export function directExecutions(result: unknown): DirectExecution[] {
  const list = (result as { executions?: unknown } | null | undefined)?.executions;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => executionSchema.safeParse(entry).data ?? []);
}
/** The 계획 turn's plan (`result.plan`: {steps: [{title, objects?, risk?}], questions?}). */
export function directPlan(result: unknown) {
  const plan = (result as { plan?: unknown } | null | undefined)?.plan;
  return plan ? planSchema.safeParse(plan).data : undefined;
}
/**
 * An execute the host refused before it touched the document (`result.refused`, e.g. a read-only
 * Rhino document): nothing ran; the reason carries the next step.
 */
export function directRefused(result: unknown) {
  const refused = (result as { refused?: unknown } | null | undefined)?.refused;
  return z
    .object({ code: z.string(), reason: z.string(), file: z.string().optional() })
    .safeParse(refused).data;
}
// A multi-file request's [되돌리기] and automatic rollback (ADR-027): what happened per file.
const fileUndoSchema = z
  .object({
    name: z.string(),
    host: z.string().nullish(),
    target: z.object({ instance: z.string(), documentId: z.number() }).passthrough().nullish(),
    state: z.string(),
    undone: z.number().nullish(),
    kept: z.number().nullish(),
    reason: z.string().nullish(),
  })
  .passthrough();
const requestUndoSchema = z
  .object({
    at: z.string().nullish(),
    reason: z.string().nullish(),
    files: z.array(fileUndoSchema),
  })
  .passthrough();
type FileUndo = z.infer<typeof fileUndoSchema>;
/** The result's `undo` (the user's [되돌리기]) or `rollback` (automatic), when present. */
export function requestUndo(result: unknown, key: 'undo' | 'rollback') {
  const value = (result as Record<string, unknown> | null | undefined)?.[key];
  return value ? requestUndoSchema.safeParse(value).data : undefined;
}
const fileKey = (execution: {
  host?: string | null;
  target?: { instance: string; documentId: number } | null;
  file?: { name: string } | null;
}) =>
  execution.target
    ? JSON.stringify([
        execution.host ?? 'rhino',
        execution.target.instance,
        execution.target.documentId,
      ])
    : (execution.file?.name ?? '');
/** Executions by file, in the order the request first wrote each file. */
export function executionFiles(executions: DirectExecution[]) {
  const files = new Map<
    string,
    { key: string; name: string; host: string; rows: DirectExecution[] }
  >();
  for (const execution of executions) {
    const key = fileKey(execution);
    const file = files.get(key) ?? {
      key,
      name: execution.file?.name ?? `${hostName(execution.host ?? undefined)} 문서`,
      host: execution.host ?? 'rhino',
      rows: [],
    };
    file.rows.push(execution);
    files.set(key, file);
  }
  return [...files.values()];
}
/** A request that wrote two or more files is shown and undone per request (ADR-027). */
export const isMultiFile = (result: unknown, executions: DirectExecution[]) =>
  (result as { multiFile?: unknown } | null | undefined)?.multiFile === true ||
  executionFiles(executions).length > 1;
/** A guard the whole request waits on (`result.guarded`, state 'needs-confirmation'). */
export function requestGuard(result: unknown) {
  const guarded = (result as { guarded?: unknown } | null | undefined)?.guarded;
  return guarded ? guardSchema.safeParse(guarded).data : undefined;
}
/**
 * A request of the direct flow: its result names the mode, executions, a plan or a guard. Results
 * stored before 2026-09-30 have none of these and keep their earlier view.
 */
export const isDirect = (message: Message) => {
  const result = message.request?.result as { mode?: unknown; appliedDirectly?: unknown } | null;
  return (
    message.request?.state === 'needs-confirmation' ||
    result?.mode === 'plan' ||
    result?.mode === 'auto' ||
    result?.appliedDirectly !== undefined ||
    directExecutions(result).length > 0 ||
    directPlan(result) !== undefined
  );
};
const guardLabels: Record<string, string> = {
  'bulk-delete': '대량 삭제',
  'layer-delete': '레이어 삭제',
  purge: '사용하지 않는 항목 정리',
  save: '원본 파일 덮어쓰기',
  'save-as': '다른 이름으로 저장',
  export: '경로로 내보내기',
  publish: '외부 게시',
  account: '계정·로그인',
};
const executionStates: Record<string, string> = {
  applied: '적용됨',
  undone: '되돌림',
  guarded: '확인 대기 · 되돌려 둠',
  // The held execution once [진행] re-ran it (the re-run is its own row with the undo record).
  confirmed: '확인함 · 다시 실행',
  failed: '실패 · 되돌림',
};
/** What the view needs beyond the history actions: direct-mode calls (app.ts posts them). */
export interface DirectActions {
  direct: (
    id: string,
    action: 'undo' | 'confirm' | 'continue' | 'acknowledge',
    body?: Record<string, unknown>,
  ) => Promise<void>;
}
/** A sent image attachment's [영역 표시] (SPEC-09.2 2): app.ts opens its reference-image tab. */
export interface ReferenceActions {
  reference?: (file: { id: string; name: string }) => void;
}
export type ViewActions = Actions & DirectActions & ReferenceActions;
const changeCount = (execution: DirectExecution) => ({
  added: execution.changes?.added?.length ?? 0,
  changed: execution.changes?.changed?.length ?? 0,
  removed: execution.changes?.removed?.length ?? 0,
});
function ChangeList({ title, rows }: { title: string; rows: Change[] }) {
  if (!rows.length) return null;
  return (
    <li>
      {title} {rows.length}개
      <ul>
        {rows.slice(0, 50).map((row, index) => (
          <li key={(row.nativeId ?? '') + index}>
            {row.nativeId ?? '식별자 없음'}
            {row.layer ? ` · ${row.layer}` : ''}
          </li>
        ))}
        {rows.length > 50 ? <li>외 {rows.length - 50}개</li> : null}
      </ul>
    </li>
  );
}
/** An action undo cannot easily repair: the host undid it; [진행] re-runs it with the guard off. */
function GuardCard({
  guard,
  run,
  actions,
}: {
  guard: z.infer<typeof guardSchema>;
  run: () => Promise<void>;
  actions: ViewActions;
}) {
  return (
    <section className="guard-card" role="group" aria-label="진행 확인">
      <p>
        <strong>{guardLabels[guard.kind] ?? guard.kind}</strong>
        {guard.detail ? ` · ${guard.detail}` : ''}
      </p>
      <p>
        되돌리기로 복구하기 어려운 변경이라 이 실행을 되돌려 두었습니다. 진행하면 같은 작업을 다시
        실행합니다.
      </p>
      <Action latch error={actions.error} run={run}>
        진행
      </Action>
    </section>
  );
}
/** Per-execution change rows with [되돌리기] (one file), and the guard card with [진행]. */
function DirectChanges({
  message,
  executions,
  actions,
  undoEach = true,
  label = '실행별 변경',
}: {
  message: Message;
  executions: DirectExecution[];
  actions: ViewActions;
  /** A multi-file request has one [되돌리기] for the request instead (ADR-027). */
  undoEach?: boolean;
  label?: string;
}) {
  if (!executions.length) return null;
  return (
    <ol className="direct-executions" aria-label={label}>
      {executions.map((execution, index) => {
        const count = changeCount(execution);
        const state = execution.state;
        // [진행] only while the request waits on it; an ended request's held row is not run.
        const guarded = guardOpen(state, message.request?.state) ? execution.guarded : undefined;
        const ended = heldRowLabel(state, message.request?.state);
        return (
          <li key={execution.id} className="direct-execution" data-state={state}>
            <div className="direct-row">
              <span className="direct-label">{execution.label || `실행 ${index + 1}`}</span>
              <span className="direct-count">
                추가 {count.added} · 변경 {count.changed} · 삭제 {count.removed}
              </span>
              <span className="direct-state">{ended ?? executionStates[state] ?? state}</span>
              {undoEach && ['applied', 'confirmed'].includes(state) && execution.undoId !== null ? (
                <Action
                  latch
                  error={actions.error}
                  run={() => actions.direct(message.id, 'undo', { executionId: execution.id })}
                >
                  되돌리기
                </Action>
              ) : null}
            </div>
            {count.added + count.changed + count.removed ? (
              <details>
                <summary>변경 객체</summary>
                <ul>
                  <ChangeList title="추가" rows={execution.changes?.added ?? []} />
                  <ChangeList title="변경" rows={execution.changes?.changed ?? []} />
                  <ChangeList title="삭제" rows={execution.changes?.removed ?? []} />
                </ul>
              </details>
            ) : null}
            {guarded ? (
              <GuardCard
                guard={guarded}
                run={() => actions.direct(message.id, 'confirm', { executionId: execution.id })}
                actions={actions}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
const fileUndoState = (file: FileUndo) =>
  file.state === 'undone'
    ? '되돌림'
    : file.state === 'unknown'
      ? '확인 필요'
      : `되돌리지 못함 · ${undoReason(file.reason)}`;
/**
 * A multi-file request (ADR-027): rows grouped by file with each file's totals, one [되돌리기]
 * for the whole request, and what an automatic rollback or the last [되돌리기] did per file.
 */
function FileGroups({
  message,
  executions,
  actions,
}: {
  message: Message;
  executions: DirectExecution[];
  actions: ViewActions;
}) {
  const result = message.request?.result;
  const rollback = requestUndo(result, 'rollback');
  const undo = requestUndo(result, 'undo');
  const files = executionFiles(executions);
  const undoable = executions.filter(
    (execution) => execution.state === 'applied' && execution.undoId,
  );
  const undoFiles = new Set(undoable.map(fileKey));
  const outcomeOf = (key: string) =>
    [...(undo?.files ?? []), ...(rollback?.files ?? [])].find(
      (file) =>
        (file.target
          ? JSON.stringify([file.host ?? 'rhino', file.target.instance, file.target.documentId])
          : file.name) === key,
    );
  const left = (outcome?: { files: FileUndo[] }) =>
    (outcome?.files ?? []).filter((file) => file.state !== 'undone');
  return (
    <section className="direct-files" aria-label="파일별 변경">
      {rollback ? (
        <p className="direct-rollback" data-state={left(rollback).length ? 'partial' : 'done'}>
          {left(rollback).length
            ? `자동으로 되돌리지 못한 파일: ${left(rollback)
                .map((file) => `${file.name}(${fileUndoState(file)})`)
                .join(', ')} · 호스트에서 Ctrl+Z(ZWCAD는 U)로 되돌리거나 상태를 확인하세요.`
            : `${rollback.reason === 'cancelled' ? '중단해서' : '요청이 실패해서'} 모든 파일의 변경을 자동으로 되돌렸습니다.`}
        </p>
      ) : null}
      {undo && left(undo).length ? (
        <p className="direct-rollback" data-state="partial">
          되돌리지 못한 파일:{' '}
          {left(undo)
            .map((file) => `${file.name}(${fileUndoState(file)})`)
            .join(', ')}{' '}
          · 호스트에서 Ctrl+Z(ZWCAD는 U)로 순서대로 되돌리세요.
        </p>
      ) : null}
      {undoable.length ? (
        <div className="direct-request-undo">
          <span>
            파일 {undoFiles.size}개의 실행 {undoable.length}개를 되돌립니다
          </span>
          <Action
            latch
            error={actions.error}
            run={() => actions.direct(message.id, 'undo', { all: true })}
          >
            되돌리기
          </Action>
        </div>
      ) : null}
      {files.map((file) => {
        const total = file.rows.reduce(
          (sum, row) => {
            const count = changeCount(row);
            return {
              added: sum.added + count.added,
              changed: sum.changed + count.changed,
              removed: sum.removed + count.removed,
            };
          },
          { added: 0, changed: 0, removed: 0 },
        );
        const outcome = outcomeOf(file.key);
        return (
          <section key={file.key} className="direct-file" aria-label={file.name}>
            <div className="direct-file-head">
              <strong>{file.name}</strong>
              <span className="direct-count">
                {hostName(file.host)} · 추가 {total.added} · 변경 {total.changed} · 삭제{' '}
                {total.removed}
              </span>
              {outcome ? (
                <span
                  className="direct-state"
                  data-state={outcome.state}
                  title={outcome.reason ?? undefined}
                >
                  {fileUndoState(outcome)}
                </span>
              ) : null}
            </div>
            <DirectChanges
              message={message}
              executions={file.rows}
              actions={actions}
              undoEach={false}
              label={`${file.name} 실행별 변경`}
            />
          </section>
        );
      })}
    </section>
  );
}
/** The 계획 turn's plan: steps, questions and [진행] (continues the conversation in 자동). */
function PlanCard({
  message,
  plan,
  continued,
  actions,
}: {
  message: Message;
  plan: NonNullable<ReturnType<typeof directPlan>>;
  continued: boolean;
  actions: ViewActions;
}) {
  const questions = (plan.questions ?? []).map((entry) =>
    typeof entry === 'string' ? entry : entry.text,
  );
  return (
    <section className="plan-card" aria-label="계획">
      <h5>계획</h5>
      <ol>
        {plan.steps.map((step, index) => (
          <li key={index}>
            <span>{step.title}</span>
            {step.objects?.length ? <small> · 객체 {step.objects.length}개</small> : null}
            {step.risk ? <small className="plan-risk"> · 주의: {step.risk}</small> : null}
          </li>
        ))}
      </ol>
      {questions.length ? (
        <>
          <h6>확인할 질문</h6>
          <ul>
            {questions.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </>
      ) : null}
      {continued ? (
        <small>자동으로 이어서 실행했습니다.</small>
      ) : message.request?.state === 'succeeded' ? (
        <div className="plan-actions">
          <Action latch error={actions.error} run={() => actions.direct(message.id, 'continue')}>
            진행
          </Action>
          <small>같은 대화에서 자동으로 실행합니다. 질문의 답은 작성기에 적어 보내도 됩니다.</small>
        </div>
      ) : null}
    </section>
  );
}
const marks: Record<Stage['state'], string> = {
  pending: '○',
  active: '◐',
  done: '●',
  skipped: '–',
  failed: '✕',
};
const stageText: Record<Stage['state'], string> = {
  pending: '대기',
  active: '진행 중',
  done: '완료',
  skipped: '생략',
  failed: '멈춤',
};
const jigOf = (message: Message) => {
  const jig = (message.request?.input as { jig?: { kind?: unknown } } | undefined)?.jig;
  return typeof jig?.kind === 'string' ? jig.kind : undefined;
};
export function stagesOf(message: Message, now = Date.now()) {
  const request = message.request,
    result = request?.result;
  const started = request?.createdAt ? Date.parse(request.createdAt) : NaN;
  const endedAt = (result as { endedAt?: unknown } | undefined)?.endedAt;
  const ended = typeof endedAt === 'string' ? Date.parse(endedAt) : NaN;
  return workStages({
    ...(Number.isFinite(started) ? { startedAt: started } : {}),
    now,
    state: request?.state ?? 'queued',
    provider: message.provider,
    source: message.source,
    host: request?.input?.host ?? message.host,
    jig: jigOf(message),
    phase: result?.phase,
    activity: activityEntries(result?.activity),
    progress: result?.progress,
    maxHostCommands: request?.input ? executionLimits(request.input).maxHostCommands : undefined,
    // The open document edited directly (ADR-022) has its own stages (no save-and-reopen check).
    direct:
      typeof (result as { appliedDirectly?: unknown } | undefined)?.appliedDirectly === 'boolean',
    ...(Number.isFinite(ended) ? { endedAt: ended } : {}),
    acknowledged:
      typeof (result as { acknowledgedAt?: unknown } | undefined)?.acknowledgedAt === 'string',
  });
}

/** What the user can do now, placed at the current stage (SPEC-02.11). */
function Interventions({
  message,
  projectId,
  actions,
}: {
  message: Message;
  projectId: string;
  actions: Actions;
}) {
  const request = message.request,
    result = request.result;
  if (message.provider === 'extension' || ['file', 'document'].includes(message.source ?? ''))
    return null;
  const reason = actions.interventionReason(message.id);
  const waiting = result?.phase === 'waiting';
  return (
    <div className="work-intervene" role="group" aria-label="개입">
      {!request.input?.parentRequestId && !waiting ? (
        <button
          type="button"
          disabled={!!reason}
          title={
            reason ||
            (request.input?.linkedTargets
              ? '이 작업의 두 대상에 작성기 입력을 추가합니다. 저장된 부분 결과가 있으면 확인 후 이어갑니다.'
              : '작성기의 입력을 조건으로 추가하고, 이전 작업이 끝나면 원 기준에서 다시 실행합니다.')
          }
          onClick={() => actions.intervene(message.id)}
        >
          추가 지시
        </button>
      ) : null}
      {result?.phase === 'host' ? (
        <small>호스트에 쓰고 검증하는 중이라 이 단계가 끝난 뒤 중단할 수 있습니다.</small>
      ) : (
        <Action
          latch
          error={actions.error}
          run={async () => {
            await api(`/projects/${projectId}/requests/${message.id}/cancel`, 'POST', {});
          }}
        >
          중단
        </Action>
      )}
      {reason && !waiting && !request.input?.parentRequestId ? <small>{reason}</small> : null}
    </div>
  );
}

function StageList({
  message,
  projectId,
  actions,
}: {
  message: Message;
  projectId: string;
  actions: Actions;
}) {
  const request = message.request;
  const running = Boolean(request && ['queued', 'running'].includes(request.state));
  // The stage in progress counts up while the request runs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [running]);
  const stages = stagesOf(message, now);
  const active = stages.findIndex((stage) => stage.state === 'active');
  const here = active < 0 ? 0 : active;
  const waiting = request?.result?.phase === 'waiting';
  const executeWait = running ? executeWaitOf(request?.result) : undefined;
  const note = running
    ? [...activityEntries(request?.result?.activity)]
        .reverse()
        .find((entry) => entry.kind === 'message' || entry.kind === 'thinking')
    : undefined;
  return (
    <ol className="work-stages" aria-label="진행 단계">
      {stages.map((stage, index) => (
        <li key={stage.key} data-state={stage.state}>
          <div className="stage-row">
            <span className="stage-mark" aria-hidden="true">
              {marks[stage.state]}
            </span>
            <span className="stage-label">
              {stage.label}
              {stage.elapsedMs !== undefined ? (
                <span className="stage-time"> ({formatElapsed(stage.elapsedMs)})</span>
              ) : null}
            </span>
            <span className="stage-detail">
              {stage.detail || (stage.state === 'active' ? stageText.active : '')}
            </span>
            <span className="sr-only">{stageText[stage.state]}</span>
          </div>
          {running && index === here ? (
            <>
              {waiting ? (
                <small className="stage-note">추가 지시 접수 · 이전 작업 종료 대기</small>
              ) : null}
              {executeWait ? (
                <small className="stage-note">{waitingText(executeWait)}</small>
              ) : null}
              {note ? <p className="stage-ai">AI: {note.text}</p> : null}
              <Interventions message={message} projectId={projectId} actions={actions} />
            </>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function WorkView({
  message,
  messages,
  conversation = messages,
  models,
  projectId,
  actions,
}: {
  message: Message;
  messages: Message[];
  /** The requests of the chosen conversation (all of them without chips). */
  conversation?: Message[];
  models: { id: string; name: string }[];
  projectId: string;
  actions: ViewActions;
}) {
  const request = message.request,
    result = request?.result;
  const direct = isDirect(message);
  const executions = directExecutions(result);
  const plan = directPlan(result);
  const guard = requestGuard(result);
  const refused = directRefused(result);
  const continued =
    Boolean((result as { continuedRequestId?: unknown } | null | undefined)?.continuedRequestId) ||
    messages.some((entry) => {
      // The server's continuation names its plan `continuesPlanId` (execution.ts continuePlan).
      const input = entry.request?.input as
        | { continuesRequestId?: unknown; continuesPlanId?: unknown }
        | undefined;
      return input?.continuesPlanId === message.id || input?.continuesRequestId === message.id;
    });
  const related = new Map(messages.map((entry) => [entry.id, entry]));
  const running = Boolean(request && ['queued', 'running'].includes(request.state));
  const activity = activityEntries(result?.activity);
  const imported = ['file', 'document'].includes(message.source ?? '');
  const others = conversation.filter(
    (entry) =>
      entry.id !== message.id &&
      !entry.request?.input?.parentRequestId &&
      ['queued', 'running'].includes(entry.request?.state ?? ''),
  );
  const execution =
    message.provider === 'extension'
      ? '확장 · ' + message.extensionVersion
      : imported
        ? message.host === 'zwcad'
          ? isDwgSdkEditMode(result?.dwgEditMode)
            ? 'ZWCAD 작업 사본'
            : 'ZWCAD 참고 도면'
          : result?.displayOnly === true
            ? 'Rhino 화면 동기화'
            : 'Rhino 작업 사본'
        : `${models.find((model) => model.id === message.model)?.name || legacyModels[message.model] || message.model} · ${message.effort === 'default' ? '기본 강도' : message.effort}`;
  const base = message.baseRequestId ? related.get(message.baseRequestId) : undefined;
  const reviews = actions.reviewsOf(message.id);
  const jig = jigOf(message);
  const jigCheck = (result as { jigCheck?: { unknown?: string[] } } | undefined)?.jigCheck;
  // The latest verified change while the work is still running (the candidate comes at the end).
  const verified = [...activity].reverse().find((entry) => entry.kind === 'result');
  const target = request?.input?.linkedTargets?.length
    ? request.input.linkedTargets
        .map((linked) => {
          const source = related.get(linked.baseRequestId);
          return (
            hostName(linked.host) +
            ' · ' +
            (source?.request?.result?.sourceDocument?.name || source?.body || '기준 후보')
          );
        })
        .join(' ↔ ')
    : jig === 'sync-review'
      ? 'Sync jig 표 (호스트 없음)'
      : (request?.input as { hostUse?: unknown } | undefined)?.hostUse === 'none'
        ? 'VIDE 안 계산 (호스트 없음)'
        : hostName(request?.input?.host || message.host) +
          (result?.sourceDocument?.name
            ? ' · ' + result.sourceDocument.name
            : base?.request?.result?.sourceDocument?.name
              ? ' · ' + base.request.result.sourceDocument.name
              : '');
  const checks = [
    request?.state === 'unknown'
      ? '호스트 결과가 확인되지 않았습니다. 문서를 확인한 뒤 [확인함]을 누르세요. 그동안 다음 작업은 이 문서를 먼저 읽고 진행합니다.'
      : '',
    result?.recovered
      ? '사본에서 복구한 결과 · 목표 완료 미확인. 이어가기 전에 후보를 확인하세요.'
      : '',
    jigCheck?.unknown?.length
      ? `AI가 표에 없는 행(${jigCheck.unknown.join(', ')})을 인용했습니다. 그 부분은 근거가 없습니다.`
      : '',
    !direct && result?.hostExecuted && result.sourceDocument && !result.displayOnly
      ? '후보는 취득 시점의 문서를 기준으로 만들었습니다. 원본이 그 뒤 바뀌었는지는 적용할 때 확인합니다.'
      : '',
  ].filter(Boolean);
  return (
    <article
      className="work-view chat-message"
      data-request-id={message.id}
      data-state={request?.state}
      data-open="true"
    >
      {others.length ? (
        <div className="work-others">
          <span>진행 중인 다른 작업 {others.length}개</span>
          {others.slice(0, 3).map((entry) => (
            <button key={entry.id} type="button" onClick={() => actions.focus(entry.id)}>
              {(entry.body || '첨부 검토').slice(0, 24)}
            </button>
          ))}
        </div>
      ) : null}
      <header className="work-head">
        <h3 className="card-title">{message.body || '첨부한 문맥 검토'}</h3>
        <span className="card-state" data-state={request?.state}>
          {request ? stateLabels[request.state] || request.state : ''}
        </span>
      </header>
      <section className="work-conditions" aria-label="조건">
        <dl>
          <dt>대상</dt>
          <dd>{target}</dd>
          {base ? (
            <>
              <dt>기준</dt>
              <dd>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => actions.candidate(base.id)}
                >
                  {base.body || '이전 결과'}
                </button>
              </dd>
            </>
          ) : null}
          {message.pins.length ? (
            <>
              <dt>핀</dt>
              <dd className="work-pins">
                {message.pins.map((pin, index) => (
                  <span key={index} data-role={pin.role}>
                    {pin.name || pin.id} · {roleLabel[pin.role]}
                  </span>
                ))}
              </dd>
            </>
          ) : null}
          {message.sketches.length || message.files.length ? (
            <>
              <dt>첨부</dt>
              <dd>
                <Attachments
                  message={message}
                  projectId={projectId}
                  reference={actions.reference}
                />
              </dd>
            </>
          ) : null}
          {!imported && message.provider !== 'extension' ? (
            <>
              <dt>모드</dt>
              <dd>{modeLabel(message)}</dd>
            </>
          ) : null}
          <dt>실행</dt>
          <dd>{execution}</dd>
        </dl>
        <details>
          <summary>요청 원문</summary>
          <pre>{JSON.stringify(request?.input || message, null, 2)}</pre>
        </details>
      </section>
      <section className="work-progress" aria-label="진행">
        <h4>진행</h4>
        <StageList message={message} projectId={projectId} actions={actions} />
        {result?.targetResults?.length ? (
          <ul className="work-targets" aria-label="호스트별 진행">
            {result.targetResults.map((saved) => {
              const child = related.get(saved.requestId);
              const state = child?.request?.state ?? saved.state;
              const now = child
                ? stagesOf(child).find((stage) => stage.state === 'active')
                : undefined;
              return (
                <li key={saved.requestId}>
                  <span>
                    {hostName(saved.host)} ·{' '}
                    {child?.request?.result?.unchanged
                      ? '변경 없음 · 기존 후보 확인'
                      : stateLabels[state] || state}
                    {now ? ` · ${now.label}${now.detail ? ' (' + now.detail + ')' : ''}` : ''}
                  </span>
                  {state === 'succeeded' && child?.request?.result?.hostExecuted ? (
                    <button onClick={() => actions.candidate(saved.requestId)}>
                      대상 후보 보기
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
      {request ? (
        <section className="work-result" aria-label="결과">
          <h4>결과</h4>
          {running ? (
            <p className="work-muted">
              {workMode(message) === 'plan'
                ? '읽고 계획하는 중입니다. 문서는 바꾸지 않습니다.'
                : executions.length
                  ? `열린 문서에 실행 ${executions.length}회 적용 · 실행마다 되돌리기 기록이 남습니다.`
                  : verified
                    ? `확인된 변경: ${verified.text.replace(/^실행 성공 · /, '')}`
                    : '아직 문서를 바꾸지 않았습니다.'}
            </p>
          ) : null}
          {result?.unchanged ? <small>변경 없음</small> : null}
          {message.provider === 'extension' && request.state === 'succeeded' ? (
            <small>확장 완료</small>
          ) : null}
          {result?.applicationState === 'succeeded' ? (
            <p>
              연결 Rhino에 반영했습니다. 아래 AI 답변은 원본 반영 전에 작성된 작업 사본 설명입니다.
            </p>
          ) : null}
          {result?.text ? <p className="work-answer">{result.text}</p> : null}
          {result?.extensionResult?.rows.map((row, index) => (
            <details key={index}>
              <summary>
                {row.type} · {row.layer || '레이어 미상'} · {row.count}개
              </summary>
              {row.objectIds.map((id) => (
                <button
                  key={id}
                  onClick={() => actions.selection(message.baseRequestId ?? undefined, id)}
                >
                  {message.pins.find((pin) => pin.id === id)?.name || id}
                </button>
              ))}
            </details>
          ))}
          {plan ? (
            <PlanCard message={message} plan={plan} continued={continued} actions={actions} />
          ) : null}
          {refused ? (
            <p className="direct-refused">
              실행하지 않음 · {refused.file ? `${refused.file} · ` : ''}
              {refused.reason}
            </p>
          ) : null}
          {isMultiFile(result, executions) ? (
            <FileGroups message={message} executions={executions} actions={actions} />
          ) : (
            <DirectChanges message={message} executions={executions} actions={actions} />
          )}
          {request.state === 'needs-confirmation' &&
          guard &&
          !executions.some((execution) => execution.state === 'guarded') ? (
            <GuardCard
              guard={guard}
              run={() => actions.direct(message.id, 'confirm', {})}
              actions={actions}
            />
          ) : null}
          {result?.hostExecuted && direct ? (
            <>
              <button type="button" onClick={() => actions.candidate(message.id)}>
                모델 보기
              </button>
              <Action error={actions.error} run={() => actions.saveReview(message.id)}>
                검토본 저장
              </Action>
            </>
          ) : result?.hostExecuted ? (
            <Candidate message={message} projectId={projectId} actions={actions} />
          ) : null}
          {reviews.length ? (
            <p className="work-reviews">
              <span>이 작업으로 만든 검토본</span>
              {reviews.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="link-button"
                  title={new Date(row.createdAt).toLocaleString('ko-KR')}
                  onClick={() => actions.openReview(row)}
                >
                  {row.title}
                </button>
              ))}
            </p>
          ) : null}
          {result?.code ? <p>{errorLabels[result.code] || result.code}</p> : null}
          {(request.state === 'unknown' && !result?.applicationId) ||
          messages.some(
            (entry) =>
              entry.request?.input?.parentRequestId === message.id &&
              entry.request.state === 'unknown',
          ) ? (
            <Action
              latch
              error={actions.error}
              run={() => actions.direct(message.id, 'acknowledge', {})}
            >
              확인함
            </Action>
          ) : null}
          {request.state === 'unknown' &&
          !result?.applicationId &&
          result?.executionMode === 'sdk' ? (
            <Action
              error={actions.error}
              run={async () => {
                message.request = workspaceRequestSchema.parse(
                  await api(`/projects/${projectId}/requests/${message.id}/reconcile`, 'POST', {}),
                );
                actions.changed();
              }}
            >
              저장된 후보 다시 확인
            </Action>
          ) : null}
          {request.state === 'unknown' &&
          message.source === 'file' &&
          message.host === 'zwcad' &&
          result?.sourceHash ? (
            <Action
              error={actions.error}
              run={async () => {
                message.request = workspaceRequestSchema.parse(
                  await api(`/projects/${projectId}/imports/${message.id}/reconcile`, 'POST', {}),
                );
                actions.changed();
              }}
            >
              불러오기 결과 확인
            </Action>
          ) : null}
          {message.linkedTargets &&
          ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(request.state) ? (
            <Action error={actions.error} run={() => actions.restore(request)}>
              확인된 후보에서 이어가기
            </Action>
          ) : null}
          {request.state === 'succeeded' &&
          result?.recovered &&
          result.hostExecuted &&
          !request.input.linkedTargets &&
          !imported ? (
            <Action error={actions.error} run={() => actions.restore(request)}>
              복구 후보에서 이어가기
            </Action>
          ) : null}
          {['failed', 'cancelled', 'interrupted'].includes(request.state) &&
          message.provider !== 'extension' &&
          !message.linkedTargets &&
          !imported ? (
            <Action error={actions.error} run={() => actions.restore(request)}>
              입력을 초안으로 복원
            </Action>
          ) : null}
        </section>
      ) : null}
      {checks.length ? (
        <section className="work-checks" aria-label="확인할 것">
          <h4>확인할 것</h4>
          <ul>
            {checks.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {activity.length ? (
        <details className="activity">
          <summary>
            작업 과정 · {activity.length}개 기록{running ? ' · 진행 중' : ''}
          </summary>
          <ActivityLog entries={activity} live={running} />
        </details>
      ) : null}
    </article>
  );
}

const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
/**
 * The request's attachments (T-109; the work history no longer lists them): a kept image opens
 * from the engine's attachment route in a new tab; other kept files show their name and size (the
 * engine serves only images, SPEC-01.12 4); sketches and VIDE's own small notes show their name.
 */
function Attachments({
  message,
  projectId,
  reference,
}: {
  message: Message;
  projectId: string;
  reference?: ReferenceActions['reference'];
}) {
  return (
    <span className="work-attachments">
      {message.sketches.map((sketch, index) => (
        <span key={'s' + index}>{String(sketch.name ?? '스케치 ' + (index + 1))}</span>
      ))}
      {message.files.map((file, index) => {
        const stored = storedAttachments([file])[0];
        const name = String(file.displayName || file.name);
        if (!stored) return <span key={'f' + index}>{name}</span>;
        return stored.kind === 'image' && projectId ? (
          <span key={'f' + index} className="work-attachment-image">
            <a
              href={attachmentPreview(projectId, stored.id)}
              target="_blank"
              rel="noopener"
              title={`${stored.name} · ${fileSize(stored.size)} · 새 탭에서 보기`}
            >
              {name}
            </a>
            {reference ? (
              <button
                type="button"
                className="work-reference-mark"
                title="참고 이미지 탭에서 원하는 부분을 영역으로 표시합니다"
                onClick={() => reference({ id: stored.id, name })}
              >
                영역 표시
              </button>
            ) : null}
          </span>
        ) : (
          <span
            key={'f' + index}
            title={`${stored.name} · ${fileSize(stored.size)} · AI가 첨부 도구로 읽습니다`}
          >
            {name} · {fileSize(stored.size)}
          </span>
        );
      })}
    </span>
  );
}

/**
 * The work shown under the chosen conversation (SCR-15, PLAN-24 T-061): the focused request when
 * it belongs to it, else the conversation's latest running (or latest) request, chosen the way
 * the app chooses without a conversation (§06 SCR-03). Without chips (panel mode) nothing changes.
 */
export function workInConversation(
  focused: Message | undefined,
  messages: Message[],
  filter: string | null | undefined,
) {
  if (filter === undefined || (focused && inConversation(focused, filter))) return focused;
  const listed = messages.filter(
    (entry) => !entry.request?.input?.parentRequestId && inConversation(entry, filter),
  );
  return (
    [...listed].reverse().find((entry) => ['queued', 'running'].includes(entry.request?.state)) ??
    listed.at(-1)
  );
}
export interface WorkThreadProps {
  focused: Message | undefined;
  messages: Message[];
  models: { id: string; name: string }[];
  projectId: string | undefined;
  actions: ViewActions;
  /** The chosen conversation (`undefined` without chips). */
  filter: string | null | undefined;
}
/** The work view's content (`#conversation`, src/ui/shell/right-column.tsx). */
export function WorkThread({
  focused,
  messages,
  models,
  projectId,
  actions,
  filter,
}: WorkThreadProps) {
  const shown = workInConversation(focused, messages, filter);
  // Requests of other conversations stay in `related` (base and child lookups) but not in the
  // "진행 중인 다른 작업" line.
  const others =
    filter === undefined ? messages : messages.filter((entry) => inConversation(entry, filter));
  return shown ? (
    <WorkView
      key={shown.id}
      message={shown}
      messages={messages}
      conversation={others}
      models={models}
      projectId={projectId ?? ''}
      actions={actions}
    />
  ) : (
    <div className="chat-empty">
      {filter === undefined
        ? '요청을 보내면 진행 단계와 결과가 여기에 표시됩니다.'
        : '이 대화에는 아직 작업이 없습니다. 요청을 보내면 여기에 표시됩니다.'}
      <span className="chat-empty-history"> 지난 작업은 왼쪽 작업 이력에서 엽니다.</span>
    </div>
  );
}

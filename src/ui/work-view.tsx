import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { isDwgSdkEditMode } from '../contracts/dwg-edit-mode.ts';
import { executionLimits } from '../contracts/execution-limits.ts';
import { ActivityLog, activityEntries } from './activity.tsx';
import { api } from './gateway.ts';
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
const modeLabel = (message: Message) =>
  message.applyToSource
    ? 'Auto mode · 원본에 적용'
    : message.permission === 'review'
      ? 'Plan mode · 읽기만'
      : 'Accept edits · 후보 생성';
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
  models,
  projectId,
  actions,
}: {
  message: Message;
  messages: Message[];
  models: { id: string; name: string }[];
  projectId: string;
  actions: Actions;
}) {
  const request = message.request,
    result = request?.result;
  const related = new Map(messages.map((entry) => [entry.id, entry]));
  const running = Boolean(request && ['queued', 'running'].includes(request.state));
  const activity = activityEntries(result?.activity);
  const imported = ['file', 'document'].includes(message.source ?? '');
  const others = messages.filter(
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
  const attachments = [...message.sketches, ...message.files].map((item) => item.name);
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
      : hostName(request?.input?.host || message.host) +
        (result?.sourceDocument?.name
          ? ' · ' + result.sourceDocument.name
          : base?.request?.result?.sourceDocument?.name
            ? ' · ' + base.request.result.sourceDocument.name
            : '');
  const checks = [
    request?.state === 'unknown' ? '호스트 결과가 확인되지 않았습니다. 새 쓰기는 보류됩니다.' : '',
    result?.recovered
      ? '사본에서 복구한 결과 · 목표 완료 미확인. 이어가기 전에 후보를 확인하세요.'
      : '',
    jigCheck?.unknown?.length
      ? `AI가 표에 없는 행(${jigCheck.unknown.join(', ')})을 인용했습니다. 그 부분은 근거가 없습니다.`
      : '',
    result?.hostExecuted && result.sourceDocument && !result.displayOnly
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
                  {base.body || '이전 후보'}
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
          {attachments.length ? (
            <>
              <dt>첨부</dt>
              <dd>{attachments.join(' · ')}</dd>
            </>
          ) : null}
          {!imported && message.provider !== 'extension' ? (
            <>
              <dt>권한</dt>
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
          {running && !result?.hostExecuted ? (
            <p className="work-muted">
              {verified
                ? `검증된 변경: ${verified.text.replace(/^실행 성공 · /, '').replace(/ · 저장·재열기 검증$/, '')} (저장·재열기 확인). 후보 형상은 작업이 끝나면 보입니다.`
                : '아직 준비된 결과가 없습니다.'}
              {base ? ' 지금은 기준 후보를 볼 수 있습니다.' : ''}
            </p>
          ) : null}
          {result?.unchanged ? <small>변경 없음 · 기존 후보 확인</small> : null}
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
          {result?.hostExecuted ? (
            <Candidate message={message} projectId={projectId} actions={actions} />
          ) : null}
          {result?.code ? <p>{errorLabels[result.code] || result.code}</p> : null}
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

const roots = new Map<HTMLElement, Root>();
export function renderWork(
  element: HTMLElement,
  focused: Message | undefined,
  messages: Message[],
  models: { id: string; name: string }[],
  projectId: string | undefined,
  actions: Actions,
): void {
  let root = roots.get(element);
  if (!root) {
    root = createRoot(element);
    roots.set(element, root);
  }
  root.render(
    focused ? (
      <WorkView
        key={focused.id}
        message={focused}
        messages={messages}
        models={models}
        projectId={projectId ?? ''}
        actions={actions}
      />
    ) : (
      <div className="chat-empty">
        요청을 보내면 진행 단계와 결과가 여기에 표시됩니다.
        <span className="chat-empty-history"> 지난 작업은 왼쪽 작업 이력에서 엽니다.</span>
      </div>
    ),
  );
}
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    for (const root of roots.values()) root.unmount();
    roots.clear();
  }
});

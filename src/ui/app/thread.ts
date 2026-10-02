// AI column (PLAN-26 T-113, region C): conversation chips, question cards, the work view and history
// focus, route cards, the request poll and the AI's screen actions.
import { renderRequests } from '../requests.tsx';
import { requestData, requestMessage } from '../workspace-data.ts';
import { element as $, append as el, readableError } from '../elements.ts';
import { api, requestAction, errors } from '../gateway.ts';
import {
  models,
  recoveredRequestDraft,
  failedRequestDraft,
  objects,
  draftHasInput,
  validate,
} from '../model.ts';
import { removeDraft } from '../draft-storage.ts';
import { renderWork } from '../work-view.tsx';
import { linkedRequestDraft, interventionTargetDraft } from '../linked-draft.ts';
import { reviewsOf, openReview } from '../reviews.tsx';
import { jigRouteText } from '../request-route.ts';
import { skillChecklist, startSkill } from '../skill-start.ts';
import { AgendaTurns, AGENDA_CHANGED, type AgendaTurn, agendaNotice } from '../agenda-text.ts';
import { setWorkspace } from '../workspaces.ts';
import { sessionState } from '../store/session.ts';
import { draftState } from '../store/draft.ts';
import { workState, type QuestionCardsModule } from '../store/work.ts';
import { linksState } from '../store/links.ts';
import { selectionState } from '../store/selection.ts';
import { viewerState } from '../store/viewer.ts';
import { sketchState } from '../store/sketch.ts';
import { revealPanel, mobileView, sidebar, showModelView } from './left.ts';
import {
  setBody,
  switchDraft,
  followConversationModel,
  submitRequest,
  skillToChat,
  focusDraft,
} from './composer.ts';
import { currentProject, panelMode } from './context.ts';
import { renderMessages, render } from './render.ts';
import { openReferenceTab, reviews, skillDeps, jigConversations } from './glue.ts';
import { pendingSketch, selectInResult, captureViewport } from './viewport.ts';
import { message, messageWithActions } from './status.ts';

export const conversationScreens = import.meta.glob<typeof import('../conversations.tsx')>(
  '../conversations.tsx',
);
export const questionScreens = import.meta.glob<QuestionCardsModule>('../question-card.tsx');
/**
 * The question cards of the chosen conversation (SPEC-02.19 6): shown while its latest turn ended
 * with questions; the answer goes to `…/conversations/:cid/answer` and becomes its next turn.
 */
export function renderQuestionCards() {
  // The default conversation's turns carry its row's ID once its first turn made it.
  const conversationId =
    currentConversation() ?? (sessionState.project ? defaultRowId() : undefined);
  const own = conversationId
    ? draftState.state.messages.filter((entry) => {
        const input = entry.request?.input as
          | { conversationId?: unknown; parentRequestId?: unknown }
          | undefined;
        return !input?.parentRequestId && input?.conversationId === conversationId;
      })
    : [];
  const last = own.at(-1);
  // A running Claude turn asking with its own question tool (ADR-026 4): answered in the same run.
  const running = last?.request?.result as { phase?: unknown; questions?: unknown } | null;
  const native =
    last?.request?.state === 'running' &&
    running?.phase === 'question' &&
    Array.isArray(running.questions)
      ? { status: 'question', questions: running.questions }
      : undefined;
  const turnOutput =
    native ??
    (last?.request?.state === 'succeeded'
      ? (last.request.result as { turnOutput?: unknown } | null | undefined)?.turnOutput
      : undefined);
  if (!workState.mountCards || !conversationId || !last || !turnOutput) {
    workState.questionCards?.unmount();
    workState.questionCards = undefined;
    return;
  }
  const projectId = currentProject().id;
  const options = {
    projectId,
    conversationId,
    requestId: last.id,
    turnOutput,
    ...(native
      ? {
          answerPath: `/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(last.id)}/questions`,
        }
      : {}),
    onAnswered: ({ id }: { id: string }) =>
      void requestData(`/projects/${projectId}/requests/${id}`).then((request) => {
        if (sessionState.project?.id !== projectId) return;
        if (!draftState.state.messages.some((entry) => entry.id === id))
          draftState.state.messages.push(requestMessage(request));
        workState.focusedWork = id;
        renderMessages();
        void workState.conversationChips?.refresh();
        // The native answer continues the turn that is already followed.
        if (!native) void poll(id, projectId);
      }),
  };
  if (workState.questionCards) workState.questionCards.update(options);
  else workState.questionCards = workState.mountCards($('question-cards'), api, options);
}
/** The conversation the next request goes to; undefined = the project's default conversation. */
export const currentConversation = () => workState.conversationChips?.active() ?? undefined;
/** The default conversation's row on the server (src/server/conversations.ts). */
export const defaultRowId = () => `default-${currentProject().id}`;
export const conversationOptions = () => ({
  projectId: currentProject().id,
  models: models.map(({ id, name, provider }) => ({ id, name, provider })),
  targets: linksState.links.map((link) => ({ id: link.id, name: link.name })),
  messages: draftState.state.messages,
});
export async function mountConversationScreens() {
  try {
    const chips = await conversationScreens['../conversations.tsx']?.();
    workState.conversationChips?.unmount();
    workState.conversationChips = chips?.mountConversations($('conversation-chips'), api, {
      ...conversationOptions(),
      selected: draftState.draftConversation,
      onChange: (id) => {
        switchDraft(id);
        renderMessages();
      },
      onClosed: (id) => {
        if (sessionState.project) removeDraft(sessionState.project.id, id);
      },
      onFixed: followConversationModel,
      // [+] opens a tab at once (T-097): the next thing is to type.
      onCreated: () => $('body').focus(),
    });
  } catch {
    workState.conversationChips = undefined;
  }
  try {
    workState.mountCards = (await questionScreens['../question-card.tsx']?.())?.mountQuestionCards;
  } catch {
    workState.mountCards = undefined;
  }
  workState.questionCards?.unmount();
  workState.questionCards = undefined;
  renderQuestionCards();
}
/** The work shown on the right: the one chosen in the work history, else the newest running. */
export function focusedMessage() {
  const listed = draftState.state.messages.filter((m) => !m.request?.input?.parentRequestId);
  return (
    listed.find((m) => m.id === workState.focusedWork) ??
    [...listed].reverse().find((m) => ['queued', 'running'].includes(m.request?.state)) ??
    listed.at(-1)
  );
}
export function focusWork(id: string) {
  workState.focusedWork = id;
  revealPanel('right');
  mobileView('input');
  sidebar();
  renderConversation();
  $('thread').scrollTop = 0;
}
export function renderConversation() {
  renderWork(
    $('conversation'),
    focusedMessage(),
    draftState.state.messages,
    models,
    sessionState.project?.id,
    {
      // A sent image attachment reopens its reference-image tab (SPEC-09.2 2); not in host panels.
      ...(panelMode ? {} : { reference: openReferenceTab }),
      restore: (request) => {
        if (sessionState.busy) throw Error('현재 전송이 끝난 뒤 복원하세요.');
        const draft = request.input.linkedTargets
          ? linkedRequestDraft(draftState.state, request)
          : request.result?.recovered
            ? recoveredRequestDraft(draftState.state, request)
            : failedRequestDraft(draftState.state, request);
        if (
          (draftState.state.linkedTargets?.length ||
            draftState.state.body.trim() ||
            (draftState.state.instructions || []).length ||
            draftState.state.pins.length ||
            draftState.state.sketches.length ||
            draftState.state.files.length ||
            pendingSketch()) &&
          !confirm('현재 작성 중인 초안을 저장된 요청 입력으로 바꿀까요?')
        )
          return;
        Object.assign(draftState.state, draft);
        selectionState.selectedResult = draft.baseRequestId ?? null;
        selectionState.appliedSelection = undefined;
        selectionState.displayedResult = undefined;
        linksState.shownSignature = '';
        objects.splice(0, objects.length);
        viewerState.viewport?.replace([]);
        sketchState.strokes = [];
        setBody(draftState.state.body);
        render();
        renderMessages();
        revealPanel('right');
        mobileView('input');
        message('원 입력과 기준을 복원했습니다. 설정을 확인한 뒤 보내세요.');
      },
      candidate: (id) => {
        selectionState.selectedResult = id;
        selectionState.appliedSelection = undefined;
        renderMessages();
        showModelView();
      },
      selection: (requestId, id) => {
        selectInResult(requestId, id);
        showModelView();
      },
      report: downloadReport,
      saveReview: async (id) => {
        selectionState.selectedResult = id;
        renderMessages();
        await reviews.create(id, captureViewport());
      },
      reviewsOf: (id) => reviewsOf(sessionState.project?.id, id),
      openReview: (row) => {
        if (sessionState.project) openReview(sessionState.project.id, row);
      },
      changed: renderMessages,
      error: message,
      focus: focusWork,
      intervene: (id) => {
        void submitRequest(id);
      },
      interventionReason: (id) => interventionReason(id),
      direct: directAction,
    },
  );
}
/**
 * Direct-mode actions of the work view: [되돌리기] (…/undo {executionId}), the guard card's
 * [진행] (…/confirm {executionId}), the plan card's [진행] (…/continue) and [확인함] of an
 * unresolved result (…/acknowledge, T-102). A reply naming
 * another request (`requestId`, or a request with its own id) opens and follows it; otherwise the
 * request is read again.
 */
export async function directAction(
  id: string,
  action: 'undo' | 'confirm' | 'continue' | 'acknowledge',
  body: Record<string, unknown> = {},
) {
  const projectId = currentProject().id;
  // A 409 here: the request already ended or runs again; it is read again (SPEC-02.13 4).
  const reply = (await requestAction(`/projects/${projectId}/requests/${id}/${action}`, body, () =>
    poll(id, projectId),
  )) as {
    ok?: unknown;
    reason?: unknown;
    id?: unknown;
    input?: unknown;
    requestId?: unknown;
  } | null;
  if (reply?.ok === false) {
    // [되돌리기] of a whole request (ADR-027): the files left are named in the result; show it.
    if (action === 'undo' && body.all === true) {
      await poll(id, projectId);
      throw Error(errors.UNDO_PARTIAL);
    }
    const code = reply.reason === 'not-latest' ? 'UNDO_NOT_LATEST' : String(reply.reason ?? '');
    throw Error(errors[code] || errors.DIRECT_ACTION_FAILED);
  }
  const nextId =
    typeof reply?.requestId === 'string'
      ? reply.requestId
      : typeof reply?.id === 'string' && reply.input
        ? reply.id
        : undefined;
  if (sessionState.project?.id !== projectId) return;
  if (nextId && nextId !== id) {
    const request = await requestData(`/projects/${projectId}/requests/${nextId}`);
    if (!draftState.state.messages.some((entry) => entry.id === request.id))
      draftState.state.messages.push(requestMessage(request));
    workState.focusedWork = request.id;
    renderMessages();
    void poll(request.id, projectId);
    return;
  }
  await poll(id, projectId);
}
export function interventionReason(id: string): string | undefined {
  if (sessionState.busy || !sessionState.ready) return '현재 전송이 끝난 뒤 추가하세요.';
  const parent = draftState.state.messages.find((entry) => entry.id === id)?.request;
  const original = parent?.input;
  if (!parent || !original || original.parentRequestId) return '상위 작업에서 추가하세요.';
  if (!draftHasInput(draftState.state))
    return '작성기에 바꿀 조건을 쓰면 추가 지시를 보낼 수 있습니다.';
  const draft = interventionTargetDraft(draftState.state, parent);
  if (validate(draft)) return validate(draft);
  if (
    (original.host || 'rhino') !== draftState.state.host ||
    original.permission !== draftState.state.permission ||
    (original.baseRequestId ?? null) !== (draftState.state.baseRequestId ?? null) ||
    JSON.stringify(original.linkedTargets) !== JSON.stringify(draft.linkedTargets)
  )
    return '이 작업의 대상·기준·모드를 맞춘 뒤 추가하세요.';
  if (
    draftState.state.messages.some(
      (entry) =>
        entry.request.input.supersedesRequestId === id &&
        ['queued', 'running'].includes(entry.request.state),
    )
  )
    return '이미 추가 지시가 대기 중입니다.';
}
/** '계획부터 할까요?' over the composer: plan once (the toggle stays), or run in 자동 now. */
export function showPlanFirstCard() {
  const card = $('route-card');
  card.replaceChildren();
  el('p', 'Jev · 여러 단계나 여러 파일이 걸린 요청입니다. 계획부터 할까요?', card);
  const row = el('div', '', card, { class: 'route-card-actions' });
  el('button', '계획부터', row, { type: 'button', class: 'primary-button' }).onclick = () => {
    hideRouteCard();
    void submitRequest(undefined, 'plan');
  };
  el('button', '바로 진행', row, { type: 'button' }).onclick = () => {
    hideRouteCard();
    void submitRequest(undefined, 'auto');
  };
  el('button', '닫기', row, { type: 'button' }).onclick = hideRouteCard;
  card.hidden = false;
}
/** A proposal card over the composer (jig to open, T2 app action): one button carries it out. */
export function showRouteCard(
  text: string,
  run: { label: string; action: () => void } | undefined,
  toAi: () => void,
) {
  const card = $('route-card');
  card.replaceChildren();
  el('p', text, card);
  const row = el('div', '', card, { class: 'route-card-actions' });
  if (run)
    el('button', run.label, row, { type: 'button', class: 'primary-button' }).onclick = () => {
      hideRouteCard();
      run.action();
    };
  el('button', 'AI 작업으로 보내기', row, { type: 'button' }).onclick = toAi;
  el('button', '닫기', row, { type: 'button' }).onclick = hideRouteCard;
  card.hidden = false;
}
export function hideRouteCard() {
  $('route-card').classList.remove('route-row', 'reference-check');
  $('route-card').hidden = true;
  $('route-card').replaceChildren();
}
/**
 * The route row of a jig start (SPEC-07.18 3·7, RESEARCH-12 §6.2 M5): what opened, the checklist,
 * [진행] in 계획 and [일반 대화로] — never a card with only [닫기].
 */
export function renderSkillRow(options: { status?: string; progress?: () => void } = {}) {
  const shown = workState.shownSkill;
  const card = $('route-card');
  card.replaceChildren();
  if (!shown) {
    card.hidden = true;
    return;
  }
  card.classList.add('route-row');
  const start = shown.start;
  el(
    'p',
    `${shown.route.by === 'jev' ? 'Jev · ' : ''}jig · ${jigRouteText(
      start?.name ?? shown.route.jig?.name ?? '',
    )}${options.status ? ' · ' + options.status : ''}`,
    card,
    { class: 'route-row-head' },
  );
  if (start && !start.legacy) {
    const list = el('ul', '', card, { class: 'route-row-steps' });
    for (const item of skillChecklist(start))
      el('li', `${item.done ? '✓' : '□'} ${item.text}`, list, { 'data-done': String(item.done) });
    const summary = start.summary;
    if (summary && (summary.waiting.length || summary.failed.length))
      el(
        'p',
        [
          summary.waiting.length ? `사람 확인 대기: ${summary.waiting.join(', ')}` : '',
          summary.failed.length ? `멈춘 단계: ${summary.failed.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        card,
        { class: 'route-row-note' },
      );
  }
  const row = el('div', '', card, { class: 'route-card-actions' });
  if (options.progress)
    el('button', '진행', row, { type: 'button', class: 'primary-button' }).onclick =
      options.progress;
  el('button', '일반 대화로', row, { type: 'button' }).onclick = () => void skillToChat();
  card.hidden = false;
}
export function hideSkillRow() {
  workState.shownSkill = undefined;
  $('route-card').classList.remove('route-row');
  hideRouteCard();
}
/**
 * Screen actions the AI asked for in a conversation turn (jig_open, ui_go: ledger items the engine
 * recorded): each is carried out once, and only for items made while this page is open. 할 일 the
 * AI added or changed (SPEC-01.14 6) redraw the dashboard at once; the writes of one turn get one
 * notice with [되돌리기] when the turn has ended (`finished`, the request id).
 */
export const pageOpened = new Date().toISOString();
export const performedActions = new Set<string>();
export const agendaTurns = new AgendaTurns();
export async function followAppActions(conversationId: string, finished?: string) {
  let detail: {
    ledger?: { id: string; body?: unknown; createdAt?: string; requestId?: string | null }[];
  } | null;
  try {
    detail = (await api(
      `/projects/${encodeURIComponent(currentProject().id)}/conversations/${encodeURIComponent(conversationId)}`,
    )) as typeof detail;
  } catch {
    return;
  }
  for (const item of detail?.ledger ?? []) {
    const body = (item.body ?? {}) as Record<string, unknown>;
    if (performedActions.has(item.id) || body.by !== 'ai') continue;
    if (body.appAction === 'agenda') {
      performedActions.add(item.id);
      if ((item.createdAt ?? '') >= pageOpened) {
        agendaTurns.add(item);
        dispatchEvent(new Event(AGENDA_CHANGED));
      }
      continue;
    }
    if (body.appAction !== 'jig_open' && body.appAction !== 'ui_go') continue;
    performedActions.add(item.id);
    if ((item.createdAt ?? '') < pageOpened) continue;
    if (body.appAction === 'jig_open' && typeof body.jigId === 'string')
      void startSkill(skillDeps, body.jigId, {
        mode: draftState.mode,
        by: 'ai',
        conversationId,
        ...(body.reuse === 'new' ? { reuse: 'new' as const } : {}),
      })
        .then((start) => {
          if (start.conversationId)
            jigConversations.set(start.conversationId, start.instanceId || null);
          message(`AI가 '${start.name}'을(를) 열었습니다.`);
        })
        .catch((cause) => message(readableError(cause).message));
    else if (body.appAction === 'ui_go' && typeof body.stage === 'string') {
      const own = jigConversations.get(conversationId);
      if (body.stage === 'jig' && own) setWorkspace('', { instanceId: own });
      else setWorkspace(body.stage);
      if (body.view === 'plan' || body.view === '3d') {
        $('projection').value = body.view === 'plan' ? 'plan' : 'axon';
        $('projection').dispatchEvent(new Event('change'));
      }
    }
  }
  for (const turn of agendaTurns.take(finished)) followAgenda(conversationId, turn);
}
/**
 * One turn's 할 일 notice: what the AI added or changed, with [되돌리기] for all of that turn's
 * writes. It stays until it is used or closed (the reply is read first).
 */
export function followAgenda(conversationId: string, turn: AgendaTurn) {
  const text = agendaNotice(turn.body);
  if (!text) return;
  const projectId = currentProject().id;
  messageWithActions(
    text,
    [
      {
        label: '되돌리기',
        run: () =>
          void api(`/projects/${encodeURIComponent(projectId)}/agenda/undo`, 'POST', {
            conversationId,
            ledgerIds: turn.ledgerIds,
          })
            .then((value) => {
              dispatchEvent(new Event(AGENDA_CHANGED));
              const { skipped } = value as { skipped?: number };
              message(
                skipped
                  ? `되돌렸습니다. 그 뒤에 바뀌었거나 빠진 ${skipped}개는 그대로 둡니다.`
                  : '되돌렸습니다.',
              );
            })
            .catch((cause) => {
              const error = readableError(cause);
              message(
                error.code === 'AGENDA_UNDONE'
                  ? '이미 되돌렸습니다.'
                  : errors[error.code ?? ''] || error.message,
              );
            }),
      },
      { label: '대시보드', run: () => setWorkspace('dashboard') },
      { label: '닫기', run: () => {} },
    ],
    { keep: true },
  );
}
export async function poll(
  id: string,
  projectId = currentProject().id,
  original = draftState.state,
) {
  if (sessionState.project?.id !== projectId || draftState.state !== original) return;
  if (selectionState.selectedResult === undefined)
    selectionState.selectedResult = selectionState.displayedResult ?? null;
  try {
    const request = await requestData(`/projects/${projectId}/requests/${id}`);
    const children = await Promise.all(
      (request.result?.targetResults || []).map((target) =>
        requestData(`/projects/${projectId}/requests/${target.requestId}`),
      ),
    );
    if (sessionState.project?.id !== projectId || draftState.state !== original) return;
    for (const child of children) {
      const existing = draftState.state.messages.find((message) => message.id === child.id);
      if (existing) existing.request = child;
      else draftState.state.messages.push(requestMessage(child));
    }
    const m = draftState.state.messages.find((x) => x.id === id);
    if (m) m.request = request;
    // Screen actions the AI asked for in this conversation turn (jig_open, ui_go).
    const turnConversation = (request.input as { conversationId?: unknown }).conversationId;
    if (typeof turnConversation === 'string')
      void followAppActions(
        turnConversation,
        ['queued', 'running'].includes(request.state) ? undefined : request.id,
      );
    if (request.result?.hostExecuted && workState.foregroundRequest?.id === id) {
      if (
        workState.foregroundRequest.selected === selectionState.selectedResult &&
        workState.foregroundRequest.draft === focusDraft()
      )
        selectionState.selectedResult = request.id;
      workState.foregroundRequest = undefined;
    }
    renderMessages();
    render();
    if (['queued', 'running'].includes(request.state))
      setTimeout(() => poll(id, projectId, original), 1200);
  } catch (cause) {
    const error = readableError(cause);
    if (sessionState.project?.id !== projectId || draftState.state !== original) return;
    message('작업 상태 연결이 끊겼습니다. 새로고침하면 저장된 기록을 다시 읽습니다.');
  }
}
export async function downloadReport(id: string) {
  try {
    selectionState.selectedResult = id;
    renderMessages();
    const response = await fetch(`api/v1/projects/${currentProject().id}/requests/${id}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: captureViewport() }),
    });
    if (!response.ok) {
      const failure = await response.json();
      throw Error(failure.code);
    }
    const url = URL.createObjectURL(await response.blob()),
      anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'VIDE-review.html';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (cause) {
    const error = readableError(cause);
    message(error.message);
  }
}

export function initThread1() {
  $('toggle-recent').onclick = () => {
    const open = $('recent-section').dataset.open !== 'true';
    $('recent-section').dataset.open = String(open);
    $('toggle-recent').setAttribute('aria-expanded', String(open));
  };
}

/** render(): the request queue under the work view (rebuilt unless only a draft field changed). */
export function paintRequestQueue(rebuildRequests: boolean) {
  if (rebuildRequests) renderRequests(draftState.state, render);
}

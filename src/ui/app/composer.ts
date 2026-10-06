// Composer (PLAN-26 T-113, region D): the draft and its mode, model and effort, context chips,
// attachments, request routing (view, setting, app action, jig start) and sending.
import { requestAdmission, waitingOf } from '../../contracts/request-scope.ts';
import { requestMode } from '../../contracts/workspace.ts';
import { attachmentPreview, addViewCopy, uploadAttachments } from '../attachments.ts';
import { element as $, readableError } from '../elements.ts';
import {
  models,
  chooseModel,
  draftHasInput,
  objects,
  objectById,
  validate,
  packet,
} from '../model.ts';
import {
  rememberConversation,
  restoreDraft,
  draftKey,
  draftSnapshot,
  clearStoredDraft,
} from '../draft-storage.ts';
import { tokenLabels, attachPinTokens } from '../pin-tokens.ts';
import { sourceIdOf, displayIdOf } from '../layers.ts';
import {
  type RouteContext,
  officialRouteJigs,
  instanceRouteContext,
  type Route,
  routeRequest,
  routeSubjects,
  routeQuery,
  routeAnswer,
  jevRoute,
  routeRevert,
  routeCard,
  goesToAi,
  worksOnFile,
} from '../request-route.ts';
import { skillRouteJigs } from '../skill-catalog.ts';
import { api, errors } from '../gateway.ts';
import { type SkillStart, startSkill, continueSkill, revertSkill } from '../skill-start.ts';
import { setWorkspace } from '../workspaces.ts';
import {
  referenceIntent,
  pathCandidates,
  imagesAtPaths,
  attachImagePath,
} from '../reference-check.ts';
import { interventionTargetDraft } from '../linked-draft.ts';
import { requestData, requestMessage, modelsSchema } from '../workspace-data.ts';
import { waitingText } from '../request-scope.ts';
import { setReferenceBridge } from '../reference-bridge.ts';
import { draftState, paintComposer, type ContextItem, type WorkMode } from '../store/draft.ts';
import { sessionState } from '../store/session.ts';
import { sketchState } from '../store/sketch.ts';
import { selectionState } from '../store/selection.ts';
import { viewerState } from '../store/viewer.ts';
import { workState } from '../store/work.ts';
import { linksState } from '../store/links.ts';
import {
  openSettings,
  refreshAccount,
  message,
  messageWithActions,
  messageWithAction,
} from './status.ts';
import { type ShortcutResult } from './shortcuts.ts';
import { setHostPins, attachPanelSelection } from './boot.ts';
import { panelView, panelHost, panelMode, currentProject } from './context.ts';
import { render, renderMessages } from './render.ts';
import { pendingSketch, attachStrokes, draw, annotatedCapture } from './viewport.ts';
import {
  hideRouteCard,
  renderSkillRow,
  hideSkillRow,
  showRouteCard,
  showPlanFirstCard,
  showReferenceCard,
  interventionReason,
  currentConversation,
  poll,
  defaultRowId,
} from './thread.ts';
import {
  skillCatalog,
  openJigInstance,
  jigInstancePath,
  skillDeps,
  jigConversations,
  openReferenceTab,
  jigConversation,
} from './glue.ts';
import { syncLink } from './links-sync.ts';

export const modeKey = (projectId: string) => 'vide:mode:' + projectId;
export const modeFields = (value: WorkMode) =>
  ({ mode: value, permission: value === 'plan' ? 'review' : 'candidate' }) as const;
/** A stored request's mode; older requests carry only the permission (review → 계획). */
export const modeOf = (input: { mode?: unknown; permission?: unknown }): WorkMode =>
  requestMode(input);
export function loadMode(projectId: string) {
  try {
    draftState.mode = localStorage.getItem(modeKey(projectId)) === 'plan' ? 'plan' : 'auto';
  } catch {
    draftState.mode = 'auto';
  }
}
export function setMode(next: WorkMode) {
  draftState.mode = next;
  try {
    if (sessionState.project) localStorage.setItem(modeKey(sessionState.project.id), next);
  } catch {
    // The mode stays for this page only.
  }
  render();
}
/** Keeps the draft's permission field in step with the mode and draws the toggle. */
export function syncMode() {
  draftState.state.permission = draftState.mode === 'plan' ? 'review' : 'candidate';
  draftState.view.mode = draftState.mode;
  draftState.view.ready = sessionState.ready;
  paintComposer();
  $('mode-status').textContent =
    draftState.mode === 'plan' ? '계획 · 문서를 바꾸지 않음' : '자동 · 열린 문서에 바로 적용';
}
/**
 * The composer's model follows the chosen conversation's fixed AI (SPEC-02.19 2), so sending there
 * keeps it; a conversation whose first turn has not chosen yet goes back to "자동 (Jev)" unless the
 * user picked a model themselves.
 */
export function followConversationModel(fixed: { provider: string; model: string | null } | null) {
  const automatic = models.find((m) => m.id === 'auto');
  const target = fixed
    ? (models.find(
        (m) => m.provider === fixed.provider && m.id === (fixed.model ?? fixed.provider),
      ) ?? automatic)
    : draftState.modelFollowsConversation
      ? automatic
      : undefined;
  if (!target) return;
  draftState.modelFollowsConversation = !!fixed;
  if (target.id === draftState.state.model) return;
  chooseModel(draftState.state, target.id);
  void refreshAccount();
  render();
}
/**
 * Another conversation tab was chosen (SPEC-02.19 1, 2026-10-02): the composer's draft (words,
 * request list, attachments, pins, sketches, mode, effort) stays with the tab it was written in
 * and the chosen tab's own draft comes back. The draft object is changed in place, so polls and a
 * send in flight (they compare `state`) go on. A tab without a draft starts empty with the mode
 * and effort of the tab before it; the model follows the conversation (`onFixed`).
 */
export function switchDraft(next: string | null) {
  if (!sessionState.project || next === draftState.draftConversation) return;
  const projectId = sessionState.project.id;
  // Strokes drawn but not attached belong to the draft they were drawn for.
  if (pendingSketch())
    try {
      attachStrokes();
    } catch {
      sketchState.strokes = [];
    }
  render(false);
  draftState.draftConversation = next;
  if (!panelMode) rememberConversation(projectId, next);
  hideRouteCard();
  draftState.unreadableDraft = false;
  let restored: ReturnType<typeof restoreDraft> | undefined;
  try {
    const raw = localStorage.getItem(draftKey(projectId, next));
    if (raw) restored = restoreDraft(JSON.parse(raw), draftState.state.messages);
  } catch {
    draftState.unreadableDraft = true;
    message('이 대화의 저장된 초안을 확인할 수 없습니다. 작업 이력은 유지됩니다.');
  }
  Object.assign(draftState.state, {
    body: '',
    instructions: [],
    pins: [],
    sketches: [],
    files: [],
    linkedTargets: undefined,
    coordinateBasis: undefined,
    baseRequestId: selectionState.displayedResult,
  });
  if (restored) {
    // The selection and the shared request list stay as they are.
    const draft: Partial<typeof restored> = { ...restored };
    delete draft.selected;
    delete draft.messages;
    Object.assign(draftState.state, draft);
    // The draft's model is the user's choice; a fixed conversation still overrides it (onFixed).
    draftState.modelFollowsConversation = false;
    if (!models.some((m) => m.id === draftState.state.model)) {
      const first = models.find((m) => m.provider === draftState.state.model) ?? models[0];
      if (first) chooseModel(draftState.state, first.id);
    }
    draftState.mode = draftState.state.permission === 'review' ? 'plan' : 'auto';
    if (
      draftHasInput(draftState.state) &&
      draftState.state.baseRequestId &&
      draftState.state.baseRequestId !== selectionState.selectedResult
    ) {
      selectionState.selectedResult = draftState.state.baseRequestId;
      selectionState.appliedSelection = undefined;
    }
  }
  setBody(draftState.state.body);
  render();
  draw();
}
export const focusDraft = () =>
  JSON.stringify({ draft: draftSnapshot(draftState.state), strokes: sketchState.strokes });
/** A chip over the message box (`#context`), drawn by shell/composer.tsx. */
function chip(
  items: ContextItem[],
  text: string,
  remove: () => void,
  title?: string,
  select?: () => void,
  thumbnail?: string,
  action?: { label: string; title: string; run: () => void },
) {
  items.push({ kind: 'chip', text, remove, title, select, thumbnail, action });
}
/** Model menu grouped by service; an older draft's "CLI default" becomes that service's first model. */
export function fillModels() {
  const labels: Record<string, string> = { 'claude-cli': 'Claude', 'codex-cli': 'ChatGPT' };
  // "자동 (Jev)" picks the service itself, so it sits first, outside the service groups.
  const automatic = (model: { id: string }) => model.id === 'auto';
  const choice = (model: { id: string; name: string }) => ({ id: model.id, name: model.name });
  const listed = models.filter((m) => !automatic(m));
  draftState.view.models = {
    first: models.filter(automatic).map(choice),
    groups: [...new Set(listed.map((m) => m.provider))].map((provider) => ({
      label: labels[provider] ?? provider,
      options: listed.filter((m) => m.provider === provider).map(choice),
    })),
  };
  draftState.view.extraModels = [];
  if (!models.some((m) => m.id === draftState.state.model)) {
    const first = models.find((m) => m.provider === draftState.state.model);
    if (first) chooseModel(draftState.state, first.id);
  }
  draftState.view.model = draftState.state.model;
  paintComposer();
}
/** Selected objects of the displayed model that can be pinned (they belong to a request basis). */
export function pinnable() {
  return selectionState.selectedIds.flatMap((id) => {
    const object = objectById(id);
    return object?.revision ? [object] : [];
  });
}
export let pinComposer!: ReturnType<typeof attachPinTokens>;
export const routeObjects = () =>
  objects.map((object) => ({
    id: object.id,
    type: object.type,
    layer: object.layerName ?? object.layer,
    name: object.name,
  }));
/**
 * What the words are read against: the skill catalog (this project's jigs first; the official
 * list when it cannot be read) and the open jig's settings.
 */
export async function routeContext(): Promise<{ context: RouteContext; instanceId?: string }> {
  const jigs = await skillCatalog()
    .then(skillRouteJigs)
    .catch(() => officialRouteJigs());
  const instanceId = openJigInstance();
  if (!instanceId) return { context: { jigs } };
  try {
    const view = (await api(jigInstancePath(instanceId))) as {
      params?: unknown;
      jig?: { id?: unknown };
    } | null;
    const openJig = typeof view?.jig?.id === 'string' ? view.jig.id : undefined;
    return {
      context: { jigs, ...instanceRouteContext(view?.params), ...(openJig ? { openJig } : {}) },
      instanceId,
    };
  } catch {
    return { context: { jigs } };
  }
}
/** Request routing (SPEC-02.17): Jev decides; without a key or on failure, the rules. */
export async function decideRoute(
  body: string,
): Promise<{ route: Route; instanceId?: string; planFirst?: boolean }> {
  const { context, instanceId } = await routeContext();
  const rules = routeRequest(body, routeObjects(), selectionState.selectedIds, context);
  const subjects = routeSubjects(routeObjects(), selectionState.selectedIds);
  try {
    const raw = await api(
      `/projects/${currentProject().id}/route`,
      'POST',
      routeQuery(body, subjects, context),
    );
    const answer = routeAnswer(raw);
    const route =
      answer.target === null ? rules : (jevRoute(answer, subjects, rules, context, body) ?? rules);
    return { route, instanceId, planFirst: suggestsPlan(raw) };
  } catch {
    return { route: rules, instanceId };
  }
}
/**
 * Jev judges a request complex (`task: 'complex'` in the /route answer, RouteDecision): in 자동 the
 * composer suggests '계획부터' before anything runs.
 */
export function suggestsPlan(raw: unknown) {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return value.task === 'complex';
}
/**
 * 'AI 작업으로 보내기' (SPEC-02.17 2): undo what VIDE did, record the reversal (route and who chose
 * it, never the words) and send the same words to the AI.
 */
/** The message box's text (`#body`); every writer outside the box itself goes through here. */
export function setBody(text: string) {
  $('body').value = text;
}
export function sendToAi(route: Route, body: string, undo: () => void = () => {}) {
  return () => {
    undo();
    hideRouteCard();
    void api(`/projects/${currentProject().id}/route/revert`, 'POST', routeRevert(route)).catch(
      () => {},
    );
    draftState.state.body = body;
    setBody(body);
    render();
    void submitRequest();
  };
}
export function clearComposer() {
  draftState.state.body = '';
  setBody('');
  render();
}
/** The jig screens read the instance again after a setting changed from the request box. */
export const jigParamsChanged = (instanceId: string) =>
  window.dispatchEvent(new CustomEvent('vide:jig-params-changed', { detail: { instanceId } }));
/**
 * A setting of the open jig read from the words (SPEC-02.17 2, SPEC-07.6): applied at once without
 * the AI, with an undo; a value the words do not give, a fixed setting or one out of range is not
 * applied and the notice says why.
 */
export async function runParamRequest(route: Route, body: string, instanceId: string | undefined) {
  // One setting, or several named in one request ("경간 11로, 작은보 간격 2.2").
  const entries = route.params ?? (route.param ? [route.param] : []);
  const applied = entries.filter((entry) => entry.change.ok);
  const toAiOnly = (text: string) =>
    messageWithActions(text, [{ label: 'AI 작업으로 보내기', run: sendToAi(route, body) }]);
  if (!applied.length) return toAiOnly(entries.map((entry) => entry.change.text).join(' '));
  if (!instanceId) return toAiOnly('설정값을 바꿀 jig 작업본이 열려 있지 않습니다.');
  const path = jigInstancePath(instanceId);
  try {
    const result = (await api(`${path}/params`, 'PUT', {
      values: applied.map((entry) => ({
        key: entry.key,
        value: (entry.change as { value: number | string | boolean }).value,
      })),
      by: 'user',
      reason: '요청 입력',
    })) as { seqs?: unknown } | null;
    const seqs = (Array.isArray(result?.seqs) ? result.seqs.map(Number) : []).filter(
      (seq) => Number.isInteger(seq) && seq > 0,
    );
    clearComposer();
    jigParamsChanged(instanceId);
    const undoable = seqs.length > 0;
    const undo = () => {
      if (!undoable) return;
      void (async () => {
        for (const seq of [...seqs].reverse()) await api(`${path}/params/undo`, 'POST', { seq });
      })()
        .then(() => jigParamsChanged(instanceId))
        .catch((cause) => {
          const error = readableError(cause);
          message(errors[error.code ?? ''] || error.message);
        });
    };
    const text = routeCard(route)?.text ?? applied.map((entry) => entry.change.text).join(' · ');
    messageWithActions(text, [
      ...(undoable ? [{ label: '되돌리기', run: undo }] : []),
      { label: 'AI 작업으로 보내기', run: sendToAi(route, body, undo) },
    ]);
  } catch (cause) {
    const error = readableError(cause);
    toAiOnly(errors[error.code ?? ''] || error.message);
  }
}
export const skillErrors: Record<string, string> = {
  JIG_USER_ONLY: '이 jig는 사용자가 JIG 목록에서 직접 엽니다.',
  NOT_FOUND: '이 jig를 이 프로젝트에서 찾지 못했습니다.',
  JIG_INVALID: '이 jig의 설명서에 문제가 있어 열 수 없습니다.',
};
/** The AI turn after a start: the request's words in the jig's conversation, without the host. */
export async function sendSkillTurn(body: string, sendMode: WorkMode) {
  const typed = draftState.state.body;
  draftState.state.body = body;
  setBody(body);
  render();
  const before = new Set(draftState.state.messages.map((entry) => entry.id));
  await submitRequest(undefined, sendMode, { hostUse: 'none' });
  const sent = draftState.state.messages.find((entry) => !before.has(entry.id));
  if (workState.shownSkill && sent) {
    workState.shownSkill.aiRequest = sent.id;
    if (workState.shownSkill.start) workState.shownSkill.start.aiRequest = sent.id;
    renderSkillRow({ status: 'AI가 요약하는 중' });
  }
  // Something typed meanwhile stays in the composer.
  if (typed.trim() && typed !== body && !draftState.state.body) {
    draftState.state.body = typed;
    setBody(typed);
    render();
  }
}
/**
 * A request judged to be a jig (ADR-026 4): open and compute it at once (자동), or open and bind
 * it with a checklist and [진행] (계획); then the AI summarizes and asks what is unclear.
 */
export async function runSkillRoute(route: Route, body: string) {
  const jig = route.jig!;
  const runMode = draftState.mode;
  workState.shownSkill = { body, route };
  renderSkillRow({ status: '여는 중…' });
  let start: SkillStart;
  try {
    start = await startSkill(skillDeps, jig.id, {
      mode: runMode,
      request: body,
      by: route.by ?? 'rules',
    });
  } catch (cause) {
    // Nothing moved (SPEC-07.18 7): the reason, the JIG list and the words to the AI.
    hideSkillRow();
    const code = String((cause as { code?: unknown } | null)?.code ?? '');
    messageWithActions(
      `'${jig.name}'을(를) 열지 못했습니다. ${skillErrors[code] ?? readableError(cause).message}`,
      [
        { label: 'JIG 목록에서 열기', run: () => setWorkspace('jig') },
        { label: '일반 대화로', run: sendToAi(route, body) },
      ],
    );
    return;
  }
  if (workState.shownSkill?.body !== body) return;
  workState.shownSkill.start = start;
  if (start.conversationId) jigConversations.set(start.conversationId, start.instanceId || null);
  if (start.legacy) {
    renderSkillRow({ status: '열었습니다' });
    return;
  }
  if (start.pending) {
    renderSkillRow({
      status: '계획 · [진행]을 누르면 계산합니다',
      progress: () => void progressSkill(start, body),
    });
    return;
  }
  renderSkillRow({ status: '계산했습니다 · AI가 요약합니다' });
  await sendSkillTurn(body, runMode);
}
/** [진행] of a 계획 start: make or open, apply, compute, then the AI turn. */
export async function progressSkill(start: SkillStart, body: string) {
  renderSkillRow({ status: '계산하는 중…' });
  try {
    await continueSkill(skillDeps, start, body);
  } catch (cause) {
    renderSkillRow({ status: '멈춤 · ' + readableError(cause).message });
    return;
  }
  if (start.conversationId) jigConversations.set(start.conversationId, start.instanceId || null);
  renderSkillRow({ status: '계산했습니다 · AI가 요약합니다' });
  // [진행] is the person's go-ahead for this jig: the turn may set its settings from the answers.
  await sendSkillTurn(body, 'auto');
}
/**
 * [일반 대화로] (SPEC-02.17 3): close what the start opened, undo its settings, stop its AI turn,
 * record the reversal and send the same words as an ordinary AI turn.
 */
export async function skillToChat() {
  const shown = workState.shownSkill;
  if (!shown) return;
  hideSkillRow();
  const projectId = currentProject().id;
  if (shown.aiRequest)
    await api(`/projects/${projectId}/requests/${shown.aiRequest}/cancel`, 'POST').catch(
      () => undefined,
    );
  if (shown.start) await revertSkill(skillDeps, shown.start).catch(() => undefined);
  else
    await api(`/projects/${projectId}/route/revert`, 'POST', routeRevert(shown.route)).catch(
      () => undefined,
    );
  draftState.state.body = shown.body;
  setBody(shown.body);
  render();
  void submitRequest();
}
/** Which linked file an app action names: the one chosen, the only one, or the one open now. */
export function routedLink(id?: string) {
  if (id) return linksState.links.find((entry) => entry.id === id);
  if (linksState.links.length === 1) return linksState.links[0];
  return linksState.links.find(
    (entry) =>
      entry.connection?.instance === linksState.connectedTarget?.instance &&
      entry.connection?.documentId === linksState.connectedTarget?.documentId,
  );
}
/**
 * Routes VIDE does itself (SPEC-02.17 2·3, SPEC-02.19 7): a jig or a T1 app action (Sync) is
 * proposed on a card with its one button, a T2 one waits for its confirmation card. Every notice
 * and card keeps 'AI 작업으로 보내기'.
 */
export function runAppRoute(route: Route, body: string) {
  const toAi = sendToAi(route, body);
  const card = routeCard(route, { signedIn: sessionState.providerSignedIn });
  if (!card) return void submitRequest();
  if (route.jig) {
    void runSkillRoute(route, body);
    return;
  }
  const app = route.app!;
  if (app.action === 'sync_link') {
    const link = routedLink(app.link);
    if (!link?.connection) {
      messageWithActions(
        '다시 Sync 받을 연결 파일을 찾지 못했습니다. 연결 파일 목록에서 고르세요.',
        [{ label: 'AI 작업으로 보내기', run: toAi }],
      );
      return;
    }
    // T1 (SPEC-02.19 7): proposed on a card and run by the person's press, never by the words alone.
    showRouteCard(
      `'${link.name}'을(를) 다시 Sync 받을까요? 원본은 그대로입니다.`,
      {
        label: 'Sync 받기',
        action: () => {
          clearComposer();
          void syncLink(link);
        },
      },
      toAi,
    );
    return;
  }
  if (card.tier === 'R' || !card.run) {
    messageWithActions(card.text, [{ label: 'AI 작업으로 보내기', run: toAi }]);
    return;
  }
  // The connector install and offline view happen in the settings. (Signing in, out and switching
  // accounts are answered with where to do it, ADR-025: those cards have no button.)
  const open =
    app.action === 'export'
      ? () => message('내보내기는 jig 결과 표나 산출물 › 검토본 화면의 내보내기 버튼에서 합니다.')
      : () => openSettings();
  showRouteCard(
    card.text,
    {
      label: card.run,
      action: () => {
        clearComposer();
        open();
      },
    },
    toAi,
  );
}
/** A screen-only request changes the VIDE view; the file and AI are not involved. */
export function runViewRequest(route: Route, body: string) {
  const view = route.view!;
  // Sending it to the AI after all: undo the view change and send the same words.
  const toAi = (undo: () => void) => sendToAi(route, body, undo);
  if (view.action !== 'unhide' && !view.ids.length) {
    messageWithAction(
      '화면에서 어떤 객체인지 찾지 못했습니다. 객체를 고른 뒤 다시 보내거나, AI에게 맡기세요.',
      'AI 작업으로 보내기',
      toAi(() => {}),
    );
    return;
  }
  const count = view.ids.length.toLocaleString();
  const before = [...selectionState.selectedIds];
  if (view.action === 'hide') viewerState.viewport?.hide(view.ids);
  else if (view.action === 'isolate') viewerState.viewport?.isolate(view.ids);
  else if (view.action === 'unhide') viewerState.viewport?.unhide();
  else if (view.action === 'fit') viewerState.viewport?.fit(view.ids);
  else {
    selectionState.selectedIds = [...view.ids];
    draftState.state.selected = selectionState.selectedIds.at(-1) ?? null;
  }
  const verb = {
    hide: '숨김',
    isolate: '만 표시',
    unhide: '모두 보이기',
    select: '선택',
    fit: '확대',
  }[view.action];
  draftState.state.body = '';
  setBody('');
  render();
  messageWithAction(
    view.action === 'unhide'
      ? '숨긴 객체를 모두 다시 보입니다 · 원본은 그대로입니다.'
      : `화면에서 ${view.subject} ${count}개 ${verb} · 원본은 그대로입니다. 다시 보이게 하려면 U.`,
    'AI 작업으로 보내기',
    toAi(() => {
      if (view.action === 'hide' || view.action === 'isolate') viewerState.viewport?.unhide();
      if (view.action === 'select') {
        selectionState.selectedIds = before;
        draftState.state.selected = selectionState.selectedIds.at(-1) ?? null;
      }
    }),
  );
}
/** Attachments and paths already answered on the check before sending (SPEC-09.11 4). */
export const referenceAnswered = new Set<string>();
export const pathRefusals: Record<string, string> = {
  FILE_FORBIDDEN: '이 위치의 파일은 읽지 않습니다(키·로그인·VIDE 데이터 폴더).',
  FILE_NOT_FOUND: '그 파일이 이 PC에 없습니다.',
  FORBIDDEN: '원격 세션에서는 이 PC의 경로를 읽지 않습니다.',
};
/** A picked image of a path in the words becomes an attachment and opens its reference tab. */
export async function attachPathImage(path: string) {
  try {
    if (!sessionState.project || !sessionState.ready) throw Error('프로젝트를 연 뒤 첨부하세요.');
    if (sessionState.busy) throw Error('현재 요청 전송이 끝난 뒤 첨부하세요.');
    const projectId = sessionState.project.id,
      conversation = draftState.draftConversation;
    message('이미지를 첨부하는 중입니다.');
    const kept = await attachImagePath(api, projectId, path);
    if (sessionState.project?.id !== projectId || draftState.draftConversation !== conversation)
      throw Error('대화가 바뀌어 이미지 첨부를 취소했습니다.');
    if (!draftState.state.files.some((entry) => entry.id === kept.id))
      draftState.state.files.push(kept);
    render();
    // A large image gets the smaller copy the model sees, as a picked file does.
    void addViewCopy(projectId, kept);
    openReferenceTab({ id: kept.id, name: kept.name });
    message(`${kept.name}을(를) 첨부했습니다.`);
  } catch (cause) {
    const error = readableError(cause);
    message(
      pathRefusals[error.code ?? error.message] ||
        errors[error.code ?? error.message] ||
        error.message,
    );
  }
}
export function sendComposer() {
  if (!draftState.state.body.trim() || draftState.state.linkedTargets || sessionState.busy) {
    void submitRequest();
    return;
  }
  if (draftState.routing) return;
  draftState.routing = true;
  paintComposer();
  const body = draftState.state.body;
  hideRouteCard();
  void decideRoute(body)
    .then(({ route, instanceId, planFirst }) => {
      if (route.target === 'view') runViewRequest(route, body);
      else if (route.target === 'param') void runParamRequest(route, body, instanceId);
      else if (goesToAi(route) && planFirst && draftState.mode === 'auto') showPlanFirstCard();
      else if (goesToAi(route)) void submitRequest();
      else runAppRoute(route, body);
    })
    .finally(() => {
      draftState.routing = false;
      paintComposer();
    });
}
export async function submitRequest(
  predecessorId?: string,
  sendMode: WorkMode = draftState.mode,
  extra: { hostUse?: 'none' } = {},
) {
  if (
    validate(draftState.state) ||
    sessionState.busy ||
    !sessionState.project ||
    (predecessorId && interventionReason(predecessorId))
  )
    return;
  sessionState.busy = true;
  render();
  // The draft being sent: another tab chosen meanwhile keeps its own draft (SPEC-02.19 1).
  const sentDraft = draftState.draftConversation;
  const predecessor =
    predecessorId && draftState.state.messages.find((entry) => entry.id === predecessorId)?.request;
  const chosen = predecessorId ? undefined : currentConversation();
  // The default conversation's turns go as `default`: its first turn fixes its AI (SPEC-02.19 2).
  const conversationId =
    chosen ?? (!predecessorId && workState.conversationChips ? 'default' : undefined);
  // A jig conversation's turns work on its jig (the jig tools), unless the words name the file.
  const hostless =
    extra.hostUse === 'none' ||
    (!predecessor &&
      !draftState.state.linkedTargets &&
      !worksOnFile(draftState.state.body) &&
      !!(await jigConversation(chosen)));
  // Another tab chosen while its jig was looked up: that tab's draft is not what was meant.
  if (draftState.draftConversation !== sentDraft) {
    sessionState.busy = false;
    render();
    return;
  }
  const input = {
    ...packet(
      predecessor ? interventionTargetDraft(draftState.state, predecessor) : draftState.state,
    ),
    ...modeFields(predecessor ? modeOf(predecessor.input) : sendMode),
    id: crypto.randomUUID(),
    ...(conversationId ? { conversationId } : {}),
    ...(hostless ? { hostUse: 'none' } : {}),
  };
  // Pins and sketches also go to the AI as a picture of the view with them drawn (PLAN-24).
  const image = predecessor ? undefined : annotatedCapture();
  if (image) Object.assign(input, { images: [image] });
  const projectId = currentProject().id,
    original = draftState.state;
  try {
    const path =
      `/projects/${projectId}/requests` + (predecessorId ? `/${predecessorId}/interventions` : '');
    const request = await requestData(path, 'POST', input);
    if (sessionState.project?.id !== projectId || draftState.state !== original) return;
    if (!draftState.state.messages.some((entry) => entry.id === request.id))
      draftState.state.messages.push(requestMessage(request));
    if (draftState.draftConversation === sentDraft) {
      draftState.state.body = '';
      draftState.state.instructions = [];
      draftState.state.pins = [];
      draftState.state.sketches = [];
      draftState.state.files = [];
      draftState.state.linkedTargets = undefined;
      draftState.state.coordinateBasis = undefined;
      setBody('');
    } else clearStoredDraft(draftKey(projectId, sentDraft));
    if (selectionState.selectedResult === undefined)
      selectionState.selectedResult = selectionState.displayedResult ?? null;
    workState.foregroundRequest = {
      id: request.id,
      selected: selectionState.selectedResult,
      draft: focusDraft(),
    };
    workState.focusedWork = request.id;
    renderMessages();
    void workState.conversationChips?.refresh();
    void poll(request.id, projectId, original);
    // Another model than the conversation's: the server opened a new conversation and sent the
    // request there (SPEC-02.19 5); its tab is chosen.
    const landed = (request.input as { conversationId?: unknown }).conversationId;
    if (
      conversationId &&
      typeof landed === 'string' &&
      landed !== conversationId &&
      landed !== defaultRowId()
    ) {
      workState.conversationChips?.select(landed);
      const model = (request.input as { model?: unknown }).model;
      message(
        `모델이 달라 새 대화로 이어서 보냈습니다 · ${models.find((m) => m.id === model)?.name ?? model ?? ''}`,
      );
      return;
    }
    const waiting = waitingOf(request);
    if (waiting) message(`${waitingText(waiting)} · 앞 작업이 끝나면 자동으로 시작합니다.`);
  } catch (cause) {
    const error = readableError(cause);
    message(errors[error.code ?? ''] || error.message);
  } finally {
    sessionState.busy = false;
    render();
  }
}
/** Shift+Tab switches 계획 ↔ 자동, like Claude Code. */
export function cycleMode() {
  setMode(draftState.mode === 'plan' ? 'auto' : 'plan');
  const button = document.querySelector<HTMLButtonElement>(
    `#mode-toggle [data-mode="${draftState.mode}"]`,
  );
  message(`${button?.textContent ?? draftState.mode} · ${button?.title ?? ''}`);
}
/**
 * Composer attachments (SPEC-01.12): any type, picked, pasted or dropped; the engine keeps each
 * file and the draft holds its record (no size or count cap, ADR-031 7).
 */
export async function attachFiles(files: File[]) {
  if (!files.length) return;
  try {
    if (!sessionState.project || !sessionState.ready) throw Error('프로젝트를 연 뒤 첨부하세요.');
    if (sessionState.busy) throw Error('현재 요청 전송이 끝난 뒤 첨부하세요.');
    const original = draftState.state,
      conversation = draftState.draftConversation;
    message(`파일 ${files.length}개를 첨부하는 중입니다.`);
    const kept = await uploadAttachments(currentProject().id, files);
    if (draftState.state !== original) throw Error('프로젝트가 바뀌어 파일 첨부를 취소했습니다.');
    if (draftState.draftConversation !== conversation)
      throw Error('대화가 바뀌어 파일 첨부를 취소했습니다. 그 대화에서 다시 첨부하세요.');
    // The same content attached again is one entry.
    for (const file of kept)
      if (!draftState.state.files.some((entry) => entry.id === file.id))
        draftState.state.files.push(file);
    render();
    message(`파일 ${kept.length}개를 첨부했습니다.`);
  } catch (cause) {
    const error = readableError(cause);
    message(errors[error.code ?? error.message] || error.message);
  }
}
export function fileSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export function initComposer1() {
  fillModels();
  Object.assign(draftState.actions, {
    chooseModel(id: string) {
      draftState.modelFollowsConversation = false;
      chooseModel(draftState.state, id);
      void refreshAccount();
      render();
    },
    chooseEffort(index: number) {
      draftState.state.effort =
        models.find((m) => m.id === draftState.state.model)?.efforts[index] || 'default';
      render();
    },
    setMode,
  });
  $('body').oninput = () => {
    draftState.state.body = $('body').value;
    // Pins whose inline token was deleted from the message leave the request.
    const labels = tokenLabels(draftState.state.body);
    draftState.state.pins = draftState.state.pins.filter(
      (pin) => !pin.label || labels.has(pin.label),
    );
    render();
    // Drafts save automatically per project; only a failure is worth showing.
    draftState.view.saved = draftState.draftSaved ? '' : '초안 저장 실패';
    paintComposer();
  };
  pinComposer = attachPinTokens($('body'), {
    selection: () => {
      const chosen = pinnable(),
        count = chosen.length;
      // No ghost for a selection that is already exactly one token's objects.
      const key = chosen
        .map((object) => sourceIdOf(object))
        .sort()
        .join();
      const labels = [...new Set(draftState.state.pins.map((pin) => pin.label).filter(Boolean))];
      if (
        labels.some(
          (label) =>
            draftState.state.pins
              .filter((pin) => pin.label === label)
              .map((pin) => pin.id)
              .sort()
              .join() === key,
        )
      )
        return { count: 0 };
      return {
        count: sessionState.ready && !sessionState.busy ? count : 0,
      };
    },
    insert: (label) => {
      draftState.state.pins.push(
        ...pinnable().map((object) => ({
          id: sourceIdOf(object),
          name: object.name,
          // A pin is a change pin in whichever linked file it lives (SPEC-01.11 5, T-103).
          role: 'target' as const,
          basis: object.revision!,
          label,
        })),
      );
    },
    focusToken: (label) => {
      selectionState.selectedIds = draftState.state.pins
        .filter((pin) => pin.label === label)
        .flatMap((pin) => displayIdOf(objects, pin.basis, pin.id) ?? []);
      draftState.state.selected = selectionState.selectedIds.at(-1) ?? null;
      render();
      if (selectionState.selectedIds.length) viewerState.viewport?.fit(selectionState.selectedIds);
    },
  });
  draftState.refreshPinComposer = () => pinComposer.refresh();
}

export function initComposer2() {
  /**
   * The check before sending (SPEC-09.11): an image attachment with reference words, or a path to
   * images in the words, asks with one line over the composer; [그냥 보내기] sends as before.
   */
  draftState.actions.send = () => {
    if (
      sessionState.busy ||
      draftState.routing ||
      panelMode ||
      !sessionState.project ||
      validate(draftState.state)
    )
      return sendComposer();
    const words = [draftState.state.body, ...(draftState.state.instructions ?? [])].join('\n');
    const image = draftState.state.files.find(
      (file) =>
        file.kind === 'image' &&
        typeof file.id === 'string' &&
        !referenceAnswered.has('a:' + file.id),
    );
    if (image && referenceIntent(words)) {
      const key = 'a:' + (image.id as string);
      showReferenceCard({
        mark: () => {
          referenceAnswered.add(key);
          hideRouteCard();
          openReferenceTab({
            id: image.id as string,
            name: String(image.displayName || image.name),
          });
        },
        send: () => {
          referenceAnswered.add(key);
          hideRouteCard();
          sendComposer();
        },
        close: hideRouteCard,
      });
      return;
    }
    const paths = pathCandidates(words).filter((path) => !referenceAnswered.has('p:' + path));
    if (!paths.length) return sendComposer();
    const projectId = sessionState.project.id,
      conversation = draftState.draftConversation;
    draftState.routing = true;
    paintComposer();
    void imagesAtPaths(api, projectId, paths)
      .catch(() => undefined)
      .then((found) => {
        draftState.routing = false;
        paintComposer();
        if (sessionState.project?.id !== projectId || draftState.draftConversation !== conversation)
          return;
        if (!found?.path || !found.images.length) {
          for (const path of paths) referenceAnswered.add('p:' + path);
          return sendComposer();
        }
        // Every reading of the words is answered at once, so the same path does not ask again.
        const answer = () => {
          for (const path of paths) referenceAnswered.add('p:' + path);
          hideRouteCard();
        };
        showReferenceCard({
          found,
          pick: (picked) => {
            answer();
            void attachPathImage(picked.path);
          },
          send: () => {
            answer();
            sendComposer();
          },
          close: hideRouteCard,
        });
      });
  };
  // The reference tab's turns (SPEC-09, T-090) go like the composer's: the chosen conversation, the
  // composer's model and document, shown and followed in the AI column; the board's data is added
  // by the engine (src/server/reference-boards.ts).
  setReferenceBridge({
    ai: () => {
      const chosen = models.find((m) => m.id === draftState.state.model);
      if (!chosen) return undefined;
      return {
        provider: chosen.provider,
        model: chosen.id,
        name: chosen.name,
        images: chosen.images !== false,
      };
    },
    capture: () => {
      if (!viewerState.viewport || !objects.length) return undefined;
      try {
        const dataUrl = viewerState.viewport.captureWithAnnotations([], {
          maxSize: 1280,
          quality: 0.82,
        });
        return /^data:image\/(png|jpeg);base64,/.test(dataUrl) ? dataUrl : undefined;
      } catch {
        return undefined;
      }
    },
    send: async (turn) => {
      if (!sessionState.project) throw Error('NO_PROJECT');
      const projectId = currentProject().id,
        original = draftState.state;
      const chosen = models.find((m) => m.id === draftState.state.model);
      const input = {
        host: draftState.state.host || 'rhino',
        baseRequestId: draftState.state.baseRequestId ?? null,
        body: '',
        pins: [],
        sketches: [],
        files: turn.files ?? [],
        ...(turn.images?.length ? { images: turn.images } : {}),
        provider: chosen?.provider ?? 'claude-cli',
        model: draftState.state.model,
        effort: draftState.state.effort,
        ...modeFields(turn.reference.action === 'confirm' ? 'auto' : 'plan'),
        id: crypto.randomUUID(),
        conversationId: currentConversation() ?? 'default',
        reference: turn.reference,
      };
      const request = await requestData(`/projects/${projectId}/requests`, 'POST', input);
      if (sessionState.project?.id === projectId && draftState.state === original) {
        if (!draftState.state.messages.some((entry) => entry.id === request.id))
          draftState.state.messages.push(requestMessage(request));
        workState.focusedWork = request.id;
        renderMessages();
        void workState.conversationChips?.refresh();
        void poll(request.id, projectId, original);
      }
      return request as unknown as { id: string; input: Record<string, unknown> };
    },
  });
  $('body').onkeydown = (e) => {
    if (e.key === 'Tab' && e.shiftKey && !e.isComposing) {
      e.preventDefault();
      cycleMode();
      return;
    }
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      $('request').click();
    } else if (e.shiftKey) {
      // Shift+Enter queues the message in the request list instead of inserting a newline.
      e.preventDefault();
      $('add-request').click();
    }
  };
}

export function initComposer3() {
  // Picked (the paperclip), pasted or dropped files (SPEC-01.12 1); pinning and sketching have their
  // own places (selection bar, viewport pencil). Which linked files to change is the AI's (T-103).
  draftState.actions.attach = (files) => void attachFiles(files);
  $('body').addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    void attachFiles(files);
  });
}

export function initComposer4() {
  document.addEventListener('pointerdown', (e) => {
    for (const id of ['effort-menu']) {
      const menu = document.getElementById(id);
      if (menu instanceof HTMLDetailsElement && menu.open && !menu.contains(e.target as Node))
        menu.open = false;
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (
      pendingSketch() ||
      (!draftState.draftSaved &&
        (draftState.state.body ||
          draftState.state.instructions?.length ||
          draftState.state.pins.length ||
          draftState.state.sketches.length))
    ) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

export function initComposer5() {
  draftState.actions.queue = () => {
    if (!draftState.state.body.trim()) return;
    draftState.state.instructions ??= [];
    draftState.state.instructions.push(draftState.state.body);
    draftState.state.body = '';
    setBody('');
    render();
    $('body').focus();
  };
  window.addEventListener('vide-accounts-changed', () => {
    const current = ++sessionState.catalogGeneration;
    void (async () => {
      const catalog = modelsSchema.parse(await api('/models'));
      if (current !== sessionState.catalogGeneration) return;
      models.splice(0, models.length, ...catalog);
      // Keep the explicit model if supported; require a fresh selection if absent.
      fillModels();
      render();
      void refreshAccount();
    })().catch((error) => message(readableError(error).message));
  });
}

/** render(): the composer is usable only once the page is ready; the mode toggle follows. */
export function paintComposerReady() {
  // `#body` is uncontrolled (pin-tokens.ts reads `disabled` in this same render()).
  $('body').disabled = !sessionState.ready;
  draftState.view.modelDisabled = !sessionState.ready;
  // `#effort` follows the same flag; paintSettings() narrows it to models with several steps.
  draftState.view.effort.disabled = !sessionState.ready;
  syncMode();
}
/** render(): a draft without input follows the shown result as its basis. */
export function followShownBasis() {
  if (draftState.unreadableDraft && draftHasInput(draftState.state))
    draftState.unreadableDraft = false;
  if (!draftHasInput(draftState.state) && selectionState.displayedResult)
    draftState.state.baseRequestId = selectionState.displayedResult;
}
/** render(): the draft is saved per project and conversation on every render. */
export function saveDraft() {
  if (sessionState.project && !draftState.unreadableDraft)
    try {
      localStorage.setItem(
        draftKey(currentProject().id, draftState.draftConversation),
        JSON.stringify(draftSnapshot(draftState.state)),
      );
      draftState.draftSaved = true;
    } catch {
      draftState.draftSaved = false;
    }
}
/** render(): the attached context chips over the message box. */
export function paintContext() {
  const items: ContextItem[] = [];
  if (draftState.state.linkedTargets?.length)
    chip(
      items,
      '연계 묶음 · ' +
        draftState.state.linkedTargets
          .map(
            (target) =>
              (target.host === 'zwcad' ? 'ZWCAD' : 'Rhino') +
              ' · ' +
              (draftState.state.messages
                .find((m) => m.id === target.baseRequestId)
                ?.body.slice(0, 35) || '기준 후보'),
          )
          .join(' ↔ '),
      () => {
        draftState.state.linkedTargets = undefined;
        draftState.state.coordinateBasis = undefined;
        render();
      },
    );
  // One chip for the whole pinned set; Rhino-pinned objects outside the current Sync show as pending.
  // Inline "[고정N · k개]" tokens carry their own pins; only unlabeled pins get a chip.
  const loosePins = draftState.state.pins.filter((pin) => !pin.label);
  const pendingPins = linksState.hostPinned.filter(
    (id) => !draftState.state.pins.some((pin) => pin.id === id),
  ).length;
  if (loosePins.length || pendingPins)
    chip(
      items,
      `📌 고정 객체 ${loosePins.length}개${pendingPins ? ` · Sync 대기 ${pendingPins}개` : ''}`,
      () => {
        draftState.state.pins = draftState.state.pins.filter((pin) => pin.label);
        if (linksState.hostPinned.length) void setHostPins([]).catch(() => {});
        render();
      },
      loosePins.map((pin) => pin.name || pin.id).join('\n') ||
        'Rhino에서 고정했지만 아직 Sync 전인 객체',
      () => {
        selectionState.selectedIds = loosePins.flatMap(
          (pin) => displayIdOf(objects, pin.basis, pin.id) ?? [],
        );
        draftState.state.selected = selectionState.selectedIds.at(-1) ?? null;
        render();
        if (draftState.state.selected) viewerState.viewport?.fit(draftState.state.selected);
      },
    );
  draftState.state.sketches.forEach((s, i) =>
    chip(items, '⌁ ' + s.name, () => {
      draftState.state.sketches.splice(i, 1);
      render();
    }),
  );
  // Kept attachments (SPEC-01.12) carry an id; images show a small preview.
  draftState.state.files.forEach((f, i) =>
    chip(
      items,
      (f.kind === 'image' ? '' : '▧ ') + (f.displayName || f.name),
      () => {
        draftState.state.files.splice(i, 1);
        render();
      },
      typeof f.size === 'number' && typeof f.id === 'string'
        ? `${f.name} · ${fileSize(f.size)}`
        : undefined,
      undefined,
      f.kind === 'image' && typeof f.id === 'string' && sessionState.project
        ? attachmentPreview(currentProject().id, f.id)
        : undefined,
      // An image opens its reference-image tab for marking regions (SPEC-09.2, PLAN-26 T-090).
      f.kind === 'image' && typeof f.id === 'string' && sessionState.project && !panelMode
        ? {
            label: '영역 표시',
            title: '참고 이미지 탭에서 원하는 부분을 영역으로 표시합니다',
            run: () =>
              openReferenceTab({ id: f.id as string, name: String(f.displayName || f.name) }),
          }
        : undefined,
    ),
  );
  // Host panel: what is selected in Rhino/CAD right now, one click to attach (Design SCR-12).
  if (panelMode && panelView.selection.length)
    items.push({
      kind: 'selection',
      text: `${panelHost === 'zwcad' ? 'CAD' : 'Rhino'} 선택 ${panelView.selection.length}개 첨부`,
      run: () => void attachPanelSelection(),
    });
  // Several files on screen form one space; only a draft whose basis is off screen says so.
  if (
    draftHasInput(draftState.state) &&
    selectionState.displayedResult &&
    draftState.state.baseRequestId !== selectionState.displayedResult &&
    !linksState.currentLayers.some((layer) => layer.requestId === draftState.state.baseRequestId)
  ) {
    if (draftState.state.baseRequestId)
      items.push({
        kind: 'basis',
        run: () => {
          selectionState.selectedResult = draftState.state.baseRequestId;
          renderMessages();
        },
      });
    else items.push({ kind: 'new-basis' });
  }
  draftState.view.context = items;
  paintComposer();
}
/** render(): the model menu, the effort slider and the attach/queue buttons. */
export function paintSettings() {
  const view = draftState.view;
  const model = draftState.state.model;
  const selected = models.find((m) => m.id === model);
  const listed = [
    ...view.models.first,
    ...view.models.groups.flatMap((group) => group.options),
  ].some((choice) => choice.id === model);
  // A model off the list (an older draft's) stays in the menu until it is filled again.
  if (!selected && !listed && !view.extraModels.includes(model))
    view.extraModels = [...view.extraModels, model];
  view.model = model;
  const efforts = selected?.efforts || [draftState.state.effort];
  const effortLabel = draftState.state.effort === 'default' ? '기본값' : draftState.state.effort;
  view.effort = {
    max: Math.max(0, efforts.length - 1),
    index: Math.max(0, efforts.indexOf(draftState.state.effort)),
    disabled: !sessionState.ready || efforts.length < 2,
    label: effortLabel,
    title: efforts.join(' → '),
    fill: `${efforts.length > 1 ? (efforts.indexOf(draftState.state.effort) / (efforts.length - 1)) * 100 : 0}%`,
    steps: efforts.map((effort) => ({
      text: effort === 'default' ? '기본' : effort,
      active: effort === draftState.state.effort,
    })),
  };
  view.attachDisabled = !sessionState.ready || sessionState.busy;
  view.addDisabled = !sessionState.ready || sessionState.busy || !draftState.state.body.trim();
  paintComposer();
}
/** render(): [보내기] follows the draft, the request admission and the page state. */
export function paintSendButton() {
  // SPEC-02.9: overlapping work waits its turn instead of being refused, so sending stays on and
  // the title tells where the request would wait. Only an unresolved result stops it.
  const admission = requestAdmission(
    { ...draftState.state, id: '__draft__', baseRequestId: draftState.state.baseRequestId ?? null },
    draftState.state.messages.map((entry) => entry.request),
  );
  const conflict = admission.code;
  draftState.view.send = {
    disabled:
      !sessionState.ready ||
      !sessionState.project ||
      sessionState.busy ||
      !!conflict ||
      !!validate(draftState.state),
    title:
      validate(draftState.state) ||
      (conflict && errors[conflict]) ||
      (admission.waitingFor
        ? `보내면 대기합니다: ${waitingText(admission.waitingFor)} · Ctrl+Enter`
        : '보내기 · Ctrl+Enter'),
  };
  paintComposer();
}

/** Escape (shortcut order 50): closes the effort menu and gives its summary the focus. */
export function escapeEffortMenu(e: KeyboardEvent): ShortcutResult {
  if (e.key === 'Escape') {
    const effortMenu = document.querySelector<HTMLDetailsElement>('#effort-menu')!;
    if (effortMenu.open) {
      effortMenu.open = false;
      effortMenu.querySelector<HTMLElement>('summary')?.focus();
    }
  }
}

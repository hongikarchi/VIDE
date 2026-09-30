import { initializeViewportEmpty } from './viewport-empty.ts';
import { initializeWorkspaceStatus } from './workspace-status.ts';
import { linkedRequestDraft, interventionTargetDraft } from './linked-draft.ts';
import { accountIndicator } from './account-indicator.ts';
import { executionLimits } from '../contracts/execution-limits.ts';
import { showExecutionLimits } from './execution-limits.tsx';
import { requestAdmission, waitingOf } from '../contracts/request-scope.ts';
import { waitingText } from './request-scope.ts';
import { draftSnapshot, restoreDraft } from './draft-storage.ts';
import { z } from 'zod';
import {
  hostDocumentsSchema,
  hostSelectionSchema,
  type HostTarget,
} from '../contracts/host-documents.ts';
import { element as $, append as el, readableError } from './elements.ts';
import {
  requestData,
  requestMessage,
  modelsSchema,
  providersSchema,
  hostStatusSchema,
} from './workspace-data.ts';
import type { DraftPin, DraftStroke } from './model.ts';
import type { MobileView } from './mobile-navigation.tsx';
import { renderProjectHeading } from './project-heading.tsx';
import { setMobileView } from './mobile-navigation.tsx';
import { showQuantities } from './quantities.tsx';
import { attachNativeAttributes } from './native-attributes.ts';
import { attachJigs, overlayPicked, refreshJigs, showJigs, type JigContext } from './jigs.tsx';
import type { ConversationsController } from './conversations.tsx';
import {
  activeWorkspace,
  contextId,
  contextTabs,
  initializeWorkspaces,
  setWorkspace,
  workspaceShowsViewport,
} from './workspaces.ts';
const showAiSettings: typeof import('./ai-settings.tsx').showAiSettings = async (onStatus) =>
  (await import('./ai-settings.tsx')).showAiSettings(onStatus);
import { initializeReviews } from './reviews.tsx';
import { attachSharedFeedback } from './shared-feedback.tsx';
import { linkedCandidates, showLinkedTargets } from './linked-targets.tsx';
import { renderWork } from './work-view.tsx';
import {
  linkRowSchema,
  offlineStatusSchema,
  renderLinks,
  type InboxItem,
  type LinkRow,
  type OfflineStatus,
} from './links.tsx';
import { hostAction, renderLinkCard, renderPanelHeader, type PanelState } from './host-panel.tsx';
import { mountUsageBars } from './usage-bars.ts';
import { composeLayers, displayIdOf, layerSignature, sourceIdOf } from './layers.ts';
import {
  goesToAi,
  instanceRouteContext,
  jevRoute,
  officialRouteJigs,
  routeAnswer,
  routeCard,
  routeQuery,
  routeRequest,
  routeRevert,
  routeSubjects,
  type Route,
  type RouteContext,
  type Service,
} from './request-route.ts';
import { renderRequests } from './requests.tsx';
import { iconSvg, initializeInspector, renderInspector } from './inspector.ts';
import { api, connect, errors, labels } from './gateway.ts';
import { remoteSession } from './remote-panel.ts';
import { applyDisplayDelta } from '../core/display-delta.ts';
import {
  objects,
  models,
  initial,
  chooseModel,
  pinSelection,
  attachHostSelection,
  attachReviewNote,
  failedRequestDraft,
  recoveredRequestDraft,
  draftHasInput,
  validate,
  packet,
  attachBrushSketch,
} from './model.ts';
import { createObjectList, type SelectMode } from './object-list.ts';
import { attachPinTokens, tokenLabels } from './pin-tokens.ts';
import { initializeWorkspacePanels } from './workspace-panels.ts';
import { createViewport } from './viewport.ts';
import { initializeDisplaySettings } from './display-settings.ts';

// Host panel mode (?panel=rhino|zwcad, Design SCR-12): the chat column only, bound to one
// attached document of the Rhino panel or the ZWCAD palette.
const panelParams = new URLSearchParams(location.search);
const panelHost = (['rhino', 'zwcad'] as const).find((host) => host === panelParams.get('panel'));
const panelMode = panelHost !== undefined;
/** What the panel header shows; refreshed by the host poll. */
const panelView: {
  file: string;
  state: PanelState;
  detail: string;
  selection: string[];
} = { file: panelParams.get('name') ?? '', state: 'checking', detail: '', selection: [] };
// Rhino's shared pinned set for the attached document, mirrored from the Rhino plugin.
let hostPinned: string[] = [],
  hostSelectionVersion = -1,
  hostPinBasis: string | undefined;
let project: { id: string; name: string } | undefined,
  ready = false,
  busy = false,
  displayedResult: string | undefined,
  selectedResult: string | null | undefined,
  draftSaved = false,
  unreadableDraft = false,
  // Projects for the heading, and the account website when this PC is signed in.
  projects: { id: string; name: string }[] = [],
  accountSite: string | undefined;
function currentProject() {
  if (!project) throw Error('프로젝트를 먼저 여세요.');
  return project;
}
let state = initial();
function openExecutionLimits() {
  const targetProject = project?.id;
  showExecutionLimits(executionLimits(state), (value) => {
    if (project?.id !== targetProject) return;
    state.executionLimits = value;
    render();
  });
}
let selectedIds: string[] = [];
// Set once the inline pin composer exists; render() may run before that.
let refreshPinComposer = () => {};
/** Rhino-style selection: replace by default, Shift adds, Ctrl removes. */
function applySelection(ids: string[], mode: SelectMode, pin = false) {
  if (mode === 'replace') selectedIds = [...new Set(ids)];
  else if (mode === 'add') selectedIds = [...new Set([...selectedIds, ...ids])];
  else selectedIds = selectedIds.filter((id) => !ids.includes(id));
  state.selected = selectedIds.at(-1) ?? null;
  const picked = objects.find((object) => object.id === state.selected);
  if (typeof picked?.documentKey === 'string' && picked.documentKey !== activeLayer) {
    activeLayer = picked.documentKey;
    applyActiveLayer();
    renderLinkPanel();
  }
  if (pin) pinSelection(state, ids);
  render();
}
/** Show a result and select one of its objects by the object's own id. */
function selectInResult(requestId: string | undefined, id: string) {
  if (requestId) {
    selectedResult = requestId;
    appliedSelection = undefined;
    renderMessages();
  }
  state.selected = (requestId && displayIdOf(objects, requestId, id)) || id;
  render();
  return state.selected;
}
const renderObjectList = createObjectList($('objects'), (ids, mode) => {
  applySelection(ids, mode, tool === 'pin');
  if (ids.length === 1 && mode !== 'remove') viewport?.fit(ids[0]);
});
let foregroundRequest: { id: string; selected: typeof selectedResult; draft: string } | undefined;
/** The work opened in the work view (work history row or the latest request sent). */
let focusedWork: string | undefined;
// Request routing (SPEC-02.17): Jev judges view-only or file work when the request is sent.
let routing = false;
/** Who is signed in (the providers' status), for the login card (SPEC-02.17 3). */
let providerSignedIn: Partial<Record<Service, boolean>> = {};
// Conversation chips (PLAN-24 T-061, src/ui/conversations.tsx) and question cards (T-062,
// src/ui/question-card.tsx) are their own screens, loaded after the page; the glob keeps this page
// working while one of them is not there yet.
type QuestionCardsModule = typeof import('./question-card.tsx');
const conversationScreens = import.meta.glob<typeof import('./conversations.tsx')>(
  './conversations.tsx',
);
const questionScreens = import.meta.glob<QuestionCardsModule>('./question-card.tsx');
let conversationChips: ConversationsController | undefined;
let mountCards: QuestionCardsModule['mountQuestionCards'] | undefined;
let questionCards: ReturnType<QuestionCardsModule['mountQuestionCards']> | undefined;
/**
 * The question cards of the chosen conversation (SPEC-02.19 6): shown while its latest turn ended
 * with questions; the answer goes to `…/conversations/:cid/answer` and becomes its next turn.
 */
function renderQuestionCards() {
  const conversationId = currentConversation();
  const own = conversationId
    ? state.messages.filter((entry) => {
        const input = entry.request?.input as
          | { conversationId?: unknown; parentRequestId?: unknown }
          | undefined;
        return !input?.parentRequestId && input?.conversationId === conversationId;
      })
    : [];
  const last = own.at(-1);
  const turnOutput =
    last?.request?.state === 'succeeded'
      ? (last.request.result as { turnOutput?: unknown } | null | undefined)?.turnOutput
      : undefined;
  if (!mountCards || !conversationId || !last || !turnOutput) {
    questionCards?.unmount();
    questionCards = undefined;
    return;
  }
  const projectId = currentProject().id;
  const options = {
    projectId,
    conversationId,
    requestId: last.id,
    turnOutput,
    onAnswered: ({ id }: { id: string }) =>
      void requestData(`/projects/${projectId}/requests/${id}`).then((request) => {
        if (project?.id !== projectId) return;
        if (!state.messages.some((entry) => entry.id === id))
          state.messages.push(requestMessage(request));
        focusedWork = id;
        renderMessages();
        void conversationChips?.refresh();
        void poll(id, projectId);
      }),
  };
  if (questionCards) questionCards.update(options);
  else questionCards = mountCards($('question-cards'), api, options);
}
/** The conversation the next request goes to; undefined = the project's default conversation. */
const currentConversation = () => conversationChips?.active() ?? undefined;
const conversationOptions = () => ({
  projectId: currentProject().id,
  models: models.map(({ id, name, provider }) => ({ id, name, provider })),
  targets: links.map((link) => ({ id: link.id, name: link.name })),
  messages: state.messages,
});
async function mountConversationScreens() {
  try {
    const chips = await conversationScreens['./conversations.tsx']?.();
    conversationChips?.unmount();
    conversationChips = chips?.mountConversations($('conversation-chips'), api, {
      ...conversationOptions(),
      onChange: () => renderMessages(),
    });
  } catch {
    conversationChips = undefined;
  }
  try {
    mountCards = (await questionScreens['./question-card.tsx']?.())?.mountQuestionCards;
  } catch {
    mountCards = undefined;
  }
  questionCards?.unmount();
  questionCards = undefined;
  renderQuestionCards();
}
const focusDraft = () => JSON.stringify({ draft: draftSnapshot(state), strokes });
initializeWorkspacePanels();
/**
 * Sync coverage badge (SPEC-01.2, T-043): what the host left out of the current model before any
 * row existed — hidden layers, hidden objects, block-definition geometry. Beside the host name.
 */
function syncCoverageBadge(coverage?: {
  omittedHidden?: number;
  omittedFiltered?: number;
  omittedBlockInternal?: number;
  hiddenLayers?: { path: string; count: number }[];
}) {
  let badge = document.getElementById('sync-coverage');
  if (!badge) {
    badge = document.createElement('small');
    badge.id = 'sync-coverage';
    badge.className = 'coverage-badge';
    $('document-host').after(badge);
  }
  const layers = coverage?.hiddenLayers ?? [];
  const onLayers = layers.reduce((sum, layer) => sum + layer.count, 0);
  const hidden = (coverage?.omittedHidden ?? 0) - onLayers;
  const parts = [
    layers.length
      ? `꺼진 레이어 ${layers.length.toLocaleString()}개(${onLayers.toLocaleString()}개)`
      : '',
    hidden > 0 ? `숨긴 객체 ${hidden.toLocaleString()}개` : '',
    coverage?.omittedBlockInternal
      ? `블록 내부 ${coverage.omittedBlockInternal.toLocaleString()}개`
      : '',
    coverage?.omittedFiltered ? `레이어 밖 ${coverage.omittedFiltered.toLocaleString()}개` : '',
  ].filter(Boolean);
  badge.hidden = parts.length === 0;
  badge.textContent = parts.length ? `${parts.join('·')}는 가져오지 않았습니다` : '';
  badge.title = layers.map((layer) => `${layer.path} (${layer.count})`).join('\n');
}
const workspaceStatus = initializeWorkspaceStatus({
  openFailure: (id) => {
    selectedResult = id;
    renderMessages();
    focusWork(id);
  },
  openAiSettings: () => openAiSettings(),
  openExecutionLimits: () => openExecutionLimits(),
  onAccount: (site) => {
    accountSite = site;
    renderHeading();
  },
});
let tool: 'select' | 'pin' | 'sketch' = 'select',
  strokes: DraftStroke[] = [],
  toastTimer: ReturnType<typeof setTimeout> | undefined;
const message = (text: string) => {
  clearTimeout(toastTimer);
  $('message').textContent = text;
  $('message').hidden = false;
  toastTimer = setTimeout(() => ($('message').hidden = true), 4500);
};
const reviews = initializeReviews(
  () => project?.id,
  message,
  (note, review) => {
    if (busy) throw Error('현재 요청 전송이 끝난 뒤 첨부하세요.');
    attachReviewNote(state, note, review);
    render();
    if ($('right').hidden) $('toggle-right').click();
    mobileView('input');
    message('의견과 원 기준을 요청 초안에 첨부했습니다. 조건을 확인한 뒤 보내세요.');
  },
  (id) => {
    selectedResult = id;
    renderMessages();
    message('의견 작성 당시 후보를 열었습니다.');
  },
  (note) => {
    if (busy) throw Error('현재 요청 전송이 끝난 뒤 첨부하세요.');
    if (note.projectId !== project?.id) throw Error('의견의 프로젝트가 다릅니다.');
    attachSharedFeedback(state, note);
    render();
    if ($('right').hidden) $('toggle-right').click();
    mobileView('input');
    message('외부 의견의 원문과 공간 입력을 초안에 첨부했습니다. 확인한 뒤 보내세요.');
  },
);
const viewportEmpty = initializeViewportEmpty($('canvas').parentElement!);
let connectedTarget: HostTarget | undefined;
// Asked the plugin once to drop a link removed in VIDE; its reload gives the panel a fresh page.
let panelUnlinking = false;
// Request whose display is refreshed in place (Live Sync): keep the camera, rebuild only changes.
let liveRefresh: string | undefined;
const liveReplySchema = z.union([
  z.object({ resync: z.literal(true) }),
  z.object({ retry: z.string() }),
  z.object({
    requestId: z.string(),
    basisId: z.string(),
    request: z.record(z.string(), z.unknown()),
    delta: z.object({
      objects: z.array(z.object({ id: z.string(), nativeId: z.string() }).passthrough()),
      scene: z.array(z.object({ id: z.string(), nativeId: z.string() }).passthrough()),
      removed: z.array(z.string()),
      definitions: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);
/** SPEC-01.11 Live Sync: apply only the objects Rhino changed to the latest display Sync. */
async function liveSyncHostDocument(target: HostTarget): Promise<boolean | 'retry'> {
  const basis = state.messages
    .filter(
      (entry) =>
        entry.request?.state === 'succeeded' &&
        entry.request.result?.displayOnly === true &&
        entry.request.result.sourceDocument?.instance === target.instance &&
        entry.request.result.sourceDocument.documentId === target.documentId,
    )
    .at(-1);
  if (basis?.request.result?.sceneOmitted && !basis.request.result.scene) {
    await loadFullResult(basis.id);
    return liveSyncHostDocument(target);
  }
  const result = basis?.request.result;
  const revision = result?.sourceDocument?.revision;
  if (!basis || !result?.objects || !result.scene || typeof revision !== 'number') return false;
  const reply = liveReplySchema.parse(
    await api(`/projects/${currentProject().id}/live-sync`, 'POST', {
      ...target,
      basisId: basis.id,
      revision,
    }),
  );
  if ('resync' in reply) return false;
  if ('retry' in reply) return 'retry';
  type Definitions = NonNullable<typeof result.definitions>;
  const merged = applyDisplayDelta<
    (typeof result.objects)[number],
    (typeof result.scene)[number],
    Definitions[string]
  >(
    { objects: result.objects, scene: result.scene, definitions: result.definitions },
    reply.delta as unknown as {
      objects: typeof result.objects;
      scene: typeof result.scene;
      removed: string[];
      definitions?: Definitions;
    },
  );
  // The reply carries only the request summary; the merged arrays are attached after parsing.
  const next = requestMessage(reply.request);
  next.request.result = { ...next.request.result, ...merged };
  const index = state.messages.findIndex((entry) => entry.id === reply.requestId);
  if (index >= 0) state.messages[index] = next;
  else state.messages.push(next);
  const link = links.find((entry) => entry.id === basis.request.input.linkId);
  if (reply.requestId !== basis.id) {
    if (link) {
      link.lastSync = { requestId: reply.requestId, at: new Date().toISOString() };
      if (layerOverride.get(link.id) === basis.id) layerOverride.delete(link.id);
    } else if (transientResult === basis.id) transientResult = reply.requestId;
  }
  liveRefresh = reply.requestId;
  renderMessages();
  return true;
}
// Linked files (SPEC-01.11): files linked from the host plugins, drawn together as layers. No file
// is the main one; the composer targets the file of the last picked object (or the chosen row).
let links: LinkRow[] = [],
  linksLoaded = false,
  linkSignature = '',
  linksPolling = false,
  linkSyncing = false;
const linkNotes = new Map<string, string>();
/** A candidate (or older Sync) shown in a file's place instead of its latest Sync. */
const layerOverride = new Map<string, string>();
/** A result shown that belongs to no linked file (file import, older work). */
let transientResult: string | undefined;
let activeLayer: string | undefined;
let shownSignature = '',
  fitNext = true;
interface Layer {
  key: string;
  requestId: string;
  name: string;
  link?: LinkRow;
}
let currentLayers: Layer[] = [];
const seenGeneration = new Map<string, number>();
/** The linked file a request belongs to: its own link, or the link of its basis chain. */
function linkOfRequest(id: string | null | undefined): string | undefined {
  let current = id ? state.messages.find((entry) => entry.id === id) : undefined;
  for (let depth = 0; current && depth < 30; depth++) {
    const linkId = current.request.input.linkId;
    if (typeof linkId === 'string' && links.some((link) => link.id === linkId)) return linkId;
    const base = current.request.input.baseRequestId ?? current.request.result?.baseRequestId;
    current =
      typeof base === 'string' ? state.messages.find((entry) => entry.id === base) : undefined;
  }
  return undefined;
}
function visibleLayers(): Layer[] {
  const layers: Layer[] = [];
  for (const link of links) {
    if (link.hidden) continue;
    const requestId = layerOverride.get(link.id) ?? link.lastSync?.requestId;
    if (requestId && state.messages.some((entry) => entry.id === requestId))
      layers.push({ key: link.id, requestId, name: link.name, link });
  }
  const entry = transientResult
    ? state.messages.find((item) => item.id === transientResult)
    : undefined;
  if (entry && !layers.some((layer) => layer.requestId === entry.id))
    layers.push({
      key: 'result:' + entry.id,
      requestId: entry.id,
      name: entry.request.result?.sourceDocument?.name || entry.body.slice(0, 40) || '결과',
    });
  return layers;
}
/** Open a result: a linked file's candidate takes that file's place; anything else shows beside. */
function showRequest(id: string) {
  const link = links.find((entry) => entry.id === linkOfRequest(id));
  if (link) {
    if (link.lastSync?.requestId === id) layerOverride.delete(link.id);
    else layerOverride.set(link.id, id);
    if (link.hidden) void setLinkHidden(link, false);
    transientResult = undefined;
    activeLayer = link.id;
  } else {
    transientResult = id;
    activeLayer = 'result:' + id;
  }
  fitNext = true;
}
/** The composer's target follows the active layer (SPEC-01.11 요청 대상). */
function applyActiveLayer() {
  if (!currentLayers.some((layer) => layer.key === activeLayer)) {
    const newest = [...currentLayers].sort((a, b) =>
      String(
        state.messages.find((entry) => entry.id === a.requestId)?.request.createdAt ?? '',
      ).localeCompare(
        String(state.messages.find((entry) => entry.id === b.requestId)?.request.createdAt ?? ''),
      ),
    );
    activeLayer = newest.at(-1)?.key;
  }
  const active = currentLayers.find((layer) => layer.key === activeLayer);
  displayedResult = active?.requestId;
  const result = state.messages.find((entry) => entry.id === displayedResult)?.request.result;
  if (result && !draftHasInput(state)) {
    state.host = result.host || 'rhino';
    $('host-target').value = state.host;
  }
  const connection = active?.link?.connection;
  if (!panelMode)
    connectedTarget =
      connection && active?.link?.host === 'rhino'
        ? { instance: connection.instance, documentId: connection.documentId }
        : undefined;
  viewportEmpty.connection(
    links.find((link) => link.connection)
      ? {
          key: links.find((link) => link.connection)!.id,
          name: links.find((link) => link.connection)!.name,
          host: links.find((link) => link.connection)!.host,
        }
      : undefined,
  );
}
async function setLinkHidden(link: LinkRow, hidden: boolean) {
  link.hidden = hidden;
  renderMessages();
  renderLinkPanel();
  try {
    await api(`/projects/${currentProject().id}/links/${link.id}`, 'PUT', { hidden });
  } catch (error) {
    message(readableError(error).message);
  }
}
/** Draft or running work based on this file holds its automatic updates (SPEC-01.11 보류). */
function syncHeld(link: LinkRow) {
  const uses = (id?: string | null) => !!id && linkOfRequest(id) === link.id;
  if (
    (draftHasInput(state) || pendingSketch()) &&
    (uses(state.baseRequestId) || state.pins.some((pin) => uses(pin.basis)))
  )
    return true;
  return state.messages.some(
    (entry) =>
      ['queued', 'running'].includes(entry.request?.state) &&
      (uses(entry.request.input.baseRequestId) ||
        (entry.request.input.linkedTargets ?? []).some((target) => uses(target.baseRequestId))),
  );
}
async function syncLink(link: LinkRow, mode: 'first' | 'auto' | 'manual') {
  const connection = link.connection;
  if (!connection || !project || linkSyncing) return;
  const projectId = project.id,
    target = { instance: connection.instance, documentId: connection.documentId };
  linkSyncing = true;
  linkNotes.set(link.id, 'Sync 중');
  renderLinkPanel();
  if (!currentLayers.length) viewportEmpty.sync('loading');
  try {
    if (mode === 'auto' && link.host === 'rhino' && link.lastSync) {
      const live = await liveSyncHostDocument(target);
      if (live === 'retry') {
        linkNotes.set(link.id, '변경 중 · 곧 다시 Sync');
        return;
      }
      if (live) {
        linkNotes.delete(link.id);
        viewportEmpty.sync('idle');
        return;
      }
    }
    const request = await requestData(`/projects/${projectId}/capture`, 'POST', {
      ...target,
      id: crypto.randomUUID(),
      linkId: link.id,
    });
    if (project?.id !== projectId) return;
    if (!state.messages.some((entry) => entry.id === request.id))
      state.messages.push(requestMessage(request));
    if (request.result?.hostExecuted) {
      link.lastSync = { requestId: request.id, at: request.createdAt ?? new Date().toISOString() };
      if (mode === 'manual') layerOverride.delete(link.id);
      if (mode === 'first') fitNext = true;
      linkNotes.delete(link.id);
      viewportEmpty.sync('idle');
    } else {
      linkNotes.set(link.id, errors[request.result?.code ?? ''] || 'Sync 실패');
      viewportEmpty.sync(currentLayers.length ? 'idle' : 'failed');
    }
  } catch (error) {
    linkNotes.set(link.id, readableError(error).message);
    viewportEmpty.sync(currentLayers.length ? 'idle' : 'failed');
  } finally {
    linkSyncing = false;
    if (project?.id === projectId) {
      renderMessages();
      render();
      renderLinkPanel();
    }
  }
}
async function pollLinks() {
  if (!project || !ready || document.hidden || linksPolling) return;
  linksPolling = true;
  const projectId = project.id;
  try {
    const next = z.array(linkRowSchema).parse(await api(`/projects/${projectId}/links`));
    if (project?.id !== projectId) return;
    links = next;
    conversationChips?.update({ targets: next.map((link) => ({ id: link.id, name: link.name })) });
    linksLoaded = true;
    // The host panel works on its own file: requests from it target that file.
    if (panelMode && connectedTarget) {
      const own = links.find(
        (link) =>
          link.connection?.instance === connectedTarget?.instance &&
          link.connection?.documentId === connectedTarget?.documentId,
      );
      if (own && activeLayer !== own.id) {
        activeLayer = own.id;
        applyActiveLayer();
      }
      // Removed from the project in VIDE (SPEC-01.11 9): the plugin drops its link as well.
      const target = connectedTarget;
      if (
        !panelUnlinking &&
        panelParams.get('project') === projectId &&
        !links.some(
          (link) =>
            (link.instance === target.instance && link.documentId === target.documentId) ||
            (link.connection?.instance === target.instance &&
              link.connection.documentId === target.documentId),
        )
      ) {
        panelUnlinking = true;
        hostAction('unlink');
      }
    }
    if (offlineAsked !== projectId) {
      offlineAsked = projectId;
      void pollOffline();
    }
    // Syncs made elsewhere (another window, the Rhino panel) are fetched once.
    for (const link of links) {
      const id = link.lastSync?.requestId;
      if (id && !state.messages.some((entry) => entry.id === id))
        state.messages.push(requestMessage(await api(`/projects/${projectId}/requests/${id}`)));
    }
    const signature = JSON.stringify(links.map((link) => [link.id, link.hidden, link.lastSync]));
    if (signature !== linkSignature) {
      linkSignature = signature;
      renderMessages();
    } else applyActiveLayer();
    renderLinkPanel();
    for (const link of links) {
      const connection = link.connection;
      if (linkSyncing || !connection || connection.hostBusy) continue;
      const seen = seenGeneration.get(link.id);
      const first = !link.lastSync && seen === undefined;
      const changed = seen !== undefined && connection.generation > seen;
      // Opened again while VIDE was closed: a Live file catches up once.
      const reopened = seen === undefined && !!link.lastSync && connection.live;
      if (!first && !changed && !reopened) {
        if (seen === undefined) seenGeneration.set(link.id, connection.generation);
        continue;
      }
      if (!first && syncHeld(link)) {
        linkNotes.set(link.id, '자동 Sync 보류 · 이 파일 기준 작업 중');
        continue;
      }
      seenGeneration.set(link.id, connection.generation);
      await syncLink(link, first ? 'first' : 'auto');
      break;
    }
  } catch {
    /* Transient; the next poll retries and the last display stays. */
  } finally {
    linksPolling = false;
  }
}
setInterval(() => void pollLinks(), 1500);
// Offline view on the account site and requests left there (PLAN-20).
let offlineState: { projectId: string; status: OfflineStatus } | undefined,
  offlineAsked = '';
async function pollOffline(change?: Promise<unknown>) {
  if (!project || !ready) return;
  const projectId = project.id;
  try {
    const status = offlineStatusSchema.parse(
      (await change) ?? (await api(`/projects/${projectId}/offline-view`)),
    );
    if (project?.id !== projectId) return;
    offlineState = { projectId, status };
    renderLinkPanel();
  } catch (error) {
    if (change) message(readableError(error).message);
  }
}
setInterval(() => {
  if (!document.hidden) void pollOffline();
}, 15_000);
function useInboxItem(item: InboxItem) {
  state.body = item.body;
  $('body').value = item.body;
  if (item.linkId && links.some((link) => link.id === item.linkId)) {
    activeLayer = item.linkId;
    applyActiveLayer();
  }
  render();
  $('body').focus();
  message('사이트에서 남긴 요청을 작성기에 넣었습니다. 내용을 확인하고 보내세요.');
  dismissInboxItem(item);
}
function dismissInboxItem(item: InboxItem) {
  void pollOffline(
    api(`/projects/${item.projectId}/offline-view/inbox/${item.id}/dismiss`, 'POST', {}),
  );
}
function renderLinkPanel() {
  renderPanel();
  renderLinks($('host-document-controls'), {
    links,
    projectName: project?.name,
    active: activeLayer,
    notes: linkNotes,
    candidates: new Set(
      [...layerOverride]
        .filter(
          ([id, request]) => links.find((link) => link.id === id)?.lastSync?.requestId !== request,
        )
        .map(([id]) => id),
    ),
    loaded: linksLoaded,
    onToggle: (link) => void setLinkHidden(link, !link.hidden),
    onSync: (link) => void syncLink(link, 'manual'),
    onRemove: (link) => {
      if (
        !confirm(
          link.kind === 'file'
            ? `${link.name}을(를) 목록에서 뺄까요? VIDE에 불러온 사본과 기록이 지워집니다. 원본 파일은 그대로입니다.`
            : `${link.name}을(를) 목록에서 빼고 연결을 끊을까요? VIDE의 Sync 기록과 사본이 지워집니다. ${link.host === 'zwcad' ? 'ZWCAD' : 'Rhino'} 파일과 객체는 그대로이고, 다시 쓰려면 플러그인에서 Link를 누르세요.`,
        )
      )
        return;
      void api(`/projects/${currentProject().id}/links/${link.id}/remove`, 'POST', {})
        .then((reply) => {
          // Its records are gone (SPEC-01.11 9): drop them from the conversation too.
          const gone = new Set(
            z.object({ requestIds: z.array(z.string()).default([]) }).parse(reply).requestIds,
          );
          state.messages = state.messages.filter((entry) => !gone.has(entry.id));
          if (selectedResult && gone.has(selectedResult)) selectedResult = undefined;
          state.pins = state.pins.filter((pin) => !gone.has(pin.basis));
          if (state.baseRequestId && gone.has(state.baseRequestId)) state.baseRequestId = undefined;
          links = links.filter((entry) => entry.id !== link.id);
          layerOverride.delete(link.id);
          renderMessages();
          render();
          renderLinkPanel();
        })
        .catch((error: unknown) => message(readableError(error).message));
    },
    onFocus: (link) => {
      if (link.hidden) void setLinkHidden(link, false);
      activeLayer = link.id;
      applyActiveLayer();
      render();
      renderLinkPanel();
      const ids = objects
        .filter((object) => object.documentKey === link.id)
        .map((object) => object.id);
      if (ids.length) viewport?.fit(ids);
      else if (!link.lastSync) message('아직 Sync 전입니다. 파일이 열려 있으면 곧 표시됩니다.');
    },
    onBackToSync: (link) => {
      layerOverride.delete(link.id);
      renderMessages();
      renderLinkPanel();
    },
    offline: offlineState?.projectId === project?.id ? offlineState?.status : undefined,
    onOffline: (enabled) => {
      const projectId = currentProject().id;
      // The switch moves at once; the PC's answer then fills in the saved state.
      if (offlineState?.projectId === projectId) {
        offlineState = { projectId, status: { ...offlineState.status, enabled } };
        renderLinkPanel();
      }
      void pollOffline(api(`/projects/${projectId}/offline-view`, 'PUT', { enabled }));
    },
    onInboxUse: useInboxItem,
    onInboxDismiss: dismissInboxItem,
  });
}
/** Composer menu entry: attach the objects selected in the target file's host window. */
async function attachConnectedSelection() {
  const layer = currentLayers.find((entry) => entry.key === activeLayer);
  const connection = layer?.link?.connection;
  if (!layer || !connection)
    throw Error('선택을 가져올 파일을 연결 파일 목록에서 고르세요 (파일이 열려 있어야 합니다).');
  const selection = hostSelectionSchema.parse(
    await api(
      `/host/selection?instance=${encodeURIComponent(connection.instance)}&document=${connection.documentId}`,
    ),
  );
  const request = state.messages.find((entry) => entry.id === layer.requestId)?.request;
  const count = attachHostSelection(state, request, selection);
  render();
  message(
    selection.selectedIds.length
      ? `${count}개 객체를 요청에 첨부했습니다.`
      : '호스트에서 선택한 객체가 없습니다.',
  );
}
let inspectorTab: NonNullable<Parameters<typeof renderInspector>[3]> = 'properties';
initializeInspector((tab) => {
  inspectorTab = tab;
  render();
});
let viewport: ReturnType<typeof createViewport> | undefined;
try {
  viewport = createViewport(
    $('canvas'),
    objects,
    (ids, mode, pin, source) =>
      source.source === 'overlay' ? overlayPicked(source) : applySelection(ids, mode, pin),
    (event) => {
      if (event.type === 'stroke') {
        if (strokes.length >= 200) {
          message('스케치 하나에 200획까지 그릴 수 있습니다. 먼저 첨부하세요.');
          return;
        }
        strokes.push(event.stroke);
      } else strokes.splice(event.index, 1);
      draw();
    },
    (camera) => {
      document
        .querySelectorAll<HTMLButtonElement>('[data-view]')
        .forEach((button) =>
          button.setAttribute('aria-pressed', String(button.dataset.view === camera.view)),
        );
      const toggle = $('projection-toggle');
      toggle.dataset.projection = camera.projection;
      // The icon shows the current projection; the button switches to the other one.
      toggle.innerHTML = iconSvg(
        camera.projection === 'perspective' ? 'perspective' : 'orthographic',
      );
      toggle.title =
        camera.projection === 'perspective'
          ? '지금 원근 투영 · 눌러서 평행(직교) 투영'
          : '지금 평행(직교) 투영 · 눌러서 원근 투영';
      toggle.setAttribute(
        'aria-label',
        camera.projection === 'perspective' ? '평행 투영으로 전환' : '원근 투영으로 전환',
      );
    },
  );
} catch {
  message('3D 뷰포트를 열 수 없습니다. WebGL 지원을 확인하세요.');
}
initializeDisplaySettings($('display-settings') as HTMLButtonElement, (settings) =>
  viewport?.display(settings),
);
function captureViewport() {
  if (!viewport) throw Error('3D 화면을 준비한 뒤 다시 시도하세요.');
  return viewport.capture();
}
/**
 * The view with the draft's sketch strokes and numbered pin markers, small enough for the stored
 * request (the whole input stays under 200 KB); undefined without pins/sketches or a view.
 */
function annotatedCapture() {
  if (!viewport || (!state.pins.length && !state.sketches.length)) return undefined;
  const pins = state.pins.flatMap((pin, index) => {
    const id = displayIdOf(objects, pin.basis, pin.id);
    return id ? [{ id, label: /\d+/.exec(pin.label ?? '')?.[0] ?? String(index + 1) }] : [];
  });
  try {
    for (const [maxSize, quality] of [
      [1280, 0.8],
      [960, 0.7],
      [720, 0.6],
    ]) {
      const dataUrl = viewport.captureWithAnnotations(pins, { maxSize, quality });
      if (dataUrl.length <= 150_000 && /^data:image\/(png|jpeg);base64,/.test(dataUrl))
        return { kind: 'annotated' as const, name: '고정·스케치 화면', dataUrl };
    }
  } catch {
    /* No picture: the pins and sketches still go as data. */
  }
  return undefined;
}
/** Unattached brush strokes. */
function pendingSketch() {
  return strokes.length > 0;
}
function draw() {
  viewport?.sketches(state.sketches, strokes);
  $('finish-sketch').disabled = !strokes.length;
  $('undo-point').disabled = !pendingSketch();
  $('clear-sketch').disabled = !pendingSketch();
}
const followSurface = () => $('brush-surface').getAttribute('aria-pressed') !== 'false';
function brushSettings() {
  const width = $('brush-width').valueAsNumber || 4;
  $('brush-width-value').textContent = String(width);
  for (const swatch of document.querySelectorAll<HTMLButtonElement>('.swatch'))
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color === $('brush-color').value));
  viewport?.brush({
    color: $('brush-color').value,
    width,
    surface: followSurface(),
    erase: $('brush-eraser').getAttribute('aria-pressed') === 'true',
  });
  draw();
}
function setEraser(on: boolean) {
  $('brush-eraser').setAttribute('aria-pressed', String(on));
  brushSettings();
}
/** Attach the drawn strokes to the message as one sketch. */
function attachStrokes() {
  if (!strokes.length) return;
  attachBrushSketch(state, strokes, { placement: followSurface() ? 'surface' : 'view' });
  strokes = [];
  render();
}
function setTool(next: 'select' | 'pin' | 'sketch') {
  // Leaving the sketch tool keeps what was drawn: the strokes join the message as a sketch.
  if (tool === 'sketch' && next !== 'sketch' && pendingSketch())
    try {
      attachStrokes();
      message('그린 선을 입력에 첨부했습니다.');
    } catch (cause) {
      message(readableError(cause).message);
      return;
    }
  tool = next;
  document
    .querySelectorAll<HTMLButtonElement>('[data-tool]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
  $('sketch-tools').hidden = tool !== 'sketch';
  viewport?.mode(tool);
  if (tool === 'sketch') brushSettings();
  $('tool-hint').textContent =
    tool === 'sketch'
      ? '펜·드래그로 그리기 · 손가락/우클릭 회전 · 두 손가락/Shift+우클릭 이동 · 휠·핀치 확대 · 위/앞/옆 보기는 그 평면에 그리기'
      : tool === 'pin'
        ? '객체를 누르면 입력에 첨부됩니다.'
        : '';
  draw();
}
function chip(text: string, remove: () => void, title?: string, select?: () => void) {
  const span = el('span', text, $('context'), { class: 'chip' });
  if (title) span.title = title;
  if (select) {
    span.classList.add('chip-action');
    span.onclick = (event) => {
      if (event.target === span) select();
    };
  }
  const b = el('button', '×', span, { 'aria-label': `${text} 제외` });
  b.onclick = remove;
}
function render(rebuildRequests = true) {
  $('body').disabled = !ready;
  for (const id of ['permission', 'model', 'effort'] as const) $(id).disabled = !ready;
  if (unreadableDraft && draftHasInput(state)) unreadableDraft = false;
  if (!draftHasInput(state) && displayedResult) {
    const sourceOf = (id: string | null | undefined) =>
      state.messages.find((m) => m.id === id)?.request.result?.sourceDocument;
    const before = sourceOf(state.baseRequestId),
      after = sourceOf(displayedResult);
    if (
      state.applyToSource &&
      (!before ||
        !after ||
        before.instance !== after.instance ||
        before.documentId !== after.documentId)
    )
      state.applyToSource = false;
    state.baseRequestId = displayedResult;
  }
  if (rebuildRequests) renderRequests(state, render);
  // Intervention availability follows the composer, so the work view follows every render.
  if (project) renderConversation();
  $('host-target').value = state.host || 'rhino';
  if (project && !unreadableDraft)
    try {
      localStorage.setItem(
        'vide:draft:' + currentProject().id,
        JSON.stringify(draftSnapshot(state)),
      );
      draftSaved = true;
    } catch {
      draftSaved = false;
    }
  // Other panels may set a single primary selection; keep the multi-selection consistent.
  if (state.selected && !selectedIds.includes(state.selected)) selectedIds = [state.selected];
  if (!state.selected && selectedIds.length) selectedIds = [];
  selectedIds = selectedIds.filter((id) => objects.some((o) => o.id === id));
  renderObjectList(objects, selectedIds);
  viewport?.select(selectedIds);
  $('selection').textContent =
    selectedIds.length > 1
      ? `${selectedIds.length.toLocaleString()}개 객체 선택`
      : objects.find((o) => o.id === state.selected)?.name || '';
  $('selection-bar').hidden = !selectedIds.length;
  $('selection-count').textContent = `${selectedIds.length.toLocaleString()}개 선택`;
  refreshPinComposer();
  $('context').replaceChildren();
  if (state.linkedTargets?.length)
    chip(
      '연계 묶음 · ' +
        state.linkedTargets
          .map(
            (target) =>
              (target.host === 'zwcad' ? 'ZWCAD' : 'Rhino') +
              ' · ' +
              (state.messages.find((m) => m.id === target.baseRequestId)?.body.slice(0, 35) ||
                '기준 후보'),
          )
          .join(' ↔ '),
      () => {
        state.linkedTargets = undefined;
        state.coordinateBasis = undefined;
        render();
      },
    );
  // One chip for the whole pinned set; Rhino-pinned objects outside the current Sync show as pending.
  // Inline "[고정N · k개]" tokens carry their own pins; only unlabeled pins get a chip.
  const loosePins = state.pins.filter((pin) => !pin.label);
  const pendingPins = hostPinned.filter((id) => !state.pins.some((pin) => pin.id === id)).length;
  if (loosePins.length || pendingPins)
    chip(
      `📌 고정 객체 ${loosePins.length}개${pendingPins ? ` · Sync 대기 ${pendingPins}개` : ''}`,
      () => {
        state.pins = state.pins.filter((pin) => pin.label);
        if (hostPinned.length) void setHostPins([]).catch(() => {});
        render();
      },
      loosePins.map((pin) => pin.name || pin.id).join('\n') ||
        'Rhino에서 고정했지만 아직 Sync 전인 객체',
      () => {
        selectedIds = loosePins.flatMap((pin) => displayIdOf(objects, pin.basis, pin.id) ?? []);
        state.selected = selectedIds.at(-1) ?? null;
        render();
        if (state.selected) viewport?.fit(state.selected);
      },
    );
  state.sketches.forEach((s, i) =>
    chip('⌁ ' + s.name, () => {
      state.sketches.splice(i, 1);
      render();
    }),
  );
  state.files.forEach((f, i) =>
    chip('▧ ' + (f.displayName || f.name), () => {
      state.files.splice(i, 1);
      render();
    }),
  );
  // Host panel: what is selected in Rhino/CAD right now, one click to attach (Design SCR-12).
  if (panelMode && panelView.selection.length) {
    const chip = el(
      'button',
      `${panelHost === 'zwcad' ? 'CAD' : 'Rhino'} 선택 ${panelView.selection.length}개 첨부`,
      $('context'),
      {
        type: 'button',
        class: 'chip selection-chip',
        title: '지금 고른 객체를 이 요청의 대상으로 첨부합니다',
      },
    );
    chip.onclick = () => void attachPanelSelection();
  }
  // Several files on screen: say which one this request changes (SPEC-01.11 요청 대상).
  const target = currentLayers.find(
    (layer) => layer.requestId === (state.baseRequestId ?? displayedResult),
  );
  if (currentLayers.length > 1 && target)
    el('span', '대상 파일 · ' + target.name, $('context'), {
      class: 'chip target-file',
      title:
        '변경 핀이 있는 파일, 없으면 마지막으로 고른 객체의 파일입니다. 다른 파일의 객체를 누르면 바뀝니다.',
    });
  // With several files the target chip already names the basis when it is on screen.
  if (
    draftHasInput(state) &&
    displayedResult &&
    state.baseRequestId !== displayedResult &&
    !(currentLayers.length > 1 && target)
  ) {
    if (state.baseRequestId) {
      const basis = el('button', '입력 기준 보기', $('context'));
      basis.onclick = () => {
        selectedResult = state.baseRequestId;
        renderMessages();
      };
    } else el('small', '새 작업 기준', $('context'));
  }
  const selected = models.find((m) => m.id === state.model);
  if (!selected && !Array.from($('model').options).some((option) => option.value === state.model))
    el('option', state.model + ' · 사용 확인 필요', $('model'), { value: state.model });
  $('model').value = state.model;
  const efforts = selected?.efforts || [state.effort];
  $('effort').max = String(Math.max(0, efforts.length - 1));
  $('effort').value = String(Math.max(0, efforts.indexOf(state.effort)));
  $('effort').disabled = !ready || efforts.length < 2;
  const effortLabel = state.effort === 'default' ? '기본값' : state.effort;
  $('effort-label').textContent = effortLabel;
  $('effort').setAttribute('aria-valuetext', effortLabel);
  $('effort').title = efforts.join(' → ');
  $('effort').style.setProperty(
    '--effort-fill',
    `${efforts.length > 1 ? (efforts.indexOf(state.effort) / (efforts.length - 1)) * 100 : 0}%`,
  );
  $('effort-steps').replaceChildren(
    ...efforts.map((effort) => {
      const step = document.createElement('span');
      step.textContent = effort === 'default' ? '기본' : effort;
      step.dataset.active = String(effort === state.effort);
      return step;
    }),
  );
  $('pin').disabled =
    !ready ||
    busy ||
    !selectedIds.some((id) => {
      const object = objects.find((o) => o.id === id && o.revision);
      return (
        !!object &&
        !state.pins.some((p) => p.id === sourceIdOf(object) && p.basis === object.revision)
      );
    });
  $('pin').title = '현재 후보에서 첨부하지 않은 객체를 선택하세요.';
  $('add-request').disabled = !ready || busy || !state.body.trim();
  $('linked-targets').disabled = !ready || busy || linkedCandidates(state).length < 2;
  $('linked-hint').textContent =
    linkedCandidates(state).length < 2 ? '실행에 성공한 SDK 후보 2개가 필요합니다.' : '';

  $('permission').value = state.applyToSource ? 'apply' : state.permission;
  $('permission').dataset.mode = $('permission').value;
  const inspected = objects.find((o) => o.id === state.selected);
  const active = state.messages.find(
    (m) =>
      m.id === (typeof inspected?.revision === 'string' ? inspected.revision : displayedResult),
  )?.request;
  renderInspector(
    inspected && { ...inspected, id: sourceIdOf(inspected) },
    active?.result,
    active,
    inspectorTab,
    {
      quantities: (request, object) => {
        if (!request) return;
        void showQuantities(
          currentProject().id,
          request.id,
          (id) => {
            selectInResult(request.id, id);
          },
          object.id,
        ).catch((error) => message(error.message));
      },
      attachAttributes: (request, object) => {
        try {
          if (busy) throw Error('전송이 끝난 뒤 첨부하세요.');
          if (!request) throw Error('기준 후보를 확인하세요.');
          attachNativeAttributes(state, request, object);
          render();
          message('표시된 속성을 요청 초안에 첨부했습니다.');
        } catch (cause) {
          const error = readableError(cause);
          message(error.message);
        }
      },
      get: (id) => state.messages.find((message) => message.id === id)?.request,
      open: (id, objectId) => {
        if (objectId) selectInResult(id, objectId);
        else {
          selectedResult = id;
          appliedSelection = undefined;
          renderMessages();
          state.selected = null;
          render();
        }
      },
    },
  );
  if (selectedIds.length > 1)
    $('selection').textContent = `${selectedIds.length.toLocaleString()}개 객체 선택`;
  viewportEmpty.modelShown(Boolean(active?.result?.hostExecuted) || tool === 'sketch');
  workspaceStatus.setDisplayCoverage(active?.result?.displayCoverage);
  $('document-host').textContent =
    (active?.result?.host || state.host) === 'zwcad' ? 'ZWCAD' : 'Rhino';
  syncCoverageBadge(active?.result?.displayCoverage);
  workspaceStatus.setFailures(
    state.messages
      .filter((entry) => ['failed', 'unknown', 'interrupted'].includes(entry.request?.state))
      .map((entry) => ({
        id: entry.id,
        title: (entry.body || '작업').slice(0, 120),
        reason:
          errors[entry.request?.result?.code || ''] ||
          labels[entry.request?.state ?? ''] ||
          String(entry.request?.state),
        code: entry.request?.result?.code,
        at: entry.request?.createdAt,
        label: `${(entry.body || '작업').slice(0, 120)} · ${entry.request?.result?.code ?? ''}`,
      })),
  );
  $('work-count').textContent = `${state.messages.length}개 작업`;
  const waitingCount = state.messages.filter((m) => waitingOf(m.request)).length;
  $('workspace-status').textContent = state.messages.some((m) =>
    ['queued', 'running'].includes(m.request?.state),
  )
    ? '작업 진행 중' + (waitingCount ? ` · 대기 ${waitingCount}` : '')
    : project
      ? '로컬 작업 공간 · ' + project.name
      : '연결 중';
  sidebar();
  // SPEC-02.9: overlapping work waits its turn instead of being refused, so sending stays on and
  // the title tells where the request would wait. Only an unresolved result stops it.
  const admission = requestAdmission(
    { ...state, id: '__draft__', baseRequestId: state.baseRequestId ?? null },
    state.messages.map((entry) => entry.request),
  );
  const conflict = admission.code;
  $('request').disabled = !ready || !project || busy || !!conflict || !!validate(state);
  $('request').title =
    validate(state) ||
    (conflict && errors[conflict]) ||
    (admission.waitingFor
      ? `보내면 대기합니다: ${waitingText(admission.waitingFor)} · Ctrl+Enter`
      : '보내기 · Ctrl+Enter');
  draw();
}
/** Remove a finished request from the conversation and history (its records are kept). */
async function hideRequest(id: string) {
  await api(`/projects/${currentProject().id}/requests/${id}/hide`, 'POST', {});
  const index = state.messages.findIndex((entry) => entry.id === id);
  if (index >= 0) state.messages.splice(index, 1);
  if (selectedResult === id) selectedResult = undefined;
  renderMessages();
  render();
}
/** Work history: every request, newest first, with its state; opens it in the conversation. */
function sidebar() {
  $('task-list').replaceChildren();
  if (!state.messages.length) el('small', '아직 요청이 없습니다.', $('task-list'));
  const shown = focusedMessage();
  const listed = state.messages.filter((m) => !m.request?.input?.parentRequestId);
  [...listed].reverse().forEach((m, i) => {
    const request = m.request;
    const row = el('div', '', $('task-list'), { class: 'task-row', 'data-task-id': m.id });
    if (m.id === shown?.id) row.setAttribute('aria-current', 'true');
    const open = el('button', '', row, { class: 'task-open', type: 'button' });
    el('span', m.body || `첨부 검토 ${listed.length - i}`, open, { class: 'task-title' });
    const meta = el('span', '', open, { class: 'task-meta' });
    if (request?.createdAt)
      el(
        'span',
        new Date(request.createdAt).toLocaleString('ko-KR', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        meta,
      );
    el('span', m.host === 'zwcad' ? 'ZWCAD' : 'Rhino', meta);
    if (request)
      el('span', labels[request.state] || request.state, meta, {
        class: 'card-state',
        'data-state': request.state,
      });
    open.onclick = () => focusWork(m.id);
    if (request && !['queued', 'running'].includes(request.state)) {
      const remove = el('button', '×', row, {
        class: 'task-remove',
        type: 'button',
        title: '목록에서 지우기 (모델과 작업 기록은 보존)',
        'aria-label': '목록에서 지우기',
      });
      remove.onclick = () => {
        if (confirm('이 작업을 목록에서 지울까요? 모델과 작업 기록은 보존됩니다.'))
          void hideRequest(m.id).catch((error: unknown) =>
            message(error instanceof Error ? error.message : '지우지 못했습니다.'),
          );
      };
    }
  });
  $('reference-list').replaceChildren();
  // Reference files go with the next request (text formats; the AI reads their content).
  const attach = el('button', '파일 첨부', $('reference-list'), {
    type: 'button',
    class: 'reference-attach',
  });
  attach.onclick = () => $('files').click();
  el(
    'small',
    'TXT·MD·CSV·JSON, 파일당 50KB까지. 다음 요청에 함께 보내며 AI가 내용을 읽습니다.',
    $('reference-list'),
  );
  const files = [...state.messages.flatMap((m) => m.files), ...state.files];
  if (!files.length) el('small', '첨부한 파일이 없습니다.', $('reference-list'));
  files.forEach((f) => el('small', f.name, $('reference-list'), { class: 'reference-file' }));
}
let appliedSelection: string | null | undefined;
function renderMessages() {
  conversationChips?.update({ messages: state.messages });
  renderQuestionCards();
  if (selectedResult !== appliedSelection) {
    appliedSelection = selectedResult;
    if (selectedResult) showRequest(selectedResult);
    else if (selectedResult === null) {
      transientResult = undefined;
      activeLayer = undefined;
    }
  }
  // A project without linked files shows its latest result, as before links existed.
  if (!links.length && selectedResult === undefined)
    transientResult = state.messages
      .filter(
        (entry) =>
          entry.request?.result?.hostExecuted &&
          (entry.request.result.host || 'rhino') === (state.host || 'rhino'),
      )
      .at(-1)?.id;
  showLayers();
  sidebar();
  renderConversation();
  // A new Sync reaches the jigs that are open (their Sync lists).
  if (project) refreshJigs();
}
/** The request list omits display meshes; fetch one request in full when it is shown. */
const loadingResults = new Set<string>();
async function loadFullResult(id: string) {
  if (loadingResults.has(id) || !project) return;
  loadingResults.add(id);
  viewportEmpty.sync('loading');
  try {
    const full = requestMessage(await api(`/projects/${currentProject().id}/requests/${id}`));
    const index = state.messages.findIndex((entry) => entry.id === id);
    if (index >= 0) state.messages[index] = full;
    viewportEmpty.sync('idle');
    renderMessages();
  } catch (error) {
    viewportEmpty.sync('failed');
    message(readableError(error).message);
  } finally {
    loadingResults.delete(id);
  }
}
/** Draw every visible layer together (SPEC-01.11); rebuild only when the layer set changed. */
function showLayers() {
  const layers = visibleLayers();
  for (const layer of layers) {
    const result = state.messages.find((entry) => entry.id === layer.requestId)?.request.result;
    if (result?.hostExecuted && !result.scene && result.sceneOmitted) {
      void loadFullResult(layer.requestId);
      return;
    }
  }
  const drawable = layers.flatMap((layer) => {
    const result = state.messages.find((entry) => entry.id === layer.requestId)?.request.result;
    return result?.hostExecuted && result.objects && result.scene ? [{ layer, result }] : [];
  });
  currentLayers = drawable.map(({ layer }) => layer);
  const signature = layerSignature(currentLayers);
  const refresh =
    liveRefresh !== undefined && currentLayers.some((layer) => layer.requestId === liveRefresh);
  liveRefresh = undefined;
  if (signature === shownSignature && !refresh && !fitNext) {
    applyActiveLayer();
    return;
  }
  const decoder = new TextDecoder();
  const layerOf = (value?: string) => {
    if (!value) return undefined;
    try {
      return decoder.decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
    } catch {
      return undefined;
    }
  };
  const many = drawable.length > 1;
  const composed = composeLayers(
    drawable.map(({ layer, result }) => {
      const native = new Map(result.scene!.map((item) => [item.id, item]));
      return {
        key: layer.key,
        name: layer.name,
        requestId: layer.requestId,
        objects: result.objects!.map((o) => {
          const item = native.get(o.id);
          const name = layerOf(item?.layer64);
          return {
            ...o,
            // Several files: the object tree groups by file, then by layer.
            layer: many ? `${layer.name} › ${name ?? '레이어 없음'}` : name,
            layerName: name,
            type: item?.nativeType || o.kind,
          };
        }),
        scene: result.scene!,
        definitions: result.definitions,
      };
    }),
  );
  objects.splice(0, objects.length, ...(composed.objects as unknown as typeof objects));
  if (!shownSignature || fitNext) viewport?.replace(composed.scene, composed.definitions);
  else viewport?.update(composed.scene, composed.definitions);
  shownSignature = signature;
  fitNext = false;
  applyActiveLayer();
  render();
  if (drawable.length) scheduleThumbnail();
}
let thumbnailTimer: ReturnType<typeof setTimeout> | undefined,
  thumbnailSent = 0;
/** A small viewport image for the project card on the account website (signed-in PCs only). */
function scheduleThumbnail() {
  if (!accountSite || !project) return;
  clearTimeout(thumbnailTimer);
  const wait = Date.now() - thumbnailSent > 60_000 ? 1500 : 60_000;
  thumbnailTimer = setTimeout(() => void sendThumbnail().catch(() => {}), wait);
}
async function sendThumbnail() {
  if (!viewport || !project || !objects.length) return;
  const target = project.id,
    source = new Image();
  source.src = viewport.capture();
  await source.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 300;
  const scale = Math.max(480 / source.width, 300 / source.height),
    width = source.width * scale,
    height = source.height * scale;
  canvas.getContext('2d')?.drawImage(source, (480 - width) / 2, (300 - height) / 2, width, height);
  if (project?.id !== target) return;
  thumbnailSent = Date.now();
  // Plain fetch: a missed card image is not a work error worth reporting.
  await fetch(`api/v1/projects/${encodeURIComponent(target)}/thumbnail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: canvas.toDataURL('image/jpeg', 0.72) }),
  });
}
/** The work shown on the right: the one chosen in the work history, else the newest running. */
function focusedMessage() {
  const listed = state.messages.filter((m) => !m.request?.input?.parentRequestId);
  return (
    listed.find((m) => m.id === focusedWork) ??
    [...listed].reverse().find((m) => ['queued', 'running'].includes(m.request?.state)) ??
    listed.at(-1)
  );
}
function focusWork(id: string) {
  focusedWork = id;
  if ($('right').hidden) $('toggle-right').click();
  mobileView('input');
  sidebar();
  renderConversation();
  $('thread').scrollTop = 0;
}
function renderConversation() {
  renderWork($('conversation'), focusedMessage(), state.messages, models, project?.id, {
    restore: (request) => {
      if (busy) throw Error('현재 전송이 끝난 뒤 복원하세요.');
      const draft = request.input.linkedTargets
        ? linkedRequestDraft(state, request)
        : request.result?.recovered
          ? recoveredRequestDraft(state, request)
          : failedRequestDraft(state, request);
      if (
        (state.linkedTargets?.length ||
          state.body.trim() ||
          (state.instructions || []).length ||
          state.pins.length ||
          state.sketches.length ||
          state.files.length ||
          pendingSketch()) &&
        !confirm('현재 작성 중인 초안을 저장된 요청 입력으로 바꿀까요?')
      )
        return;
      Object.assign(state, draft);
      selectedResult = draft.baseRequestId ?? null;
      appliedSelection = undefined;
      displayedResult = undefined;
      shownSignature = '';
      objects.splice(0, objects.length);
      viewport?.replace([]);
      strokes = [];
      $('body').value = state.body;
      render();
      renderMessages();
      if ($('right').hidden) $('toggle-right').click();
      mobileView('input');
      message('원 입력과 기준을 복원했습니다. 설정을 확인한 뒤 보내세요.');
    },
    candidate: (id) => {
      selectedResult = id;
      appliedSelection = undefined;
      renderMessages();
      showModelView();
    },
    selection: (requestId, id) => {
      selectInResult(requestId, id);
      showModelView();
    },
    report: downloadReport,
    saveReview: async (id) => {
      selectedResult = id;
      renderMessages();
      await reviews.create(id, captureViewport());
    },
    changed: renderMessages,
    error: message,
    focus: focusWork,
    intervene: (id) => {
      void submitRequest(id);
    },
    interventionReason: (id) => interventionReason(id),
  });
}

/** Layer paths in the stored Syncs, newest first: the output layers a jig instance may use. */
function syncLayerPaths() {
  const paths = new Set<string>();
  for (const entry of [...state.messages].reverse()) {
    if (entry.request.state !== 'succeeded') continue;
    const layers = (entry.request.result as { layers?: unknown } | null | undefined)?.layers;
    if (!Array.isArray(layers)) continue;
    for (const layer of layers as { fullPath?: unknown }[])
      if (typeof layer?.fullPath === 'string' && layer.fullPath) paths.add(layer.fullPath);
  }
  return [...paths];
}
// Workspace tabs (T-047): the JIG tab and jig context tabs use the project, its Syncs, the
// viewport and the conversation through this context.
attachJigs(
  (): JigContext => ({
    projectId: currentProject().id,
    projectName: currentProject().name,
    get layers() {
      return syncLayerPaths();
    },
    sources: linkedCandidates(state).map((entry) => ({
      id: entry.id,
      host: entry.request.result?.host === 'zwcad' ? 'zwcad' : 'rhino',
      label:
        (entry.request.result?.sourceDocument?.name || entry.body.slice(0, 60)) +
        (entry.request.createdAt
          ? ' · ' +
            new Date(entry.request.createdAt).toLocaleString('ko-KR', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : ''),
    })),
    show: (requestId, objectId) => {
      const shown = selectInResult(requestId, objectId);
      // The Sync's scene loads with the selection; frame it once it is shown.
      setTimeout(() => viewport?.fit(displayIdOf(objects, requestId, objectId) ?? shown), 400);
      mobileView('model');
    },
    tint: (requestId, colors) => {
      // Sync object ids → displayed ids; the verdict colours stay until the display is reset.
      const mapped: Record<string, string> = {};
      for (const [objectId, color] of Object.entries(colors)) {
        const id = displayIdOf(objects, requestId, objectId);
        if (id) mapped[id] = color;
      }
      viewport?.tint(Object.keys(mapped).length ? mapped : null);
      mobileView('model');
    },
    clearTint: () => viewport?.clearTint(),
    overlay: (key, items) => viewport?.overlay(key, items),
    overlayStyle: (key, style) => viewport?.overlayStyle(key, style),
    focus: (target) =>
      viewport?.focus(
        'requestId' in target
          ? target.ids.flatMap((id) => displayIdOf(objects, target.requestId, id) ?? [])
          : target,
      ),
    send: async (extra) => {
      const projectId = currentProject().id;
      const input = {
        ...packet({ ...state, body: extra.body, pins: [], sketches: [], files: [] }),
        id: crypto.randomUUID(),
        ...extra,
      };
      if (!extra.host) delete (input as Record<string, unknown>).host;
      if (!extra.baseRequestId) delete (input as Record<string, unknown>).baseRequestId;
      const request = await requestData(`/projects/${projectId}/requests`, 'POST', input);
      if (!state.messages.some((entry) => entry.id === request.id))
        state.messages.push(requestMessage(request));
      focusedWork = request.id;
      renderMessages();
      if ($('right').hidden) $('toggle-right').click();
      void poll(request.id, projectId, state);
    },
  }),
);
// The rail's JIG button goes back to the jig used last, or to the JIG list.
$('jigs').onclick = () => {
  if (project) showJigs();
};
/** A result shown from the conversation needs the 3D view: leave the JIG list for the model. */
function showModelView() {
  if (!workspaceShowsViewport()) setWorkspace('model');
}
// The documents panel belongs to the model tab: its rail buttons bring that tab back.
for (const button of document.querySelectorAll<HTMLButtonElement>('.rail [data-section]'))
  button.addEventListener('click', () => {
    if (activeWorkspace() !== 'model') setWorkspace('model');
  });
function openAiSettings() {
  void showAiSettings((rows) => {
    $('connection-status').textContent = rows
      .map(
        (row) =>
          `${row.id === 'claude-cli' ? 'Claude' : 'ChatGPT'} ${row.available ? '연결됨' : '미연결'}`,
      )
      .join(' · ');
  }).catch((error) => message(error.message));
}
const refreshAccount = accountIndicator(
  $('status-account'),
  () => models.find((m) => m.id === state.model)?.provider ?? '',
);
/** Model menu grouped by service; an older draft's "CLI default" becomes that service's first model. */
function fillModels() {
  $('model').replaceChildren();
  const labels: Record<string, string> = { 'claude-cli': 'Claude', 'codex-cli': 'ChatGPT' };
  // "자동 (Jev)" picks the service itself, so it sits first, outside the service groups.
  const automatic = (model: { id: string }) => model.id === 'auto';
  for (const model of models.filter(automatic))
    el('option', model.name, $('model'), { value: model.id });
  const listed = models.filter((m) => !automatic(m));
  for (const provider of [...new Set(listed.map((m) => m.provider))]) {
    const group = el('optgroup', '', $('model'), { label: labels[provider] ?? provider });
    for (const model of listed.filter((m) => m.provider === provider))
      el('option', model.name, group, { value: model.id });
  }
  if (!models.some((m) => m.id === state.model)) {
    const first = models.find((m) => m.provider === state.model);
    if (first) chooseModel(state, first.id);
  }
  $('model').value = state.model;
}
fillModels();
$('model').onchange = () => {
  chooseModel(state, $('model').value);
  void refreshAccount();
  render();
};
$('effort').oninput = () => {
  state.effort =
    models.find((m) => m.id === state.model)?.efforts[$('effort').valueAsNumber] || 'default';
  render();
};
$('permission').onchange = () => {
  state.applyToSource = $('permission').value === 'apply';
  state.permission = state.applyToSource
    ? 'candidate'
    : z.enum(['review', 'candidate']).parse($('permission').value);
  render();
};
$('body').oninput = () => {
  state.body = $('body').value;
  // Pins whose inline token was deleted from the message leave the request.
  const labels = tokenLabels(state.body);
  state.pins = state.pins.filter((pin) => !pin.label || labels.has(pin.label));
  render();
  // Drafts save automatically per project; only a failure is worth showing.
  $('saved').textContent = draftSaved ? '' : '초안 저장 실패';
  if (state.body.endsWith('@')) $('attach-menu').open = true;
};
/** Selected objects of the displayed model that can be pinned (they belong to a request basis). */
function pinnable() {
  return selectedIds.flatMap((id) => {
    const object = objects.find((o) => o.id === id && o.revision);
    return object ? [object] : [];
  });
}
const pinComposer = attachPinTokens($('body'), {
  selection: () => {
    const chosen = pinnable(),
      count = chosen.length;
    // No ghost for a selection that is already exactly one token's objects.
    const key = chosen
      .map((object) => sourceIdOf(object))
      .sort()
      .join();
    const labels = [...new Set(state.pins.map((pin) => pin.label).filter(Boolean))];
    if (
      labels.some(
        (label) =>
          state.pins
            .filter((pin) => pin.label === label)
            .map((pin) => pin.id)
            .sort()
            .join() === key,
      )
    )
      return { count: 0 };
    return { count: ready && !busy && count && state.pins.length + count <= 100 ? count : 0 };
  },
  insert: (label) => {
    state.pins.push(
      ...pinnable().map((object) => ({
        id: sourceIdOf(object),
        name: object.name,
        // Objects of another file than the composer's target are references (SPEC-01.11).
        role:
          state.baseRequestId && object.revision !== state.baseRequestId
            ? ('reference' as const)
            : ('target' as const),
        basis: object.revision!,
        label,
      })),
    );
  },
  focusToken: (label) => {
    selectedIds = state.pins
      .filter((pin) => pin.label === label)
      .flatMap((pin) => displayIdOf(objects, pin.basis, pin.id) ?? []);
    state.selected = selectedIds.at(-1) ?? null;
    render();
    if (selectedIds.length) viewport?.fit(selectedIds);
  },
});
refreshPinComposer = () => pinComposer.refresh();
function interventionReason(id: string): string | undefined {
  if (busy || !ready) return '현재 전송이 끝난 뒤 추가하세요.';
  const parent = state.messages.find((entry) => entry.id === id)?.request;
  const original = parent?.input;
  if (!parent || !original || original.parentRequestId) return '상위 작업에서 추가하세요.';
  if (!draftHasInput(state)) return '작성기에 바꿀 조건을 쓰면 추가 지시를 보낼 수 있습니다.';
  const draft = interventionTargetDraft(state, parent);
  if (validate(draft)) return validate(draft);
  if (
    (original.host || 'rhino') !== state.host ||
    original.permission !== state.permission ||
    Boolean(original.applyToSource) !== Boolean(state.applyToSource) ||
    (original.baseRequestId ?? null) !== (state.baseRequestId ?? null) ||
    JSON.stringify(original.linkedTargets) !== JSON.stringify(draft.linkedTargets)
  )
    return '이 작업의 대상·기준·권한을 맞춘 뒤 추가하세요.';
  if (
    state.messages.some(
      (entry) =>
        entry.request.input.supersedesRequestId === id &&
        ['queued', 'running'].includes(entry.request.state),
    )
  )
    return '이미 추가 지시가 대기 중입니다.';
}
const routeObjects = () =>
  objects.map((object) => ({
    id: object.id,
    type: object.type,
    layer: object.layerName ?? object.layer,
    name: object.name,
  }));
/** The open jig instance: the context tab shown now (older jigs' tabs have no settings). */
function openJigInstance() {
  const active = activeWorkspace();
  return contextTabs().find(
    (tab) => contextId(tab.instanceId) === active && !tab.instanceId.startsWith('legacy:'),
  )?.instanceId;
}
const jigInstancePath = (instanceId: string) =>
  `/projects/${encodeURIComponent(currentProject().id)}/jig-instances/${encodeURIComponent(instanceId)}`;
/** What the words are read against: the official jigs and the open jig's settings. */
async function routeContext(): Promise<{ context: RouteContext; instanceId?: string }> {
  const jigs = officialRouteJigs();
  const instanceId = openJigInstance();
  if (!instanceId) return { context: { jigs } };
  try {
    const view = (await api(jigInstancePath(instanceId))) as { params?: unknown } | null;
    return { context: { jigs, ...instanceRouteContext(view?.params) }, instanceId };
  } catch {
    return { context: { jigs } };
  }
}
/** Request routing (SPEC-02.17): Jev decides; without a key or on failure, the rules. */
async function decideRoute(body: string): Promise<{ route: Route; instanceId?: string }> {
  const { context, instanceId } = await routeContext();
  const rules = routeRequest(body, routeObjects(), selectedIds, context);
  const subjects = routeSubjects(routeObjects(), selectedIds);
  try {
    const answer = routeAnswer(
      await api(
        `/projects/${currentProject().id}/route`,
        'POST',
        routeQuery(body, subjects, context),
      ),
    );
    const route =
      answer.target === null ? rules : (jevRoute(answer, subjects, rules, context, body) ?? rules);
    return { route, instanceId };
  } catch {
    return { route: rules, instanceId };
  }
}
/** A notice with action buttons (undo, send to the AI after all). */
function messageWithActions(text: string, actions: { label: string; run: () => void }[]) {
  clearTimeout(toastTimer);
  const box = $('message');
  box.replaceChildren(text + ' ');
  for (const { label, run } of actions) {
    const button = el('button', label, box, { type: 'button', class: 'message-action' });
    button.onclick = () => {
      box.hidden = true;
      run();
    };
  }
  box.hidden = false;
  toastTimer = setTimeout(() => (box.hidden = true), 9000);
}
/** A notice with one action button (e.g. send a view-only request to the AI after all). */
function messageWithAction(text: string, label: string, action: () => void) {
  messageWithActions(text, [{ label, run: action }]);
}
/**
 * 'AI 작업으로 보내기' (SPEC-02.17 2): undo what VIDE did, record the reversal (route and who chose
 * it, never the words) and send the same words to the AI.
 */
function sendToAi(route: Route, body: string, undo: () => void = () => {}) {
  return () => {
    undo();
    hideRouteCard();
    void api(`/projects/${currentProject().id}/route/revert`, 'POST', routeRevert(route)).catch(
      () => {},
    );
    state.body = body;
    $('body').value = body;
    render();
    void submitRequest();
  };
}
function clearComposer() {
  state.body = '';
  $('body').value = '';
  render();
}
/** A proposal card over the composer (jig to open, T2 app action): one button carries it out. */
function showRouteCard(
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
function hideRouteCard() {
  $('route-card').hidden = true;
  $('route-card').replaceChildren();
}
/** The jig screens read the instance again after a setting changed from the request box. */
const jigParamsChanged = (instanceId: string) =>
  window.dispatchEvent(new CustomEvent('vide:jig-params-changed', { detail: { instanceId } }));
/**
 * A setting of the open jig read from the words (SPEC-02.17 2, SPEC-07.6): applied at once without
 * the AI, with an undo; a value the words do not give, a fixed setting or one out of range is not
 * applied and the notice says why.
 */
async function runParamRequest(route: Route, body: string, instanceId: string | undefined) {
  const param = route.param!;
  const change = param.change;
  const toAiOnly = (text: string) =>
    messageWithActions(text, [{ label: 'AI 작업으로 보내기', run: sendToAi(route, body) }]);
  if (!change.ok) return toAiOnly(change.text);
  if (!instanceId) return toAiOnly('설정값을 바꿀 jig 작업본이 열려 있지 않습니다.');
  const path = jigInstancePath(instanceId);
  try {
    const result = (await api(`${path}/params`, 'PUT', {
      values: [{ key: param.key, value: change.value }],
      by: 'user',
      reason: '요청 입력',
    })) as { seqs?: unknown } | null;
    const seq = Array.isArray(result?.seqs) ? Number(result.seqs[0]) : NaN;
    clearComposer();
    jigParamsChanged(instanceId);
    const undoable = Number.isInteger(seq) && seq > 0;
    const undo = () => {
      if (!undoable) return;
      void api(`${path}/params/undo`, 'POST', { seq })
        .then(() => jigParamsChanged(instanceId))
        .catch((cause) => {
          const error = readableError(cause);
          message(errors[error.code ?? ''] || error.message);
        });
    };
    messageWithActions(routeCard(route)?.text ?? change.text, [
      ...(undoable ? [{ label: '되돌리기', run: undo }] : []),
      { label: 'AI 작업으로 보내기', run: sendToAi(route, body, undo) },
    ]);
  } catch (cause) {
    const error = readableError(cause);
    toAiOnly(errors[error.code ?? ''] || error.message);
  }
}
/** Which linked file an app action names: the one chosen, the only one, or the one open now. */
function routedLink(id?: string) {
  if (id) return links.find((entry) => entry.id === id);
  if (links.length === 1) return links[0];
  return links.find(
    (entry) =>
      entry.connection?.instance === connectedTarget?.instance &&
      entry.connection?.documentId === connectedTarget?.documentId,
  );
}
/**
 * Routes VIDE does itself (SPEC-02.17 2·3, SPEC-02.19 7): a jig or a T1 app action (Sync) is
 * proposed on a card with its one button, a T2 one waits for its confirmation card. Every notice
 * and card keeps 'AI 작업으로 보내기'.
 */
function runAppRoute(route: Route, body: string) {
  const toAi = sendToAi(route, body);
  const card = routeCard(route, { signedIn: providerSignedIn });
  if (!card) return void submitRequest();
  if (route.jig) {
    const name = route.jig.name;
    showRouteCard(
      card.text,
      {
        label: card.run ?? '열기',
        action: () => {
          clearComposer();
          setWorkspace('jig');
          message(`JIG 목록에서 '${name}'을(를) 여세요.`);
        },
      },
      toAi,
    );
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
          void syncLink(link, 'manual');
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
  // Signing in, out or switching accounts happens in the account settings, where the one-time code
  // is typed into the login window itself; the connector install and offline view in the settings.
  const open = ['login', 'logout', 'switch_account'].includes(app.action)
    ? () => openAiSettings()
    : app.action === 'export'
      ? () => message('내보내기는 jig 결과 표나 검토본 화면의 내보내기 버튼에서 합니다.')
      : () => $('workspace-settings').click();
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
function runViewRequest(route: Route, body: string) {
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
  const before = [...selectedIds];
  if (view.action === 'hide') viewport?.hide(view.ids);
  else if (view.action === 'isolate') viewport?.isolate(view.ids);
  else if (view.action === 'unhide') viewport?.unhide();
  else if (view.action === 'fit') viewport?.fit(view.ids);
  else {
    selectedIds = [...view.ids];
    state.selected = selectedIds.at(-1) ?? null;
  }
  const verb = {
    hide: '숨김',
    isolate: '만 표시',
    unhide: '모두 보이기',
    select: '선택',
    fit: '확대',
  }[view.action];
  state.body = '';
  $('body').value = '';
  render();
  messageWithAction(
    view.action === 'unhide'
      ? '숨긴 객체를 모두 다시 보입니다 · 원본은 그대로입니다.'
      : `화면에서 ${view.subject} ${count}개 ${verb} · 원본은 그대로입니다. 다시 보이게 하려면 U.`,
    'AI 작업으로 보내기',
    toAi(() => {
      if (view.action === 'hide' || view.action === 'isolate') viewport?.unhide();
      if (view.action === 'select') {
        selectedIds = before;
        state.selected = selectedIds.at(-1) ?? null;
      }
    }),
  );
}
$('request').onclick = () => {
  if (!state.body.trim() || state.linkedTargets || busy) {
    void submitRequest();
    return;
  }
  if (routing) return;
  routing = true;
  const body = state.body;
  $('request').setAttribute('aria-busy', 'true');
  hideRouteCard();
  void decideRoute(body)
    .then(({ route, instanceId }) => {
      if (route.target === 'view') runViewRequest(route, body);
      else if (route.target === 'param') void runParamRequest(route, body, instanceId);
      else if (goesToAi(route)) void submitRequest();
      else runAppRoute(route, body);
    })
    .finally(() => {
      routing = false;
      $('request').removeAttribute('aria-busy');
    });
};
async function submitRequest(predecessorId?: string) {
  if (validate(state) || busy || !project || (predecessorId && interventionReason(predecessorId)))
    return;
  busy = true;
  render();
  const predecessor =
    predecessorId && state.messages.find((entry) => entry.id === predecessorId)?.request;
  const conversationId = predecessorId ? undefined : currentConversation();
  const input = {
    ...packet(predecessor ? interventionTargetDraft(state, predecessor) : state),
    id: crypto.randomUUID(),
    ...(conversationId ? { conversationId } : {}),
  };
  // Pins and sketches also go to the AI as a picture of the view with them drawn (PLAN-24).
  const image = predecessor ? undefined : annotatedCapture();
  if (image) Object.assign(input, { images: [image] });
  const projectId = currentProject().id,
    original = state;
  try {
    const path =
      `/projects/${projectId}/requests` + (predecessorId ? `/${predecessorId}/interventions` : '');
    const request = await requestData(path, 'POST', input);
    if (project?.id !== projectId || state !== original) return;
    if (!state.messages.some((entry) => entry.id === request.id))
      state.messages.push(requestMessage(request));
    state.body = '';
    state.instructions = [];
    state.pins = [];
    state.sketches = [];
    state.files = [];
    state.linkedTargets = undefined;
    state.coordinateBasis = undefined;
    $('body').value = '';
    if (selectedResult === undefined) selectedResult = displayedResult ?? null;
    foregroundRequest = { id: request.id, selected: selectedResult, draft: focusDraft() };
    focusedWork = request.id;
    renderMessages();
    void conversationChips?.refresh();
    void poll(request.id, projectId, original);
    const waiting = waitingOf(request);
    if (waiting) message(`${waitingText(waiting)} · 앞 작업이 끝나면 자동으로 시작합니다.`);
  } catch (cause) {
    const error = readableError(cause);
    message(errors[error.code ?? ''] || error.message);
  } finally {
    busy = false;
    render();
  }
}
async function poll(id: string, projectId = currentProject().id, original = state) {
  if (project?.id !== projectId || state !== original) return;
  if (selectedResult === undefined) selectedResult = displayedResult ?? null;
  try {
    const request = await requestData(`/projects/${projectId}/requests/${id}`);
    const children = await Promise.all(
      (request.result?.targetResults || []).map((target) =>
        requestData(`/projects/${projectId}/requests/${target.requestId}`),
      ),
    );
    if (project?.id !== projectId || state !== original) return;
    for (const child of children) {
      const existing = state.messages.find((message) => message.id === child.id);
      if (existing) existing.request = child;
      else state.messages.push(requestMessage(child));
    }
    const m = state.messages.find((x) => x.id === id);
    if (m) m.request = request;
    if (request.result?.hostExecuted && foregroundRequest?.id === id) {
      if (foregroundRequest.selected === selectedResult && foregroundRequest.draft === focusDraft())
        selectedResult = request.id;
      foregroundRequest = undefined;
    }
    renderMessages();
    render();
    if (['queued', 'running'].includes(request.state))
      setTimeout(() => poll(id, projectId, original), 1200);
  } catch (cause) {
    const error = readableError(cause);
    if (project?.id !== projectId || state !== original) return;
    message('작업 상태 연결이 끊겼습니다. 새로고침하면 저장된 기록을 다시 읽습니다.');
  }
}
/** Shift+Tab cycles Plan → Accept edits → Auto, like Claude Code. */
function cycleMode() {
  const order = ['review', 'candidate', 'apply'];
  $('permission').value = order[(order.indexOf($('permission').value) + 1) % order.length];
  $('permission').dispatchEvent(new Event('change'));
  const label = $('permission').selectedOptions[0];
  message(`${label.textContent} · ${label.title}`);
}
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
$('pin').onclick = () => {
  $('attach-menu').open = false;
  pinComposer.insertSelection();
};
$('toggle-recent').onclick = () => {
  const open = $('recent-section').dataset.open !== 'true';
  $('recent-section').dataset.open = String(open);
  $('toggle-recent').setAttribute('aria-expanded', String(open));
};
$('inspect-selection').onclick = () => {
  $('attach-menu').open = false;
  void attachConnectedSelection().catch((error) => message(readableError(error).message));
};
$('draw').onclick = () => {
  $('attach-menu').open = false;
  mobileView('model');
  setTool('sketch');
};
$('attach-file').onclick = () => {
  $('files').click();
  $('attach-menu').open = false;
};
$('linked-targets').onclick = () => {
  if (busy) return;
  $('attach-menu').open = false;
  const original = state;
  showLinkedTargets(state, () => {
    if (state !== original) throw Error('프로젝트가 바뀌었습니다.');
    render();
  });
};
$('files').onchange = async () => {
  try {
    const original = state;
    const selectedFiles = Array.from($('files').files ?? []);
    if (selectedFiles.some((f) => f.size > 50000 || !/\.(txt|md|csv|json)$/i.test(f.name)))
      throw Error('현재 참고 자료는 파일당 50,000바이트 이하 TXT·MD·CSV·JSON을 지원합니다.');
    const attached = [];
    for (const f of selectedFiles) {
      attached.push({
        name: f.name,
        size: f.size,
        type: f.type,
        text: await f.text(),
        contentStatus: 'included',
      });
    }
    if (state !== original) throw Error('프로젝트가 바뀌어 파일 첨부를 취소했습니다.');
    state.files.push(...attached);
    render();
  } catch (cause) {
    const error = readableError(cause);
    message(error.message);
  } finally {
    $('files').value = '';
  }
};
$('selection-pin').onclick = () => {
  $('pin').click();
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]'))
  button.onclick = () => setTool(z.enum(['select', 'pin', 'sketch']).parse(button.dataset.tool));
for (const id of ['brush-color', 'brush-width'] as const)
  $(id).addEventListener('input', brushSettings);
$('brush-surface').onclick = () => {
  $('brush-surface').setAttribute('aria-pressed', String(!followSurface()));
  brushSettings();
};
for (const swatch of document.querySelectorAll<HTMLButtonElement>('.swatch')) {
  // The page CSP blocks inline style attributes; set each swatch's color through the CSSOM.
  swatch.style.setProperty('--swatch', swatch.dataset.color ?? '#d0473a');
  swatch.onclick = () => {
    $('brush-color').value = swatch.dataset.color ?? '#d0473a';
    setEraser(false);
  };
}
$('brush-eraser').onclick = () =>
  setEraser($('brush-eraser').getAttribute('aria-pressed') !== 'true');
$('clear-sketch').onclick = () => {
  strokes = [];
  draw();
};
$('finish-sketch').onclick = () => {
  try {
    attachStrokes();
    setTool('select');
    mobileView('input');
    $('body').focus();
  } catch (cause) {
    message(readableError(cause).message);
  }
};
$('cancel-sketch').onclick = () => {
  strokes = [];
  setTool('select');
};
$('undo-point').onclick = () => {
  strokes.pop();
  draw();
};
$('fit-view').onclick = () => viewport?.fit();
$('projection').onchange = () => {
  if ($('projection').value === 'axon') viewport?.home();
  else
    viewport?.plane(
      ({ plan: 'XY', front: 'XZ', side: 'YZ' } as const)[
        z.enum(['plan', 'front', 'side']).parse($('projection').value)
      ],
    );
};
function mobileView(view: MobileView) {
  setMobileView(view);
}
for (const side of ['left', 'right'])
  $(`toggle-${side}`).onclick = () => {
    if (matchMedia('(max-width:850px)').matches) {
      $(side).hidden = false;
      mobileView(side === 'left' ? 'documents' : 'input');
      return;
    }
    $(side).hidden = !$(side).hidden;
    document.body.classList.toggle(`${side}-hidden`, Boolean($(side).hidden));
    $(`toggle-${side}`).setAttribute('aria-expanded', String(!$(side).hidden));
    $(`toggle-${side}`).textContent =
      side === 'left' ? ($(side).hidden ? '›' : '‹') : $(side).hidden ? '‹' : '›';
    $(`toggle-${side}`).focus();
  };
document.addEventListener('keydown', (e) => {
  const typing =
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLTextAreaElement ||
    e.target instanceof HTMLSelectElement;
  if (tool === 'sketch' && !typing) {
    if (e.key === 'e' || e.key === 'E') {
      setEraser($('brush-eraser').getAttribute('aria-pressed') !== 'true');
      return;
    }
    if (e.key === 's' || e.key === 'S') {
      $('brush-surface').click();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      $('undo-point').click();
      return;
    }
    if (e.key === '[' || e.key === ']') {
      const width = $('brush-width').valueAsNumber + (e.key === ']' ? 1 : -1);
      $('brush-width').value = String(Math.min(24, Math.max(1, width)));
      brushSettings();
      return;
    }
  }
  // 3D shortcuts only where the 3D view is (not the JIG list).
  if (!typing && tool !== 'sketch' && viewport && !e.altKey && workspaceShowsViewport()) {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 'a') {
      e.preventDefault();
      const shown = new Set(viewport.visibleIds());
      selectedIds = objects.map((o) => o.id).filter((id) => shown.has(id));
      state.selected = selectedIds.at(-1) ?? null;
      render();
      return;
    }
    if (!e.ctrlKey && !e.metaKey && ['h', 'i', 'u', 'z'].includes(key)) {
      e.preventDefault();
      if (key === 'z') viewport.fit(selectedIds.length ? selectedIds : undefined);
      else if (key === 'u') {
        const count = viewport.hiddenCount();
        viewport.unhide();
        if (count) message(`숨긴 객체 ${count.toLocaleString()}개를 다시 표시했습니다.`);
      } else if (!selectedIds.length) message('먼저 객체를 선택하세요.');
      else {
        if (key === 'h') viewport.hide(selectedIds);
        else viewport.isolate(selectedIds);
        message(
          key === 'h'
            ? `${selectedIds.length.toLocaleString()}개 숨김 · U로 모두 표시`
            : `선택한 ${selectedIds.length.toLocaleString()}개만 표시 · U로 모두 표시`,
        );
        if (key === 'h') {
          selectedIds = [];
          state.selected = null;
        }
        render();
      }
      return;
    }
  }
  if (e.key === 'Escape') {
    if (tool !== 'sketch' && selectedIds.length && !(e.target instanceof HTMLTextAreaElement)) {
      selectedIds = [];
      state.selected = null;
      render();
    }
    if (tool === 'sketch') {
      strokes = [];
      setTool('select');
    }
    $('attach-menu').open = false;
    const effortMenu = document.querySelector<HTMLDetailsElement>('#effort-menu')!;
    if (effortMenu.open) {
      effortMenu.open = false;
      effortMenu.querySelector<HTMLElement>('summary')?.focus();
    }
  }
  if (e.altKey && e.shiftKey && ['KeyL', 'KeyR'].includes(e.code)) {
    e.preventDefault();
    $(`toggle-${e.code === 'KeyL' ? 'left' : 'right'}`).click();
  }
});
document.addEventListener('pointerdown', (e) => {
  for (const id of ['effort-menu', 'attach-menu']) {
    const menu = document.getElementById(id);
    if (menu instanceof HTMLDetailsElement && menu.open && !menu.contains(e.target as Node))
      menu.open = false;
  }
});
window.addEventListener('beforeunload', (e) => {
  if (
    pendingSketch() ||
    (!draftSaved &&
      (state.body || state.instructions?.length || state.pins.length || state.sketches.length))
  ) {
    e.preventDefault();
    e.returnValue = '';
  }
});
window.addEventListener('pagehide', () => viewport?.dispose(), { once: true });
mobileView(panelMode ? 'input' : 'model');
render();

function selectProject(id: string) {
  location.search = '?project=' + encodeURIComponent(id);
}
async function createProject(name: string) {
  try {
    const p = z.object({ id: z.string() }).parse(await api('/projects', 'POST', { name }));
    location.search = '?project=' + encodeURIComponent(p.id);
  } catch (cause) {
    message(readableError(cause).message);
  }
}
async function renameProject(name: string) {
  if (!project) return;
  try {
    const renamed = z
      .object({ id: z.string(), name: z.string() })
      .parse(await api(`/projects/${project.id}`, 'PUT', { name }));
    project = renamed;
    projects = projects.map((entry) => (entry.id === renamed.id ? renamed : entry));
    document.title = `${renamed.name} · VIDE`;
    renderHeading();
  } catch (cause) {
    message(readableError(cause).message);
  }
}
function renderHeading() {
  renderPanel();
  // Link back to the account site's project list when this PC is signed in.
  const home = $('rail-home') as HTMLAnchorElement;
  home.hidden = !accountSite;
  if (accountSite) home.href = accountSite;
  if (!project) return;
  renderProjectHeading({
    projects,
    selected: project.id,
    select: selectProject,
    create: createProject,
    rename: renameProject,
  });
}

$('import-model').onclick = () => {
  if (project && !busy) $('model-file').click();
};
$('model-file').onchange = async () => {
  const file = $('model-file').files?.[0];
  if (!file || !project) return;
  if (file.size > 64 * 1024 * 1024) {
    message('현재 파일 크기는 64MB까지 지원합니다.');
    return;
  }
  busy = true;
  $('import-model').disabled = true;
  render();
  message('모델 작업 사본을 읽고 있습니다.');
  try {
    const response = await fetch(
      `api/v1/projects/${currentProject().id}/import?name=${encodeURIComponent(file.name)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
    );
    const value: unknown = await response.json();
    if (!response.ok) throw Error(z.object({ code: z.string() }).parse(value).code);
    const request = requestMessage(value).request;
    state.messages.push(requestMessage(request));
    if (request.result?.hostExecuted) {
      selectedResult = request.id;
      state.pins = [];
    }
    renderMessages();
    message(
      request.state === 'succeeded'
        ? '작업 사본을 열었습니다.'
        : errors[request.result?.code ?? ''] || '불러오기에 실패했습니다.',
    );
  } catch (cause) {
    const error = readableError(cause);
    message(error.message);
  } finally {
    busy = false;
    $('import-model').disabled = false;
    $('model-file').value = '';
    render();
  }
};

async function downloadReport(id: string) {
  try {
    selectedResult = id;
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

$('host-target').onchange = () => {
  state.host = z.enum(['rhino', 'zwcad']).parse($('host-target').value);
  state.baseRequestId = undefined;
  state.selected = null;
  selectedResult = undefined;
  appliedSelection = undefined;
  displayedResult = undefined;
  shownSignature = '';
  objects.splice(0, objects.length);
  viewport?.replace([]);
  renderMessages();
  render();
};

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
  button.onclick = () => {
    $('projection').value = z.enum(['axon', 'plan', 'front', 'side']).parse(button.dataset.view);
    $('projection').dispatchEvent(new Event('change'));
  };
$('fit-selection').onclick = () => {
  if (state.selected) viewport?.fit(state.selected);
  else message('먼저 객체를 선택하세요.');
};
$('projection-toggle').onclick = () => {
  viewport?.projection(
    $('projection-toggle').dataset.projection === 'perspective' ? 'orthographic' : 'perspective',
  );
};

$('add-request').onclick = () => {
  if (!state.body.trim()) return;
  state.instructions ??= [];
  state.instructions.push(state.body);
  state.body = '';
  $('body').value = '';
  render();
  $('body').focus();
};

let catalogGeneration = 0;
window.addEventListener('vide-accounts-changed', () => {
  const current = ++catalogGeneration;
  void (async () => {
    const catalog = modelsSchema.parse(await api('/models'));
    if (current !== catalogGeneration) return;
    models.splice(0, models.length, ...catalog);
    // Keep the explicit model if supported; require a fresh selection if absent.
    fillModels();
    render();
    void refreshAccount();
  })().catch((error) => message(readableError(error).message));
});

// Rhino link: panel mode, shared pins and live selection for the attached Rhino document.
function rhinoBasis(target: HostTarget) {
  return state.messages
    .filter(
      (entry) =>
        entry.request?.result?.hostExecuted &&
        entry.request.result.sourceDocument?.instance === target.instance &&
        entry.request.result.sourceDocument.documentId === target.documentId &&
        (entry.source === 'document' || entry.request.result.applicationState === 'succeeded'),
    )
    .at(-1);
}
if (panelMode) {
  document.body.classList.add('panel-mode');
  document.documentElement.dataset.theme = panelParams.get('theme') === 'dark' ? 'dark' : 'light';
  const documentId = Number(panelParams.get('document'));
  const instance = panelParams.get('instance') ?? '';
  if (instance && documentId > 0) connectedTarget = { instance, documentId };
  else {
    // Not linked yet: one card with the Link action; nothing to send a request about.
    panelView.state = 'unlinked';
    document.body.classList.add('panel-unlinked');
    renderLinkCard($('panel-card'), panelHost!, panelView.file);
    $('panel-card').hidden = false;
  }
  $('panel-header').hidden = false;
  $('panel-footer').hidden = false;
  renderPanel();
}
function renderPanel() {
  if (!panelMode) return;
  renderPanelHeader($('panel-header'), {
    host: panelHost!,
    file: panelView.file,
    state: panelView.state,
    detail: panelView.detail,
    project: project?.name,
    syncing: linkSyncing,
    onSync: () => {
      const target = connectedTarget;
      const link = links.find(
        (entry) =>
          entry.connection?.instance === target?.instance &&
          entry.connection?.documentId === target?.documentId,
      );
      if (link) void syncLink(link, 'manual');
      else
        message(
          '이 파일이 아직 이 프로젝트의 연결 파일 목록에 없습니다. ⋯ → 다른 프로젝트에 연결로 다시 연결하세요.',
        );
    },
  });
}
/** The panel's "선택 N개 첨부": Rhino keeps them as its pinned set; CAD attaches them to the draft. */
async function attachPanelSelection() {
  try {
    const target = connectedTarget;
    if (!target) throw Error('파일이 연결되지 않았습니다.');
    if (panelHost === 'rhino') {
      await setHostPins([...new Set([...hostPinned, ...panelView.selection])]);
      if (!rhinoBasis(target)) message('첨부했습니다. 요청에 포함하려면 먼저 Sync 하세요.');
      return;
    }
    const selection = hostSelectionSchema.parse(
      await api(
        `/host/selection?instance=${encodeURIComponent(target.instance)}&document=${target.documentId}`,
      ),
    );
    const count = attachHostSelection(state, rhinoBasis(target)?.request, selection);
    render();
    message(count ? `${count}개 객체를 요청에 첨부했습니다.` : '먼저 Sync 하세요.');
  } catch (cause) {
    message(readableError(cause).message);
  }
}
/** Rhino's pinned set is the source of truth while a Rhino document is attached. */
function applyHostPins(ids: string[]) {
  hostPinned = ids;
  const target = connectedTarget,
    basis = target && rhinoBasis(target);
  hostPinBasis = basis?.id;
  if (!basis) return;
  const available = basis.request.result?.objects ?? [];
  // Rhino's set replaces the pins of every Sync of this document, not only the newest one.
  const sameDocument = (id: string) => {
    const source = state.messages.find((entry) => entry.id === id)?.request.result?.sourceDocument;
    return source?.instance === target.instance && source.documentId === target.documentId;
  };
  state.pins = [
    ...state.pins.filter((pin) => pin.basis !== basis.id && !sameDocument(pin.basis)),
    ...ids.flatMap((id) => {
      const object = available.find((item) => item.id === id);
      return object ? [{ id, name: object.name, role: 'target' as const, basis: basis.id }] : [];
    }),
  ];
}
async function setHostPins(ids: string[]) {
  if (!connectedTarget) return false;
  const reply = z
    .object({ pinnedIds: z.array(z.string()) })
    .parse(await api('/host/pins', 'POST', { ...connectedTarget, ids }));
  applyHostPins(reply.pinnedIds);
  render();
  return true;
}
let hostLinkPolling = false;
async function pollHostLink() {
  const target = connectedTarget;
  // One status call at a time: a slow host must not pile up overlapping polls.
  if (!ready || !target || document.hidden || hostLinkPolling) return;
  hostLinkPolling = true;
  try {
    const catalog = hostDocumentsSchema.parse(await api('/host/attached-documents'));
    const item = catalog.documents.find(
      (doc) =>
        (doc.instance ?? catalog.instance) === target.instance && doc.id === target.documentId,
    );
    if (!item) {
      if (panelMode && panelView.state !== 'lost') {
        panelView.state = 'lost';
        renderPanel();
      }
      return;
    }
    const basis = rhinoBasis(target);
    if (panelMode) {
      panelView.file = item.name;
      panelView.state = item.live ? 'live' : 'connected';
      panelView.detail = [
        basis?.request.createdAt
          ? 'Sync ' +
            new Date(basis.request.createdAt).toLocaleTimeString('ko-KR', {
              hour: '2-digit',
              minute: '2-digit',
            })
          : 'Sync 필요',
        `${item.objectCount.toLocaleString()}개`,
      ].join(' · ');
      // Rhino reports its selection with the document; CAD is asked separately.
      const selection =
        panelHost === 'rhino'
          ? (item.selectedIds ?? []).filter((id) => !(item.pinnedIds ?? []).includes(id))
          : await api(
              `/host/selection?instance=${encodeURIComponent(target.instance)}&document=${target.documentId}`,
            )
              .then((value) => hostSelectionSchema.parse(value).selectedIds)
              .catch(() => panelView.selection);
      const changed = selection.join() !== panelView.selection.join();
      panelView.selection = selection;
      renderPanel();
      if (changed) render();
    }
    const pinned = item.pinnedIds ?? [];
    // Re-resolve when Rhino's pins change or a new Sync basis arrives.
    if (pinned.join() !== hostPinned.join() || (pinned.length && basis?.id !== hostPinBasis)) {
      applyHostPins(pinned);
      render();
    }
    if (item.selectionVersion !== undefined && item.selectionVersion !== hostSelectionVersion) {
      hostSelectionVersion = item.selectionVersion;
      // Mirror Rhino's selection in the viewport when this document is the one on screen.
      const basis = displayedResult ?? rhinoBasis(target)?.id;
      const mirrored = basis
        ? (item.selectedIds ?? []).flatMap((id) => displayIdOf(objects, basis, id) ?? [])
        : [];
      if (mirrored.length || selectedIds.length) {
        selectedIds = mirrored;
        state.selected = mirrored.at(-1) ?? null;
        render();
      }
    }
  } catch {
    /* Transient; the next poll retries. */
  } finally {
    hostLinkPolling = false;
  }
}
setInterval(() => void pollHostLink(), 1200);
async function initializeWorkspace() {
  try {
    const linked = await connect();
    // Usage needs the session that connect() just opened.
    mountUsageBars(panelMode ? $('panel-footer') : $('usage-bars'));
    void workspaceStatus.refreshAccount();
    const catalog = modelsSchema.parse(await api('/models'));
    models.splice(0, models.length, ...catalog);
    fillModels();
    project = linked.project;
    state.messages = linked.requests.map(requestMessage);
    const lastSync = state.messages.filter((entry) => entry.source === 'document').at(-1);
    if (lastSync?.request.state === 'failed') viewportEmpty.sync('failed');
    void reviews.refresh().catch((error) => message(error.message));
    projects = linked.projects;
    document.title = `${project.name} · VIDE`;
    renderHeading();
    let restored = false;
    try {
      const raw = localStorage.getItem('vide:draft:' + project.id);
      if (raw) {
        state = restoreDraft(JSON.parse(raw), state.messages);
        selectedResult = state.baseRequestId ?? null;
        restored = true;
        $('body').value = state.body;
      }
    } catch {
      unreadableDraft = true;
      message('저장된 초안의 형식 또는 기준을 확인할 수 없습니다. 작업 이력은 유지됩니다.');
    }
    if (!restored)
      selectedResult = linked.requests.filter((request) => request.result?.hostExecuted).at(-1)?.id;
    ready = true;
    void refreshAccount();
    render();
    renderMessages();
    // The tab row and this project's last tab; host panels have neither (SCR-12).
    if (!panelMode) initializeWorkspaces({ projectId: project.id, mount: $('workspace-tabs') });
    void mountConversationScreens();
    for (const entry of state.messages)
      if (['queued', 'running'].includes(entry.request.state)) void poll(entry.id);
    const host = hostStatusSchema.parse(await api('/host'));
    const providers = providersSchema.parse(await api('/providers'));
    providerSignedIn = Object.fromEntries(
      providers.map((provider) => [provider.id, provider.available]),
    );
    $('connection-status').textContent = providers
      .map(
        (provider) =>
          `${provider.id === 'claude-cli' ? 'Claude' : 'ChatGPT'} ${provider.available ? '연결됨' : '미연결'}`,
      )
      .join(' · ');
    $('host-status').textContent =
      'Rhino ' +
      (host.available ? '실행 준비' : '미연결') +
      ' · ZWCAD ' +
      (host.zwcadAvailable ? '실행 준비' : '미연결') +
      ' · 문서 연결은 문서 목록에서 확인';
  } catch (cause) {
    const error = readableError(cause);
    message(errors[error.code ?? ''] || error.message);
  }
}
window.addEventListener('vide:connection-lost', (event) => {
  ready = false;
  $('auth-status').hidden = false;
  const code = (event as CustomEvent<string>).detail;
  if (remoteSession()) {
    // Opened from another device: the PC restarted or went off. Reopen from the project list.
    $('auth-status').textContent =
      (code === 'UNAUTHORIZED'
        ? '작업 PC 세션이 끝났습니다(PC 재시작 등).'
        : errors[code] || '작업 PC 연결이 끊겼습니다.') + ' 초안은 유지됩니다. ';
    el('a', '프로젝트 목록에서 다시 열기', $('auth-status'), { href: '/' });
    message($('auth-status').textContent ?? '');
  } else
    $('auth-status').textContent =
      code === 'UNAUTHORIZED'
        ? '로컬 인증이 만료됐습니다. VIDE 실행 링크로 다시 여세요. 초안은 유지됩니다.'
        : '로컬 서버 연결이 끊겼습니다. 서버 확인 후 다시 여세요. 초안은 유지됩니다.';
  $('connection-status').textContent = '연결 상태 확인 필요';
  $('host-status').textContent = '호스트 상태 확인 필요';
  render();
});
await initializeWorkspace();

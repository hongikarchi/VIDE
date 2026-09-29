import { initializeViewportEmpty } from './viewport-empty.ts';
import { initializeWorkspaceStatus } from './workspace-status.ts';
import { linkedRequestDraft, interventionTargetDraft } from './linked-draft.ts';
import { accountIndicator } from './account-indicator.ts';
import { executionLimits } from '../contracts/execution-limits.ts';
import { showExecutionLimits } from './execution-limits.tsx';
import { requestConflict } from '../contracts/request-scope.ts';
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
import { showExtensions } from './extensions.tsx';
import { hideJigs, showJigs } from './jigs.tsx';
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
import { composeLayers, displayIdOf, layerSignature, sourceIdOf } from './layers.ts';
import { routeRequest, type Route } from './request-route.ts';
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

// Rhino panel mode (?panel=rhino): the chat column only, bound to one attached document.
const panelParams = new URLSearchParams(location.search);
const panelMode = panelParams.get('panel') === 'rhino';
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
// Request routing (SPEC-02.15): a flipped route chip and the automatic model choice.
let routeOverride: 'view' | 'document' | undefined,
  autoModel = true,
  autoModelReason = '';
const focusDraft = () => JSON.stringify({ draft: draftSnapshot(state), strokes });
initializeWorkspacePanels();
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
/** SPEC-01.9 Live Sync: apply only the objects Rhino changed to the latest display Sync. */
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
// Linked files (SPEC-01.9): files linked from the host plugins, drawn together as layers. No file
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
/** The composer's target follows the active layer (SPEC-01.9 요청 대상). */
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
/** Draft or running work based on this file holds its automatic updates (SPEC-01.9 보류). */
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
    linksLoaded = true;
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
  applyAutoModel();
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
  renderLinks($('host-document-controls'), {
    links,
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
          `${link.name}을(를) 이 프로젝트의 연결 목록에서 뺄까요? 파일과 Sync 기록은 그대로입니다.`,
        )
      )
        return;
      void api(`/projects/${currentProject().id}/links/${link.id}/remove`, 'POST', {})
        .then(() => {
          links = links.filter((entry) => entry.id !== link.id);
          layerOverride.delete(link.id);
          renderMessages();
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
    (ids, mode, pin) => applySelection(ids, mode, pin),
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
  // Where this request goes and which model it uses (SPEC-02.15), changeable before sending.
  const route = state.body.trim() ? currentRoute() : undefined;
  // Ordinary file work needs no chip; show where it goes when screen words or a flip are involved.
  if (route && (route.target === 'view' || route.viewWords || routeOverride)) {
    const view = route.target === 'view';
    const routeChip = el(
      'button',
      view
        ? `🖥 VIDE 화면만 · ${route.view?.subject ? `${route.view.subject} ${route.view.ids.length}개` : route.view?.action === 'unhide' ? '모두 보이기' : '대상 확인 필요'}`
        : '📄 파일 작업',
      $('context'),
      {
        type: 'button',
        class: 'chip route-chip',
        'data-target': route.target,
        title: `${route.reason}. 누르면 ${view ? '파일 작업(AI가 원본 작업 사본을 고침)' : 'VIDE 화면만(원본은 그대로)'}으로 바꿉니다.`,
      },
    );
    routeChip.onclick = () => {
      routeOverride = view ? 'document' : 'view';
      render();
    };
  }
  if (route?.target === 'document' && autoModelReason)
    el(
      'span',
      `모델 자동 · ${models.find((m) => m.id === state.model)?.name ?? state.model} (${autoModelReason})`,
      $('context'),
      {
        class: 'chip model-chip',
        title:
          '모델링은 GPT-6-Astra, 프로그램 작업은 Claude Opus 5.5를 고릅니다. 모델을 직접 고르면 자동 선택을 멈춥니다.',
      },
    );
  // Several files on screen: say which one this request changes (SPEC-01.9 요청 대상).
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
  $('workspace-status').textContent = state.messages.some((m) =>
    ['queued', 'running'].includes(m.request?.state),
  )
    ? '작업 진행 중'
    : project
      ? '로컬 작업 공간 · ' + project.name
      : '연결 중';
  sidebar();
  const conflict = requestConflict(
    { ...state, id: '__draft__', baseRequestId: state.baseRequestId ?? null },
    state.messages.map((entry) => entry.request),
  );
  $('request').disabled = !ready || !project || busy || !!conflict || !!validate(state);
  $('request').title = validate(state) || (conflict && errors[conflict]) || '보내기 · Ctrl+Enter';
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
/** Draw every visible layer together (SPEC-01.9); rebuild only when the layer set changed. */
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
    },
    selection: (requestId, id) => {
      selectInResult(requestId, id);
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

function openExtensions() {
  if (!project) return;
  hideJigs();
  void showExtensions(
    {
      projectId: project.id,
      requestId: displayedResult,
      selected: state.selected,
      objects: structuredClone(objects),
    },
    (request) => {
      if (!state.messages.some((message) => message.id === request.id))
        state.messages.push(requestMessage(request));
      focusedWork = request.id;
      renderMessages();
      render();
      mobileView('input');
    },
  ).catch((error) => message(error.message));
}
// JIG tab: the jig gallery and the Sync jig (relation and differences of a Rhino and a CAD Sync).
$('jigs').onclick = () => {
  if (!project) return;
  showJigs({
    projectId: project.id,
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
      hideJigs();
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
      hideJigs();
      mobileView('model');
    },
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
    extensions: openExtensions,
  });
};
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
  for (const provider of [...new Set(models.map((m) => m.provider))]) {
    const group = el('optgroup', '', $('model'), { label: labels[provider] ?? provider });
    for (const model of models.filter((m) => m.provider === provider))
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
  // The user's own choice wins over the automatic one until the next request.
  autoModel = false;
  autoModelReason = '';
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
  applyAutoModel();
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
        // Objects of another file than the composer's target are references (SPEC-01.9).
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
/** Request routing (SPEC-02.15): the rule result, unless the user flipped the chip. */
function currentRoute(): Route {
  const route = routeRequest(
    state.body,
    objects.map((object) => ({
      id: object.id,
      type: object.type,
      layer: object.layerName ?? object.layer,
      name: object.name,
    })),
    models,
    selectedIds,
  );
  if (!routeOverride || routeOverride === route.target) return route;
  if (routeOverride === 'document')
    return { target: 'document', reason: '사용자가 파일 작업으로 바꿨습니다' };
  // Flipped to the screen: act on the selection, or say that objects are needed.
  return {
    target: 'view',
    view: route.view ?? {
      action: 'isolate',
      ids: [...selectedIds],
      subject: selectedIds.length ? '선택한 객체' : '',
    },
    reason: '사용자가 VIDE 화면만으로 바꿨습니다',
  };
}
/** Modeling → GPT-6-Astra, programming → Claude Opus 5.5, while the user has not chosen. */
function applyAutoModel() {
  if (!autoModel) return;
  const route = currentRoute();
  if (route.target !== 'document' || !route.model) {
    autoModelReason = '';
    return;
  }
  if (route.model !== state.model) {
    chooseModel(state, route.model);
    $('model').value = state.model;
    void refreshAccount();
  }
  autoModelReason = route.task === 'programming' ? '프로그램 작업' : '모델링';
}
/** A screen-only request changes the VIDE view; the file and AI are not involved. */
function runViewRequest(route: Route) {
  const view = route.view!;
  if (view.action !== 'unhide' && !view.ids.length) {
    message(
      '화면에서 어떤 객체인지 찾지 못했습니다. 객체를 고르거나, 파일 작업으로 보내려면 "VIDE 화면만" 칩을 누르세요.',
    );
    return;
  }
  const count = view.ids.length.toLocaleString();
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
  message(
    view.action === 'unhide'
      ? '숨긴 객체를 모두 다시 보입니다 · 원본은 그대로입니다.'
      : `화면에서 ${view.subject} ${count}개 ${verb} · 원본은 그대로입니다. 다시 보이게 하려면 U.`,
  );
  state.body = '';
  $('body').value = '';
  routeOverride = undefined;
  autoModel = true;
  autoModelReason = '';
  render();
}
$('request').onclick = () => {
  const route = state.body.trim() ? currentRoute() : undefined;
  if (route?.target === 'view' && !state.linkedTargets) {
    runViewRequest(route);
    return;
  }
  void submitRequest();
};
async function submitRequest(predecessorId?: string) {
  if (validate(state) || busy || !project || (predecessorId && interventionReason(predecessorId)))
    return;
  busy = true;
  render();
  const predecessor =
    predecessorId && state.messages.find((entry) => entry.id === predecessorId)?.request;
  const input = {
    ...packet(predecessor ? interventionTargetDraft(state, predecessor) : state),
    id: crypto.randomUUID(),
  };
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
    routeOverride = undefined;
    autoModel = true;
    autoModelReason = '';
    focusedWork = request.id;
    renderMessages();
    void poll(request.id, projectId, original);
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
  if (!typing && tool !== 'sketch' && viewport && !e.altKey) {
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
  $('panel-header').hidden = false;
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
      if (panelMode) $('panel-state').textContent = 'Rhino 연결이 끊겼습니다 · Rhino 패널에서 연결';
      return;
    }
    const basis = rhinoBasis(target);
    if (panelMode) {
      $('panel-doc').textContent = item.name;
      $('panel-state').textContent = [
        item.live ? 'Live Sync' : '연결됨',
        basis?.request.createdAt
          ? 'Sync ' + new Date(basis.request.createdAt).toLocaleTimeString()
          : 'Sync 필요',
        `${item.objectCount.toLocaleString()}개 객체`,
      ].join(' · ');
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
$('panel-sync').onclick = () => {
  const target = connectedTarget;
  const link = links.find(
    (entry) =>
      entry.connection?.instance === target?.instance &&
      entry.connection?.documentId === target?.documentId,
  );
  if (link) void syncLink(link, 'manual');
  else message('이 문서를 먼저 Rhino 패널의 Link로 프로젝트에 연결하세요.');
};
$('panel-pin').onclick = async () => {
  try {
    if (!connectedTarget) throw Error('Rhino 문서가 연결되지 않았습니다.');
    const catalog = hostDocumentsSchema.parse(await api('/host/attached-documents'));
    const item = catalog.documents.find((doc) => doc.id === connectedTarget?.documentId);
    const selection = item?.selectedIds ?? [];
    if (!selection.length) throw Error('Rhino에서 고정할 객체를 먼저 선택하세요.');
    await setHostPins([...new Set([...hostPinned, ...selection])]);
    if (!rhinoBasis(connectedTarget)) message('고정했습니다. 요청에 포함하려면 먼저 Sync 하세요.');
  } catch (cause) {
    message(readableError(cause).message);
  }
};

async function initializeWorkspace() {
  try {
    const linked = await connect();
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
    for (const entry of state.messages)
      if (['queued', 'running'].includes(entry.request.state)) void poll(entry.id);
    const host = hostStatusSchema.parse(await api('/host'));
    const providers = providersSchema.parse(await api('/providers'));
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

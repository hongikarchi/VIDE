// Start of the work screen (PLAN-26 T-113, region E): boot() runs every region's init*() in the
// order the old single app.ts ran its top level, connects to the engine, and owns the host panel mode,
// the Rhino link poll (shared pins, live selection) and the lost-engine banner.
import { z } from 'zod';
import {
  type HostTarget,
  hostDocumentsSchema,
  hostSelectionSchema,
} from '../../contracts/host-documents.ts';
import { setTheme } from '../theme.ts';
import { renderLinkCard, renderPanelHeader } from '../host-panel.tsx';
import { element as $, readableError } from '../elements.ts';
import { api, connect, errors } from '../gateway.ts';
import { attachHostSelection, objects, models } from '../model.ts';
import { displayIdOf } from '../layers.ts';
import { mountUsageBars } from '../usage-bars.ts';
import { modelsSchema, requestMessage } from '../workspace-data.ts';
import { migrateProjectDraft, lastConversation, draftKey, restoreDraft } from '../draft-storage.ts';
import { initializeWorkspaces } from '../workspaces.ts';
import { remoteSession } from '../remote-panel.ts';
import { connectionRecovery, probeEngine } from '../connection-recovery.ts';
import { draftState } from '../store/draft.ts';
import { linksState } from '../store/links.ts';
import { sessionState } from '../store/session.ts';
import { selectionState } from '../store/selection.ts';
import {
  setBody,
  fillModels,
  loadMode,
  initComposer1,
  initComposer2,
  initComposer3,
  initComposer4,
  initComposer5,
} from './composer.ts';
import {
  setConnectionStatus,
  setHostStatus,
  setAuthStatus,
  setConnectionBanner,
  onReconnect,
  message,
  workspaceStatus,
  refreshAccount,
  refreshConnectionStatus,
  initStatus1,
  initStatus2,
} from './status.ts';
import {
  mobileView,
  renderLinkPanel,
  renderHeading,
  initLeft1,
  initLeft2,
  initLeft3,
  initLeft4,
  initLeft5,
} from './left.ts';
import { panelMode, panelParams, panelView, panelHost, initContext1 } from './context.ts';
import { render, renderMessages } from './render.ts';
import { syncLink, applyActiveLayer, pollLinks, initLinksSync1 } from './links-sync.ts';
import {
  viewportEmpty,
  initViewport1,
  initViewport2,
  initViewport3,
  initViewport4,
  initViewport5,
} from './viewport.ts';
import { reviews, initGlue1, initGlue2, initGlue3, initGlue4 } from './glue.ts';
import { mountConversationScreens, poll, initThread1 } from './thread.ts';
import { initShortcuts } from './shortcuts.ts';

export const hostDocumentKey = (target: HostTarget) => `${target.instance}|${target.documentId}`;
export const hostPinsApplied = new Map<string, string[]>(),
  hostSelectionSeen = new Map<string, number>();
// Rhino link: panel mode, shared pins and live selection for the attached Rhino document.
export function rhinoBasis(target: HostTarget) {
  return draftState.state.messages
    .filter(
      (entry) =>
        entry.request?.result?.hostExecuted &&
        entry.request.result.sourceDocument?.instance === target.instance &&
        entry.request.result.sourceDocument.documentId === target.documentId &&
        (entry.source === 'document' || entry.request.result.applicationState === 'succeeded'),
    )
    .at(-1);
}
export function renderPanel() {
  if (!panelMode) return;
  renderPanelHeader($('panel-header'), {
    host: panelHost!,
    file: panelView.file,
    state: panelView.state,
    detail: panelView.detail,
    project: sessionState.project?.name,
    syncing: linksState.linkSyncing,
    onSync: () => {
      const target = linksState.connectedTarget;
      const link = linksState.links.find(
        (entry) =>
          entry.connection?.instance === target?.instance &&
          entry.connection?.documentId === target?.documentId,
      );
      if (link) void syncLink(link);
      else
        message(
          '이 파일이 아직 이 프로젝트의 연결 파일 목록에 없습니다. ⋯ → 다른 프로젝트에 연결로 다시 연결하세요.',
        );
    },
  });
}
/** The panel's "선택 N개 첨부": Rhino keeps them as its pinned set; CAD attaches them to the draft. */
export async function attachPanelSelection() {
  try {
    const target = linksState.connectedTarget;
    if (!target) throw Error('파일이 연결되지 않았습니다.');
    if (panelHost === 'rhino') {
      // Rhino's selection now, not the last poll's (a click right after picking the next object).
      const catalog = hostDocumentsSchema.parse(await api('/host/attached-documents'));
      const item = catalog.documents.find(
        (doc) =>
          (doc.instance ?? catalog.instance) === target.instance && doc.id === target.documentId,
      );
      const selected = item ? (item.selectedIds ?? []) : panelView.selection;
      await setHostPins([...new Set([...(item?.pinnedIds ?? linksState.hostPinned), ...selected])]);
      // The pinned objects leave the "선택 N개 첨부" chip at once; the next poll confirms.
      panelView.selection = selected.filter((id) => !linksState.hostPinned.includes(id));
      render();
      void pollHostLink();
      if (!rhinoBasis(target)) message('첨부했습니다. 요청에 포함하려면 먼저 Sync 하세요.');
      return;
    }
    const selection = hostSelectionSchema.parse(
      await api(
        `/host/selection?instance=${encodeURIComponent(target.instance)}&document=${target.documentId}`,
      ),
    );
    const count = attachHostSelection(draftState.state, rhinoBasis(target)?.request, selection);
    render();
    message(count ? `${count}개 객체를 요청에 첨부했습니다.` : '먼저 Sync 하세요.');
  } catch (cause) {
    message(readableError(cause).message);
  }
}
/**
 * Rhino's pinned set is the source of truth for the pins it holds while a Rhino document is
 * attached. Pins made in VIDE (inline "[고정N]" tokens, 요청에 고정) are the user's own and stay.
 */
export function applyHostPins(ids: string[]) {
  linksState.hostPinned = ids;
  const target = linksState.connectedTarget;
  if (!target) return;
  const key = hostDocumentKey(target);
  // What Rhino's set held before for this document, or holds now: only those pins change.
  const managed = new Set([...(hostPinsApplied.get(key) ?? []), ...ids]);
  hostPinsApplied.set(key, ids);
  const basis = rhinoBasis(target);
  linksState.hostPinBasis = basis?.id;
  if (!basis) return;
  const available = new Map((basis.request.result?.objects ?? []).map((item) => [item.id, item]));
  // Rhino's set replaces its pins on every Sync of this document, not only the newest one.
  const sameDocument = (id: string) => {
    const source = draftState.state.messages.find((entry) => entry.id === id)?.request.result
      ?.sourceDocument;
    return source?.instance === target.instance && source.documentId === target.documentId;
  };
  draftState.state.pins = [
    ...draftState.state.pins.filter(
      (pin) =>
        pin.label || !managed.has(pin.id) || (pin.basis !== basis.id && !sameDocument(pin.basis)),
    ),
    ...ids.flatMap((id) => {
      const object = available.get(id);
      return object ? [{ id, name: object.name, role: 'target' as const, basis: basis.id }] : [];
    }),
  ];
}
export async function setHostPins(ids: string[]) {
  if (!linksState.connectedTarget) return false;
  const reply = z
    .object({ pinnedIds: z.array(z.string()) })
    .parse(await api('/host/pins', 'POST', { ...linksState.connectedTarget, ids }));
  applyHostPins(reply.pinnedIds);
  render();
  return true;
}
export async function pollHostLink() {
  // One status call at a time: a slow host must not pile up overlapping polls.
  if (
    !sessionState.ready ||
    !linksState.connectedTarget ||
    document.hidden ||
    sessionState.hostLinkPolling
  )
    return;
  sessionState.hostLinkPolling = true;
  try {
    const catalog = hostDocumentsSchema.parse(await api('/host/attached-documents'));
    const documentOf = (target: HostTarget) =>
      catalog.documents.find(
        (doc) =>
          (doc.instance ?? catalog.instance) === target.instance && doc.id === target.documentId,
      );
    // Picking objects in another linked Rhino window makes that file the one the page follows
    // (SPEC-01.11 4); every linked document's counter is kept so no old pick replays later.
    if (!panelMode)
      for (const link of linksState.links) {
        const connection = link.connection;
        if (link.host !== 'rhino' || !connection) continue;
        const doc = documentOf(connection);
        if (doc?.selectionVersion === undefined) continue;
        const key = hostDocumentKey(connection);
        const seen = hostSelectionSeen.get(key);
        if (
          seen !== undefined &&
          seen !== doc.selectionVersion &&
          doc.selectedIds?.length &&
          key !== hostDocumentKey(linksState.connectedTarget) &&
          linksState.currentLayers.some((layer) => layer.key === link.id)
        ) {
          linksState.activeLayer = link.id;
          applyActiveLayer();
          renderLinkPanel();
          // Mirror this pick below, as for the file already followed.
          hostSelectionSeen.set(key, seen);
          break;
        }
      }
    const target = linksState.connectedTarget;
    if (!target) return;
    const targetKey = hostDocumentKey(target);
    linksState.hostPinned = hostPinsApplied.get(targetKey) ?? [];
    const item = documentOf(target);
    if (!panelMode)
      for (const link of linksState.links) {
        const connection = link.connection;
        const doc = connection && documentOf(connection);
        const key = connection && hostDocumentKey(connection);
        if (doc?.selectionVersion !== undefined && key && key !== targetKey)
          hostSelectionSeen.set(key, doc.selectionVersion);
      }
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
    if (
      !hostPinsApplied.has(targetKey) ||
      pinned.join() !== linksState.hostPinned.join() ||
      (pinned.length && basis?.id !== linksState.hostPinBasis)
    ) {
      applyHostPins(pinned);
      render();
    }
    const seen = hostSelectionSeen.get(targetKey);
    if (item.selectionVersion !== undefined && item.selectionVersion !== seen) {
      hostSelectionSeen.set(targetKey, item.selectionVersion);
      // A file followed just now (a click in VIDE) starts from its current pick, not a replay.
      if (seen === undefined && !panelMode) return;
      // Mirror Rhino's selection in the viewport when this document is the one on screen.
      const basis = selectionState.displayedResult ?? rhinoBasis(target)?.id;
      const picked = item.selectedIds ?? [];
      const mirrored = basis ? picked.flatMap((id) => displayIdOf(objects, basis, id) ?? []) : [];
      // Objects Rhino has but the last Sync does not yet keep VIDE's selection as it is.
      if (mirrored.length || (!picked.length && selectionState.selectedIds.length)) {
        selectionState.selectedIds = mirrored;
        draftState.state.selected = mirrored.at(-1) ?? null;
        render();
      }
    }
  } catch {
    /* Transient; the next poll retries. */
  } finally {
    sessionState.hostLinkPolling = false;
  }
}
export async function initializeWorkspace() {
  try {
    const linked = await connect();
    // Usage needs the session that connect() just opened; a retried start mounts it once.
    if (!sessionState.usageMounted) mountUsageBars(panelMode ? $('panel-footer') : $('usage-bars'));
    sessionState.usageMounted = true;
    void workspaceStatus.refreshAccount();
    const catalog = modelsSchema.parse(await api('/models'));
    models.splice(0, models.length, ...catalog);
    fillModels();
    sessionState.project = linked.project;
    draftState.state.messages = linked.requests.map(requestMessage);
    const lastSync = draftState.state.messages
      .filter((entry) => entry.source === 'document')
      .at(-1);
    if (lastSync?.request.state === 'failed') viewportEmpty.sync('failed');
    void reviews.refresh().catch((error) => message(error.message));
    sessionState.projects = linked.projects;
    document.title = `${sessionState.project.name} · VIDE`;
    renderHeading();
    loadMode(sessionState.project.id);
    let restored = false;
    // Drafts are per conversation; the last viewed tab comes back (SPEC-02.19 1). Host panels
    // have no chips and keep the default conversation's draft.
    migrateProjectDraft(sessionState.project.id);
    draftState.draftConversation = panelMode ? null : lastConversation(sessionState.project.id);
    try {
      const raw = localStorage.getItem(
        draftKey(sessionState.project.id, draftState.draftConversation),
      );
      if (raw) {
        draftState.state = restoreDraft(JSON.parse(raw), draftState.state.messages);
        selectionState.selectedResult = draftState.state.baseRequestId ?? null;
        restored = true;
        setBody(draftState.state.body);
        draftState.mode = draftState.state.permission === 'review' ? 'plan' : 'auto';
      }
    } catch {
      draftState.unreadableDraft = true;
      message('저장된 초안의 형식 또는 기준을 확인할 수 없습니다. 작업 이력은 유지됩니다.');
    }
    if (!restored)
      selectionState.selectedResult = linked.requests
        .filter((request) => request.result?.hostExecuted)
        .at(-1)?.id;
    selectionState.restoredSelection = selectionState.selectedResult ?? undefined;
    sessionState.ready = true;
    void refreshAccount();
    render();
    renderMessages();
    // The display waits for the links (renderMessages); read them now rather than at the next tick.
    void pollLinks();
    // The tab row and this project's last tab; host panels have neither (SCR-12).
    if (!panelMode)
      initializeWorkspaces({ projectId: sessionState.project.id, mount: $('workspace-tabs') });
    void mountConversationScreens();
    for (const entry of draftState.state.messages)
      if (['queued', 'running'].includes(entry.request.state)) void poll(entry.id);
    await refreshConnectionStatus();
  } catch (cause) {
    const error = readableError(cause);
    message(errors[error.code ?? ''] || error.message);
  }
}
export const lostText = (code: string) =>
  remoteSession()
    ? (code === 'UNAUTHORIZED'
        ? '작업 PC 세션이 끝났습니다(PC 재시작 등).'
        : errors[code] || '작업 PC 연결이 끊겼습니다.') + ' 초안은 유지됩니다. '
    : code === 'UNAUTHORIZED'
      ? '로컬 인증이 만료됐습니다. 트레이의 VIDE 아이콘이나 실행 링크로 다시 연 뒤 [다시 연결]을 누르세요. 초안은 유지됩니다.'
      : '작업 엔진에 연결할 수 없습니다. 엔진이 다시 켜지면 자동으로 이어집니다. 초안은 유지됩니다.';
export function showLost(text: string) {
  // Opened from another device: the PC restarted or went off. Reopen from the project list.
  setConnectionBanner({ text, link: remoteSession() });
}
export let recovery!: ReturnType<typeof connectionRecovery>;

/** The work screen start: each region's initialization in the order the old app.ts ran it. */
export async function boot() {
  initContext1();
  initLeft1();
  initStatus1();
  initGlue1();
  initViewport1();
  initLinksSync1();
  initViewport2();
  initGlue2();
  initLeft2();
  initGlue3();
  initLeft3();
  initStatus2();
  initComposer1();
  initGlue4();
  initComposer2();
  initThread1();
  initComposer3();
  initViewport3();
  initLeft4();
  initShortcuts();
  initComposer4();
  initViewport4();
  mobileView(panelMode ? 'input' : 'model');
  render();
  initLeft5();
  initViewport5();
  initComposer5();
  if (panelMode) {
    document.body.classList.add('panel-mode');
    setTheme(panelParams.get('theme') === 'dark' ? 'dark' : 'light', false);
    const documentId = Number(panelParams.get('document'));
    const instance = panelParams.get('instance') ?? '';
    if (instance && documentId > 0) linksState.connectedTarget = { instance, documentId };
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
  setInterval(() => void pollHostLink(), 1200);
  // A lost engine locks the composer only until it answers again (engine restart, sleep): the
  // banner above the composer (shell/connection-banner.tsx) says why and retries by itself,
  // [다시 연결] checks at once.
  recovery = connectionRecovery({
    probe: () => probeEngine(),
    onState(next) {
      if (next === 'ok') return;
      showLost(
        next === 'checking'
          ? '작업 엔진 연결을 다시 확인하는 중… 초안은 유지됩니다.'
          : lostText(next === 'unauthorized' ? 'UNAUTHORIZED' : sessionState.lostCode),
      );
      setConnectionBanner({ checking: next === 'checking' });
    },
    async onRecovered() {
      setConnectionBanner({ hidden: true });
      setAuthStatus(undefined);
      // Never loaded (the first start failed): load now. Otherwise unlock and refresh what polls.
      if (!sessionState.project) {
        await initializeWorkspace();
        return;
      }
      sessionState.ready = true;
      render();
      renderMessages();
      message('작업 엔진에 다시 연결됐습니다.');
      for (const entry of draftState.state.messages)
        if (['queued', 'running'].includes(entry.request.state)) void poll(entry.id);
      void reviews.refresh().catch(() => {});
      await refreshConnectionStatus().catch(() => {});
    },
  });
  onReconnect(() => recovery.retry());
  window.addEventListener('focus', () => recovery.retry());
  window.addEventListener('vide:connection-lost', (event) => {
    sessionState.ready = false;
    const code = (event as CustomEvent<string>).detail;
    sessionState.lostCode = code;
    const text = lostText(code);
    setAuthStatus(text, remoteSession());
    if (remoteSession() && !recovery.active) message(text);
    showLost(text);
    setConnectionBanner({ hidden: false, checking: false });
    setConnectionStatus('연결 상태 확인 필요');
    setHostStatus('호스트 상태 확인 필요');
    recovery.lost();
    render();
  });
  await initializeWorkspace();
}

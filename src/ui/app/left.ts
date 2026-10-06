// Rail, left panel and side panels (PLAN-26 T-113, region A): projects, linked files list, object
// list, work history, coverage badge, theme toggle and panel folding.
import { z } from 'zod';
import { createObjectList } from '../object-list.ts';
import { element as $, readableError } from '../elements.ts';
import { initializeWorkspacePanels } from '../workspace-panels.ts';
import { refreshDashboard } from '../dashboard.tsx';
import { renderLinks } from '../links.tsx';
import { draftHasInput, objects } from '../model.ts';
import { api, labels, errors } from '../gateway.ts';
import { reviewsOf, openReview } from '../reviews.tsx';
import { setWorkspace, workspaceShowsViewport } from '../workspaces.ts';
import {
  layoutState,
  paintThemeToggle,
  revealPanel,
  setMobileView,
  togglePanel,
  type HistoryRow,
  type MobileView,
} from '../store/layout.ts';
import { removeProjectDrafts } from '../draft-storage.ts';
import { renderProjectHeading } from '../project-heading.tsx';
import { requestMessage } from '../workspace-data.ts';
import { viewerState } from '../store/viewer.ts';
import { linksState } from '../store/links.ts';
import { sessionState } from '../store/session.ts';
import { draftState } from '../store/draft.ts';
import { selectionState } from '../store/selection.ts';
import { type ShortcutResult } from './shortcuts.ts';
import { type ActiveRequest, applySelection } from './viewport.ts';
import { renderPanel } from './boot.ts';
import {
  linkNotes,
  layerOverride,
  transientLayer,
  applyActiveLayer,
  setLinkHidden,
  syncLink,
  pollLinks,
  pollOffline,
  useInboxItem,
  dismissInboxItem,
} from './links-sync.ts';
import { renderMessages, render } from './render.ts';
import { currentProject } from './context.ts';
import { message } from './status.ts';
import { focusedMessage, focusWork } from './thread.ts';

export let renderObjectList!: ReturnType<typeof createObjectList>;
/**
 * Sync coverage badge (SPEC-01.2, T-043): what the host left out of the current model before any
 * row existed — hidden layers, hidden objects, block-definition geometry. Beside the host name.
 */
export function syncCoverageBadge(coverage?: {
  omittedHidden?: number;
  omittedFiltered?: number;
  omittedBlockInternal?: number;
  hiddenLayers?: { path: string; count: number }[];
}) {
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
  // The badge (beside the host name) exists from the first render on, hidden when it says nothing.
  layoutState.coverage = {
    text: parts.length ? `${parts.join('·')}는 가져오지 않았습니다` : '',
    title: layers.map((layer) => `${layer.path} (${layer.count})`).join('\n'),
  };
  layoutState.bump();
}
export function renderLinkPanel() {
  renderPanel();
  refreshDashboard();
  renderLinks($('host-document-controls'), {
    links: linksState.links,
    projectName: sessionState.project?.name,
    active: linksState.activeLayer,
    notes: linkNotes,
    candidates: new Set(
      [...layerOverride]
        .filter(
          ([id, request]) =>
            linksState.links.find((link) => link.id === id)?.lastSync?.requestId !== request,
        )
        .map(([id]) => id),
    ),
    loaded: linksState.linksLoaded,
    results: (() => {
      const layer = transientLayer();
      return layer ? [{ key: layer.key, name: layer.name }] : [];
    })(),
    onCloseResult: () => {
      // Closed until it is opened again from the work history (SPEC-01.11 4); a restart does not
      // bring it back as the restored view.
      if (
        !draftHasInput(draftState.state) &&
        draftState.state.baseRequestId === linksState.transientResult
      )
        draftState.state.baseRequestId = undefined;
      linksState.transientResult = undefined;
      selectionState.selectedResult = null;
      selectionState.appliedSelection = null;
      if (linksState.activeLayer?.startsWith('result:')) linksState.activeLayer = undefined;
      renderMessages();
      render();
    },
    onFocusResult: (key) => {
      linksState.activeLayer = key;
      applyActiveLayer();
      render();
      renderLinkPanel();
    },
    onToggle: (link) => void setLinkHidden(link, !link.hidden),
    onSync: (link, full) => void syncLink(link, full),
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
          draftState.state.messages = draftState.state.messages.filter(
            (entry) => !gone.has(entry.id),
          );
          if (selectionState.selectedResult && gone.has(selectionState.selectedResult))
            selectionState.selectedResult = undefined;
          draftState.state.pins = draftState.state.pins.filter((pin) => !gone.has(pin.basis));
          if (draftState.state.baseRequestId && gone.has(draftState.state.baseRequestId))
            draftState.state.baseRequestId = undefined;
          linksState.links = linksState.links.filter((entry) => entry.id !== link.id);
          layerOverride.delete(link.id);
          renderMessages();
          render();
          renderLinkPanel();
        })
        .catch((error: unknown) => message(readableError(error).message));
    },
    onSplit: (link) => {
      // The note (and its buttons) leaves at once, so a second click cannot split again.
      const notice = link.notice;
      link.notice = undefined;
      renderLinkPanel();
      void api(`/projects/${currentProject().id}/links/${link.id}/split`, 'POST', {})
        .then((reply) => {
          if (!z.object({ stored: z.boolean() }).parse(reply).stored)
            message(
              '새 항목으로 나눴습니다. 문서에 새 연결 ID를 쓰지 못했으니 다음에 Link할 때 새 항목을 고르세요.',
            );
          return pollLinks();
        })
        .catch((error: unknown) => {
          const failure = readableError(error);
          message(failure.message);
          // Already split, or the notice is gone (an engine restart): the list tells which.
          if (failure.code === 'LINK_NOTICE_GONE') return pollLinks();
          link.notice = notice;
          renderLinkPanel();
        });
    },
    onDismiss: (link) => {
      link.notice = undefined;
      renderLinkPanel();
      void api(`/projects/${currentProject().id}/links/${link.id}/dismiss`, 'POST', {}).catch(
        () => undefined,
      );
    },
    onMerge: (link, into) => {
      const target = linksState.links.find((entry) => entry.id === into);
      if (
        !confirm(
          `${link.name}의 Sync 기록을 ${target?.name ?? '같은 창의 항목'}(으)로 옮기고 이 항목을 목록에서 뺄까요? 파일과 객체는 그대로입니다.`,
        )
      )
        return;
      void api(`/projects/${currentProject().id}/links/${link.id}/merge`, 'POST', { into })
        .then(() => {
          // Its requests now belong to the other row: the conversation reads them that way too.
          for (const entry of draftState.state.messages)
            if (entry.request.input.linkId === link.id) entry.request.input.linkId = into;
          linksState.links = linksState.links.filter((entry) => entry.id !== link.id);
          layerOverride.delete(link.id);
          renderMessages();
          render();
          renderLinkPanel();
          return pollLinks();
        })
        .catch((error: unknown) => message(readableError(error).message));
    },
    onFocus: (link) => {
      if (link.hidden) void setLinkHidden(link, false);
      linksState.activeLayer = link.id;
      applyActiveLayer();
      render();
      renderLinkPanel();
      const ids = objects
        .filter((object) => object.documentKey === link.id)
        .map((object) => object.id);
      if (ids.length) viewerState.viewport?.fit(ids);
      else if (!link.lastSync) message('아직 Sync 전입니다. 파일이 열려 있으면 곧 표시됩니다.');
    },
    onBackToSync: (link) => {
      layerOverride.delete(link.id);
      renderMessages();
      renderLinkPanel();
    },
    offline:
      linksState.offlineState?.projectId === sessionState.project?.id
        ? linksState.offlineState?.status
        : undefined,
    onOffline: (enabled) => {
      const projectId = currentProject().id;
      // The switch moves at once; the PC's answer then fills in the saved state.
      if (linksState.offlineState?.projectId === projectId) {
        linksState.offlineState = {
          projectId,
          status: { ...linksState.offlineState.status, enabled },
        };
        renderLinkPanel();
      }
      void pollOffline(api(`/projects/${projectId}/offline-view`, 'PUT', { enabled }));
    },
    onInboxUse: useInboxItem,
    onInboxDismiss: dismissInboxItem,
  });
}
/** Remove a finished request from the conversation and history (its records are kept). */
export async function hideRequest(id: string) {
  await api(`/projects/${currentProject().id}/requests/${id}/hide`, 'POST', {});
  const index = draftState.state.messages.findIndex((entry) => entry.id === id);
  if (index >= 0) draftState.state.messages.splice(index, 1);
  if (selectionState.selectedResult === id) selectionState.selectedResult = undefined;
  renderMessages();
  render();
}
/** Work history: every request, newest first, with its state; opens it in the conversation. */
export function sidebar() {
  const shown = focusedMessage();
  const listed = draftState.state.messages.filter((m) => !m.request?.input?.parentRequestId);
  const rows = [...listed].reverse().map((m, i): HistoryRow => {
    const request = m.request;
    const row: HistoryRow = {
      id: m.id,
      title: m.body || `첨부 검토 ${listed.length - i}`,
      current: m.id === shown?.id,
      host: m.host === 'zwcad' ? 'ZWCAD' : 'Rhino',
      open: () => focusWork(m.id),
    };
    if (request?.createdAt)
      row.time = new Date(request.createdAt).toLocaleString('ko-KR', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    if (request)
      row.state = { label: labels[request.state] || request.state, value: request.state };
    if (request && !['queued', 'running'].includes(request.state))
      row.remove = () => {
        if (confirm('이 작업을 목록에서 지울까요? 모델과 작업 기록은 보존됩니다.'))
          void hideRequest(m.id).catch((error: unknown) =>
            message(error instanceof Error ? error.message : '지우지 못했습니다.'),
          );
      };
    // The 검토본 saved from this request (T-109): they are listed in 산출물; the row links them.
    const saved = reviewsOf(sessionState.project?.id, m.id);
    if (saved.length && sessionState.project) {
      const projectId = sessionState.project.id;
      row.review = {
        text:
          saved.length > 1 ? `이 작업으로 만든 검토본 ${saved.length}` : '이 작업으로 만든 검토본',
        title:
          saved.length > 1
            ? '가장 최근 검토본을 엽니다. 모두 보기는 산출물 › 검토본'
            : saved[0].title,
        open: () => openReview(projectId, saved[0]),
      };
    }
    return row;
  });
  layoutState.history = { empty: !draftState.state.messages.length, rows };
  layoutState.bump();
}
export { paintThemeToggle };
/** A result shown from the conversation needs the 3D view: leave the JIG list for the model. */
export function showModelView() {
  if (!workspaceShowsViewport()) setWorkspace('model');
}
export { revealPanel };
export function mobileView(view: MobileView) {
  setMobileView(view);
}
export function selectProject(id: string) {
  location.search = '?project=' + encodeURIComponent(id);
}
export async function createProject(name: string) {
  try {
    const p = z.object({ id: z.string() }).parse(await api('/projects', 'POST', { name }));
    location.search = '?project=' + encodeURIComponent(p.id);
  } catch (cause) {
    message(readableError(cause).message);
  }
}
export async function renameProject(name: string) {
  if (!sessionState.project) return;
  try {
    const renamed = z
      .object({ id: z.string(), name: z.string() })
      .parse(await api(`/projects/${sessionState.project.id}`, 'PUT', { name }));
    sessionState.project = renamed;
    sessionState.projects = sessionState.projects.map((entry) =>
      entry.id === renamed.id ? renamed : entry,
    );
    document.title = `${renamed.name} · VIDE`;
    renderHeading();
  } catch (cause) {
    message(readableError(cause).message);
  }
}
/** Confirmed in the heading; the project, its requests, links, jigs and conversations go. */
export async function deleteProject() {
  if (!sessionState.project) return;
  const id = sessionState.project.id;
  try {
    await api(`/projects/${encodeURIComponent(id)}`, 'DELETE');
    removeProjectDrafts(id);
    const next = sessionState.projects.find((entry) => entry.id !== id);
    // With none left, the start page makes a new one.
    location.search = next ? '?project=' + encodeURIComponent(next.id) : '';
  } catch (cause) {
    message(readableError(cause).message);
  }
}
export function renderHeading() {
  renderPanel();
  // Link back to the account site's project list when this PC is signed in.
  layoutState.homeShown = !!sessionState.accountSite;
  if (sessionState.accountSite) layoutState.homeHref = sessionState.accountSite;
  layoutState.bump();
  if (!sessionState.project) return;
  renderProjectHeading({
    projects: sessionState.projects,
    selected: sessionState.project.id,
    select: selectProject,
    create: createProject,
    rename: renameProject,
    remove: deleteProject,
  });
}

export function initLeft1() {
  renderObjectList = createObjectList($('objects'), (ids, mode) => {
    applySelection(ids, mode);
    if (ids.length === 1 && mode !== 'remove') viewerState.viewport?.fit(ids[0]);
  });
  initializeWorkspacePanels();
}

export function initLeft2() {
  // The rail's fixed destinations (user decision 2026-10-01) are wired in src/ui/shell/rail.tsx:
  // 대시보드 · 자료 · JIG (the list) · 산출물 open their screens; 모델 and 작업 이력 open the
  // model screen on their left-panel section. The theme toggle shows the theme it switches to.
  paintThemeToggle();
}

/** The rail's 모델 and 작업 이력 bring the model screen back: src/ui/shell/rail.tsx. */
export function initLeft3() {}

/** The edge toggles fold the side panels: src/ui/shell/edge-toggles.tsx, store/layout.ts. */
export function initLeft4() {}

export function initLeft5() {
  $('import-model').onclick = () => {
    if (sessionState.project && !sessionState.busy) $('model-file').click();
  };
  $('model-file').onchange = async () => {
    const file = $('model-file').files?.[0];
    if (!file || !sessionState.project) return;
    if (file.size > 64 * 1024 * 1024) {
      message('현재 파일 크기는 64MB까지 지원합니다.');
      return;
    }
    sessionState.busy = true;
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
      draftState.state.messages.push(requestMessage(request));
      if (request.result?.hostExecuted) {
        selectionState.selectedResult = request.id;
        draftState.state.pins = [];
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
      sessionState.busy = false;
      $('import-model').disabled = false;
      $('model-file').value = '';
      render();
    }
  };
  $('host-target').onchange = () => {
    draftState.state.host = z.enum(['rhino', 'zwcad']).parse($('host-target').value);
    draftState.state.baseRequestId = undefined;
    draftState.state.selected = null;
    selectionState.selectedResult = undefined;
    selectionState.appliedSelection = undefined;
    selectionState.displayedResult = undefined;
    linksState.shownSignature = '';
    objects.splice(0, objects.length);
    viewerState.viewport?.replace([]);
    renderMessages();
    render();
  };
}

/** render(): the hidden host select follows the draft's host. */
export function paintHostTarget() {
  $('host-target').value = draftState.state.host || 'rhino';
}
/** render(): the document panel's host name and what the host left out of the model. */
export function paintDocumentHost(active: ActiveRequest) {
  layoutState.documentHost =
    (active?.result?.host || draftState.state.host) === 'zwcad' ? 'ZWCAD' : 'Rhino';
  syncCoverageBadge(active?.result?.displayCoverage);
}

/** Alt+Shift+L / Alt+Shift+R (shortcut order 60): fold or open the side panels. */
export function panelToggleKeys(e: KeyboardEvent): ShortcutResult {
  if (e.altKey && e.shiftKey && ['KeyL', 'KeyR'].includes(e.code)) {
    e.preventDefault();
    togglePanel(e.code === 'KeyL' ? 'left' : 'right');
  }
}

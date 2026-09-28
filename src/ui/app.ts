import { initializeViewportEmpty } from './viewport-empty.ts';
import { initializeWorkspaceStatus } from './workspace-status.ts';
import { linkedRequestDraft, interventionTargetDraft } from './linked-draft.ts';
import { accountIndicator } from './account-indicator.ts';
import { executionLimits } from '../contracts/execution-limits.ts';
import { showExecutionLimits } from './execution-limits.tsx';
import { requestConflict } from '../contracts/request-scope.ts';
import { draftSnapshot, restoreDraft } from './draft-storage.ts';
import { z } from 'zod';
import { hostDocumentsSchema, type HostTarget } from '../contracts/host-documents.ts';
import { element as $, append as el, readableError } from './elements.ts';
import {
  requestData,
  requestMessage,
  modelsSchema,
  providersSchema,
  hostStatusSchema,
} from './workspace-data.ts';
import type { Point2, DraftPin, DraftStroke } from './model.ts';
import type { MobileView } from './mobile-navigation.tsx';
import { renderProjectHeading } from './project-heading.tsx';
import { setMobileView } from './mobile-navigation.tsx';
import { showQuantities } from './quantities.tsx';
import { attachNativeAttributes } from './native-attributes.ts';
import { showExtensions } from './extensions.tsx';
const showAiSettings: typeof import('./ai-settings.tsx').showAiSettings = async (onStatus) =>
  (await import('./ai-settings.tsx')).showAiSettings(onStatus);
import { initializeReviews } from './reviews.tsx';
import { attachSharedFeedback } from './shared-feedback.tsx';
import { linkedCandidates, showLinkedTargets } from './linked-targets.tsx';
import { renderHistory, expandAll, setExpandAll } from './history.tsx';
import { initializeDocuments, attachConnectedSelection } from './documents.tsx';
import { renderPoints, validCoordinate } from './sketch.tsx';
import { renderRequests, renderActiveWork } from './requests.tsx';
import { initializeInspector, renderInspector } from './inspector.ts';
import { api, connect, errors } from './gateway.ts';
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
  attachSketch,
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
  if (pin) pinSelection(state, ids);
  render();
}
const renderObjectList = createObjectList($('objects'), (ids, mode) => {
  applySelection(ids, mode, tool === 'pin');
  if (ids.length === 1 && mode !== 'remove') viewport?.fit(ids[0]);
});
let foregroundRequest: { id: string; selected: typeof selectedResult; draft: string } | undefined;
const focusDraft = () => JSON.stringify({ draft: draftSnapshot(state), points, strokes });
initializeWorkspacePanels();
const workspaceStatus = initializeWorkspaceStatus({
  openFailure: (id) => {
    selectedResult = id;
    renderMessages();
    if ($('right').hidden) $('toggle-right').click();
    setMobileView('input');
    document
      .querySelector<HTMLElement>(`[data-request-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  },
  openAiSettings: () => openAiSettings(),
  openExecutionLimits: () => openExecutionLimits(),
  onAccount: (site) => {
    accountSite = site;
    renderHeading();
  },
});
let tool: 'select' | 'pin' | 'sketch' = 'select',
  points: Point2[] = [],
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
  const shown = displayedResult === basis.id || displayedResult === rhinoBasis(target)?.id;
  const index = state.messages.findIndex((entry) => entry.id === reply.requestId);
  if (index >= 0) state.messages[index] = next;
  else state.messages.push(next);
  if (shown) {
    selectedResult = reply.requestId;
    liveRefresh = reply.requestId;
  }
  renderMessages();
  return true;
}
const captureHostDocument = async (target: HostTarget, automatic = false) => {
  if (
    automatic &&
    (!project ||
      busy ||
      draftHasInput(state) ||
      pendingSketch() ||
      state.messages.some((m) => m.request && ['queued', 'running'].includes(m.request.state)))
  )
    return false;
  if (automatic) {
    const live = await liveSyncHostDocument(target);
    if (live !== false) return live;
  }
  if (!project || busy) throw Error('현재 작업이 끝난 뒤 가져오세요.');
  busy = true;
  viewportEmpty.sync('loading');
  render();
  message('열린 호스트 문서의 모델을 가져오고 있습니다.');
  try {
    const request = await requestData(`/projects/${currentProject().id}/capture`, 'POST', {
      ...target,
      id: crypto.randomUUID(),
    });
    state.messages.push(requestMessage(request));
    if (!request.result?.hostExecuted) {
      renderMessages();
      throw Error(errors[request.result?.code ?? ''] || 'Sync 실패');
    }
    viewportEmpty.sync('idle');
    if (
      request.result?.hostExecuted &&
      (!automatic || (!draftHasInput(state) && !pendingSketch()))
    ) {
      selectedResult = request.id;
      state.selected = null;
    }
    renderMessages();
    message(
      request.result?.text ||
        errors[request.result?.code ?? ''] ||
        '작업 사본을 가져오지 못했습니다.',
    );
  } catch (error) {
    viewportEmpty.sync('failed');
    throw error;
  } finally {
    busy = false;
    render();
  }
};
initializeDocuments(
  message,
  captureHostDocument,
  (selection) => {
    const request = state.messages.find((message) => message.id === displayedResult)?.request;
    const count = attachHostSelection(state, request, selection);
    render();
    message(
      selection.selectedIds.length
        ? `${count}개 객체를 요청에 첨부했습니다.`
        : '호스트에서 선택한 객체가 없습니다.',
    );
  },
  (connection) => {
    viewportEmpty.connection(connection);
    if (panelMode) return;
    // The work target follows the chosen document (Rhino or ZWCAD); no separate host switch.
    if (connection && connection.host !== state.host && !draftHasInput(state)) {
      $('host-target').value = connection.host;
      $('host-target').dispatchEvent(new Event('change'));
    }
    const [instance, id] = connection?.key.split('/') ?? [];
    connectedTarget =
      connection?.host === 'rhino' && instance && id
        ? { instance, documentId: Number(id) }
        : undefined;
  },
);
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
      toggle.textContent = camera.projection === 'perspective' ? '원근' : '직교';
      toggle.setAttribute(
        'aria-label',
        camera.projection === 'perspective' ? '직교 투영으로 전환' : '원근 투영으로 전환',
      );
    },
  );
} catch {
  message('3D 뷰포트를 열 수 없습니다. WebGL 지원을 확인하세요.');
}
initializeDisplaySettings($('display-settings') as HTMLButtonElement, (settings) =>
  viewport?.display(settings),
);
function planeName() {
  return z.enum(['XY', 'XZ', 'YZ']).parse($('plane').value);
}
function captureViewport() {
  if (!viewport) throw Error('3D 화면을 준비한 뒤 다시 시도하세요.');
  return viewport.capture();
}
/** Unattached brush strokes or numeric points. */
function pendingSketch() {
  return points.length > 0 || strokes.length > 0;
}
function planeOffset() {
  const value = $('plane-offset').valueAsNumber;
  return Number.isFinite(value) ? value : 0;
}
function draw() {
  renderPoints(points, draw, message);
  viewport?.sketches(state.sketches, strokes, points, planeName(), planeOffset());
  $('finish-sketch').disabled = !strokes.length && points.length < 2;
  $('undo-point').disabled = !pendingSketch();
  $('clear-sketch').disabled = !pendingSketch();
  const placement = $('placement').value;
  $('plane').hidden = $('plane-offset').hidden = placement !== 'plane';
}
function brushSettings() {
  const width = $('brush-width').valueAsNumber || 4;
  $('brush-width-value').textContent = String(width);
  for (const swatch of document.querySelectorAll<HTMLButtonElement>('.swatch'))
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color === $('brush-color').value));
  viewport?.brush({
    color: $('brush-color').value,
    width,
    placement: z.enum(['surface', 'view', 'plane']).parse($('placement').value),
    plane: planeName(),
    offset: planeOffset(),
    erase: $('brush-eraser').getAttribute('aria-pressed') === 'true',
  });
  draw();
}
function setEraser(on: boolean) {
  $('brush-eraser').setAttribute('aria-pressed', String(on));
  brushSettings();
}
function setTool(next: 'select' | 'pin' | 'sketch') {
  if (tool === 'sketch' && next !== 'sketch' && pendingSketch()) {
    message('그린 선을 첨부하거나 취소하세요.');
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
      ? '드래그로 그리기 · 우클릭 회전 · Shift+우클릭 이동 · 휠 확대 · E 지우개 · Esc 취소'
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
  renderActiveWork(state.messages, interventionReason, (id) => {
    void submitRequest(id);
  });
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
        selectedIds = loosePins
          .map((pin) => pin.id)
          .filter((id) => objects.some((o) => o.id === id));
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
  if (draftHasInput(state) && displayedResult && state.baseRequestId !== displayedResult) {
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
    !selectedIds.some(
      (id) =>
        objects.some((o) => o.id === id && o.revision) && !state.pins.some((p) => p.id === id),
    );
  $('pin').title = '현재 후보에서 첨부하지 않은 객체를 선택하세요.';
  $('add-request').disabled = !ready || busy || !state.body.trim();
  $('linked-targets').disabled = !ready || busy || linkedCandidates(state).length < 2;
  $('linked-hint').textContent =
    linkedCandidates(state).length < 2 ? '실행에 성공한 SDK 후보 2개가 필요합니다.' : '';

  $('permission').value = state.applyToSource ? 'apply' : state.permission;
  $('permission').dataset.mode = $('permission').value;
  const active = state.messages.find((m) => m.id === displayedResult)?.request;
  renderInspector(
    objects.find((o) => o.id === state.selected),
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
            selectedResult = request.id;
            renderMessages();
            state.selected = id;
            render();
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
        selectedResult = id;
        renderMessages();
        state.selected = objectId || null;
        render();
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
        label: `${(entry.body || '작업').slice(0, 120)} · ${errors[entry.request?.result?.code || ''] || entry.request?.state}${entry.request?.result?.code ? ` (${entry.request.result.code})` : ''}`,
      })),
  );
  $('work-count').textContent = `${state.messages.length}개 작업`;
  $('recent-count').textContent = state.messages.length ? String(state.messages.length) : '';
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
function sidebar() {
  $('task-list').replaceChildren();
  if (!state.messages.length) el('small', '아직 요청이 없습니다.', $('task-list'));
  state.messages.forEach((m, i) => {
    const b = el('button', m.body || `첨부 검토 ${i + 1}`, $('task-list'));
    b.onclick = () => {
      if ($('right').hidden) $('toggle-right').click();
      mobileView('input');
      document.querySelectorAll('.chat-message')[i]?.scrollIntoView({ block: 'nearest' });
    };
  });
  $('reference-list').replaceChildren();
  const files = [...state.messages.flatMap((m) => m.files), ...state.files];
  if (!files.length) el('small', '첨부한 파일이 없습니다.', $('reference-list'));
  files.forEach((f) => el('small', f.name, $('reference-list')));
}
function renderMessages() {
  const latest =
    selectedResult === null
      ? undefined
      : state.messages.find((m) => m.id === selectedResult) ||
        state.messages
          .filter(
            (m) =>
              m.request?.result?.hostExecuted &&
              (m.request.result.host || 'rhino') === (state.host || 'rhino'),
          )
          .at(-1);
  const incremental = latest !== undefined && liveRefresh === latest.id && !!displayedResult;
  liveRefresh = undefined;
  if (latest && (latest.id !== displayedResult || incremental)) showResult(latest, incremental);
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
function showResult(latest: (typeof state.messages)[number], incremental: boolean) {
  {
    const result = latest.request.result;
    if (result?.hostExecuted && !result.scene && result.sceneOmitted) {
      void loadFullResult(latest.id);
      return;
    }
    if (!result?.hostExecuted || !result.objects || !result.scene) {
      message('후보 형상을 확인할 수 없습니다.');
      return;
    }
    if (!draftHasInput(state)) {
      state.host = result.host || 'rhino';
      $('host-target').value = state.host;
    }
    const native = new Map(result.scene.map((item) => [item.id, item]));
    const decoder = new TextDecoder();
    const layerOf = (value?: string) => {
      if (!value) return undefined;
      try {
        return decoder.decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
      } catch {
        return undefined;
      }
    };
    objects.splice(
      0,
      objects.length,
      ...result.objects.map((o) => {
        const item = native.get(o.id);
        return {
          ...o,
          revision: latest.id,
          layer: layerOf(item?.layer64),
          type: item?.nativeType || o.kind,
        };
      }),
    );
    if (incremental) viewport?.update(result.scene, result.definitions);
    else viewport?.replace(result.scene, result.definitions);
    displayedResult = latest.id;
    render();
    scheduleThumbnail();
  }
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
  await fetch(`/api/v1/projects/${encodeURIComponent(target)}/thumbnail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: canvas.toDataURL('image/jpeg', 0.72) }),
  });
}
function renderConversation() {
  renderHistory($('conversation'), state.messages, models, project?.id, {
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
      displayedResult = undefined;
      objects.splice(0, objects.length);
      viewport?.replace([]);
      points = [];
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
      renderMessages();
    },
    selection: (requestId, id) => {
      selectedResult = requestId;
      renderMessages();
      state.selected = id;
      render();
    },
    report: downloadReport,
    saveReview: async (id) => {
      selectedResult = id;
      renderMessages();
      await reviews.create(id, captureViewport());
    },
    changed: renderMessages,
    error: message,
    hide: async (id) => {
      await api(`/projects/${currentProject().id}/requests/${id}/hide`, 'POST', {});
      const index = state.messages.findIndex((entry) => entry.id === id);
      if (index >= 0) state.messages.splice(index, 1);
      if (selectedResult === id) selectedResult = undefined;
      renderMessages();
      render();
    },
  });
}

$('extensions').onclick = () => {
  if (!project) return;
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
      renderMessages();
      render();
      mobileView('input');
    },
  ).catch((error) => message(error.message));
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
for (const model of models) el('option', model.name, $('model'), { value: model.id });
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
      .map((object) => object.id)
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
        id: object.id,
        name: object.name,
        role: 'target' as const,
        basis: object.revision!,
        label,
      })),
    );
  },
  focusToken: (label) => {
    selectedIds = state.pins
      .filter((pin) => pin.label === label)
      .map((pin) => pin.id)
      .filter((id) => objects.some((o) => o.id === id));
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
$('request').onclick = () => {
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
$('expand-history').textContent = expandAll() ? '모두 접기' : '모두 펼치기';
$('expand-history').onclick = (event) => {
  event.preventDefault();
  setExpandAll(!expandAll());
  $('expand-history').textContent = expandAll() ? '모두 접기' : '모두 펼치기';
  renderMessages();
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
$('plane').onchange = () => {
  if (points.length) {
    $('plane').value = state.drawingPlane || 'XY';
    message('작성 중인 좌표 점을 첨부하거나 취소한 뒤 평면을 바꾸세요.');
    return;
  }
  state.drawingPlane = planeName();
  brushSettings();
};
for (const id of ['placement', 'plane-offset', 'brush-color', 'brush-width'] as const)
  $(id).addEventListener('input', brushSettings);
$('placement').onchange = brushSettings;
for (const swatch of document.querySelectorAll<HTMLButtonElement>('.swatch'))
  swatch.onclick = () => {
    $('brush-color').value = swatch.dataset.color ?? '#d0473a';
    setEraser(false);
  };
$('brush-eraser').onclick = () =>
  setEraser($('brush-eraser').getAttribute('aria-pressed') !== 'true');
$('clear-sketch').onclick = () => {
  strokes = [];
  points = [];
  draw();
};
$('finish-sketch').onclick = () => {
  try {
    if (strokes.length)
      attachBrushSketch(state, strokes, {
        placement: z.enum(['surface', 'view', 'plane']).parse($('placement').value),
        role: $('line-role').value,
        plane: $('plane').value,
        planeOffset: planeOffset(),
        points,
      });
    else attachSketch(state, points, $('plane').value, $('line-role').value);
    points = [];
    strokes = [];
    setTool('select');
    render();
    mobileView('input');
    $('body').focus();
  } catch (cause) {
    message(readableError(cause).message);
  }
};
$('cancel-sketch').onclick = () => {
  points = [];
  strokes = [];
  setTool('select');
};
$('undo-point').onclick = () => {
  if (strokes.length) strokes.pop();
  else points.pop();
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
      points = [];
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
  if (!project) return;
  renderProjectHeading({
    projects,
    selected: project.id,
    select: selectProject,
    create: createProject,
    rename: renameProject,
    site: accountSite,
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
      `/api/v1/projects/${currentProject().id}/import?name=${encodeURIComponent(file.name)}`,
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
    const response = await fetch(`/api/v1/projects/${currentProject().id}/requests/${id}/report`, {
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
  displayedResult = undefined;
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

$('add-point').onclick = () => {
  const point: Point2 = [$('point-u').valueAsNumber, $('point-v').valueAsNumber];
  if (!point.every(validCoordinate)) {
    message('U·V 좌표를 m 단위 숫자로 입력하세요.');
    return;
  }
  if (points.length >= 1000) {
    message('스케치 하나에 1,000점까지 입력할 수 있습니다.');
    return;
  }
  points.push(point);
  $('point-u').value = '';
  $('point-v').value = '';
  draw();
  $('point-u').focus();
};
for (const id of ['point-u', 'point-v'] as const)
  $(id).onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('add-point').click();
    }
  };

let catalogGeneration = 0;
window.addEventListener('vide-accounts-changed', () => {
  const current = ++catalogGeneration;
  void (async () => {
    const catalog = modelsSchema.parse(await api('/models'));
    if (current !== catalogGeneration) return;
    models.splice(0, models.length, ...catalog);
    $('model').replaceChildren();
    for (const model of models) el('option', model.name, $('model'), { value: model.id });
    // Keep the explicit model if supported; require a fresh selection if absent.
    $('model').value = state.model;
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
  state.pins = [
    ...state.pins.filter((pin) => pin.basis !== basis.id),
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
      const shown = new Set(objects.map((object) => object.id));
      const mirrored = (item.selectedIds ?? []).filter((id) => shown.has(id));
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
  if (!connectedTarget) return;
  void captureHostDocument(connectedTarget).catch((error) => message(readableError(error).message));
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
    $('model').replaceChildren();
    for (const model of models) el('option', model.name, $('model'), { value: model.id });
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
  $('auth-status').textContent =
    (event as CustomEvent<string>).detail === 'UNAUTHORIZED'
      ? '로컬 인증이 만료됐습니다. VIDE 실행 링크로 다시 여세요. 초안은 유지됩니다.'
      : '로컬 서버 연결이 끊겼습니다. 서버 확인 후 다시 여세요. 초안은 유지됩니다.';
  $('connection-status').textContent = '연결 상태 확인 필요';
  $('host-status').textContent = '호스트 상태 확인 필요';
  render();
});
await initializeWorkspace();

// Connections to other screens (PLAN-26 T-113, frozen after step F): jigs, the dashboard, saved
// reviews and the skill start parts.
import { initializeReviews, onReviewsChange } from '../reviews.tsx';
import { orderLayerPaths, type HostLayer } from '../../core/layer-tree.ts';
import { attachReviewNote, linkedCandidates, objects, packet, models } from '../model.ts';
import { attachSharedFeedback } from '../shared-feedback.tsx';
import { withObjects } from '../object-rows.ts';
import { attachJigs, type JigContext, legacyJigTab } from '../jigs.tsx';
import { displayIdOf } from '../layers.ts';
import { requestData, requestMessage } from '../workspace-data.ts';
import { provideDashboard } from '../dashboard.tsx';
import { api } from '../gateway.ts';
import { AGENDA_ASK } from '../shell/agenda-helper.tsx';
import {
  activeWorkspace,
  contextTabs,
  contextId,
  openContextTab,
  closeContextTab,
} from '../workspaces.ts';
import { type SkillEntry } from '../skill-catalog.ts';
import { type SkillDeps, type SkillRunReport, provideSkillDeps } from '../skill-start.ts';
import { preferRun, JIG_RAN } from '../jig-panel/instance.ts';
import { sessionState } from '../store/session.ts';
import { draftState } from '../store/draft.ts';
import { selectionState } from '../store/selection.ts';
import { viewerState } from '../store/viewer.ts';
import { workState } from '../store/work.ts';
import { linksState } from '../store/links.ts';
import { revealPanel, mobileView, showModelView, sidebar } from './left.ts';
import { message } from './status.ts';
import { render, renderMessages } from './render.ts';
import { renderConversation, poll } from './thread.ts';
import { currentProject } from './context.ts';
import { selectInResult } from './viewport.ts';
import {
  modeFields,
  modeOf,
  jigParamsChanged,
  referenceAnswered,
  setBody,
  submitRequest,
} from './composer.ts';

export let reviews!: ReturnType<typeof initializeReviews>;
/**
 * Layer paths in the stored Syncs, newest Sync first and each in Rhino's panel order (sublayers
 * under their parent): the output layers a jig instance may use.
 */
export function syncLayerPaths() {
  const paths = new Set<string>();
  for (const entry of [...draftState.state.messages].reverse()) {
    if (entry.request.state !== 'succeeded') continue;
    const layers = (entry.request.result as { layers?: unknown } | null | undefined)?.layers;
    if (!Array.isArray(layers)) continue;
    const table = (layers as Partial<HostLayer>[]).filter(
      (layer): layer is HostLayer => typeof layer?.fullPath === 'string' && layer.fullPath !== '',
    );
    for (const path of orderLayerPaths(
      table.map((layer) => layer.fullPath),
      table,
    ))
      paths.add(path);
  }
  return [...paths];
}
/** The open jig instance: the context tab shown now (older jigs' tabs have no settings). */
export function openJigInstance() {
  const active = activeWorkspace();
  return contextTabs().find(
    (tab) => contextId(tab.instanceId) === active && !tab.instanceId.startsWith('legacy:'),
  )?.instanceId;
}
export const jigInstancePath = (instanceId: string) =>
  `/projects/${encodeURIComponent(currentProject().id)}/jig-instances/${encodeURIComponent(instanceId)}`;
/**
 * The project's skill catalog (GET /projects/:id/skills, RESEARCH-12 §6.3): its jigs first, the
 * official list last. Read once per project and again after a minute (jigs are pinned rarely).
 */
export function skillCatalog(): Promise<SkillEntry[]> {
  const projectId = currentProject().id;
  if (workState.skillCache?.projectId === projectId && Date.now() - workState.skillCache.at < 60000)
    return workState.skillCache.list;
  const list = api(`/projects/${encodeURIComponent(projectId)}/skills`).then(
    (value) => ((value as { skills?: SkillEntry[] } | null)?.skills ?? []) as SkillEntry[],
  );
  workState.skillCache = { projectId, at: Date.now(), list };
  list.catch(() => {
    if (workState.skillCache?.list === list) workState.skillCache = undefined;
  });
  return list;
}
// ── jig = skill (RESEARCH-12 §6.3, ADR-026): a request judged to be a jig opens and computes it. ──
/** The screen's parts startSkill uses (src/ui/skill-start.ts); the JIG list uses them too. */
export const skillDeps: SkillDeps = {
  api,
  projectId: () => currentProject().id,
  catalog: () => skillCatalog(),
  openTab: (tab) => openContextTab(tab),
  closeTab: (instanceId) => closeContextTab(instanceId),
  isTabOpen: (instanceId) => contextTabs().some((tab) => tab.instanceId === instanceId),
  legacyTab: (jigId) => legacyJigTab(jigId),
  preferRun: (instanceId, preference) => preferRun(instanceId, preference),
  paramsChanged: (instanceId) => jigParamsChanged(instanceId),
  waitForRun: (instanceId, startMs) =>
    new Promise<SkillRunReport | undefined>((resolve, reject) => {
      // The panel's next run of this instance; none within startMs: the start runs it itself.
      const ran = (event: Event) => {
        const detail = (
          event as CustomEvent<{ instanceId?: string; report?: unknown; error?: unknown }>
        ).detail;
        if (detail?.instanceId !== instanceId) return;
        finish();
        if (detail.error) reject(detail.error);
        else resolve(detail.report as SkillRunReport);
      };
      const finish = () => {
        clearTimeout(timer);
        window.removeEventListener(JIG_RAN, ran);
      };
      const timer = setTimeout(() => {
        finish();
        resolve(undefined);
      }, startMs);
      window.addEventListener(JIG_RAN, ran);
    }),
  conversations: {
    active: () => workState.conversationChips?.active(),
    select: (id) => workState.conversationChips?.select(id),
    refresh: () => workState.conversationChips?.refresh() ?? Promise.resolve(),
  },
  model: () => {
    const chosen = models.find((entry) => entry.id === draftState.state.model);
    return chosen ? { provider: chosen.provider, model: chosen.id } : undefined;
  },
};
/** Conversations bound to a jig instance: their AI turns use the jig tools, not the host. */
export const jigConversations = new Map<string, string | null>();
export async function jigConversation(conversationId: string | undefined | null) {
  if (!conversationId) return null;
  if (jigConversations.has(conversationId)) return jigConversations.get(conversationId) ?? null;
  try {
    const found = (await api(
      `/projects/${encodeURIComponent(currentProject().id)}/conversations/${encodeURIComponent(conversationId)}`,
    )) as { jigInstanceId?: unknown } | null;
    const instanceId = typeof found?.jigInstanceId === 'string' ? found.jigInstanceId : null;
    jigConversations.set(conversationId, instanceId);
    return instanceId;
  } catch {
    return null;
  }
}
/** An image attachment's reference-image tab for marking regions (SPEC-09.2, PLAN-26 T-090). */
export function openReferenceTab(file: { id: string; name: string }) {
  // Opened once, the check before sending does not ask about it again (SPEC-09.11 4).
  referenceAnswered.add('a:' + file.id);
  openContextTab({
    instanceId: file.id,
    kind: 'reference',
    label: `참고 이미지 · ${file.name}`,
    title: `참고 이미지 · ${file.name} · 영역 표시`,
  });
}

export function initGlue1() {
  reviews = initializeReviews(
    () => sessionState.project?.id,
    message,
    (note, review) => {
      if (sessionState.busy) throw Error('현재 요청 전송이 끝난 뒤 첨부하세요.');
      attachReviewNote(draftState.state, note, review);
      render();
      revealPanel('right');
      mobileView('input');
      message('의견과 원 기준을 요청 초안에 첨부했습니다. 조건을 확인한 뒤 보내세요.');
    },
    (id) => {
      selectionState.selectedResult = id;
      renderMessages();
      // Opened from 산출물 (T-109): the candidate is seen in the model screen.
      showModelView();
      message('의견 작성 당시 후보를 열었습니다.');
    },
    async (note) => {
      if (sessionState.busy) throw Error('현재 요청 전송이 끝난 뒤 첨부하세요.');
      if (note.projectId !== sessionState.project?.id) throw Error('의견의 프로젝트가 다릅니다.');
      // A display Sync listed without its rows (T-123) gets them before the object is checked.
      await withObjects(note.projectId, note.requestId);
      attachSharedFeedback(draftState.state, note);
      render();
      revealPanel('right');
      mobileView('input');
      message('외부 의견의 원문과 공간 입력을 초안에 첨부했습니다. 확인한 뒤 보내세요.');
    },
  );
  // A saved or re-read 검토본 list re-links the request rows and the work view (T-109).
  onReviewsChange(() => {
    sidebar();
    renderConversation();
  });
}

export function initGlue2() {
  // Workspace tabs (T-047): the JIG tab and jig context tabs use the project, its Syncs, the
  // viewport and the conversation through this context.
  attachJigs(
    (): JigContext => ({
      projectId: currentProject().id,
      projectName: currentProject().name,
      get layers() {
        return syncLayerPaths();
      },
      sources: linkedCandidates(draftState.state).map((entry) => ({
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
        setTimeout(
          () => viewerState.viewport?.fit(displayIdOf(objects, requestId, objectId) ?? shown),
          400,
        );
        mobileView('model');
      },
      tint: (requestId, colors) => {
        // Sync object ids → displayed ids; the verdict colours stay until the display is reset.
        const mapped: Record<string, string> = {};
        for (const [objectId, color] of Object.entries(colors)) {
          const id = displayIdOf(objects, requestId, objectId);
          if (id) mapped[id] = color;
        }
        viewerState.viewport?.tint(Object.keys(mapped).length ? mapped : null);
        mobileView('model');
      },
      clearTint: () => viewerState.viewport?.clearTint(),
      overlay: (key, items) => viewerState.viewport?.overlay(key, items),
      overlayStyle: (key, style) => viewerState.viewport?.overlayStyle(key, style),
      focus: (target) =>
        viewerState.viewport?.focus(
          'requestId' in target
            ? target.ids.flatMap((id) => displayIdOf(objects, target.requestId, id) ?? [])
            : target,
        ),
      send: async (extra) => {
        const projectId = currentProject().id;
        const input = {
          ...packet({ ...draftState.state, body: extra.body, pins: [], sketches: [], files: [] }),
          // A jig that asks for review only runs in 계획, whatever the toggle says.
          ...modeFields(extra.permission ? modeOf(extra) : draftState.mode),
          id: crypto.randomUUID(),
          ...extra,
        };
        if (!extra.host) delete (input as Record<string, unknown>).host;
        if (!extra.baseRequestId) delete (input as Record<string, unknown>).baseRequestId;
        const request = await requestData(`/projects/${projectId}/requests`, 'POST', input);
        if (!draftState.state.messages.some((entry) => entry.id === request.id))
          draftState.state.messages.push(requestMessage(request));
        workState.focusedWork = request.id;
        renderMessages();
        revealPanel('right');
        void poll(request.id, projectId, draftState.state);
      },
    }),
  );
}

export function initGlue3() {
  // The dashboard reads what this screen already holds (src/ui/dashboard.tsx).
  provideDashboard({
    data: () => ({
      projectName: sessionState.project?.name ?? '',
      linksLoaded: linksState.linksLoaded,
      links: linksState.links.map((link) => ({
        id: link.id,
        name: link.name,
        host: link.host,
        state:
          link.kind === 'file'
            ? 'file'
            : link.connection
              ? link.connection.live
                ? 'live'
                : 'connected'
              : 'closed',
        ...(link.lastSync?.at ? { lastSync: link.lastSync.at } : {}),
      })),
    }),
  });
  // 할 일 도우미 (Design §03 「대시보드의 AI 열」, PLAN-39 T-181): a quick request goes to the 기본
  // 대화 as a hostless Auto turn, as if typed there; its progress and answer show below.
  addEventListener(AGENDA_ASK, (event) => {
    const text = (event as CustomEvent<string>).detail;
    if (!text || sessionState.busy || !sessionState.project) return;
    workState.conversationChips?.select(null);
    draftState.state.body = text;
    setBody(text);
    render();
    void submitRequest(undefined, 'auto', { hostUse: 'none' });
  });
}

export function initGlue4() {
  provideSkillDeps(skillDeps);
}

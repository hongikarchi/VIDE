// Notices and status lines (PLAN-26 T-113, region E): the toast, the settings dialog's status lines,
// the AI settings and the account indicator.
import { waitingOf } from '../../contracts/request-scope.ts';
import { executionLimits } from '../../contracts/execution-limits.ts';
import { errors, labels, api } from '../gateway.ts';
import { showExecutionLimits } from '../execution-limits.tsx';
import { initializeWorkspaceStatus } from '../workspace-status.ts';
import { element as $, append as el } from '../elements.ts';
import { accountIndicator } from '../account-indicator.ts';
import { models } from '../model.ts';
import { hostStatusSchema, providersSchema } from '../workspace-data.ts';
import { sessionState } from '../store/session.ts';
import { draftState } from '../store/draft.ts';
import { selectionState } from '../store/selection.ts';
import { toastState } from '../store/toast.ts';
import { type ActiveRequest } from './viewport.ts';
import { render, renderMessages } from './render.ts';
import { focusWork } from './thread.ts';
import { renderHeading } from './left.ts';

export const showAiSettings: typeof import('../ai-settings.tsx').showAiSettings = async (
  onStatus,
) => (await import('../ai-settings.tsx')).showAiSettings(onStatus);
export function openExecutionLimits() {
  const targetProject = sessionState.project?.id;
  showExecutionLimits(executionLimits(draftState.state), (value) => {
    if (sessionState.project?.id !== targetProject) return;
    draftState.state.executionLimits = value;
    render();
  });
}
export let workspaceStatus!: ReturnType<typeof initializeWorkspaceStatus>;
export const message = (text: string) => {
  clearTimeout(toastState.toastTimer);
  $('message').textContent = text;
  $('message').hidden = false;
  toastState.toastTimer = setTimeout(() => ($('message').hidden = true), 4500);
};
/** The settings dialog's status tab line for the AI services (`#connection-status`). */
export function setConnectionStatus(text: string) {
  $('connection-status').textContent = text;
}
/** The settings dialog's status tab line for the hosts (`#host-status`). */
export function setHostStatus(text: string) {
  $('host-status').textContent = text;
}
/** Opens the settings dialog the way the rail's ⚙ does (src/ui/workspace-status.ts). */
export function openSettings() {
  $('workspace-settings').click();
}
export function openAiSettings() {
  void showAiSettings((rows) => {
    setConnectionStatus(
      rows
        .map(
          (row) =>
            `${row.id === 'claude-cli' ? 'Claude' : 'ChatGPT'} ${row.available ? '연결됨' : '미연결'}`,
        )
        .join(' · '),
    );
  }).catch((error) => message(error.message));
}
export let refreshAccount!: ReturnType<typeof accountIndicator>;
/**
 * A notice with action buttons (undo, send to the AI after all). It hides after 9 s, or with
 * `keep` stays until a button is pressed or another notice takes its place.
 */
export function messageWithActions(
  text: string,
  actions: { label: string; run: () => void }[],
  { keep = false }: { keep?: boolean } = {},
) {
  clearTimeout(toastState.toastTimer);
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
  if (!keep) toastState.toastTimer = setTimeout(() => (box.hidden = true), 9000);
}
/** A notice with one action button (e.g. send a view-only request to the AI after all). */
export function messageWithAction(text: string, label: string, action: () => void) {
  messageWithActions(text, [{ label, run: action }]);
}
export async function refreshConnectionStatus() {
  const host = hostStatusSchema.parse(await api('/host'));
  const providers = providersSchema.parse(await api('/providers'));
  sessionState.providerSignedIn = Object.fromEntries(
    providers.map((provider) => [provider.id, provider.available]),
  );
  setConnectionStatus(
    providers
      .map(
        (provider) =>
          `${provider.id === 'claude-cli' ? 'Claude' : 'ChatGPT'} ${provider.available ? '연결됨' : '미연결'}`,
      )
      .join(' · '),
  );
  setHostStatus(
    'Rhino ' +
      (host.available ? '실행 준비' : '미연결') +
      ' · ZWCAD ' +
      (host.zwcadAvailable ? '실행 준비' : '미연결') +
      ' · 문서 연결은 문서 목록에서 확인',
  );
}

export function initStatus1() {
  workspaceStatus = initializeWorkspaceStatus({
    openFailure: (id) => {
      selectionState.selectedResult = id;
      renderMessages();
      focusWork(id);
    },
    openAiSettings: () => openAiSettings(),
    openExecutionLimits: () => openExecutionLimits(),
    onAccount: (site) => {
      sessionState.accountSite = site;
      renderHeading();
    },
  });
}

export function initStatus2() {
  refreshAccount = accountIndicator(
    $('status-account'),
    () => models.find((m) => m.id === draftState.state.model)?.provider ?? '',
  );
}

/** render(): the display coverage behind the status bar's model button. */
export function paintDisplayCoverage(active: ActiveRequest) {
  workspaceStatus.setDisplayCoverage(active?.result?.displayCoverage);
}
/** render(): the failures list and the status bar's work count and state. */
export function paintStatus() {
  workspaceStatus.setFailures(
    draftState.state.messages
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
  $('work-count').textContent = `${draftState.state.messages.length}개 작업`;
  const waitingCount = draftState.state.messages.filter((m) => waitingOf(m.request)).length;
  $('workspace-status').textContent = draftState.state.messages.some((m) =>
    ['queued', 'running'].includes(m.request?.state),
  )
    ? '작업 진행 중' + (waitingCount ? ` · 대기 ${waitingCount}` : '')
    : sessionState.project
      ? '로컬 작업 공간 · ' + sessionState.project.name
      : '연결 중';
}

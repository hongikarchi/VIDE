// Notices and status lines (PLAN-26 T-113, region E): the toast, the settings dialog's status lines,
// the connection banner, the AI settings and the account indicator. These write store/toast.ts,
// store/session.ts and store/status.ts; the shell components (shell/toast.tsx, status-bar.tsx,
// status-lines.tsx, settings-dialog.tsx, connection-banner.tsx) draw them.
import { waitingOf } from '../../contracts/request-scope.ts';
import { executionLimits } from '../../contracts/execution-limits.ts';
import { errors, labels, api } from '../gateway.ts';
import { showExecutionLimits } from '../execution-limits.tsx';
import { initializeWorkspaceStatus } from '../workspace-status.ts';
import { element as $ } from '../elements.ts';
import { accountIndicator } from '../account-indicator.ts';
import { models } from '../model.ts';
import { hostStatusSchema, providersSchema } from '../workspace-data.ts';
import { sessionState, type SessionFields } from '../store/session.ts';
import { statusState } from '../store/status.ts';
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
const hideToast = () => {
  toastState.hidden = true;
  toastState.bump();
};
export const message = (text: string) => {
  clearTimeout(toastState.toastTimer);
  toastState.text = text;
  toastState.actions = undefined;
  toastState.hidden = false;
  toastState.generation++;
  toastState.bump();
  toastState.toastTimer = setTimeout(hideToast, 4500);
};
/** The settings dialog's status tab line for the AI services (`#connection-status`). */
export function setConnectionStatus(text: string) {
  sessionState.connection = { ...sessionState.connection, providersText: text };
  sessionState.bump();
}
/** The settings dialog's status tab line for the hosts (`#host-status`). */
export function setHostStatus(text: string) {
  sessionState.connection = { ...sessionState.connection, hostText: text };
  sessionState.bump();
}
/**
 * The status tab's lost-session line (`#auth-status`): shown with `text`, hidden without. `link`
 * adds the project list link (a page opened from another device).
 */
export function setAuthStatus(text: string | undefined, link = false) {
  sessionState.connection = {
    ...sessionState.connection,
    auth:
      text === undefined ? { hidden: true, text: '', link: false } : { hidden: false, text, link },
  };
  sessionState.bump();
}
/** The lost-engine banner above the composer (`#connection-banner`). */
export function setConnectionBanner(change: Partial<SessionFields['banner']>) {
  sessionState.banner = { ...sessionState.banner, ...change };
  sessionState.bump();
}
/** What the banner's [다시 연결] does. */
export function onReconnect(run: () => void) {
  statusState.actions = { ...statusState.actions, reconnect: run };
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
  toastState.text = text;
  toastState.actions = actions;
  toastState.hidden = false;
  toastState.generation++;
  toastState.bump();
  if (!keep) toastState.toastTimer = setTimeout(hideToast, 9000);
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
  const workCount = `${draftState.state.messages.length}개 작업`;
  const waitingCount = draftState.state.messages.filter((m) => waitingOf(m.request)).length;
  const workspaceText = draftState.state.messages.some((m) =>
    ['queued', 'running'].includes(m.request?.state),
  )
    ? '작업 진행 중' + (waitingCount ? ` · 대기 ${waitingCount}` : '')
    : sessionState.project
      ? '로컬 작업 공간 · ' + sessionState.project.name
      : '연결 중';
  if (statusState.workCount === workCount && statusState.workspaceText === workspaceText) return;
  statusState.workCount = workCount;
  statusState.workspaceText = workspaceText;
  statusState.bump();
}

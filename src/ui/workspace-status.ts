// The settings dialog's controller (PLAN-26 T-113, region E). shell/settings-dialog.tsx and
// shell/status-bar.tsx draw the dialog and the status bar from store/status.ts; this opens and closes
// the dialog, keeps its tab, hands the empty panel sections to their panels and puts the actions the
// buttons call in the store.
import { element as $ } from './elements.ts';
import { remoteSession } from './remote-panel.ts';
import { initializeAccountPopover } from './account-popover.ts';
import { attachDesktopPanel, inDesktop } from './desktop-panel.ts';
import { attachConnectorsPanel } from './connectors-panel.ts';
import { attachAccountUsage } from './account-usage-panel.ts';
import {
  statusState,
  tabHidden,
  type DisplayCoverage,
  type Failure,
  type SettingsTab,
} from './store/status.ts';

interface Options {
  openFailure: (id: string) => void;
  openAiSettings: () => void;
  openExecutionLimits: () => void;
  /** Account site of this PC when it is signed in (for "all projects" links). */
  onAccount: (site: string | undefined) => void;
}
/** Status uses observed facts. Installation readiness never implies a document connection. */
export function initializeWorkspaceStatus({
  openFailure,
  openAiSettings,
  openExecutionLimits,
  onAccount,
}: Options) {
  const dialog = document.querySelector<HTMLDialogElement>('.workspace-status-dialog')!;
  const section = (tab: SettingsTab, index = 0) =>
    dialog.querySelectorAll<HTMLElement>(`[data-pane="${tab}"] > section`)[index]!;
  let opener: HTMLElement | undefined;
  const close = () => {
    dialog.close();
    opener?.focus();
  };
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  function show(id: SettingsTab) {
    // The first tab not hidden here: AI, else (through the tunnel) 상태 · 오류.
    if (tabHidden(id, statusState)) id = tabHidden('ai', statusState) ? 'status' : 'ai';
    statusState.tab = id;
    statusState.bump();
  }
  const open = (source: HTMLElement, pane: SettingsTab = statusState.tab) => {
    opener = source;
    if (!dialog.open) statusState.opened++;
    show(pane);
    if (!dialog.open) dialog.showModal();
  };
  // One settings place, one topic per tab: AI, services, connected programs, this program, status.
  // The VIDE account and remote access are the account panel's (SPEC-05.10).
  const account = initializeAccountPopover((status) =>
    onAccount(status.linked ? status.site : undefined),
  );
  attachAccountUsage(section('ai', 1), dialog);
  attachConnectorsPanel(section('programs'), dialog);
  attachDesktopPanel(section('desktop'), dialog);
  // Pages opened through the tunnel cannot control the app, accounts, programs or AI settings.
  if (remoteSession()) document.documentElement.dataset.remote = 'true';
  statusState.desktop = inDesktop();
  statusState.remote = remoteSession();
  statusState.actions = {
    ...statusState.actions,
    open,
    close,
    show,
    openFailure,
    openAiSettings,
    openExecutionLimits,
    openAccount: () => {
      close();
      account.open();
    },
  };
  show('ai');
  $('workspace-settings').onclick = () => open($('workspace-settings'));
  window.addEventListener('vide:api-error', (event) => {
    statusState.notifications.push((event as CustomEvent<string>).detail);
    if (statusState.notifications.length > 20) statusState.notifications.shift();
    statusState.bump();
  });
  let failuresSignature = '[]';
  return {
    refreshAccount: () => account.refresh(),
    setDisplayCoverage(coverage?: DisplayCoverage) {
      if (statusState.coverage === coverage) return;
      statusState.coverage = coverage;
      statusState.bump();
    },
    setFailures(rows: Failure[]) {
      const signature = JSON.stringify(rows);
      if (signature === failuresSignature) return;
      failuresSignature = signature;
      statusState.failures = rows;
      statusState.bump();
    },
  };
}

// The status bar and the settings dialog (PLAN-26 T-113, region E): what shell/status-bar.tsx and
// shell/settings-dialog.tsx render. src/ui/app/status.ts and src/ui/workspace-status.ts write it;
// the dialog's controller (workspace-status.ts) also puts the actions the buttons call here, so the
// shell components import only stores.
import { createSlice } from './core.ts';

export type SettingsTab = 'account' | 'ai' | 'services' | 'programs' | 'desktop' | 'status';
export interface Failure {
  id: string;
  label: string;
  title?: string;
  reason?: string;
  code?: string;
  at?: string;
}
export interface DisplayCoverage {
  total: number;
  displayed: number;
  omitted: number;
  omittedTypes: Record<string, number>;
}
export interface StatusActions {
  /** Opens the settings dialog on a tab (the current one by default); focus returns to `source`. */
  open(source: HTMLElement, tab?: SettingsTab): void;
  close(): void;
  show(tab: SettingsTab): void;
  openFailure(id: string): void;
  openAiSettings(): void;
  openExecutionLimits(): void;
  /** The connection banner's [다시 연결]. */
  reconnect(): void;
}
export interface StatusFields {
  /** `#workspace-status`. */
  workspaceText: string;
  /** `#work-count`. */
  workCount: string;
  failures: Failure[];
  /** This session's API error notices (the last 20). */
  notifications: string[];
  coverage: DisplayCoverage | undefined;
  tab: SettingsTab;
  /** Opened through the tunnel: no AI or programs tab (set at start). */
  remote: boolean;
  /** Inside the desktop app: the PC program tab (set at start). */
  desktop: boolean;
  actions: StatusActions;
}
const none = () => {};
export const statusState = createSlice<StatusFields>({
  workspaceText: '작업 공간 연결 중',
  workCount: '',
  failures: [],
  notifications: [],
  coverage: undefined,
  tab: 'account',
  remote: false,
  desktop: false,
  actions: {
    open: none,
    close: none,
    show: none,
    openFailure: none,
    openAiSettings: none,
    openExecutionLimits: none,
    reconnect: none,
  },
});

/**
 * Hidden tabs: PC programs outside the desktop app; AI, external services and programs through the
 * tunnel.
 */
export const tabHidden = (tab: SettingsTab, state: Pick<StatusFields, 'remote' | 'desktop'>) =>
  tab === 'desktop'
    ? !state.desktop
    : tab === 'programs' || tab === 'ai' || tab === 'services'
      ? state.remote
      : false;

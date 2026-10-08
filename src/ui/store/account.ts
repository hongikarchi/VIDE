// The VIDE account button and panel (SPEC-05.10, Design SCR-34): what shell/account-button.tsx
// renders. src/ui/account-popover.ts writes the status and puts the open/close actions here.
import { createSlice } from './core.ts';
import type { AccountStatus } from '../remote-panel.ts';

export interface AccountActions {
  /** Opens the account panel next to `source` (the rail or narrow-screen button by default). */
  open(source?: HTMLElement): void;
  close(): void;
  toggle(source: HTMLElement): void;
}
export interface AccountFields {
  /** The last `/remote` answer; undefined until the first one. */
  status: AccountStatus | undefined;
  open: boolean;
  actions: AccountActions;
}
const none = () => {};
export const accountState = createSlice<AccountFields>({
  status: undefined,
  open: false,
  actions: { open: none, close: none, toggle: none },
});

/** The remote-access dot: none while remote access is off. */
export function remoteDot(status: AccountStatus | undefined): 'ok' | 'warn' | 'ng' | undefined {
  if (!status?.linked || !status.remote) return undefined;
  if (status.running) return 'ok';
  if (status.starting || status.downloading) return 'warn';
  return 'ng';
}

/** The button's tooltip: '아이디 · PC 이름', or '로그인 안 됨'. */
export function accountTitle(status: AccountStatus | undefined): string {
  if (!status) return '계정 확인 중';
  if (!status.linked) return '로그인 안 됨';
  return [status.username, status.name].filter(Boolean).join(' · ');
}

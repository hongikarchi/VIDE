// The VIDE account button and panel (SPEC-05.10, Design SCR-34): one circle at the bottom of the rail
// (and a row at the end of the narrow-screen bar) showing the signed-in account, with the remote
// access dot; pressing it opens the account panel `.account-popover`. The panel's sections are
// rendered empty and filled by src/ui/account-popover.ts (the VIDE account and remote access from
// remote-panel.ts, the AI accounts read only); React never gives them children.
import { memo } from 'react';
import { useStore } from '../store/core.ts';
import { accountState, accountTitle, remoteDot } from '../store/account.ts';
import { Avatar } from './avatar.tsx';

const dotLabel = { ok: '원격 접속 켜짐', warn: '원격 접속 켜는 중', ng: '원격 접속 실패' } as const;

export const AccountButton = memo(function AccountButton() {
  const status = useStore(accountState, (s) => s.status);
  const open = useStore(accountState, (s) => s.open);
  const dot = remoteDot(status);
  const title = accountTitle(status);
  return (
    <button
      id="account-button"
      className="rail-account"
      type="button"
      title={title}
      aria-label={`VIDE 계정 · ${title}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={(event) => accountState.actions.toggle(event.currentTarget)}
    >
      <Avatar name={status?.linked ? status.username : null} size={28} />
      {dot ? <span className="account-dot" data-state={dot} aria-label={dotLabel[dot]} /> : null}
    </button>
  );
});

/** The narrow-screen row (the rail is hidden below 850 px). */
export const MobileAccountButton = memo(function MobileAccountButton() {
  const status = useStore(accountState, (s) => s.status);
  const title = accountTitle(status);
  return (
    <button
      id="mobile-account-button"
      className="mobile-account"
      type="button"
      title={title}
      aria-label={`VIDE 계정 · ${title}`}
      aria-haspopup="dialog"
      onClick={(event) => accountState.actions.toggle(event.currentTarget)}
    >
      <Avatar name={status?.linked ? status.username : null} size={20} />
    </button>
  );
});

export const AccountPopover = memo(function AccountPopover() {
  return (
    <dialog className="account-popover" aria-label="VIDE 계정" tabIndex={-1}>
      <section className="remote-panel account-vide" />
      <section className="account-ai" />
      <div className="account-signout-slot" />
    </dialog>
  );
});

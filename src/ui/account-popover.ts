// The account panel's controller (SPEC-05.10, Design SCR-34). shell/account-button.tsx draws the
// button and the empty panel; this fills the panel (the VIDE account and remote access from
// remote-panel.ts, the AI accounts read only), opens it next to the button (a bottom sheet on narrow
// screens) and closes it on Esc or a press outside, focus going back to the button on Esc.
import { z } from 'zod';
import { append as el } from './elements.ts';
import { api } from './gateway.ts';
import { attachAccountPanel, remoteSession, type AccountStatus } from './remote-panel.ts';
import { accountSwitchLink, accountSwitchSchema } from './account-switch-link.ts';
import { accountState } from './store/account.ts';

const aiSchema = z.object({
  accounts: z.array(
    z.object({ provider: z.string(), signedIn: z.boolean(), email: z.string().optional() }),
  ),
  accountSwitch: accountSwitchSchema,
});
const service: Record<string, string> = { 'claude-cli': 'Claude Code', 'codex-cli': 'Codex' };

/** AI 계정 (read only, ADR-025): each CLI's login; switching is done in AccountSwitch. */
function attachAiAccounts(section: HTMLElement) {
  let generation = 0;
  return async () => {
    const current = ++generation;
    section.replaceChildren();
    el('h4', 'AI 계정 · 바꾸기는 AccountSwitch', section);
    const list = el('ul', '', section, { class: 'account-ai-rows' });
    try {
      const usage = aiSchema.parse(await api('/accounts/usage'));
      if (current !== generation) return;
      for (const provider of ['claude-cli', 'codex-cli']) {
        const row = usage.accounts.find((account) => account.provider === provider);
        const item = el('li', '', list);
        el('span', service[provider]!, item, { class: 'account-ai-name' });
        el(
          'span',
          !row ? '설치 안 됨' : !row.signedIn ? '로그인 필요' : (row.email ?? '로그인됨'),
          item,
          { class: 'account-ai-state' },
        );
      }
      accountSwitchLink(
        el('div', '', section, { class: 'account-ai-switch' }),
        usage.accountSwitch,
        {
          small: true,
        },
      );
    } catch {
      if (current === generation) el('li', 'AI 계정을 확인하지 못했습니다.', list);
    }
  };
}

export function initializeAccountPopover(onStatus: (status: AccountStatus) => void) {
  const dialog = document.querySelector<HTMLDialogElement>('.account-popover')!;
  let opener: HTMLElement | undefined;
  const panel = attachAccountPanel(
    dialog.querySelector<HTMLElement>('.account-vide')!,
    dialog,
    (status) => {
      accountState.status = status;
      accountState.bump();
      onStatus(status);
    },
    dialog.querySelector<HTMLElement>('.account-signout-slot')!,
  );
  const aiSection = dialog.querySelector<HTMLElement>('.account-ai')!;
  // Pages opened through the tunnel show the account and the site link only (SPEC-05.10 3).
  aiSection.hidden = remoteSession();
  const refreshAi = attachAiAccounts(aiSection);
  const narrow = () => window.matchMedia('(max-width: 850px)').matches;
  const anchor = () => {
    const rail = document.getElementById('account-button');
    const mobile = document.getElementById('mobile-account-button');
    return (narrow() ? mobile : rail) ?? rail ?? mobile ?? undefined;
  };
  const place = () => {
    if (narrow() || !opener) {
      dialog.style.left = dialog.style.bottom = '';
      return;
    }
    const box = opener.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    dialog.style.left = `${Math.max(8, Math.min(box.right + 8, window.innerWidth - width - 8))}px`;
    dialog.style.bottom = `${Math.max(8, window.innerHeight - box.bottom)}px`;
  };
  const close = (returnFocus = false) => {
    if (!dialog.open) return;
    dialog.close();
    accountState.open = false;
    accountState.bump();
    if (returnFocus) opener?.focus();
  };
  const open = (source?: HTMLElement) => {
    opener = source ?? anchor();
    place();
    if (!dialog.open) dialog.show();
    accountState.open = true;
    accountState.bump();
    if (!aiSection.hidden) void refreshAi();
    dialog.focus({ preventScroll: true });
  };
  // Esc inside the panel, or with nothing focused (a redraw removed the focused control).
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !dialog.open || event.defaultPrevented) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body && !dialog.contains(focused)) return;
    event.preventDefault();
    close(true);
  });
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!dialog.open) return;
      const target = event.target as Node;
      if (dialog.contains(target)) return;
      // The buttons toggle the panel themselves.
      if ((target as Element).closest?.('#account-button, #mobile-account-button')) return;
      close();
    },
    true,
  );
  window.addEventListener('resize', () => dialog.open && place());
  accountState.actions = {
    open,
    close: () => close(),
    toggle: (source) => (dialog.open ? close() : open(source)),
  };
  return { refresh: () => panel.refresh(), open, close };
}

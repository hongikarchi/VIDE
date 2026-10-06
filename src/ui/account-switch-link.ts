import { z } from 'zod';
import { append as el } from './elements.ts';
import { api } from './gateway.ts';

// [AccountSwitch 열기] when AccountSwitch is installed on this PC, else a link to install it
// (SPEC-02.18 1, PLAN-38 T-175). VIDE only starts AccountSwitch; accounts are chosen there.
export const ACCOUNT_SWITCH_DOWNLOAD =
  'https://github.com/hongikarchi/AccountSwitch/releases/latest';
export const accountSwitchSchema = z
  .object({ installed: z.boolean(), download: z.string().url().optional() })
  .optional();
export type AccountSwitchInfo = z.infer<typeof accountSwitchSchema>;

/** Appends the button or the install link; nothing for a remote session (another device). */
export function accountSwitchLink(
  parent: HTMLElement,
  info: AccountSwitchInfo,
  { small = false }: { small?: boolean } = {},
) {
  if (location.protocol === 'https:' || !info) return undefined;
  if (!info.installed)
    return el('a', 'AccountSwitch 설치', parent, {
      class: 'account-switch-link',
      href: info.download ?? ACCOUNT_SWITCH_DOWNLOAD,
      target: '_blank',
      rel: 'noopener',
    });
  const button = el('button', 'AccountSwitch 열기', parent, {
    type: 'button',
    class: small ? 'account-switch-open link-button' : 'account-switch-open',
  });
  button.onclick = () => {
    button.disabled = true;
    void api('/accountswitch/open', 'POST', {})
      .catch(() => {})
      .finally(() => (button.disabled = false));
  };
  return button;
}

import { z } from 'zod';
import { api } from './gateway.ts';
import { accountSwitchLink, accountSwitchSchema } from './account-switch-link.ts';

const window5 = z.object({ percent: z.number() }).optional();
const usageSchema = z.object({
  accounts: z.array(
    z.object({
      provider: z.string(),
      signedIn: z.boolean(),
      email: z.string().optional(),
      session: window5,
      weekly: window5,
      limitReached: z.boolean(),
    }),
  ),
  accountSwitch: accountSwitchSchema,
});
/**
 * The status bar's current account of the selected model's service: the CLI's default login
 * (ADR-025) by its email and, when usage lookup is on, its usage. Never paths or credentials.
 * When AccountSwitch changes a login, `vide-accounts-changed` goes out (the model list follows).
 * Read again when the VIDE window gets focus (back from AccountSwitch, PLAN-38 T-175); signed out,
 * [AccountSwitch 열기] or its install link sits next to it.
 */
export function accountIndicator(parent: HTMLElement, provider: () => string) {
  const label = document.createElement('small');
  label.setAttribute('aria-label', '현재 AI 계정');
  parent.append(label);
  const action = document.createElement('span');
  action.className = 'account-switch-action';
  parent.append(action);
  let signature: string | undefined;
  let generation = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    const current = ++generation;
    clearTimeout(timer);
    try {
      const usage = usageSchema.parse(await api('/accounts/usage'));
      if (current !== generation) return;
      const who = JSON.stringify(usage.accounts.map((row) => [row.provider, row.email ?? '']));
      const changed = signature !== undefined && signature !== who;
      signature = who;
      if (changed) window.dispatchEvent(new Event('vide-accounts-changed'));
      const key = provider();
      const row = usage.accounts.find((account) => account.provider === key);
      const name = !row
        ? '계정 확인 필요'
        : !row.signedIn
          ? '로그인 필요'
          : (row.email ?? '기존 CLI 로그인');
      label.title = row?.email ?? '';
      const used = [
        row?.session &&
          `${key === 'claude-cli' ? '5시간' : '단기'} ${Math.round(row.session.percent)}%`,
        row?.weekly && `7일 ${Math.round(row.weekly.percent)}%`,
      ].filter(Boolean);
      label.textContent =
        name + (row?.limitReached ? ' · 한도' : used.length ? ' · ' + used.join(' · ') : '');
      action.replaceChildren();
      if (row && !row.signedIn) accountSwitchLink(action, usage.accountSwitch, { small: true });
    } catch {
      if (current === generation) label.textContent = '계정 확인 필요';
    }
    timer = setTimeout(() => void refresh(), 120_000);
  };
  window.addEventListener('vide-accounts-changed', () => void refresh());
  // Back in VIDE (e.g. from AccountSwitch): read the login now, at most every 2 seconds.
  let focused = 0;
  window.addEventListener('focus', () => {
    if (Date.now() - focused < 2000) return;
    focused = Date.now();
    void refresh();
  });
  window.addEventListener('pagehide', () => {
    generation++;
    clearTimeout(timer);
  });
  return refresh;
}

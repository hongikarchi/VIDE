import { z } from 'zod';
import { api } from './gateway.ts';

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
});
/**
 * The status bar's current account of the selected model's service: the CLI's default login
 * (ADR-025) by its email and, when usage lookup is on, its usage. Never paths or credentials.
 * When AccountSwitch changes a login, `vide-accounts-changed` goes out (the model list follows).
 */
export function accountIndicator(parent: HTMLElement, provider: () => string) {
  const label = document.createElement('small');
  label.setAttribute('aria-label', '현재 AI 계정');
  parent.append(label);
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
    } catch {
      if (current === generation) label.textContent = '계정 확인 필요';
    }
    timer = setTimeout(() => void refresh(), 120_000);
  };
  window.addEventListener('vide-accounts-changed', () => void refresh());
  window.addEventListener('pagehide', () => {
    generation++;
    clearTimeout(timer);
  });
  return refresh;
}

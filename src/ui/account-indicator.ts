import { z } from 'zod';
import { api } from './gateway.ts';
const schema = z.object({
  profiles: z.array(z.object({ id: z.string(), label: z.string() })),
  active: z.record(z.string(), z.string()),
  pending: z.record(z.string(), z.string().nullable()),
  defaultLabels: z.record(z.string(), z.string()).optional(),
});
const window5 = z.object({ percent: z.number() }).optional();
const usageSchema = z.object({
  accounts: z.array(
    z.object({
      provider: z.string(),
      id: z.string(),
      email: z.string().optional(),
      session: window5,
      weekly: window5,
      limitReached: z.boolean(),
    }),
  ),
});
/**
 * The current account of the selected model's service: its name (or signed-in email) and, when
 * usage lookup is on, its usage. Never paths or credentials.
 */
export function accountIndicator(parent: HTMLElement, provider: () => string) {
  const label = document.createElement('small');
  label.setAttribute('aria-label', '현재 AI 계정');
  parent.append(label);
  let activeSignature: string | undefined;
  let generation = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    const current = ++generation;
    clearTimeout(timer);
    try {
      const [data, usage] = await Promise.all([
        api('/accounts').then((value) => schema.parse(value)),
        api('/accounts/usage')
          .then((value) => usageSchema.parse(value))
          .catch(() => undefined),
      ]);
      if (current !== generation) return;
      const signature = JSON.stringify(data.active);
      const changed = activeSignature !== undefined && activeSignature !== signature;
      activeSignature = signature;
      if (changed) window.dispatchEvent(new Event('vide-accounts-changed'));
      const key = provider(),
        id = data.active[key];
      const row = usage?.accounts.find((account) => account.provider === key && account.id === id);
      // A name the user gave the account comes first; otherwise the signed-in email.
      const given =
        id === 'default'
          ? data.defaultLabels?.[key]
          : data.profiles.find((p) => p.id === id)?.label;
      const name = given ?? row?.email ?? (id === 'default' ? '기존 CLI 로그인' : '계정 확인 필요');
      label.title = [given, row?.email].filter(Boolean).join(' · ');
      const used = [
        row?.session &&
          `${key === 'claude-cli' ? '5시간' : '단기'} ${Math.round(row.session.percent)}%`,
        row?.weekly && `7일 ${Math.round(row.weekly.percent)}%`,
      ].filter(Boolean);
      label.textContent =
        name +
        (row?.limitReached ? ' · 한도' : used.length ? ' · ' + used.join(' · ') : '') +
        (data.pending[key] ? ' · 전환 대기' : '');
      timer = setTimeout(
        () => void refresh(),
        Object.values(data.pending).some(Boolean) ? 2000 : 120_000,
      );
    } catch {
      if (current === generation) label.textContent = '계정 확인 필요';
    }
  };
  window.addEventListener('vide-accounts-changed', () => void refresh());
  window.addEventListener('pagehide', () => {
    generation++;
    clearTimeout(timer);
  });
  return refresh;
}

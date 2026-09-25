import { z } from 'zod';
import { api } from './gateway.ts';
const schema = z.object({
  profiles: z.array(z.object({ id: z.string(), label: z.string() })),
  active: z.record(z.string(), z.string()),
  pending: z.record(z.string(), z.string().nullable()),
});
/** Display only metadata; no path, credential or inferred usage appears in the composer. */
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
      const data = schema.parse(await api('/accounts'));
      if (current !== generation) return;
      const signature = JSON.stringify(data.active);
      const changed = activeSignature !== undefined && activeSignature !== signature;
      activeSignature = signature;
      if (changed) window.dispatchEvent(new Event('vide-accounts-changed'));
      const key = provider(),
        id = data.active[key];
      label.textContent =
        (id === 'default'
          ? '기존 CLI 로그인'
          : (data.profiles.find((p) => p.id === id)?.label ?? '계정 확인 필요')) +
        (data.pending[key] ? ' · 전환 대기' : '');
      if (Object.values(data.pending).some(Boolean)) timer = setTimeout(() => void refresh(), 2000);
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

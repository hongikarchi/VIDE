import { z } from 'zod';
import { append as el } from './elements.ts';
import { api } from './gateway.ts';

// Settings → AI: the current account of each service — the CLI's default login, with its email,
// plan, usage and reset times — read only (ADR-025, PLAN-25). Adding, signing in and switching
// accounts is done in AccountSwitch; VIDE follows whichever account it selected. The opt-in usage
// lookup stays here.
const windowSchema = z.object({ percent: z.number(), resetsAt: z.string().nullable() }).optional();
export const accountUsageSchema = z.object({
  settings: z.object({ usageLookup: z.boolean() }),
  accounts: z.array(
    z.object({
      provider: z.enum(['claude-cli', 'codex-cli']),
      signedIn: z.boolean(),
      email: z.string().optional(),
      plan: z.string().optional(),
      session: windowSchema,
      weekly: windowSchema,
      limitReached: z.boolean(),
      limitedUntil: z.string().optional(),
      checkedAt: z.string().optional(),
      state: z.enum(['ok', 'off', 'signed-out', 'token-expired', 'error']),
      error: z.string().optional(),
    }),
  ),
});
export type AccountUsageView = z.infer<typeof accountUsageSchema>;
const service = { 'claude-cli': 'Claude', 'codex-cli': 'ChatGPT' } as const;
const when = (value: string | null | undefined) => {
  if (!value) return '';
  const date = new Date(value);
  const hours = (date.getTime() - Date.now()) / 3600_000;
  return hours < 24
    ? date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit' });
};

export function attachAccountUsage(section: HTMLElement, dialog: HTMLDialogElement) {
  const box = el('div', '', section, { class: 'account-usage', 'aria-label': '현재 AI 계정' });
  let data: AccountUsageView | undefined,
    failure = '',
    timer: ReturnType<typeof setInterval> | undefined;
  const load = async (refresh = false) => {
    try {
      data = accountUsageSchema.parse(await api('/accounts/usage' + (refresh ? '?refresh=1' : '')));
      failure = '';
    } catch (error) {
      failure = error instanceof Error ? error.message : '계정 정보를 불러오지 못했습니다.';
    }
    draw();
  };
  const save = async (usageLookup: boolean) => {
    await api('/accounts/usage-settings', 'POST', { usageLookup });
    await load(true);
    window.dispatchEvent(new Event('vide-accounts-changed'));
  };
  const bar = (
    row: HTMLElement,
    label: string,
    value: AccountUsageView['accounts'][number]['session'],
  ) => {
    const line = el('div', '', row, { class: 'usage-line' });
    el('span', label, line, { class: 'usage-label' });
    const track = el('span', '', line, { class: 'usage-track' });
    const fill = el('span', '', track, { class: 'usage-fill' });
    const percent = Math.min(100, Math.max(0, value?.percent ?? 0));
    fill.style.width = percent + '%';
    fill.dataset.level = percent >= 90 ? 'high' : percent >= 70 ? 'mid' : 'low';
    el(
      'span',
      value
        ? `${Math.round(value.percent)}%${value.resetsAt ? ' · ' + when(value.resetsAt) + ' 초기화' : ''}`
        : '—',
      line,
      { class: 'usage-value' },
    );
  };
  function draw() {
    box.replaceChildren();
    el('h3', '현재 계정 · 사용량', box);
    el(
      'small',
      '요청은 각 CLI에 지금 로그인된 계정으로 보냅니다. 계정 추가·로그인·전환은 AccountSwitch에서 합니다.',
      box,
      { class: 'usage-note' },
    );
    if (failure) el('p', failure, box, { class: 'remote-error' });
    if (!data) {
      el('p', '확인 중…', box);
      return;
    }
    const list = el('ul', '', box, { class: 'settings-rows usage-list' });
    for (const account of data.accounts) {
      const row = el('li', '', list, { class: 'usage-row', 'data-provider': account.provider });
      const head = el('div', '', row, { class: 'usage-head' });
      el(
        'strong',
        `${service[account.provider]} · ${account.signedIn ? (account.email ?? '로그인됨') : '로그인 안 됨'}`,
        head,
      );
      if (account.plan) el('small', account.plan, head);
      if (account.limitReached || account.limitedUntil)
        el(
          'span',
          account.limitedUntil ? `한도 · ${when(account.limitedUntil)}까지` : '한도 도달',
          head,
          { class: 'pill' },
        );
      if (!account.signedIn)
        el('p', '터미널이나 AccountSwitch에서 이 서비스에 로그인하세요.', row, {
          class: 'usage-note',
        });
      else if (account.state === 'off')
        el('p', '사용량 조회가 꺼져 있습니다.', row, { class: 'usage-note' });
      else {
        bar(row, account.provider === 'claude-cli' ? '5시간' : '짧은 한도', account.session);
        bar(row, '7일', account.weekly);
        if (account.state === 'token-expired')
          el(
            'small',
            '로그인 토큰이 만료돼 마지막 값입니다. 이 계정으로 한 번 보내면 갱신됩니다.',
            row,
          );
        if (account.state === 'error')
          el('small', `조회 실패 (${account.error ?? '알 수 없음'})`, row);
      }
    }
    const options = el('div', '', box, { class: 'usage-options' });
    const toggle = el('label', '', options, { class: 'remote-toggle' });
    const input = el('input', '', toggle, { type: 'checkbox' });
    input.checked = data.settings.usageLookup;
    toggle.append(' 사용량 조회');
    input.onchange = () => void save(input.checked);
    el(
      'small',
      '로그인 정보로 Claude·ChatGPT의 비공개 사용량 주소를 조회합니다. 서비스 약관상 위험을 감수하는 선택 기능입니다(3분마다 갱신).',
      options,
    );
    const refresh = el('button', '지금 새로고침', box, { type: 'button', class: 'usage-refresh' });
    refresh.onclick = () => void load(true);
  }
  new MutationObserver(() => {
    clearInterval(timer);
    if (dialog.open) {
      void load();
      timer = setInterval(() => void load(), 60_000);
    }
  }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  draw();
}

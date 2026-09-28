import { element as $, append as el } from './elements.ts';
import { attachAccountPanel, remoteSession } from './remote-panel.ts';
import { attachDesktopPanel, inDesktop } from './desktop-panel.ts';
import { attachConnectorsPanel } from './connectors-panel.ts';
import { attachAccountUsage } from './account-usage-panel.ts';

interface Options {
  openFailure: (id: string) => void;
  openAiSettings: () => void;
  openExecutionLimits: () => void;
  /** Account site of this PC when it is signed in (for "all projects" links). */
  onAccount: (site: string | undefined) => void;
}
/** Status uses observed facts. Installation readiness never implies a document connection. */
export function initializeWorkspaceStatus({
  openFailure,
  openAiSettings,
  openExecutionLimits,
  onAccount,
}: Options) {
  const footer = document.querySelector<HTMLElement>('.statusbar')!;
  const dialog = document.createElement('dialog');
  dialog.className = 'workspace-status-dialog';
  dialog.setAttribute('aria-label', '상태 및 설정');
  document.body.append(dialog);
  let opener: HTMLElement | undefined;
  const close = () => {
    dialog.close();
    opener?.focus();
  };
  const head = el('div', '', dialog, { class: 'quantity-head' });
  el('h2', '설정', head);
  el('button', '닫기', head).onclick = close;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  const connection = $('connection-status');
  const host = $('host-status');
  const auth = $('auth-status');
  // One settings place, one topic per tab: account, AI, connected programs, this program, status.
  const layout = el('div', '', dialog, { class: 'settings-layout' });
  const nav = el('nav', '', layout, { class: 'settings-nav', 'aria-label': '설정 분류' });
  const panes = el('div', '', layout, { class: 'settings-panes' });
  type Tab = 'account' | 'ai' | 'programs' | 'desktop' | 'status';
  const tabs = new Map<Tab, { button: HTMLButtonElement; pane: HTMLElement }>();
  let current: Tab = 'account';
  function show(id: Tab) {
    if (tabs.get(id)?.button.hidden) id = 'account';
    current = id;
    for (const [key, { button, pane }] of tabs) {
      button.setAttribute('aria-pressed', String(key === id));
      pane.hidden = key !== id;
    }
  }
  const tab = (id: Tab, label: string) => {
    const button = el('button', label, nav, { type: 'button', 'data-tab': id });
    const pane = el('div', '', panes, { class: 'settings-pane', 'data-pane': id });
    button.onclick = () => show(id);
    tabs.set(id, { button, pane });
    return pane;
  };
  const account = attachAccountPanel(
    el('section', '', tab('account', '계정 · 원격 접속'), { class: 'remote-panel' }),
    dialog,
    (status) => onAccount(status.linked ? status.site : undefined),
  );
  const ai = el('section', '', tab('ai', 'AI'), { class: 'settings-ai' });
  el('h3', 'AI', ai);
  el(
    'small',
    '요청은 이 PC에 로그인된 Claude·ChatGPT 구독 계정으로 실행됩니다. 모델은 입력창 아래에서 고릅니다.',
    ai,
  );
  const providers = el('ul', '', ai, { class: 'settings-rows' });
  const actions = el('div', '', ai, { class: 'settings-actions' });
  for (const [label, id, action] of [
    ['AI 계정 관리', 'ai-settings', openAiSettings],
    ['작업 상한 (시간·조회 수)', 'execution-limits', openExecutionLimits],
  ] as const) {
    el('button', label, actions, { id, type: 'button' }).onclick = () => {
      close();
      action();
    };
  }
  attachAccountUsage(el('section', '', ai.parentElement!), dialog);
  attachConnectorsPanel(
    el('section', '', tab('programs', '연결 프로그램'), { class: 'remote-panel' }),
    dialog,
  );
  attachDesktopPanel(
    el('section', '', tab('desktop', 'PC 프로그램'), { class: 'remote-panel' }),
    dialog,
  );
  const statusPane = tab('status', '상태 · 오류');
  // Keep existing status writers, with their detail now in the status tab.
  const facts = el('section', '', statusPane);
  el('h3', '연결 상태', facts);
  facts.append(connection, host, auth);
  const display = el('section', '', statusPane);
  display.hidden = true;
  const problems = el('section', '', statusPane);
  // Pages opened through the tunnel cannot control the app, accounts, programs or AI settings.
  if (remoteSession()) document.documentElement.dataset.remote = 'true';
  tabs.get('desktop')!.button.hidden = !inDesktop();
  tabs.get('programs')!.button.hidden = tabs.get('ai')!.button.hidden = remoteSession();
  show('account');
  let failures: { id: string; label: string }[] = [];
  const notifications: string[] = [];
  const providerButton = el('button', 'AI · 확인 중', footer, { 'aria-label': 'AI 연결 상태' });
  const hostButton = el('button', '호스트 · 확인 중', footer, { 'aria-label': '호스트 준비 상태' });
  const displayButton = el('button', '', footer, { 'aria-label': '모델 표시 상태' });
  displayButton.hidden = true;
  const accountButton = el('button', '', footer, {
    id: 'status-account',
    'aria-label': '현재 AI 계정 설정',
  });
  const problemButton = el('button', '오류 기록 0', footer, { 'aria-label': '오류 기록' });
  const open = (source: HTMLElement, pane: Tab = current) => {
    opener = source;
    show(pane);
    if (!dialog.open) dialog.showModal();
  };
  accountButton.onclick = () => openAiSettings();
  displayButton.onclick = () => open(displayButton, 'status');
  providerButton.onclick = () => open(providerButton, remoteSession() ? 'status' : 'ai');
  hostButton.onclick = () => open(hostButton, 'status');
  problemButton.onclick = () => open(problemButton, 'status');
  $('workspace-settings').onclick = () => open($('workspace-settings'));
  function update() {
    providers.replaceChildren();
    for (const part of (connection.textContent || '').split(' · ')) {
      const match = /^(Claude|ChatGPT) (.+)$/.exec(part);
      if (!match) continue;
      const row = el('li', '', providers);
      el('strong', match[1], row);
      el('span', match[2], row, { class: 'pill', 'data-ok': String(match[2] === '연결됨') });
    }
    providerButton.textContent = connection.textContent || 'AI · 확인 전';
    hostButton.textContent = host.textContent?.split(' · 문서 연결')[0] || '호스트 · 확인 전';
    const rows = [...new Set(notifications)];
    if (!auth.hidden && auth.textContent) rows.unshift(auth.textContent);
    problemButton.textContent = `오류 기록 ${rows.length + failures.length}`;
    problemButton.dataset.error = String(rows.length + failures.length > 0);
    problems.replaceChildren();
    el('h3', '오류 기록', problems);
    if (!rows.length && !failures.length) el('p', '확인된 오류 기록이 없습니다.', problems);
    else {
      el(
        'small',
        '기록 확인은 오류 해결을 의미하지 않습니다. 해당 작업에서 결과를 확인하세요.',
        problems,
      );
      const list = el('ul', '', problems);
      failures.slice(-20).forEach((row) => {
        const action = el('button', row.label, el('li', '', list));
        action.onclick = () => {
          close();
          openFailure(row.id);
        };
      });
      rows.slice(-20).forEach((row) => el('li', row, list));
    }
  }
  const observer = new MutationObserver(update);
  for (const node of [connection, host, auth])
    observer.observe(node, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
    });
  window.addEventListener('vide:api-error', (event) => {
    notifications.push((event as CustomEvent<string>).detail);
    if (notifications.length > 20) notifications.shift();
    update();
  });
  window.addEventListener('pagehide', () => observer.disconnect());
  update();
  return {
    refreshAccount: () => account.refresh(),
    setDisplayCoverage(coverage?: {
      total: number;
      displayed: number;
      omitted: number;
      omittedTypes: Record<string, number>;
    }) {
      display.replaceChildren();
      display.hidden = !coverage;
      displayButton.hidden = !coverage || coverage.omitted === 0;
      if (!coverage) return;
      displayButton.textContent = `표시 미지원 ${coverage.omitted.toLocaleString()}`;
      el('h3', '현재 모델 표시', display);
      el(
        'p',
        `전체 ${coverage.total.toLocaleString()}개 · 화면 표시 ${coverage.displayed.toLocaleString()}개 · 표현 미지원 ${coverage.omitted.toLocaleString()}개`,
        display,
      );
      if (coverage.omitted) {
        el('p', '화면 표현 미지원 객체도 목록·네이티브 파일에 보존됩니다.', display);
        el(
          'small',
          Object.entries(coverage.omittedTypes)
            .map(([kind, count]) => `${kind} ${count.toLocaleString()}개`)
            .join(' · '),
          display,
        );
      }
    },
    setFailures(rows: { id: string; label: string }[]) {
      failures = rows;
      update();
    },
  };
}

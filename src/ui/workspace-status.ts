import { element as $, append as el } from './elements.ts';

/** Status uses observed facts. Installation readiness never implies a document connection. */
export function initializeWorkspaceStatus(openFailure: (id: string) => void) {
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
  const title = el('h2', '상태 및 설정', head);
  el('button', '닫기', head).onclick = close;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  const content = el('div', '', dialog);
  const connection = $('connection-status');
  const host = $('host-status');
  const auth = $('auth-status');
  // Keep existing status writers, with their detail now in the status dialog.
  const facts = el('section', '', content);
  facts.append(connection, host, auth);
  const display = el('section', '', content);
  display.hidden = true;
  const problems = el('section', '', content);
  const actions = el('div', '', content, { class: 'settings-actions' });
  for (const [label, id] of [
    ['AI 계정 · 연결 설정', 'ai-settings'],
    ['작업 상한 설정', 'execution-limits'],
  ]) {
    el('button', label, actions).onclick = () => {
      close();
      $(id!).click();
    };
  }
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
  const open = (source: HTMLElement, heading: string) => {
    opener = source;
    title.textContent = heading;
    if (!dialog.open) dialog.showModal();
  };
  accountButton.onclick = () => {
    $('ai-settings').click();
  };
  displayButton.onclick = () => open(displayButton, '모델 표시 상태');
  providerButton.onclick = () => open(providerButton, 'AI 연결 상태');
  hostButton.onclick = () => open(hostButton, '호스트 준비 상태');
  problemButton.onclick = () => open(problemButton, '오류 기록');
  $('workspace-settings').onclick = () => open($('workspace-settings'), '설정');
  function update() {
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

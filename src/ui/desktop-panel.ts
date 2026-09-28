import { append as el } from './elements.ts';

// Settings section "PC 프로그램": shown only inside the VIDE program window (WebView2). The window
// shell owns autostart, background mode and updates; this page talks to it by WebView2 messages.
interface WebView {
  postMessage(value: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
interface DesktopState {
  type: 'desktop:state';
  version: string;
  settings: { autostart: boolean; background: boolean };
  update: { state: string; available?: string | null; error?: string | null };
}
const webview = (window as unknown as { chrome?: { webview?: WebView } }).chrome?.webview;
export const inDesktop = () => !!webview;

const updateText: Record<string, (s: DesktopState['update']) => string> = {
  idle: () => '업데이트를 확인하지 않았습니다.',
  checking: () => '업데이트 확인 중…',
  current: () => '최신 버전입니다.',
  downloading: (s) => `새 버전 ${s.available ?? ''}을 내려받는 중…`,
  ready: (s) => `새 버전 ${s.available ?? ''}이 준비됐습니다. 재시작하면 설치됩니다.`,
  error: (s) => `업데이트를 확인하지 못했습니다. ${s.error ?? ''}`,
  unavailable: () => '설치된 프로그램이 아니어서 자동 업데이트를 쓰지 않습니다.',
};

export function attachDesktopPanel(section: HTMLElement, dialog: HTMLDialogElement) {
  if (!webview) {
    section.hidden = true;
    return;
  }
  const view = webview;
  let state: DesktopState | undefined;
  const send = (message: Record<string, unknown>) => view.postMessage(message);
  view.addEventListener('message', (event) => {
    const data = event.data as DesktopState | undefined;
    if (data?.type !== 'desktop:state') return;
    state = data;
    draw();
  });
  function toggle(label: string, checked: boolean, key: 'autostart' | 'background', hint: string) {
    const row = el('label', '', section, { class: 'remote-toggle' });
    const box = el('input', '', row, { type: 'checkbox' });
    box.checked = checked;
    row.append(' ' + label);
    box.onchange = () => send({ type: 'desktop:set', [key]: box.checked });
    el('small', hint, section);
  }
  function draw() {
    section.replaceChildren();
    el('h3', 'PC 프로그램', section);
    if (!state) {
      el('p', '확인 중…', section);
      return;
    }
    el('p', `VIDE ${state.version}`, section, { class: 'account-who' });
    toggle(
      'Windows 시작 시 자동 실행',
      state.settings.autostart,
      'autostart',
      'PC를 켜면 창 없이 트레이에서 시작합니다.',
    );
    toggle(
      '창을 닫아도 백그라운드에서 계속 실행',
      state.settings.background,
      'background',
      '끄면 창을 닫을 때 VIDE가 종료됩니다. 켜 두면 다른 기기에서 계속 열 수 있습니다.',
    );
    const update = state.update;
    el('p', (updateText[update.state] ?? updateText.idle)(update), section);
    const actions = el('div', '', section, { class: 'settings-actions' });
    if (update.state === 'ready')
      el('button', '재시작하여 업데이트', actions, { type: 'button' }).onclick = () =>
        send({ type: 'update:apply' });
    else if (update.state !== 'unavailable')
      el('button', '업데이트 확인', actions, {
        type: 'button',
        ...(update.state === 'checking' || update.state === 'downloading' ? { disabled: '' } : {}),
      }).onclick = () => send({ type: 'update:check' });
  }
  new MutationObserver(() => {
    if (dialog.open) send({ type: 'desktop:get' });
  }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  draw();
  send({ type: 'desktop:get' });
}

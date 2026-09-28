import { z } from 'zod';
import { append as el } from './elements.ts';
import { api } from './gateway.ts';

// Settings section: pair this PC with the sharing site once, then turn remote access on so a
// signed-in owner can open this workspace from another device (e.g. an iPad).
const SHARING_ORIGIN = 'https://vide-sharing-staging.archivibe.workers.dev';
const statusSchema = z.object({
  paired: z.boolean(),
  name: z.string().optional(),
  workerOrigin: z.string().optional(),
  running: z.boolean(),
  url: z.string().optional(),
  lastHeartbeat: z.string().optional(),
  error: z.string().optional(),
});
type Status = z.infer<typeof statusSchema>;
const errorText: Record<string, string> = {
  CLOUDFLARED_MISSING: 'cloudflared가 설치되지 않았습니다.',
  TUNNEL_START_TIMEOUT: '터널 주소를 받지 못했습니다. 인터넷 연결을 확인하세요.',
  TUNNEL_EXITED: '터널이 종료됐습니다. 다시 켜세요.',
  HEARTBEAT_FAILED: '공유 사이트에 상태를 보내지 못했습니다.',
  REMOTE_UNPAIRED: '공유 사이트에서 이 PC 등록이 해제됐습니다. 다시 등록하세요.',
  PAIRING_NOT_FOUND: '등록 코드가 없거나 만료됐습니다.',
};

/** True when this page itself was opened through the remote tunnel. */
export const remoteSession = () => location.protocol === 'https:';

export function attachRemotePanel(section: HTMLElement, dialog: HTMLDialogElement) {
  if (remoteSession()) {
    section.hidden = true;
    return;
  }
  let status: Status | undefined,
    busy = false,
    timer: ReturnType<typeof setInterval> | undefined;
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    busy = true;
    draw();
    try {
      status = statusSchema.parse(await action());
    } catch (error) {
      if (status) status = { ...status, error: error instanceof Error ? error.message : '실패' };
    } finally {
      busy = false;
      draw();
    }
  };
  const refresh = () => run(() => api('/remote'));
  function draw() {
    section.replaceChildren();
    el('h3', '원격 접속 (iPad 등)', section);
    if (!status) {
      el('p', '확인 중…', section);
      return;
    }
    if (status.error)
      el('p', errorText[status.error] || status.error, section, { class: 'remote-error' });
    if (!status.paired) {
      el(
        'small',
        `공유 사이트(${SHARING_ORIGIN.replace('https://', '')})에 로그인해 "PC 등록 코드"를 만든 뒤 입력하세요.`,
        section,
      );
      const form = el('form', '', section, { class: 'remote-pair' });
      const code = el('input', '', form, {
        placeholder: '등록 코드',
        'aria-label': '등록 코드',
        maxlength: '20',
      });
      const name = el('input', '', form, { 'aria-label': 'PC 이름', maxlength: '80' });
      name.value = 'VIDE PC';
      el('button', busy ? '등록 중…' : '이 PC 등록', form, { type: 'submit' });
      form.onsubmit = (event) => {
        event.preventDefault();
        void run(() =>
          api('/remote/pair', 'POST', {
            code: code.value.trim(),
            name: name.value.trim() || 'VIDE PC',
          }),
        );
      };
      return;
    }
    el(
      'p',
      status.running
        ? `켜짐 · ${status.name} · 공유 사이트의 호스트 PC 목록에서 열 수 있습니다.`
        : `꺼짐 · ${status.name}`,
      section,
    );
    if (status.running && status.lastHeartbeat)
      el(
        'small',
        `마지막 상태 전송 ${new Date(status.lastHeartbeat).toLocaleTimeString()}`,
        section,
      );
    const actions = el('div', '', section, { class: 'settings-actions' });
    el(
      'button',
      busy ? '처리 중…' : status.running ? '원격 접속 끄기' : '원격 접속 켜기',
      actions,
    ).onclick = () =>
      void run(() => api(status!.running ? '/remote/stop' : '/remote/start', 'POST', {}));
    el('button', '등록 해제', actions).onclick = () => {
      if (confirm('이 PC의 원격 접속 등록을 해제할까요?'))
        void run(() => api('/remote/unpair', 'POST', {}));
    };
  }
  // Refresh while the dialog is open (heartbeat time, tunnel exits).
  new MutationObserver(() => {
    clearInterval(timer);
    if (dialog.open) {
      void refresh();
      timer = setInterval(() => void refresh(), 5000);
    }
  }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  draw();
}

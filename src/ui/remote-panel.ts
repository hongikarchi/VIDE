import { z } from 'zod';
import { append as el } from './elements.ts';
import { api } from './gateway.ts';
import { avatarNode } from './shell/avatar.tsx';

// The account panel's "VIDE 계정" (SPEC-05.10, SCR-34): sign this PC in with the account's ID and
// password, see the site connection and turn remote access on. A signed-in PC appears on the account
// website; its projects are listed there and open here (on other devices through remote access).
export const SITE_ORIGIN = 'https://vide-sharing-staging.archivibe.workers.dev';
export const accountStatusSchema = z.object({
  linked: z.boolean(),
  username: z.string().optional(),
  name: z.string().optional(),
  site: z.string().optional(),
  remote: z.boolean(),
  running: z.boolean(),
  starting: z.boolean().optional(),
  downloading: z.boolean().optional(),
  url: z.string().optional(),
  lastHeartbeat: z.string().optional(),
  error: z.string().optional(),
});
export type AccountStatus = z.infer<typeof accountStatusSchema>;
const errorText: Record<string, string> = {
  CLOUDFLARED_MISSING:
    '원격 접속 도구(cloudflared)를 찾지 못했습니다. 원격 접속을 다시 켜면 자동으로 받습니다.',
  CLOUDFLARED_DOWNLOAD_FAILED:
    '원격 접속 도구(cloudflared)를 받지 못했습니다. 인터넷 연결을 확인하고 원격 접속을 다시 켜세요.',
  CLOUDFLARED_VERIFY_FAILED:
    '받은 원격 접속 도구의 확인값이 맞지 않아 쓰지 않았습니다. 원격 접속을 다시 켜면 새로 받습니다.',
  TUNNEL_START_FAILED:
    '원격 접속 도구를 시작하지 못했습니다. 보안 프로그램이 막았는지 확인하고 다시 켜세요.',
  TUNNEL_START_TIMEOUT: '원격 주소를 받지 못했습니다. 인터넷 연결을 확인하세요.',
  TUNNEL_UNREACHABLE: '원격 주소가 응답하지 않습니다. 잠시 후 다시 켜세요.',
  TUNNEL_EXITED: '원격 접속이 끊겼습니다. 다시 켜세요.',
  HEARTBEAT_FAILED: '웹사이트에 이 PC 상태를 보내지 못했습니다. 인터넷 연결을 확인하세요.',
  ACCOUNT_UNLINKED: '웹사이트에서 이 PC가 로그아웃됐습니다. 다시 로그인하세요.',
  PROJECT_SYNC_FAILED:
    '프로젝트 목록을 웹사이트에 올리지 못했습니다. 잠시 후 자동으로 다시 맞춥니다.',
};
export const loginError: Record<string, string> = {
  INVALID_LOGIN: '아이디 또는 비밀번호를 확인하세요.',
  SITE_UNREACHABLE: '웹사이트에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.',
  ACCOUNT_LINK_FAILED: '웹사이트가 로그인을 받지 못했습니다. 잠시 후 다시 시도하세요.',
};
/** A tunnel or tool error: shown only while remote access is on (ADR-039 3). */
const tunnelError = (code: string | undefined) => !!code && /^(CLOUDFLARED_|TUNNEL_)/.test(code);

/** True when this page itself was opened through the remote tunnel. */
export const remoteSession = () => location.protocol === 'https:';

/**
 * The VIDE account and remote access in the account panel (SPEC-05.10, SCR-34). `dialog` is the
 * panel (polled while open); `signOut`, when given, holds [이 PC 로그아웃] at the panel's end.
 */
export function attachAccountPanel(
  section: HTMLElement,
  dialog: HTMLDialogElement,
  onStatus: (status: AccountStatus) => void,
  signOut?: HTMLElement,
) {
  let status: AccountStatus | undefined,
    busy = false,
    failure = '',
    confirmUnlink = false,
    showPassword = false,
    timer: ReturnType<typeof setInterval> | undefined;
  // Typed values survive redraws (status polling, errors).
  const fields = { username: '', password: '', name: 'VIDE PC' };
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    busy = true;
    failure = '';
    draw();
    try {
      status = accountStatusSchema.parse(await action());
      onStatus(status);
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      failure = loginError[code] || (error instanceof Error ? error.message : '실패');
    } finally {
      busy = false;
      draw();
    }
  };
  const refresh = () => run(() => api('/remote'));
  // Background status check: redraw only on a change and never while the user is typing here.
  const poll = async () => {
    if (busy) return;
    try {
      const next = accountStatusSchema.parse(await api('/remote'));
      if (JSON.stringify(next) === JSON.stringify(status)) return;
      status = next;
      onStatus(next);
      // Never while the user is typing in the login form.
      const typing = document.activeElement?.matches?.('input:not([type="checkbox"])');
      if (!(typing && section.contains(document.activeElement))) draw();
    } catch {
      /* The next check or an action reports problems. */
    }
  };
  function draw() {
    section.replaceChildren();
    signOut?.replaceChildren();
    el('h3', 'VIDE 계정', section);
    if (!status) {
      el('p', '확인 중…', section);
      return;
    }
    if (failure) el('p', failure, section, { class: 'remote-error', role: 'alert' });
    if (!status.linked) {
      if (remoteSession()) {
        el('p', '이 PC는 계정에 로그인돼 있지 않습니다.', section);
        return;
      }
      el(
        'small',
        '로그인하면 웹사이트에서 이 PC의 프로젝트 목록을 보고 열 수 있습니다. 아이패드 등 다른 기기에서 열려면 로그인 뒤 원격 접속을 켭니다.',
        section,
      );
      const form = el('form', '', section, { class: 'account-login' });
      const username = el('input', '', form, {
        placeholder: '아이디',
        'aria-label': '아이디',
        autocomplete: 'username',
        autocapitalize: 'none',
        spellcheck: 'false',
        required: '',
      });
      const secret = el('div', '', form, { class: 'password-field' });
      const password = el('input', '', secret, {
        type: showPassword ? 'text' : 'password',
        placeholder: '비밀번호',
        'aria-label': '비밀번호',
        autocomplete: 'current-password',
        required: '',
      });
      const reveal = el('button', showPassword ? '숨기기' : '보기', secret, {
        type: 'button',
        class: 'password-toggle',
        'aria-label': showPassword ? '비밀번호 숨기기' : '비밀번호 보기',
        'aria-pressed': String(showPassword),
      });
      reveal.onclick = () => {
        showPassword = !showPassword;
        password.type = showPassword ? 'text' : 'password';
        reveal.textContent = showPassword ? '숨기기' : '보기';
        reveal.setAttribute('aria-pressed', String(showPassword));
        reveal.setAttribute('aria-label', showPassword ? '비밀번호 숨기기' : '비밀번호 보기');
        password.focus();
      };
      const name = el('input', '', form, {
        'aria-label': 'PC 이름',
        title: '웹사이트의 작업 PC 목록에 보일 이름',
        maxlength: '80',
      });
      username.value = fields.username;
      password.value = fields.password;
      name.value = fields.name;
      username.oninput = () => (fields.username = username.value);
      password.oninput = () => (fields.password = password.value);
      name.oninput = () => (fields.name = name.value);
      el('button', busy ? '로그인 중…' : '로그인', form, { type: 'submit' });
      form.onsubmit = (event) => {
        event.preventDefault();
        void run(async () => {
          const result = await api('/remote/link', 'POST', {
            username: fields.username.trim(),
            password: fields.password,
            name: fields.name.trim() || 'VIDE PC',
          });
          fields.password = '';
          return result;
        });
      };
      const site = el('small', '', section);
      site.append('계정이 없으면 ');
      el('a', '웹사이트', site, { href: SITE_ORIGIN, target: '_blank', rel: 'noopener' });
      site.append('에서 가입 코드로 만드세요.');
      return;
    }
    // The account (SCR-34): the circle, the ID and the PC name, then the site connection.
    const head = el('div', '', section, { class: 'account-head' });
    head.append(avatarNode(status.username, 40));
    const who = el('div', '', head, { class: 'account-who' });
    el('strong', status.username ?? '', who);
    el('small', status.name ?? '', who);
    const error = status.error;
    const site = el('p', '', section, { class: 'account-site' });
    if (error === 'ACCOUNT_UNLINKED') {
      site.classList.add('remote-error');
      site.textContent = errorText.ACCOUNT_UNLINKED!;
    } else if (error === 'HEARTBEAT_FAILED') {
      site.dataset.state = 'warn';
      const last = status.lastHeartbeat ? new Date(status.lastHeartbeat) : undefined;
      site.textContent =
        '웹사이트에 연결하지 못했습니다' +
        (last && !Number.isNaN(last.getTime())
          ? ' · 마지막 ' +
            last.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
          : '');
    } else {
      site.dataset.state = 'ok';
      site.textContent = '웹사이트 연결됨';
    }
    // Other notices (e.g. the project list not uploaded); tunnel errors only while remote is on.
    if (
      error &&
      error !== 'ACCOUNT_UNLINKED' &&
      error !== 'HEARTBEAT_FAILED' &&
      !tunnelError(error)
    )
      el('p', errorText[error] || error, section, { class: 'remote-error' });
    const links = el('div', '', section, { class: 'settings-actions' });
    el('a', '웹사이트에서 모든 프로젝트 보기 ↗', links, {
      href: status.site ?? SITE_ORIGIN,
      target: '_blank',
      rel: 'noopener',
    });
    if (remoteSession()) {
      el('p', '원격 접속과 로그아웃은 PC에서 합니다.', section, { class: 'account-note' });
      return;
    }
    const remoteGroup = el('div', '', section, { class: 'account-group account-remote' });
    el('h4', '원격 접속', remoteGroup);
    const remote = el('label', '', remoteGroup, { class: 'remote-toggle' });
    const toggle = el('input', '', remote, { type: 'checkbox' });
    toggle.checked = status.remote;
    toggle.disabled = busy;
    remote.append(' 다른 기기에서 열기 (원격 접속)');
    toggle.onchange = () =>
      void run(() => api('/remote/remote', 'POST', { enabled: toggle.checked }));
    if (status.remote && tunnelError(error))
      el('p', errorText[error!] || error!, remoteGroup, { class: 'remote-error' });
    el(
      'small',
      !status.remote
        ? '꺼짐 · 이 PC의 브라우저에서만 열 수 있습니다.'
        : status.running
          ? '켜짐 · 아이패드 등에서 웹사이트에 로그인해 열 수 있습니다.'
          : status.downloading
            ? '켜는 중… 원격 접속 도구를 처음 받고 있습니다(약 50 MB).'
            : status.starting
              ? '켜는 중…'
              : '켜기 실패 · 위 안내를 확인하세요.',
      remoteGroup,
    );
    if (!signOut) return;
    const actions = el('div', '', signOut, { class: 'account-signout' });
    if (confirmUnlink) el('small', '이 PC의 프로젝트 자료는 남습니다.', actions);
    el('button', confirmUnlink ? '로그아웃 확인' : '이 PC 로그아웃', actions, {
      type: 'button',
      ...(confirmUnlink ? { class: 'danger' } : {}),
    }).onclick = () => {
      if (!confirmUnlink) {
        confirmUnlink = true;
        draw();
        return;
      }
      confirmUnlink = false;
      void run(async () => {
        const result = await api('/remote/unlink', 'POST', {});
        // The installed VIDE needs the sign-in (ADR-039 1): back to the first-run screen. The
        // engine without the sign-in check (dev server) stays and the button turns neutral.
        const gate = z
          .object({ signInRequired: z.boolean().optional() })
          .passthrough()
          .safeParse(await api('/onboarding').catch(() => ({})));
        if (gate.success && gate.data.signInRequired) location.reload();
        return result;
      });
    };
  }
  // Refresh while the panel is open (heartbeat, tunnel start/exit); while it is closed, only while
  // remote access is on (the button's dot follows the tunnel).
  new MutationObserver(() => {
    clearInterval(timer);
    confirmUnlink = false;
    if (dialog.open) {
      void poll();
      timer = setInterval(() => void poll(), 3000);
    } else {
      draw();
      timer = setInterval(() => {
        if (status?.remote) void poll();
      }, 15000);
    }
  }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  draw();
  // Called once the page has its session (asking earlier would read as a lost connection).
  return { refresh };
}

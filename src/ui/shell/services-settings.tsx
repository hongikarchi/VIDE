// 설정 › 외부 서비스 (SPEC-13.11, PLAN-46 T-217): the cLAWde row — address, status, law DB date,
// [연결] (VIDE account) and [끊기], the development token, and this project's '법규 서비스에 보내지
// 않음'. The engine never sends the token back; a saved token shows only as '저장됨'.
import { memo, useCallback, useEffect, useState } from 'react';
import { api } from '../gateway.ts';
import { useStore } from '../store/core.ts';
import { statusState } from '../store/status.ts';
import { sessionState } from '../store/session.ts';
import {
  serviceSettingsViewSchema,
  type ClawdeSettingsView,
  type ServiceStatus,
} from '../../contracts/services.ts';

const statusText: Record<ServiceStatus, string> = {
  connected: '연결됨',
  unreachable: '닿지 않음',
  'login-required': '로그인 필요',
  off: '꺼짐',
  'not-configured': '설정 안 됨',
  unchecked: '확인 전',
};
const errorText: Record<string, string> = {
  ACCOUNT_NOT_LINKED:
    'VIDE 계정에 로그인한 PC에서만 연결할 수 있습니다. 계정 · 원격 접속에서 로그인하세요.',
  SITE_UNREACHABLE: '계정 사이트에 닿지 않습니다. 잠시 뒤 다시 누르세요.',
  SERVICE_TOKEN_UNAVAILABLE:
    '계정 사이트가 아직 서비스 토큰을 발급하지 않습니다. 개발용 토큰을 넣어 연결하세요.',
  SERVICE_NOT_CONNECTED: '서비스 주소를 먼저 저장하세요.',
  INVALID_INPUT: '주소 형식이 맞지 않습니다(https://…).',
  FORBIDDEN: '외부 서비스 설정은 이 PC의 VIDE 창에서만 바꿀 수 있습니다.',
};
const quiet = Object.keys(errorText);

export const ServicesSection = memo(function ServicesSection() {
  const tab = useStore(statusState, (s) => s.tab);
  const project = useStore(sessionState, (s) => s.project);
  const [view, setView] = useState<ClawdeSettingsView | null>(null);
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const take = useCallback((value: unknown) => {
    const next = serviceSettingsViewSchema.parse(value).clawde;
    setView(next);
    setAddress(next.baseUrl ?? '');
  }, []);
  const run = useCallback(
    async (path: string, method: 'GET' | 'PUT' | 'POST', data?: unknown) => {
      setBusy(true);
      setError('');
      try {
        take(await api('/settings/services' + path, method, data, { quiet }));
        return true;
      } catch (failure) {
        const code = (failure as { code?: string } | null)?.code ?? '';
        setError(errorText[code] ?? '설정을 저장하지 못했습니다.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [take],
  );
  useEffect(() => {
    if (tab === 'services' && sessionState.ready) void run('', 'GET');
  }, [tab, run]);

  const off = !!project && !!view?.projectsOff.includes(project.id);
  const status = view?.status;
  return (
    <section className="services-settings remote-panel">
      <h3>외부 서비스</h3>
      <small>
        법규 Q&A는 cLAWde 서비스에 묻습니다. 보낼 정보는 질문할 때 확인하며, 토큰은 이 PC에만
        암호화해 둡니다.
      </small>
      <ul className="settings-rows">
        <li>
          <strong>cLAWde · 법규</strong>
          <small id="clawde-law-date">
            {view?.lawDbDate ? `법령 DB 기준일 ${view.lawDbDate}` : null}
          </small>
          <span id="clawde-status" className="pill" data-ok={String(status === 'connected')}>
            {status ? statusText[status] : '…'}
          </span>
        </li>
      </ul>
      <form
        className="services-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run('', 'PUT', {
            clawde: { baseUrl: address.trim() || null, ...(token ? { token } : {}) },
          }).then((ok) => {
            if (!ok) return;
            setToken('');
            if (token) void run('/clawde/check', 'POST');
          });
        }}
      >
        <label>
          <span>서비스 주소</span>
          <input
            id="clawde-address"
            type="url"
            placeholder="https://"
            value={address}
            disabled={busy}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <label>
          <span>개발용 토큰</span>
          <input
            id="clawde-token"
            type="password"
            autoComplete="off"
            placeholder={
              view?.token.set
                ? `저장됨 · ${view.token.source === 'account' ? '계정' : '직접 입력'}`
                : '시험할 때만'
            }
            value={token}
            disabled={busy}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <div className="settings-actions">
          <button id="clawde-save" type="submit" disabled={busy}>
            저장
          </button>
          <button
            id="clawde-connect"
            type="button"
            disabled={busy || !view?.accountLinked}
            title={view?.accountLinked ? undefined : 'VIDE 계정에 로그인한 PC에서 씁니다'}
            onClick={() => void run('/clawde/connect', 'POST')}
          >
            연결
          </button>
          <button
            id="clawde-check"
            type="button"
            disabled={busy || !view?.token.set}
            onClick={() => void run('/clawde/check', 'POST')}
          >
            상태 확인
          </button>
          <button
            id="clawde-disconnect"
            type="button"
            disabled={busy || !view?.token.set}
            onClick={() => void run('/clawde/disconnect', 'POST')}
          >
            끊기
          </button>
        </div>
      </form>
      {project && view ? (
        <label className="remote-toggle">
          <input
            id="clawde-project-off"
            type="checkbox"
            checked={off}
            disabled={busy}
            onChange={(event) => {
              const rest = view.projectsOff.filter((id) => id !== project.id);
              void run('', 'PUT', {
                clawde: { projectsOff: event.target.checked ? [...rest, project.id] : rest },
              });
            }}
          />
          {`이 프로젝트(${project.name})는 법규 서비스에 보내지 않음`}
        </label>
      ) : null}
      {error ? (
        <p className="remote-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
});

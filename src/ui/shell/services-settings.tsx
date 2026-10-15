// 설정 › 외부 서비스 (SPEC-13.11, PLAN-46 T-217): service cards sharing one frame. The cLAWde card —
// address, status, law DB date, [연결] (VIDE account) and [끊기], the development token, this
// project's '법규 서비스에 보내지 않음', and [모델 인증] for the answer prose writers (T-236) — then the
// user's own GitHub and Cloudflare accounts (SPEC-05.11, Design SCR-41, PLAN-54 T-344). The engine
// never sends a token back; a saved token shows only as '저장됨'·'설정됨'.
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../gateway.ts';
import { useStore } from '../store/core.ts';
import { statusState } from '../store/status.ts';
import { sessionState } from '../store/session.ts';
import {
  serviceSettingsViewSchema,
  type AccountService,
  type AccountStatus,
  type ClawdeFeature,
  type ClawdeFeatures,
  type ClawdeSettingsView,
  type CloudflareSettingsView,
  type GithubSettingsView,
  type ServiceSettingsView,
  type ServiceStatus,
} from '../../contracts/services.ts';
import './services-settings.css';

/** The features as the user knows them (PLAN-48 T-240); recipes and verify go with 답 문장. */
const featureText: [ClawdeFeature, string][] = [
  ['ask', '묻기'],
  ['checklist', '단계별 법령'],
  ['contribute', 'cLAWde로 보내기'],
  ['golden', '모델 인증'],
  ['verify', '답 문장 검증'],
];

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
    'VIDE 계정에 로그인한 PC에서만 연결할 수 있습니다. 왼쪽 아래 계정 단추에서 로그인하세요.',
  SITE_UNREACHABLE: '계정 사이트에 닿지 않습니다. 잠시 뒤 다시 누르세요.',
  SERVICE_TOKEN_UNAVAILABLE:
    '계정 사이트가 아직 서비스 토큰을 발급하지 않습니다. 개발용 토큰을 넣어 연결하세요.',
  SERVICE_NOT_CONNECTED: '서비스 주소를 먼저 저장하세요.',
  INVALID_INPUT: '주소 형식이 맞지 않습니다(https://…).',
  FORBIDDEN: '외부 서비스 설정은 이 PC의 VIDE 창에서만 바꿀 수 있습니다.',
};
const quiet = Object.keys(errorText);

interface CertRow {
  provider: string;
  model: string;
  effort: string;
  cert: { passed: number; total: number; at: string; goldenVersion: string } | null;
}

/**
 * [모델 인증] (SPEC-13.13 6, PLAN-46 T-236): the writers cLAWde names for answer prose and each
 * one's last golden-set result. A run uses this PC's model on every golden question, so it starts
 * only when pressed; a model whose last run failed writes no prose until it passes.
 */
const ModelCertRows = memo(function ModelCertRows({
  connected,
  offered,
}: {
  connected: boolean;
  /** The service offers the golden set, answers and recipes now (PLAN-48 T-240). */
  offered: boolean;
}) {
  const [rows, setRows] = useState<CertRow[]>([]);
  const [running, setRunning] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const view = (await api('/legal/model-cert', 'GET', undefined, { quiet: ['FORBIDDEN'] })) as {
        models: CertRow[];
      };
      setRows(view.models);
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);
  if (!connected || !rows.length) return null;
  return (
    <div className="services-cert">
      <small>
        {offered
          ? '답 문장을 쓸 모델(cLAWde 레시피 기준). 인증은 누를 때만 돌며 토큰을 씁니다.'
          : '서비스가 아직 이 기능을 제공하지 않습니다'}
      </small>
      <ul className="settings-rows">
        {rows.map((row) => {
          const key = `${row.provider}/${row.model}/${row.effort}`;
          const passed = row.cert && row.cert.passed === row.cert.total;
          return (
            <li key={key}>
              <strong>{`${row.model} · ${row.effort}`}</strong>
              <small>
                {row.cert
                  ? `${row.cert.passed}/${row.cert.total} 통과 · ${row.cert.at.slice(0, 10)}`
                  : '인증 전'}
              </small>
              {row.cert ? (
                <span className="pill" data-ok={String(!!passed)}>
                  {passed ? '인증됨' : '인증 실패 · 문장 쓰기 안 함'}
                </span>
              ) : null}
              <button
                type="button"
                disabled={!!running || !offered}
                onClick={() => {
                  setRunning(key);
                  setError('');
                  void api(
                    '/legal/model-cert',
                    'POST',
                    { provider: row.provider, model: row.model, effort: row.effort },
                    { quiet: ['FORBIDDEN', 'LEGAL_CERT_RUNNING'], timeoutMs: 60 * 60_000 },
                  )
                    .catch((failure) => {
                      const code = (failure as { code?: string } | null)?.code ?? '';
                      setError(
                        code === 'FORBIDDEN'
                          ? '모델 인증은 이 PC의 VIDE 창에서만 돌립니다.'
                          : code === 'LEGAL_CERT_RUNNING'
                            ? '다른 모델 인증이 돌고 있습니다.'
                            : '모델 인증을 마치지 못했습니다.',
                      );
                    })
                    .finally(() => {
                      setRunning('');
                      void load();
                    });
                }}
              >
                {running === key ? '인증 중…' : '모델 인증'}
              </button>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="remote-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
});

type Request = (path: string, method: 'GET' | 'PUT' | 'POST', data?: unknown) => Promise<View>;
type View = ServiceSettingsView;
const codeOf = (failure: unknown) => (failure as { code?: string } | null)?.code ?? '';

/**
 * One service card of the tab (Design 「외부 서비스 설정」, SCR-41): the name with a grey line, an
 * optional note on the right, the status pill; the card's fields and buttons below.
 */
function ServiceCard({
  id,
  name,
  note,
  aside,
  status,
  children,
}: {
  id: string;
  name: string;
  note?: string;
  aside?: ReactNode;
  status: { text: string; ok: boolean };
  children?: ReactNode;
}) {
  return (
    <div className="service-card" id={`${id}-card`}>
      <div className="service-card-head">
        <div className="service-card-name">
          <strong>{name}</strong>
          {note ? <small>{note}</small> : null}
        </div>
        {aside}
        <span id={`${id}-status`} className="pill" data-ok={String(status.ok)}>
          {status.text}
        </span>
      </div>
      {children}
    </div>
  );
}

/** The cLAWde card (SPEC-13.11, PLAN-46 T-217): behaviour as before the account cards. */
const ClawdeCard = memo(function ClawdeCard({
  view,
  request,
}: {
  view: ClawdeSettingsView | null;
  request: Request;
}) {
  const project = useStore(sessionState, (s) => s.project);
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const savedAddress = view?.baseUrl ?? '';
  useEffect(() => setAddress(savedAddress), [savedAddress]);
  const run = useCallback(
    async (path: string, method: 'GET' | 'PUT' | 'POST', data?: unknown) => {
      setBusy(true);
      setError('');
      try {
        const next = await request(path, method, data);
        setAddress(next.clawde.baseUrl ?? '');
        return true;
      } catch (failure) {
        setError(errorText[codeOf(failure)] ?? '설정을 저장하지 못했습니다.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [request],
  );

  const off = !!project && !!view?.projectsOff.includes(project.id);
  const status = view?.status;
  const features: Partial<ClawdeFeatures> = view?.features ?? {};
  const missing = featureText.filter(([key]) => features[key] === false).map(([, text]) => text);
  return (
    <ServiceCard
      id="clawde"
      name="cLAWde · 법규"
      aside={
        <small id="clawde-law-date">
          {view?.lawDbDate ? `법령 DB 기준일 ${view.lawDbDate}` : null}
        </small>
      }
      status={{ text: status ? statusText[status] : '…', ok: status === 'connected' }}
    >
      {view?.notReady ? (
        <small id="clawde-not-ready" role="status">
          서비스 준비 중 · 법령 DB를 아직 게시하지 않았습니다
        </small>
      ) : null}
      {missing.length && status === 'connected' ? (
        <small id="clawde-features" role="status">
          {`서비스가 아직 제공하지 않는 기능: ${missing.join(' · ')}. 조항 보기·검색은 됩니다.`}
        </small>
      ) : null}
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
      <ModelCertRows
        connected={status === 'connected'}
        offered={features.golden !== false && features.ask !== false && features.recipes !== false}
      />
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
    </ServiceCard>
  );
});

/** The account pill (Design SCR-41): 연결됨 · 권한 부족 · 확인 실패 · 연결 안 됨 · 확인 전. */
const accountStatusText: Record<AccountStatus, string> = {
  connected: '연결됨',
  'scope-missing': '권한 부족',
  unreachable: '확인 실패',
  // [끊기]·꺼 둔 계정도 Design SCR-41의 다섯 말 안에서 '연결 안 됨'이다.
  off: '연결 안 됨',
  'not-configured': '연결 안 됨',
  unchecked: '확인 전',
};

/** '방금 확인' within a minute, else the time ('14:20') or the day and time on another day. */
export function checkedText(at: string | null, now = new Date()) {
  if (!at) return '';
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return '';
  if (Math.abs(now.getTime() - when.getTime()) < 60_000) return '방금';
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  return when.toDateString() === now.toDateString()
    ? time
    : `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${time}`;
}

/** The plain status line under the pill; the last check time is always last. */
export function githubLine(view: GithubSettingsView, now = new Date()) {
  const at = checkedText(view.checkedAt, now);
  const checked = at === '방금' ? '방금 확인' : `${at}에 확인`;
  switch (view.status) {
    case 'connected':
      return [
        '연결됨',
        view.login,
        view.scopesChecked ? '저장소 만들기 가능' : '세부 권한은 푸시할 때 확인',
        checked,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'scope-missing':
      return view.rejected
        ? `권한 부족 — 서비스가 이 토큰을 받지 않습니다. 저장은 했습니다 · ${checked}`
        : `권한 부족 — 저장소 만들기 권한이 없는 토큰입니다. 저장은 했습니다 · ${checked}`;
    case 'unreachable':
      return `확인 실패 — 서비스에 닿지 않습니다 · ${at === '방금' ? '방금' : at + '에'} 시도`;
    case 'unchecked':
      return '확인 전 · [연결]을 누르면 확인합니다';
    case 'off':
      return '연결 안 됨 · [연결]을 누르면 다시 씁니다';
    default:
      return '연결 안 됨';
  }
}

export function cloudflareLine(view: CloudflareSettingsView, now = new Date()) {
  const at = checkedText(view.checkedAt, now);
  const checked = at === '방금' ? '방금 확인' : `${at}에 확인`;
  switch (view.status) {
    case 'connected':
      return ['연결됨', view.accountName ? `계정 ${view.accountName}` : '', checked]
        .filter(Boolean)
        .join(' · ');
    case 'scope-missing':
      return `권한 부족 — 이 토큰으로 이 계정을 열 수 없습니다. 토큰과 계정 ID를 확인하세요 · ${checked}`;
    case 'unreachable':
      return `확인 실패 — 서비스에 닿지 않습니다 · ${at === '방금' ? '방금' : at + '에'} 시도`;
    case 'unchecked':
      return '확인 전 · [연결]을 누르면 확인합니다';
    case 'off':
      return '연결 안 됨 · [연결]을 누르면 다시 씁니다';
    default:
      return view.token.set && !view.accountId ? '연결 안 됨 · 계정 ID를 넣으세요' : '연결 안 됨';
  }
}

const accountErrorText: Record<string, string> = {
  ACCOUNT_NOT_CONNECTED: '토큰을 먼저 넣으세요.',
  INVALID_INPUT: '넣은 값의 형식이 맞지 않습니다.',
  FORBIDDEN: '외부 서비스 계정은 이 PC의 VIDE 창에서만 바꿀 수 있습니다.',
  SECRETS_UNAVAILABLE: '이 PC의 비밀 저장소를 열지 못했습니다.',
};
const accountQuiet = Object.keys(accountErrorText);

/**
 * A card for one of the user's own accounts (SPEC-05.11, Design SCR-41): the token (and for
 * Cloudflare the account ID), [연결] = save what was typed and check once, [끊기] = forget. A
 * remote session sees the status line only. A saved token never comes back to the page.
 */
const AccountCard = memo(function AccountCard({
  service,
  view,
  request,
  remote,
}: {
  service: AccountService;
  view: View | null;
  request: Request;
  remote: boolean;
}) {
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const github = service === 'github';
  const own = view ? (github ? view.github : view.cloudflare) : null;
  const line = view ? (github ? githubLine(view.github) : cloudflareLine(view.cloudflare)) : '';
  const idSet = !github && !!view?.cloudflare.accountId;
  const typed = !!token.trim() || (!github && !!accountId.trim());
  const ready = typed || (!!own?.token.set && (github || idSet));
  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      if (typed)
        await request('', 'PUT', {
          [service]: {
            ...(token.trim() ? { token: token.trim() } : {}),
            ...(!github && accountId.trim() ? { accountId: accountId.trim() } : {}),
          },
        });
      setToken('');
      setAccountId('');
      await request(`/${service}/check`, 'POST');
    } catch (failure) {
      const code = codeOf(failure);
      setError(
        code === 'INVALID_INPUT' && !github
          ? '계정 ID 형식이 맞지 않습니다(32자리 영문·숫자).'
          : code === 'ACCOUNT_NOT_CONNECTED' && !github
            ? '토큰과 계정 ID를 모두 넣으세요.'
            : (accountErrorText[code] ?? '연결하지 못했습니다.'),
      );
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    setError('');
    try {
      await request(`/${service}/disconnect`, 'POST');
      setToken('');
      setAccountId('');
    } catch (failure) {
      setError(accountErrorText[codeOf(failure)] ?? '끊지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  const status = own?.status;
  return (
    <ServiceCard
      id={service}
      name={github ? 'GitHub · 작업 폴더 이력' : 'Cloudflare · 보고용 게시'}
      note={
        github
          ? '작업 폴더의 저장점을 내 저장소에 올립니다'
          : '보고용 산출물을 내 계정에 비밀번호와 함께 올립니다'
      }
      status={{ text: status ? accountStatusText[status] : '…', ok: status === 'connected' }}
    >
      <p id={`${service}-line`} className="service-card-line" role="status">
        {line}
      </p>
      {remote ? null : (
        <form
          className="services-form"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <label>
            <span>{github ? '개인 접근 토큰' : 'API 토큰'}</span>
            <input
              id={`${service}-token`}
              type="password"
              autoComplete="off"
              placeholder={own?.token.set ? '설정됨 · 다시 넣으면 바뀝니다' : ''}
              value={token}
              disabled={busy}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          {github ? null : (
            <label>
              <span>계정 ID</span>
              <input
                id="cloudflare-account"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={idSet ? '설정됨 · 다시 넣으면 바뀝니다' : ''}
                value={accountId}
                disabled={busy}
                onChange={(event) => setAccountId(event.target.value)}
              />
            </label>
          )}
          <small className="service-card-hint">
            {github
              ? '토큰은 GitHub → Settings → Developer settings → Personal access tokens에서 만듭니다'
              : '토큰은 Cloudflare → My Profile → API Tokens에서 만듭니다'}
          </small>
          <div className="settings-actions">
            <button id={`${service}-connect`} type="submit" disabled={busy || !ready}>
              {busy ? '확인 중…' : '연결'}
            </button>
            <button
              id={`${service}-disconnect`}
              type="button"
              disabled={busy || !(own?.token.set || idSet)}
              onClick={() => void disconnect()}
            >
              끊기
            </button>
          </div>
        </form>
      )}
      {error ? (
        <p className="remote-error" role="alert">
          {error}
        </p>
      ) : null}
    </ServiceCard>
  );
});

export const ServicesSection = memo(function ServicesSection() {
  const tab = useStore(statusState, (s) => s.tab);
  const remote = useStore(statusState, (s) => s.remote);
  const [view, setView] = useState<View | null>(null);
  const request = useCallback<Request>(async (path, method, data) => {
    const next = serviceSettingsViewSchema.parse(
      await api('/settings/services' + path, method, data, {
        quiet: [...new Set([...quiet, ...accountQuiet])],
      }),
    );
    setView(next);
    return next;
  }, []);
  useEffect(() => {
    if (tab === 'services' && sessionState.ready) void request('', 'GET').catch(() => {});
  }, [tab, request]);

  return (
    <section className="services-settings remote-panel">
      <h3>외부 서비스</h3>
      <small>
        법규 Q&A는 cLAWde 서비스에 묻습니다. 보낼 정보는 질문할 때 확인하며, 토큰은 이 PC에만
        암호화해 둡니다. 아래 계정은 이 PC에만 암호화해 두고, 푸시·게시는 단추를 누를 때만 합니다.
      </small>
      <div className="service-cards">
        <ClawdeCard view={view?.clawde ?? null} request={request} />
        <AccountCard service="github" view={view} request={request} remote={remote} />
        <AccountCard service="cloudflare" view={view} request={request} remote={remote} />
      </div>
    </section>
  );
});

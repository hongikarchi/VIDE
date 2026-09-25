import { useEffect, useState } from 'react';
import { z } from 'zod';
import { api } from './gateway.ts';
import { providers } from '../contracts/ai-settings.ts';
import type { Provider } from '../contracts/ai-settings.ts';
const schema = z.object({
  profiles: z.array(z.object({ id: z.string(), provider: z.enum(providers), label: z.string() })),
  active: z.record(z.string(), z.string()),
  pending: z.record(z.string(), z.string().nullable()),
});
const loginSchema = z.array(
  z.object({
    provider: z.enum(providers),
    profileId: z.string(),
    state: z.enum(['running', 'stopping', 'succeeded', 'failed', 'cancelled']),
    reason: z.string().optional(),
  }),
);
const loginLabels = {
  running: '브라우저에서 인증하세요',
  stopping: '로그인 종료 확인 중',
  succeeded: '로그인 확인됨',
  failed: '로그인 실패 · 다시 시도하세요',
  cancelled: '로그인 취소됨',
};
export function AccountSettings({ provider }: { provider: Provider }) {
  const [data, setData] = useState<z.infer<typeof schema>>();
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState('');
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<z.infer<typeof loginSchema>[number]>();
  const loggingIn = login?.state === 'running' || login?.state === 'stopping';
  const refresh = async () => setData(schema.parse(await api('/accounts')));
  useEffect(() => {
    let alive = true;
    void api('/accounts')
      .then((value) => {
        if (alive) setData(schema.parse(value));
      })
      .catch(() => {
        if (alive) setMessage('계정 목록을 불러오지 못했습니다.');
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const statuses = loginSchema.parse(await api('/accounts/login'));
        if (alive) setLogin(statuses.find((row) => row.provider === provider));
      } catch {
        if (alive) setMessage('로그인 상태를 확인하지 못했습니다. 새로고침하세요.');
      }
      if (alive) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [provider]);
  const action = async (task: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await task();
      await refresh();
      window.dispatchEvent(new Event('vide-accounts-changed'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '계정 작업 실패');
    } finally {
      setBusy(false);
    }
  };
  const rows = [
    { id: 'default', label: '기존 CLI 로그인' },
    ...(data?.profiles.filter((p) => p.provider === provider) ?? []),
  ];
  return (
    <div className="account-settings">
      <h4>구독 계정</h4>
      {rows.map((row) => (
        <div key={row.id}>
          <span>
            {row.label} {data?.active[provider] === row.id ? '· 선택됨' : ''}{' '}
            {data?.pending[provider] === row.id ? '· 전환 대기' : ''}
          </span>
          <button
            disabled={busy || loggingIn}
            onClick={() =>
              void action(async () => {
                await api('/accounts/select', 'POST', { provider, id: row.id });
              })
            }
          >
            선택
          </button>
          {row.id !== 'default' && (
            <>
              <button
                disabled={busy || loggingIn}
                onClick={() =>
                  void action(async () => {
                    const result = await api('/accounts/login', 'POST', { provider, id: row.id });
                    setLogin(loginSchema.parse([result])[0]);
                  })
                }
              >
                로그인
              </button>
              {login?.profileId === row.id && (
                <small role="status">{loginLabels[login.state]}</small>
              )}
              {login?.profileId === row.id && loggingIn && (
                <button
                  disabled={busy || login.state === 'stopping'}
                  onClick={() =>
                    void action(async () => {
                      const result = loginSchema.parse(
                        await api('/accounts/login/cancel', 'POST', { provider }),
                      );
                      setLogin(result.find((row) => row.provider === provider));
                    })
                  }
                >
                  로그인 취소
                </button>
              )}
              <button
                disabled={busy || loggingIn}
                onClick={() =>
                  void action(async () => {
                    const result = z
                      .object({ command: z.string() })
                      .parse(
                        await api('/accounts/login-command', 'POST', { provider, id: row.id }),
                      );
                    setCommand(result.command);
                  })
                }
              >
                로그인 방법
              </button>
            </>
          )}
        </div>
      ))}
      <input
        aria-label={`${provider} 계정 이름`}
        value={label}
        maxLength={80}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="계정 이름"
      />
      <button
        disabled={busy || !label.trim()}
        onClick={() =>
          void action(async () => {
            await api('/accounts', 'POST', { provider, label });
            setLabel('');
          })
        }
      >
        계정 추가
      </button>
      <button disabled={busy} onClick={() => void action(refresh)}>
        새로고침
      </button>
      {command && (
        <div>
          <p>새 PowerShell 창에서 실행한 뒤 이 계정을 선택하세요.</p>
          <textarea aria-label="공식 CLI 로그인 명령" readOnly value={command} />
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(command)
                .catch(() => setMessage('명령을 직접 선택해 복사하세요.'))
            }
          >
            명령 복사
          </button>
        </div>
      )}
      <small>사용량 미확인 · 자동 계정 전환 꺼짐</small>
      <p role="status">{message}</p>
    </div>
  );
}

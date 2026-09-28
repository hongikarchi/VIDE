import { AccountSettings } from './account-settings.tsx';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, errors } from './gateway.ts';
import {
  aiSettingsSchema,
  aiSettingsResponseSchema,
  providerStatusSchema,
  providers,
} from '../contracts/ai-settings.ts';
import type { AiSettingsResponse, ProviderStatus, Provider } from '../contracts/ai-settings.ts';

const errorLabels: Record<string, string> = errors;
const dialog = document.createElement('dialog');
dialog.className = 'quantity-dialog ai-settings';
dialog.setAttribute('aria-label', 'AI 연결 설정');
document.body.append(dialog);
const root = createRoot(dialog);
let generation = 0;
interface Props {
  config: AiSettingsResponse;
  current: number;
  onStatus?: (rows: ProviderStatus) => void;
}
function Settings({ config, current, onStatus }: Props) {
  const [revision, setRevision] = useState(config.revision);
  const [paths, setPaths] = useState(config.paths);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState('');
  const [states, setStates] = useState<Partial<Record<Provider, string>>>({});
  const isCurrent = () => current === generation;
  const close = () => {
    generation++;
    dialog.close();
    root.render(null);
  };
  const verify = async () => {
    setChecking(true);
    try {
      const rows = providerStatusSchema.parse(await api('/providers'));
      if (!isCurrent()) return;
      setStates(
        Object.fromEntries(
          rows.map((row) => [
            row.id,
            row.available
              ? '구독 로그인 확인됨'
              : errorLabels[row.reason ?? ''] || '로그인 또는 실행 상태를 확인하세요.',
          ]),
        ),
      );
      onStatus?.(rows);
    } catch (error) {
      if (isCurrent())
        setStatus(error instanceof Error ? error.message : '연결을 확인하지 못했습니다.');
    } finally {
      if (isCurrent()) setChecking(false);
    }
  };
  useEffect(() => {
    void verify();
  }, []);
  useEffect(() => {
    const cancel = (event: Event) => {
      event.preventDefault();
      if (!saving) close();
    };
    dialog.addEventListener('cancel', cancel);
    return () => dialog.removeEventListener('cancel', cancel);
  }, [saving]);
  const save = async () => {
    if (saving || checking) return;
    setSaving(true);
    try {
      const saved = aiSettingsSchema.parse(
        await api('/settings/ai', 'PUT', {
          revision,
          paths: Object.fromEntries(
            providers.map((provider) => [provider, paths[provider]?.trim() || null]),
          ),
        }),
      );
      if (!isCurrent()) return;
      setRevision(saved.revision);
      setStatus('설정을 저장했습니다. 다음 요청부터 적용됩니다.');
      await verify();
    } catch (error) {
      if (isCurrent())
        setStatus(error instanceof Error ? error.message : '설정을 저장하지 못했습니다.');
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };
  return (
    <>
      <div className="quantity-head">
        <h2>AI 계정 · 연결</h2>
        <button disabled={saving} onClick={close}>
          닫기
        </button>
      </div>
      <p className="ai-intro">
        요청은 이 PC에서 공식 Claude Code·Codex CLI가 구독 계정으로 실행합니다. 서비스마다 계정을
        여러 개 두고 골라 쓸 수 있습니다. 사용량과 자동 전환은 설정 → AI에서 봅니다.
      </p>
      {providers.map((provider) => {
        const label = provider === 'claude-cli' ? 'Claude Code' : 'Codex · ChatGPT';
        const connected = states[provider] === '구독 로그인 확인됨';
        return (
          <section key={provider} className="ai-provider">
            <div className="ai-provider-head">
              <h3>{label}</h3>
              <span className="pill" data-ok={String(connected)} role="status">
                {states[provider] || '연결 확인 전'}
              </span>
            </div>
            <AccountSettings provider={provider} />
            <details className="ai-advanced">
              <summary>고급 · 실행 파일 경로</summary>
              <input
                aria-label={`${label} 실행 경로`}
                disabled={saving}
                value={paths[provider] ?? ''}
                placeholder={config.resolved[provider] || '실행 파일 전체 경로'}
                onChange={(event) =>
                  setPaths((previous) => ({ ...previous, [provider]: event.target.value }))
                }
              />
              <small>비워 두면 설치된 CLI를 자동으로 찾습니다.</small>
            </details>
          </section>
        );
      })}
      <div className="table-controls">
        <button
          disabled={saving || checking}
          onClick={() => {
            void save();
          }}
        >
          설정 저장
        </button>
        <button
          disabled={saving || checking}
          onClick={() => {
            void verify();
          }}
        >
          연결 확인
        </button>
      </div>
      <p role="status">{status}</p>
      <small>로그인은 각 공식 CLI 창에서 진행합니다. 경로 변경은 다음 요청부터 적용됩니다.</small>
    </>
  );
}
export async function showAiSettings(onStatus?: (rows: ProviderStatus) => void): Promise<void> {
  const current = ++generation;
  const config = aiSettingsResponseSchema.parse(await api('/settings/ai'));
  if (current !== generation) return;
  root.render(<Settings key={current} config={config} current={current} onStatus={onStatus} />);
  if (!dialog.open) dialog.showModal();
}
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    generation++;
    root.unmount();
  }
});

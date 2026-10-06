// SettingsDialog (PLAN-26 T-113, region E): the settings dialog `.workspace-status-dialog`, one topic
// per tab: account, AI, connected programs, this program, status. Drawn from store/status.ts and the
// connection lines in store/session.ts; src/ui/workspace-status.ts is its controller (opening,
// closing, the tab, the actions). The account, usage, programs and PC program sections are rendered
// empty and filled by their panels (remote-panel, account-usage-panel, connectors-panel,
// desktop-panel), which own their content; React never gives those sections children.
import { memo, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { api } from '../gateway.ts';
import { useStore } from '../store/core.ts';
import { statusState, tabHidden, type SettingsTab } from '../store/status.ts';
import { sessionState } from '../store/session.ts';
import { ConnectionLines } from './status-lines.tsx';
import { problemNotices } from './status-bar.tsx';
import { TelemetrySection } from './telemetry.tsx';

const tabs: [SettingsTab, string][] = [
  ['account', '계정 · 원격 접속'],
  ['ai', 'AI'],
  ['programs', '연결 프로그램'],
  ['desktop', 'PC 프로그램'],
  ['status', '상태 · 오류'],
];

const TabButton = memo(function TabButton({ id, label }: { id: SettingsTab; label: string }) {
  const current = useStore(statusState, (s) => s.tab);
  const hidden = useStore(statusState, (s) => tabHidden(id, s));
  return (
    <button
      type="button"
      data-tab={id}
      aria-pressed={current === id}
      hidden={hidden}
      onClick={() => statusState.actions.show(id)}
    >
      {label}
    </button>
  );
});

const Pane = memo(function Pane({ id, children }: { id: SettingsTab; children: ReactNode }) {
  const current = useStore(statusState, (s) => s.tab);
  return (
    <div className="settings-pane" data-pane={id} hidden={current !== id}>
      {children}
    </div>
  );
});

/** The AI services as rows, read from the `#connection-status` line ("Claude 연결됨 · …"). */
const ProviderRows = memo(function ProviderRows() {
  const text = useStore(sessionState, (s) => s.connection.providersText);
  const rows = text.split(' · ').flatMap((part) => {
    const match = /^(Claude|ChatGPT) (.+)$/.exec(part);
    return match ? [[match[1]!, match[2]!] as const] : [];
  });
  return (
    <ul className="settings-rows">
      {rows.map(([name, state], index) => (
        <li key={index}>
          <strong>{name}</strong>
          <span className="pill" data-ok={String(state === '연결됨')}>
            {state}
          </span>
        </li>
      ))}
    </ul>
  );
});

const DisplaySection = memo(function DisplaySection() {
  const coverage = useStore(statusState, (s) => s.coverage);
  return (
    <section hidden={!coverage}>
      {coverage ? (
        <>
          <h3>현재 모델 표시</h3>
          <p>{`전체 ${coverage.total.toLocaleString()}개 · 화면 표시 ${coverage.displayed.toLocaleString()}개 · 표현 미지원 ${coverage.omitted.toLocaleString()}개`}</p>
          {coverage.omitted ? (
            <>
              <p>화면 표현 미지원 객체도 목록·네이티브 파일에 보존됩니다.</p>
              <small>
                {Object.entries(coverage.omittedTypes)
                  .map(([kind, count]) => `${kind} ${count.toLocaleString()}개`)
                  .join(' · ') || null}
              </small>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
});

// What went wrong recently and where to look: failed requests (open them for the cause and a retry)
// and this session's connection notices. Solved problems simply stop appearing.
const ProblemsSection = memo(function ProblemsSection() {
  useStore(statusState, (s) => s.version);
  useStore(sessionState, (s) => s.connection.auth);
  const failures = statusState.failures;
  const rows = problemNotices();
  return (
    <section>
      <h3>문제가 있었던 작업</h3>
      <small>
        실패했거나 결과를 확인하지 못한 요청입니다. 누르면 그 작업으로 이동해 원인과 다시 보내기를
        볼 수 있습니다. 목록에서 지우려면 작업 이력의 ×를 누르세요.
      </small>
      {!failures.length ? (
        <p className="usage-note">문제가 있었던 작업이 없습니다.</p>
      ) : (
        <ul className="settings-rows problem-list">
          {failures
            .slice(-20)
            .reverse()
            .map((row, index) => {
              const detail = [
                row.reason,
                row.code,
                row.at &&
                  new Date(row.at).toLocaleString('ko-KR', {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <li key={index}>
                  <div className="problem-text">
                    <strong>{(row.title ?? row.label) || null}</strong>
                    <small>{detail || null}</small>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      statusState.actions.close();
                      statusState.actions.openFailure(row.id);
                    }}
                  >
                    작업 보기
                  </button>
                </li>
              );
            })}
        </ul>
      )}
      {rows.length ? (
        <>
          <h3 className="problem-notices">이번 실행 중 알림</h3>
          <ul className="settings-rows problem-list">
            {rows.slice(-20).map((row, index) => (
              <li key={index}>{row || null}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
});

const bundleSchema = z.object({ file: z.string(), bytes: z.number().optional() }).passthrough();
const size = (bytes?: number) =>
  bytes === undefined
    ? ''
    : bytes < 1024 * 1024
      ? ` · ${Math.max(1, Math.round(bytes / 1024))} KB`
      : ` · ${(bytes / 1024 / 1024).toFixed(1)} MB`;

// [진단 묶음 내보내기] (T-126): the engine zips logs, exit records, versions and a settings summary
// under the data folder's diagnostics folder and answers the file's path. This PC only.
const DiagnosticsSection = memo(function DiagnosticsSection() {
  const [state, setState] = useState<
    { busy: true } | { file: string; bytes?: number } | { error: string } | null
  >(null);
  const [copied, setCopied] = useState(false);
  const busy = state !== null && 'busy' in state;
  return (
    <section className="settings-diagnostics">
      <h3>진단 묶음</h3>
      <small>
        문제를 알릴 때 보낼 파일을 만듭니다. 기록·종료 기록·버전·설정 요약을 묶고, 요청 글·파일
        내용·로그인 정보는 넣지 않습니다.
      </small>
      <div className="settings-actions">
        <button
          id="diagnostic-bundle"
          type="button"
          disabled={busy}
          onClick={async () => {
            setState({ busy: true });
            setCopied(false);
            try {
              const value = bundleSchema.parse(
                await api('/diagnostics/bundle', 'POST', {}, { quiet: ['FORBIDDEN'] }),
              );
              setState({ file: value.file, bytes: value.bytes });
            } catch (error) {
              setState({
                error:
                  (error as { code?: unknown } | null)?.code === 'FORBIDDEN'
                    ? '진단 묶음은 이 PC의 VIDE 창에서만 만들 수 있습니다.'
                    : '진단 묶음을 만들지 못했습니다. 잠시 뒤 다시 누르세요.',
              });
            }
          }}
        >
          {busy ? '만드는 중…' : '진단 묶음 내보내기'}
        </button>
      </div>
      {state && 'file' in state ? (
        <div className="diagnostic-file" role="status">
          <small>{`만들었습니다${size(state.bytes)}`}</small>
          <code>{state.file}</code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(state.file)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
          >
            {copied ? '복사됨' : '경로 복사'}
          </button>
        </div>
      ) : state && 'error' in state ? (
        <p className="usage-note" role="status">
          {state.error}
        </p>
      ) : null}
    </section>
  );
});

export const SettingsDialog = memo(function SettingsDialog() {
  return (
    <dialog className="workspace-status-dialog" aria-label="상태 및 설정">
      <div className="quantity-head">
        <h2>설정</h2>
        <button onClick={() => statusState.actions.close()}>닫기</button>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="설정 분류">
          {tabs.map(([id, label]) => (
            <TabButton key={id} id={id} label={label} />
          ))}
        </nav>
        <div className="settings-panes">
          <Pane id="account">
            <section className="remote-panel" />
          </Pane>
          <Pane id="ai">
            <section className="settings-ai">
              <h3>AI</h3>
              <small>
                요청은 이 PC에 로그인된 Claude·ChatGPT 구독 계정으로 실행됩니다. 모델은 입력창
                아래에서 고릅니다.
              </small>
              <ProviderRows />
              <div className="settings-actions">
                <button
                  id="ai-settings"
                  type="button"
                  onClick={() => {
                    statusState.actions.close();
                    statusState.actions.openAiSettings();
                  }}
                >
                  AI 연결 설정
                </button>
                <button
                  id="execution-limits"
                  type="button"
                  onClick={() => {
                    statusState.actions.close();
                    statusState.actions.openExecutionLimits();
                  }}
                >
                  AI 응답 대기 시간
                </button>
              </div>
            </section>
            <section />
          </Pane>
          <Pane id="programs">
            <section className="remote-panel" />
          </Pane>
          <Pane id="desktop">
            <section className="remote-panel" />
          </Pane>
          <Pane id="status">
            <section>
              <h3>연결 상태</h3>
              <ConnectionLines />
            </section>
            <DisplaySection />
            <ProblemsSection />
            <TelemetrySection />
            <DiagnosticsSection />
          </Pane>
        </div>
      </div>
    </dialog>
  );
});

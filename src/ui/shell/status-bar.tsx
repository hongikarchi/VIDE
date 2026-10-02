// StatusBar (PLAN-26 T-113, region E): the status bar, drawn from store/status.ts and the connection
// lines in store/session.ts. `#mode-status` (the composer writes its text), `#usage-bars`
// (usage-bars.ts fills it) and `#status-account` (account-indicator.ts fills it) are rendered without
// React children and are not re-rendered, so their outside writers own their content.
import { memo, useRef } from 'react';
import { useStore } from '../store/core.ts';
import { statusState } from '../store/status.ts';
import { sessionState } from '../store/session.ts';

const WorkspaceText = memo(function WorkspaceText() {
  return <span id="workspace-status">{useStore(statusState, (s) => s.workspaceText)}</span>;
});
const WorkCount = memo(function WorkCount() {
  const text = useStore(statusState, (s) => s.workCount);
  return <span id="work-count">{text || null}</span>;
});
const ProviderButton = memo(function ProviderButton() {
  const text = useStore(sessionState, (s) => s.connection.providersText);
  return (
    <button
      aria-label="AI 연결 상태"
      onClick={(event) =>
        statusState.actions.open(event.currentTarget, statusState.remote ? 'status' : 'ai')
      }
    >
      {text || 'AI · 확인 전'}
    </button>
  );
});
const HostButton = memo(function HostButton() {
  const text = useStore(sessionState, (s) => s.connection.hostText);
  return (
    <button
      aria-label="호스트 준비 상태"
      onClick={(event) => statusState.actions.open(event.currentTarget, 'status')}
    >
      {text.split(' · 문서 연결')[0] || '호스트 · 확인 전'}
    </button>
  );
});
const DisplayButton = memo(function DisplayButton() {
  const coverage = useStore(statusState, (s) => s.coverage);
  // The label keeps the last count while the button is hidden, as the old button did.
  const label = useRef('');
  if (coverage) label.current = `표시 미지원 ${coverage.omitted.toLocaleString()}`;
  return (
    <button
      aria-label="모델 표시 상태"
      hidden={!coverage || coverage.omitted === 0}
      onClick={(event) => statusState.actions.open(event.currentTarget, 'status')}
    >
      {label.current || null}
    </button>
  );
});
// The current account card (read only; accounts are managed in AccountSwitch, ADR-025).
const AccountButton = memo(function AccountButton() {
  return (
    <button
      id="status-account"
      aria-label="현재 AI 계정 보기"
      onClick={(event) =>
        statusState.actions.open(event.currentTarget, statusState.remote ? 'status' : 'ai')
      }
    />
  );
});
/** The problems the status tab lists: the lost-session line, this session's notices, failures. */
export function problemNotices() {
  const { auth } = sessionState.connection;
  const rows = [...new Set(statusState.notifications)];
  const authText = auth.text + (auth.link ? '프로젝트 목록에서 다시 열기' : '');
  if (!auth.hidden && authText) rows.unshift(authText);
  return rows;
}
const ProblemButton = memo(function ProblemButton() {
  useStore(statusState, (s) => s.version);
  useStore(sessionState, (s) => s.connection.auth);
  const count = problemNotices().length + statusState.failures.length;
  return (
    <button
      aria-label="오류 기록"
      data-error={String(count > 0)}
      onClick={(event) => statusState.actions.open(event.currentTarget, 'status')}
    >
      {`문제 ${count}`}
    </button>
  );
});

export const StatusBar = memo(function StatusBar() {
  return (
    <>
      <footer className="statusbar">
        <WorkspaceText />
        <WorkCount />
        <span id="mode-status">자동 · 열린 문서에 바로 적용</span>
        <span id="usage-bars" />
        <ProviderButton />
        <HostButton />
        <DisplayButton />
        <AccountButton />
        <ProblemButton />
      </footer>
    </>
  );
});

import { errors } from './gateway.ts';
import { createRoot } from 'react-dom/client';
import type { WorkSummary } from '../contracts/workspace.ts';

interface Draft {
  instructions?: string[];
}
interface RequestProps {
  state: Draft;
  onChange: (rebuild: boolean) => void;
}
function PendingRequests({ state, onChange }: RequestProps) {
  const items = state.instructions ?? [];
  if (!items.length) return <small>입력한 요청을 모아서 실행할 수 있습니다.</small>;
  return (
    <>
      {items.map((text, index) => (
        <div className="pending-request" key={index}>
          <textarea
            value={text}
            rows={1}
            aria-label={`요청 ${index + 1}`}
            onChange={(event) => {
              items[index] = event.target.value;
              onChange(false);
              renderRequests(state, onChange);
            }}
          />
          <button
            aria-label={`요청 ${index + 1} 삭제`}
            onClick={() => {
              items.splice(index, 1);
              onChange(true);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </>
  );
}
interface ActiveProps {
  messages: WorkSummary[];
  reason?: (id: string) => string | undefined;
  intervene?: (id: string) => void;
}
function ActiveWork({ messages, reason, intervene }: ActiveProps) {
  const active = messages.filter(
    (message) =>
      message.request &&
      ['queued', 'running', 'unknown', 'interrupted'].includes(message.request.state),
  );
  if (!active.length) return <>진행 중인 작업 없음</>;
  return (
    <>
      {active.map((message) => {
        const request = message.request!;
        const phase =
          request.state === 'unknown'
            ? '호스트 결과 확인 필요 · 새 후보 보류'
            : request.state === 'interrupted'
              ? errors[request.result?.code || ''] || '연결 종료로 중단됨 · 자동 재실행 없음'
              : request.state === 'queued'
                ? request.result?.phase === 'waiting'
                  ? '추가 지시 접수 · 이전 작업 종료 대기'
                  : '대기'
                : request.result?.phase === 'host'
                  ? '호스트 생성·저장 검증'
                  : request.result?.phase === 'stopping'
                    ? '중단 확인 중'
                    : request.result?.phase === 'query'
                      ? '호스트 조회 완료 · 다음 단계 처리'
                      : request.result?.phase === 'starting-host'
                        ? '작업 사본 준비'
                        : 'AI 요청 처리';
        return (
          <div key={message.id}>
            <strong>{message.body || '첨부 문맥 검토'}</strong>
            <small>{phase}</small>
            {request.result?.progress && (
              <small>
                조회 {request.result.progress.queries}회
                {request.result.progress.attempts > 0 &&
                  ` · 실행 ${request.result.progress.attempts}/12 · 사본 저장 검증 ${request.result.progress.completed}단계`}
              </small>
            )}
            {intervene &&
              ['queued', 'running'].includes(request.state) &&
              request.result?.phase !== 'waiting' && (
                <button
                  disabled={!!reason?.(message.id)}
                  title={
                    reason?.(message.id) ||
                    '현재 입력을 추가하고 이전 작업 종료 후 원 기준에서 다시 실행합니다.'
                  }
                  onClick={() => intervene(message.id)}
                >
                  추가 지시
                </button>
              )}
          </div>
        );
      })}
    </>
  );
}
function mount(id: string) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing panel: ${id}`);
  return createRoot(element);
}
const pendingRoot = mount('pending-requests');
const activeRoot = mount('active-work');
const countRoot = mount('request-count');
export function renderRequests(state: Draft, onChange: (rebuild: boolean) => void): void {
  countRoot.render(String(state.instructions?.length ?? 0));
  pendingRoot.render(<PendingRequests state={state} onChange={onChange} />);
}
export function renderActiveWork(
  messages: WorkSummary[],
  reason?: ActiveProps['reason'],
  intervene?: ActiveProps['intervene'],
): void {
  activeRoot.render(<ActiveWork messages={messages} reason={reason} intervene={intervene} />);
}
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    pendingRoot.unmount();
    activeRoot.unmount();
    countRoot.unmount();
  }
});

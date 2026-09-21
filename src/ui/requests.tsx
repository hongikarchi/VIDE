import { createRoot } from 'react-dom/client';
import type { WorkSummary } from '../contracts/workspace.ts';

interface Draft { instructions?: string[] }
interface RequestProps { state: Draft; onChange: (rebuild: boolean) => void }
function PendingRequests({ state, onChange }: RequestProps) {
  const items = state.instructions ?? [];
  if (!items.length) return <small>입력한 요청을 모아서 실행할 수 있습니다.</small>;
  return <>{items.map((text, index) => <div className="pending-request" key={index}>
    <textarea value={text} rows={1} aria-label={`요청 ${index + 1}`} onChange={event => {
      items[index] = event.target.value;
      onChange(false);
      renderRequests(state, onChange);
    }} />
    <button aria-label={`요청 ${index + 1} 삭제`} onClick={() => {
      items.splice(index, 1); onChange(true);
    }}>×</button>
  </div>)}</>;
}
function ActiveWork({ messages }: { messages: WorkSummary[] }) {
  const active = messages.filter(message => message.request && ['queued', 'running', 'unknown', 'interrupted'].includes(message.request.state));
  if (!active.length) return <>진행 중인 작업 없음</>;
  return <>{active.map(message => {
    const request = message.request!;
    const phase = request.state === 'unknown' ? '호스트 결과 확인 필요 · 새 후보 보류'
      : request.state === 'interrupted' ? '연결 종료로 중단됨 · 자동 재실행 없음'
      : request.state === 'queued' ? '대기'
      : request.result?.phase === 'host' ? '호스트 생성·저장 검증'
      : request.result?.phase === 'stopping' ? '중단 확인 중' : 'AI 요청 처리';
    return <div key={message.id}><strong>{message.body || '첨부 문맥 검토'}</strong><small>{phase}</small></div>;
  })}</>;
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
export function renderActiveWork(messages: WorkSummary[]): void {
  activeRoot.render(<ActiveWork messages={messages} />);
}
window.addEventListener('pagehide', event => {
  if (!event.persisted) { pendingRoot.unmount(); activeRoot.unmount(); countRoot.unmount(); }
});

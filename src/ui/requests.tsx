import { createRoot } from 'react-dom/client';

interface Draft {
  instructions?: string[];
}
interface RequestProps {
  state: Draft;
  onChange: (rebuild: boolean) => void;
}
function PendingRequests({ state, onChange }: RequestProps) {
  const items = state.instructions ?? [];
  if (!items.length) return null;
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
function mount(id: string) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing panel: ${id}`);
  return createRoot(element);
}
const pendingRoot = mount('pending-requests');
const countRoot = mount('request-count');
export function renderRequests(state: Draft, onChange: (rebuild: boolean) => void): void {
  countRoot.render(String(state.instructions?.length ?? 0));
  pendingRoot.render(<PendingRequests state={state} onChange={onChange} />);
}
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    pendingRoot.unmount();
    countRoot.unmount();
  }
});

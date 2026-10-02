// The request queue under the work view (`#pending-requests`, PLAN-26 T-113): the extra requests
// added with [+] that go along when the composer sends. Rendered by the AI column
// (src/ui/shell/right-column.tsx) from the work slice's `queue`.
interface Draft {
  instructions?: string[];
}
interface RequestProps {
  state: Draft;
  /** `render(rebuild)` of the app; a text edit passes false and the queue redraws itself. */
  onChange: (rebuild: boolean) => void;
  /** Redraws the queue after a text edit (the textarea is controlled). */
  onEdited: () => void;
}
export function PendingRequests({ state, onChange, onEdited }: RequestProps) {
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
              onEdited();
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

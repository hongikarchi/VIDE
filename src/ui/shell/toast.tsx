// Toast (PLAN-26 T-113, region E): the single notice slot `#message`, drawn from store/toast.ts
// (src/ui/app/status.ts writes it). A notice with actions is its text, one space, then one
// `.message-action` button per action; a button hides the notice before it runs its action.
import { memo } from 'react';
import { useStore } from '../store/core.ts';
import { toastState } from '../store/toast.ts';

export const Toast = memo(function Toast() {
  useStore(toastState, (s) => s.version);
  const { text, hidden, actions, generation } = toastState;
  return (
    <div id="message" className="toast" role="status" hidden={hidden}>
      {actions ? (
        <>
          {text + ' '}
          {actions.map(({ label, run }, index) => (
            <button
              key={`${generation}-${index}`}
              type="button"
              className="message-action"
              onClick={() => {
                toastState.hidden = true;
                toastState.bump();
                run();
              }}
            >
              {label}
            </button>
          ))}
        </>
      ) : (
        text || null
      )}
    </div>
  );
});

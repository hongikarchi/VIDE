// Status lines (PLAN-26 T-113, region E): the three status lines `#connection-status`,
// `#host-status` and `#auth-status`, drawn from store/session.ts. They live in the settings dialog's
// status tab (shell/settings-dialog.tsx renders them there; before the move they sat in #left and
// were moved at start).
import { memo } from 'react';
import { useStore } from '../store/core.ts';
import { sessionState } from '../store/session.ts';

/** The lines themselves, in the status tab's connection section. */
export const ConnectionLines = memo(function ConnectionLines() {
  const providers = useStore(sessionState, (s) => s.connection.providersText);
  const host = useStore(sessionState, (s) => s.connection.hostText);
  const auth = useStore(sessionState, (s) => s.connection.auth);
  return (
    <>
      <p className="preview-info" id="connection-status">
        {providers || null}
      </p>
      <p className="preview-info" id="host-status">
        {host || null}
      </p>
      <p className="preview-info" id="auth-status" role="status" hidden={auth.hidden}>
        {auth.link ? (
          <>
            {auth.text || null}
            <a href="/">프로젝트 목록에서 다시 열기</a>
          </>
        ) : (
          auth.text || null
        )}
      </p>
    </>
  );
});

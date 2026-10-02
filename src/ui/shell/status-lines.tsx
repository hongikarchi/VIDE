// StatusLines (PLAN-26 T-113, region E): the three status lines; src/ui/workspace-status.ts moves
// them into the settings dialog's status tab at start. Static markup moved from index.html; it has
// no state or props and never re-renders until its region makes it stateful. Because the lines leave
// #left, they must never be the top host nodes a boundary or a conditional removes (React would call
// removeChild on #left and throw); they stay nested inside LeftPanel's <aside>, whose own removal
// does not touch them.
import { memo } from 'react';

export const StatusLines = memo(function StatusLines() {
  return (
    <>
      <p className="preview-info" id="connection-status">
        연결 확인 중
      </p>
      <p className="preview-info" id="host-status" />
      <p className="preview-info" id="auth-status" role="status" hidden />
    </>
  );
});

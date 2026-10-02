// StatusBar (PLAN-26 T-113, region E): the status bar (src/ui/workspace-status.ts appends its
// buttons). Static markup moved from index.html; it has no state or props and never re-renders
// until its region makes it stateful.
import { memo } from 'react';

export const StatusBar = memo(function StatusBar() {
  return (
    <>
      <footer className="statusbar">
        <span id="workspace-status">작업 공간 연결 중</span>
        <span id="work-count" />
        <span id="mode-status">자동 · 열린 문서에 바로 적용</span>
        <span id="usage-bars" />
      </footer>
    </>
  );
});

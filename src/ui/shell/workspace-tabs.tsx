// WorkspaceTabs (PLAN-26 T-113, region A): the workspace tab row (filled by src/ui/workspaces.ts).
// Static markup moved from index.html; it has no state or props and never re-renders until its
// region makes it stateful.
import { memo } from 'react';

export const WorkspaceTabs = memo(function WorkspaceTabs() {
  return <div className="workspace-tabs" id="workspace-tabs" />;
});

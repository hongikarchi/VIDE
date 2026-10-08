// The work screen's shell (PLAN-26 T-113, ARCH-01 「웹 화면 구조」): the regions in the order the old
// index.html had them. main.tsx mounts it once, synchronously, before src/ui/app.ts starts; it is
// never unmounted. Each region sits in its own RegionBoundary, so one region's render error does not
// unmount the rest. The whitespace text nodes are the old markup's, kept so the DOM stays the same.
// `.workspace` and `.viewport-area` also hold children other modules append (jig screens, tab
// screens, panel width handles): React renders only the static children it owns there.
import { memo } from 'react';
import { MobileNavigationShell } from './mobile-navigation-shell.tsx';
import { Rail } from './rail.tsx';
import { LeftPanel } from './left-panel.tsx';
import { WorkspaceTabs } from './workspace-tabs.tsx';
import { ViewportArea } from './viewport-area.tsx';
import { Inspector } from './inspector.tsx';
import { RightColumn } from './right-column.tsx';
import { StatusBar } from './status-bar.tsx';
import { Toast } from './toast.tsx';
import { SettingsDialog } from './settings-dialog.tsx';
import { AccountPopover } from './account-button.tsx';
import { RegionBoundary } from './region-boundary.tsx';
import { TelemetryCards } from './telemetry.tsx';

export const Shell = memo(function Shell() {
  return (
    <>
      {'\n\n'}
      <RegionBoundary name="mobile-navigation">
        <MobileNavigationShell />
      </RegionBoundary>
      {'\n'}
      <div className="app-shell">
        <RegionBoundary name="rail">
          <Rail />
        </RegionBoundary>
        <main>
          <RegionBoundary name="left">
            <LeftPanel />
          </RegionBoundary>
          {'\n'}
          <section className="workspace">
            <RegionBoundary name="workspace-tabs">
              <WorkspaceTabs />
            </RegionBoundary>
            <RegionBoundary name="viewport">
              <ViewportArea />
            </RegionBoundary>
            <RegionBoundary name="inspector">
              <Inspector />
            </RegionBoundary>
          </section>
          {'\n'}
          <RegionBoundary name="right">
            <RightColumn />
          </RegionBoundary>
        </main>
      </div>
      <RegionBoundary name="status-bar">
        <StatusBar />
      </RegionBoundary>
      <RegionBoundary name="toast">
        <Toast />
      </RegionBoundary>
      {'\n\n'}
      <RegionBoundary name="settings">
        <SettingsDialog />
      </RegionBoundary>
      <RegionBoundary name="account">
        <AccountPopover />
      </RegionBoundary>
      <RegionBoundary name="telemetry">
        <TelemetryCards />
      </RegionBoundary>
    </>
  );
});

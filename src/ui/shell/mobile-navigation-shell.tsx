// MobileNavigationShell (PLAN-26 T-113, region A): the mobile tab bar (below 850 px); its buttons
// are the MobileNavigation component, in its own boundary so a failure empties only this bar as the
// old separate root did. The VIDE account row (SCR-34) ends the bar. Static markup moved from index.html; it has no state or props
// and never re-renders until its region makes it stateful.
import { memo } from 'react';
import { MobileNavigation } from '../mobile-navigation.tsx';
import { RegionBoundary } from './region-boundary.tsx';
import { MobileAccountButton } from './account-button.tsx';

export const MobileNavigationShell = memo(function MobileNavigationShell() {
  return (
    <div className="mobile-tabs" id="mobile-navigation">
      <RegionBoundary name="mobile-navigation-buttons">
        <MobileNavigation />
      </RegionBoundary>
      <MobileAccountButton />
    </div>
  );
});

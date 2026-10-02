// EdgeToggles (PLAN-26 T-113, region A): the edge toggles that fold the side panels. Static markup
// moved from index.html; it has no state or props and never re-renders until its region makes it
// stateful.
import { memo } from 'react';

export const EdgeToggles = memo(function EdgeToggles() {
  return (
    <>
      <button
        className="edge-toggle edge-left"
        id="toggle-left"
        aria-label="문서 패널 접기/펼치기"
        aria-expanded="true"
        title="문서 · Alt+Shift+L"
      >
        ‹
      </button>
      <button
        className="edge-toggle edge-right"
        id="toggle-right"
        aria-label="작업 패널 접기/펼치기"
        aria-expanded="true"
        title="작업 · Alt+Shift+R"
      >
        ›
      </button>
    </>
  );
});

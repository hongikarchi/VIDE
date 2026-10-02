// EdgeToggles (PLAN-26 T-113, region A): the edge toggles that fold the side panels. They show the
// layout slice's folded state; a click folds or unfolds (src/ui/store/layout.ts togglePanel).
import { memo } from 'react';
import { useStore } from '../store/core.ts';
import { layoutState, togglePanel } from '../store/layout.ts';

export const EdgeToggles = memo(function EdgeToggles() {
  const leftFolded = useStore(layoutState, (s) => s.leftFolded);
  const rightFolded = useStore(layoutState, (s) => s.rightFolded);
  return (
    <>
      <button
        className="edge-toggle edge-left"
        id="toggle-left"
        aria-label="문서 패널 접기/펼치기"
        aria-expanded={String(!leftFolded) as 'true' | 'false'}
        title="문서 · Alt+Shift+L"
        onClick={() => togglePanel('left')}
      >
        {leftFolded ? '›' : '‹'}
      </button>
      <button
        className="edge-toggle edge-right"
        id="toggle-right"
        aria-label="작업 패널 접기/펼치기"
        aria-expanded={String(!rightFolded) as 'true' | 'false'}
        title="작업 · Alt+Shift+R"
        onClick={() => togglePanel('right')}
      >
        {rightFolded ? '‹' : '›'}
      </button>
    </>
  );
});

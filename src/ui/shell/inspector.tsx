// Inspector (PLAN-26 T-113, region B): the object inspector under the 3D view, drawn from the viewer
// slice. paintInspector() (src/ui/app/viewport.ts) builds what it shows; the open state, the tab
// buttons and the height handle are this component's. The header bar toggles the panel (the chevron
// button is its keyboard target, so only the bar listens).
import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../store/core.ts';
import { viewerState } from '../store/viewer.ts';
import { InspectorContent } from '../inspector-content.tsx';
import type { InspectorTab } from '../inspector.ts';
import { PartBoundary } from './part-boundary.tsx';
import { viewportActions as act } from './viewport-actions.ts';

const TABS: [InspectorTab, string][] = [
  ['properties', '속성'],
  ['geometry', '형상'],
  ['relations', '관계'],
  ['history', '이력'],
];

function toggleOpen() {
  viewerState.inspectorOpen = !viewerState.inspectorOpen;
  try {
    localStorage.setItem('vide:inspector-open', String(viewerState.inspectorOpen));
  } catch {
    /* Per-viewer convenience only. */
  }
  viewerState.bump();
}

export const Inspector = memo(function Inspector() {
  useStore(viewerState, (s) => s.version);
  const { inspectorOpen: open, inspectorTab, selectionTitle, inspector } = viewerState;
  const section = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Until a tab is clicked only the first tab carries a pressed state (as the old markup did).
  const [clicked, setClicked] = useState(false);
  const [size, setSize] = useState<{ height: number; max: number }>();
  const drag = useRef<{ y: number; height: number } | null>(null);
  const wasCollapsed = useRef(false);
  if (!open) wasCollapsed.current = true;
  const key = inspector?.key;
  useLayoutEffect(() => {
    if (key !== undefined && content.current) content.current.scrollTop = 0;
  }, [key]);
  const resize = (height: number) => {
    const max = Math.max(
      120,
      Math.min(480, (document.querySelector<HTMLElement>('.workspace')?.clientHeight ?? 640) - 160),
    );
    setSize({ height: Math.min(max, Math.max(120, height)), max });
  };
  return (
    <>
      <section
        id="inspector"
        aria-label="객체 속성"
        ref={section}
        // As the old classList.toggle: no class attribute until the panel was first collapsed.
        className={open ? (wasCollapsed.current ? '' : undefined) : 'collapsed'}
        // The page CSP blocks inline style attributes; React sets this through the CSSOM.
        style={size ? ({ '--inspector-height': size.height + 'px' } as CSSProperties) : undefined}
      >
        <div
          id="inspector-resize"
          role="separator"
          aria-label="객체 속성 높이"
          aria-orientation="horizontal"
          aria-valuemin={120}
          aria-valuemax={size?.max ?? 480}
          aria-valuenow={size ? Math.round(size.height) : 182}
          tabIndex={0}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            drag.current = { y: e.clientY, height: section.current?.clientHeight ?? 0 };
            e.currentTarget.setPointerCapture(e.pointerId);
            e.preventDefault();
          }}
          onPointerMove={(e) => {
            if (drag.current) resize(drag.current.height + drag.current.y - e.clientY);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(e) => {
            if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
              e.preventDefault();
              resize(
                e.key === 'Home'
                  ? 120
                  : e.key === 'End'
                    ? 480
                    : (section.current?.clientHeight ?? 0) + (e.key === 'ArrowUp' ? 20 : -20),
              );
            }
          }}
        />
        <div className="inspector-head" title="객체 속성 열기/닫기" onClick={toggleOpen}>
          <button
            id="inspector-toggle"
            aria-label="객체 속성 접기/펼치기"
            aria-expanded={String(open) as 'true' | 'false'}
          />
          <strong id="selection">{selectionTitle}</strong>
          <span id="selection-kind">{inspector?.kind ?? ''}</span>
        </div>
        <div className="inspector-body">
          <nav aria-label="객체 정보">
            {TABS.map(([tab, label]) => (
              <button
                key={tab}
                data-inspect={tab}
                aria-pressed={tab === inspectorTab ? 'true' : clicked ? 'false' : undefined}
                onClick={() => {
                  setClicked(true);
                  act.inspectorTab(tab);
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <div id="inspector-content" ref={content}>
            {/* The old #inspector-content root: a render error empties only this container. */}
            <PartBoundary name="inspector-content" reset={viewerState.version}>
              <InspectorContent {...(inspector?.content ?? { empty: true })} />
            </PartBoundary>
          </div>
        </div>
      </section>
    </>
  );
});

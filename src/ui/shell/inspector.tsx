// Inspector (PLAN-26 T-113, region B): the object inspector under the 3D view. Static markup moved
// from index.html; it has no state or props and never re-renders until its region makes it
// stateful.
import { memo } from 'react';

export const Inspector = memo(function Inspector() {
  return (
    <>
      <section id="inspector" aria-label="객체 속성">
        <div
          id="inspector-resize"
          role="separator"
          aria-label="객체 속성 높이"
          aria-orientation="horizontal"
          aria-valuemin={120}
          aria-valuemax={480}
          aria-valuenow={182}
          tabIndex={0}
        />
        <div className="inspector-head" title="객체 속성 열기/닫기">
          <button id="inspector-toggle" aria-label="객체 속성 접기/펼치기" aria-expanded="false" />
          <strong id="selection">객체 속성</strong>
          <span id="selection-kind" />
        </div>
        <div className="inspector-body">
          <nav aria-label="객체 정보">
            <button data-inspect="properties" aria-pressed="true">
              속성
            </button>
            <button data-inspect="geometry">형상</button>
            <button data-inspect="relations">관계</button>
            <button data-inspect="history">이력</button>
          </nav>
          <div id="inspector-content">객체를 선택하세요.</div>
        </div>
      </section>
    </>
  );
});

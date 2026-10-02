// ViewportArea (PLAN-26 T-113, region B): the 3D view, its tools and the selection bar. Other
// modules also append direct children (jig boards, display popover): they stay because this markup
// never re-renders. Static markup moved from index.html; it has no state or props and never
// re-renders until its region makes it stateful.
import { memo } from 'react';
import { EdgeToggles } from './edge-toggles.tsx';

export const ViewportArea = memo(function ViewportArea() {
  return (
    <>
      <div className="viewport-area">
        <EdgeToggles />
        <div className="spatial-tools" aria-label="공간 입력">
          <button
            data-tool="select"
            aria-label="선택"
            title="선택"
            aria-pressed="true"
            data-icon="cursor"
          />
          <button
            data-tool="sketch"
            aria-label="스케치"
            title="스케치 · 펜으로 그리고 손가락으로 회전·확대"
            data-icon="pencil"
          />
        </div>
        {'\n'}
        <div className="view-navigation">
          <button
            data-view="axon"
            title="3D 보기 (기본 시점)"
            aria-label="3D 보기"
            data-icon="cube"
          />
          <button data-view="plan" title="위 · 직교" aria-label="위 · 직교">
            위
          </button>
          <button data-view="front" title="앞 · 직교" aria-label="앞 · 직교">
            앞
          </button>
          <button data-view="side" title="옆 · 직교" aria-label="옆 · 직교">
            옆
          </button>
          <button
            id="projection-toggle"
            title="투영 방식: 원근 ↔ 평행(직교)"
            aria-label="평행 투영으로 전환"
            data-icon="perspective"
          />
          <button
            id="fit-selection"
            title="선택 객체에 맞춰 보기"
            aria-label="선택 객체에 맞춰 보기"
            data-icon="fit-selection"
          />
          <select hidden id="projection" aria-label="투영">
            <option value="axon">3D</option>
            <option value="plan">위</option>
            <option value="front">앞</option>
            <option value="side">옆</option>
          </select>
          <button
            id="fit-view"
            title="모델 전체 보기"
            aria-label="모델 전체 보기"
            data-icon="fit-all"
          />
          <button
            id="display-settings"
            title="뷰포트 표시 · 음영·색상·모서리"
            aria-label="뷰포트 표시 설정"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="8" />
              <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" />
            </svg>
          </button>
        </div>
        {'\n'}
        <div id="sketch-tools" hidden>
          <div className="brush-row">
            <div className="swatches" role="group" aria-label="브러시 색상">
              <button
                type="button"
                className="swatch"
                data-color="#d0473a"
                aria-label="색상 #d0473a"
                title="#d0473a"
              />
              <button
                type="button"
                className="swatch"
                data-color="#e8913a"
                aria-label="색상 #e8913a"
                title="#e8913a"
              />
              <button
                type="button"
                className="swatch"
                data-color="#e3c63c"
                aria-label="색상 #e3c63c"
                title="#e3c63c"
              />
              <button
                type="button"
                className="swatch"
                data-color="#3f9b5c"
                aria-label="색상 #3f9b5c"
                title="#3f9b5c"
              />
              <button
                type="button"
                className="swatch"
                data-color="#3c6fd0"
                aria-label="색상 #3c6fd0"
                title="#3c6fd0"
              />
              <button
                type="button"
                className="swatch"
                data-color="#7a4fc0"
                aria-label="색상 #7a4fc0"
                title="#7a4fc0"
              />
              <button
                type="button"
                className="swatch"
                data-color="#292c2d"
                aria-label="색상 #292c2d"
                title="#292c2d"
              />
              <input
                id="brush-color"
                type="color"
                defaultValue="#d0473a"
                aria-label="브러시 색상 직접 선택"
                title="색상 직접 선택"
              />
            </div>
            <label className="brush-width" title="브러시 굵기 · [ ]">
              굵기
              <input
                id="brush-width"
                type="range"
                min="1"
                max="24"
                step="1"
                defaultValue="4"
                aria-label="브러시 굵기"
              />
              <output id="brush-width-value">4</output>
            </label>
            <button
              type="button"
              id="brush-eraser"
              aria-pressed="false"
              title="지우개 · 획 전체를 지웁니다 (E)"
            >
              지우개
            </button>
            <span className="tool-sep" />
            <button
              type="button"
              id="brush-surface"
              aria-pressed="true"
              title="표면에 붙이기 · 켜면 모델 표면을 따라, 끄면 첫 점 깊이의 화면 평면에 그립니다. 위·앞·옆 보기에서는 그 축 평면이 됩니다. (S)"
            >
              표면에 붙이기
            </button>
            <span className="tool-sep" />
            <button type="button" id="undo-point" title="마지막 획 지우기 · Ctrl+Z">
              ↶
            </button>
            <button type="button" id="clear-sketch" title="그린 획 모두 지우기">
              비우기
            </button>
            <button type="button" id="finish-sketch" className="primary-button">
              입력에 첨부
            </button>
            <button type="button" id="cancel-sketch">
              취소
            </button>
          </div>
        </div>
        {'\n'}
        <div className="selection-bar" id="selection-bar" hidden>
          <span id="selection-count" />
          <button
            id="selection-pin"
            title="선택한 객체를 요청의 변경 대상으로 고정합니다. 연결된 Rhino에도 같이 표시됩니다."
          >
            📌 요청에 고정
          </button>
        </div>
        <div id="canvas" />
        <p id="tool-hint" />
      </div>
    </>
  );
});

// ViewportArea (PLAN-26 T-113, region B): the 3D view's tools, the sketch toolbar, the selection
// bar and the empty-view notice, drawn from the sketch, selection and viewer slices. #canvas stays an
// empty container the three.js viewer (viewport.ts) owns. Other modules append direct children
// (jig boards here, the display popover after #display-settings): every child React renders here
// is always present, so React never inserts or removes nodes next to theirs.
import { memo, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { EdgeToggles } from './edge-toggles.tsx';
import { useStore } from '../store/core.ts';
import { sketchState } from '../store/sketch.ts';
import { selectionState } from '../store/selection.ts';
import { viewerState } from '../store/viewer.ts';
import { iconSvg } from '../icons.ts';
import { viewportEmptyView } from '../viewport-empty.ts';
import { viewportActions as act } from './viewport-actions.ts';

/** The icon markup of a `data-icon` button (what paintIcons() used to fill in). */
const icon = (name: string) => ({ __html: iconSvg(name) });
const SWATCHES = ['#d0473a', '#e8913a', '#e3c63c', '#3f9b5c', '#3c6fd0', '#7a4fc0', '#292c2d'];
const SKETCH_HINT =
  '펜·드래그로 그리기 · 손가락/우클릭 회전 · 두 손가락/Shift+우클릭 이동 · 휠·핀치 확대 · 위/앞/옆 보기는 그 평면에 그리기';

function SpatialTools() {
  const tool = useStore(sketchState, (s) => s.tool);
  // Before the first tool change the sketch button had no pressed state.
  const chosen = useStore(sketchState, (s) => s.toolChosen);
  return (
    <div className="spatial-tools" aria-label="공간 입력">
      <button
        data-tool="select"
        aria-label="선택"
        title="선택"
        aria-pressed={tool === 'select'}
        data-icon="cursor"
        onClick={() => act.tool('select')}
        dangerouslySetInnerHTML={icon('cursor')}
      />
      <button
        data-tool="sketch"
        aria-label="스케치"
        title="스케치 · 펜으로 그리고 손가락으로 회전·확대"
        aria-pressed={chosen ? tool === 'sketch' : undefined}
        data-icon="pencil"
        onClick={() => act.tool('sketch')}
        dangerouslySetInnerHTML={icon('pencil')}
      />
    </div>
  );
}

function ViewButton({
  view,
  label,
  title,
}: {
  view: 'plan' | 'front' | 'side';
  label: string;
  title: string;
}) {
  const camera = useStore(viewerState, (s) => s.camera);
  return (
    <button
      data-view={view}
      title={title}
      aria-label={title}
      aria-pressed={camera ? camera.view === view : undefined}
      onClick={() => act.view(view)}
    >
      {label}
    </button>
  );
}

function ViewNavigation() {
  const camera = useStore(viewerState, (s) => s.camera);
  const perspective = camera?.projection === 'perspective';
  return (
    <div className="view-navigation">
      <button
        data-view="axon"
        title="3D 보기 (기본 시점)"
        aria-label="3D 보기"
        aria-pressed={camera ? camera.view === 'axon' : undefined}
        data-icon="cube"
        onClick={() => act.view('axon')}
        dangerouslySetInnerHTML={icon('cube')}
      />
      <ViewButton view="plan" label="위" title="위 · 직교" />
      <ViewButton view="front" label="앞" title="앞 · 직교" />
      <ViewButton view="side" label="옆" title="옆 · 직교" />
      <button
        id="walk-toggle"
        data-view="walk"
        title={
          camera?.view === 'walk'
            ? '걷기 끝내기 (Esc)'
            : '걷기 · 눈높이로 걸으며 보기 (WASD 이동, 우클릭 끌기 둘러보기)'
        }
        aria-label={camera?.view === 'walk' ? '걷기 끝내기' : '걷기'}
        aria-pressed={camera ? camera.view === 'walk' : undefined}
        data-icon="walk"
        onClick={() => act.walk()}
        dangerouslySetInnerHTML={icon('walk')}
      />
      <button
        id="projection-toggle"
        title={
          !camera
            ? '투영 방식: 원근 ↔ 평행(직교)'
            : perspective
              ? '지금 원근 투영 · 눌러서 평행(직교) 투영'
              : '지금 평행(직교) 투영 · 눌러서 원근 투영'
        }
        aria-label={!camera || perspective ? '평행 투영으로 전환' : '원근 투영으로 전환'}
        data-icon="perspective"
        data-projection={camera?.projection}
        onClick={() => act.toggleProjection()}
        // The icon shows the current projection; the button switches to the other one.
        dangerouslySetInnerHTML={icon(!camera || perspective ? 'perspective' : 'orthographic')}
      />
      <button
        id="fit-selection"
        title="선택 객체에 맞춰 보기"
        aria-label="선택 객체에 맞춰 보기"
        data-icon="fit-selection"
        onClick={() => act.fitSelection()}
        dangerouslySetInnerHTML={icon('fit-selection')}
      />
      {/* Uncontrolled: thread.ts and the view buttons set its value and send it a native change. */}
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
        onClick={() => act.fitView()}
        dangerouslySetInnerHTML={icon('fit-all')}
      />
      {/* display-settings.ts owns aria-controls/aria-expanded and the popover placed after it. */}
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
  );
}

function SketchToolbar() {
  useStore(sketchState, (s) => s.version);
  const { tool, brush, brushShown, strokes } = sketchState;
  // Before the first draw() the stroke buttons had no disabled state.
  const empty = sketchState.version ? !strokes.length : undefined;
  const color = useRef<HTMLInputElement>(null);
  const width = useRef<HTMLInputElement>(null);
  // The inputs stay uncontrolled (their value attributes keep the defaults); the brush writes
  // their values when a swatch or a shortcut changes it.
  useLayoutEffect(() => {
    if (color.current && color.current.value !== brush.color) color.current.value = brush.color;
    if (width.current && width.current.valueAsNumber !== brush.width)
      width.current.value = String(brush.width);
  }, [brush.color, brush.width]);
  return (
    <div id="sketch-tools" hidden={tool !== 'sketch'}>
      <div className="brush-row">
        <div className="swatches" role="group" aria-label="브러시 색상">
          {SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className="swatch"
              data-color={swatch}
              aria-label={`색상 ${swatch}`}
              title={swatch}
              aria-pressed={brushShown ? swatch === brush.color : undefined}
              // The page CSP blocks inline style attributes; React sets this through the CSSOM.
              style={{ '--swatch': swatch } as CSSProperties}
              onClick={() => act.swatch(swatch)}
            />
          ))}
          <input
            ref={color}
            id="brush-color"
            type="color"
            defaultValue="#d0473a"
            aria-label="브러시 색상 직접 선택"
            title="색상 직접 선택"
            onInput={(event) => act.brushColor(event.currentTarget.value)}
          />
        </div>
        <label className="brush-width" title="브러시 굵기 · [ ]">
          굵기
          <input
            ref={width}
            id="brush-width"
            type="range"
            min="1"
            max="24"
            step="1"
            defaultValue="4"
            aria-label="브러시 굵기"
            onInput={(event) => act.brushWidth(event.currentTarget.valueAsNumber)}
          />
          <output id="brush-width-value">{String(brush.width)}</output>
        </label>
        <button
          type="button"
          id="brush-eraser"
          aria-pressed={brush.erase}
          title="지우개 · 획 전체를 지웁니다 (E)"
          onClick={() => act.eraser()}
        >
          지우개
        </button>
        <span className="tool-sep" />
        <button
          type="button"
          id="brush-surface"
          aria-pressed={brush.surface}
          title="표면에 붙이기 · 켜면 모델 표면을 따라, 끄면 첫 점 깊이의 화면 평면에 그립니다. 위·앞·옆 보기에서는 그 축 평면이 됩니다. (S)"
          onClick={() => act.surface()}
        >
          표면에 붙이기
        </button>
        <span className="tool-sep" />
        <button
          type="button"
          id="undo-point"
          title="마지막 획 지우기 · Ctrl+Z"
          disabled={empty}
          onClick={() => act.undoStroke()}
        >
          ↶
        </button>
        <button
          type="button"
          id="clear-sketch"
          title="그린 획 모두 지우기"
          disabled={empty}
          onClick={() => act.clearSketch()}
        >
          비우기
        </button>
        <button
          type="button"
          id="finish-sketch"
          className="primary-button"
          disabled={empty}
          onClick={() => act.finishSketch()}
        >
          입력에 첨부
        </button>
        <button type="button" id="cancel-sketch" onClick={() => act.cancelSketch()}>
          취소
        </button>
      </div>
    </div>
  );
}

function SelectionBar() {
  const painted = useStore(selectionState, (s) => s.version) > 0;
  const count = selectionState.selectedIds.length;
  return (
    <div className="selection-bar" id="selection-bar" hidden={!painted || !count}>
      <span id="selection-count">{painted ? `${count.toLocaleString()}개 선택` : ''}</span>
      <button
        id="selection-pin"
        title="선택한 객체를 요청의 변경 대상으로 고정합니다. 연결된 Rhino에도 같이 표시됩니다."
        onClick={() => act.pinSelection()}
      >
        📌 요청에 고정
      </button>
    </div>
  );
}

function ToolHint() {
  const tool = useStore(sketchState, (s) => s.tool);
  return <p id="tool-hint">{tool === 'sketch' ? SKETCH_HINT : ''}</p>;
}

function ViewportEmpty() {
  const empty = useStore(viewerState, (s) => s.empty);
  const { hidden, state, title, detail } = viewportEmptyView(empty);
  return (
    <div
      id="viewport-empty"
      className="viewport-empty"
      role="status"
      hidden={hidden}
      data-state={state}
    >
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

export const ViewportArea = memo(function ViewportArea() {
  return (
    <>
      <div className="viewport-area">
        <EdgeToggles />
        <SpatialTools />
        {'\n'}
        <ViewNavigation />
        {'\n'}
        <SketchToolbar />
        {'\n'}
        <SelectionBar />
        {/* The three.js viewer's container: React never renders into it. */}
        <div id="canvas" />
        <ToolHint />
        <ViewportEmpty />
      </div>
    </>
  );
});

// The 단면 tool of the view toolbar (SPEC-01.15, PLAN-43 T-197): a button and its popover with the
// plane (a two-click section line, or an axis; position, flip) and box (six faces) controls.
// Always rendered (hidden when closed), so the nodes next to it that other modules insert keep
// their place.
import { useEffect, useRef } from 'react';
import { useStore } from '../store/core.ts';
import { viewerState } from '../store/viewer.ts';
import { iconSvg } from '../icons.ts';
import { viewportActions as act } from './viewport-actions.ts';

const AXES = ['x', 'y', 'z'] as const;
const metres = (value: number) => `${value.toFixed(2)} m`;
const step = (min: number, max: number) => Math.max((max - min) / 400, 0.001);

function Segment<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onPick: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      <div className="display-segment" role="group" aria-label={label}>
        {options.map(([key, text]) => (
          <button
            key={key}
            type="button"
            data-section={key}
            aria-pressed={value === key}
            onClick={() => onPick(key)}
          >
            {text}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="range"
      aria-label={label}
      title={`${label} · ${metres(value)}`}
      min={min}
      max={max}
      step={step(min, max)}
      value={value}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
    />
  );
}

export function SectionTool() {
  const s = useStore(viewerState, (state) => state.section);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!s.open) return;
    const outside = (event: PointerEvent) => {
      // Clicks in the viewport place the section line's points: the panel stays open meanwhile.
      if (viewerState.section.placing) return;
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target))
        act.sectionPanel(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape first cancels a section line being drawn, then closes the panel.
      if (viewerState.section.placing) act.sectionCancelDraw();
      else act.sectionPanel(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [s.open]);
  const on = s.mode !== 'off';
  const bounds = s.bounds;
  const axisIndex = AXES.indexOf(s.axis);
  return (
    <>
      <button
        ref={button}
        id="section-toggle"
        title={on ? '단면 보기 중 · 눌러서 조절' : '단면 · 두 점을 찍은 평면이나 상자로 잘라 보기'}
        aria-label="단면"
        aria-pressed={on}
        aria-expanded={s.open}
        aria-controls="section-panel"
        onClick={() => act.sectionPanel()}
        dangerouslySetInnerHTML={{ __html: iconSvg('section') }}
      />
      <div
        ref={panel}
        id="section-panel"
        className="display-popover section-popover"
        role="dialog"
        aria-label="단면"
        hidden={!s.open}
      >
        <Segment
          label="단면"
          options={[
            ['off', '끄기'],
            ['plane', '평면'],
            ['box', '상자'],
          ]}
          value={s.mode}
          onPick={act.sectionMode}
        />
        {s.mode === 'plane' && bounds && (
          <Segment
            label="평면 기준"
            options={[
              ['line', '두 점'],
              ['axis', '축 기준'],
            ]}
            value={s.kind}
            onPick={act.sectionKind}
          />
        )}
        {s.mode === 'plane' && s.kind === 'line' && (
          <>
            <button
              type="button"
              className="section-draw"
              aria-pressed={s.placing !== null}
              onClick={() => act.sectionDraw()}
            >
              두 점으로 그리기
            </button>
            {s.placing && (
              <p className="section-hint" role="status">
                {s.placing === 'first' ? '첫 점을 클릭하세요' : '둘째 점을 클릭하세요'} · Esc나
                오른쪽 클릭으로 취소
              </p>
            )}
            {s.line && (
              <>
                <p className="section-line" aria-label="단면선">
                  ({s.line.a[0].toFixed(2)}, {s.line.a[1].toFixed(2)}) → ({s.line.b[0].toFixed(2)},{' '}
                  {s.line.b[1].toFixed(2)}) ·{' '}
                  {metres(Math.hypot(s.line.b[0] - s.line.a[0], s.line.b[1] - s.line.a[1]))}
                </p>
                <div className="section-range">
                  <span>
                    위치 <output>{metres(s.lineOffset)}</output>
                  </span>
                  <Slider
                    label="단면선 위치"
                    value={s.lineOffset}
                    min={s.lineRange[0]}
                    max={s.lineRange[1]}
                    onChange={act.sectionLineOffset}
                  />
                </div>
                <label className="display-check">
                  <input type="checkbox" checked={s.flip} onChange={() => act.sectionFlip()} />
                  <span>반대쪽 남기기</span>
                </label>
              </>
            )}
          </>
        )}
        {s.mode === 'plane' && s.kind === 'axis' && bounds && (
          <>
            <Segment
              label="축"
              options={[
                ['x', 'X'],
                ['y', 'Y'],
                ['z', 'Z'],
              ]}
              value={s.axis}
              onPick={act.sectionAxis}
            />
            <div className="section-range">
              <span>
                위치 <output>{metres(s.offset)}</output>
              </span>
              <Slider
                label="단면 위치"
                value={s.offset}
                min={bounds.min[axisIndex]}
                max={bounds.max[axisIndex]}
                onChange={act.sectionOffset}
              />
            </div>
            <label className="display-check">
              <input type="checkbox" checked={s.flip} onChange={() => act.sectionFlip()} />
              <span>반대쪽 남기기</span>
            </label>
          </>
        )}
        {s.mode === 'box' && bounds && (
          <>
            {AXES.map((axis, index) => (
              <div className="section-range" key={axis}>
                <span>
                  {axis.toUpperCase()}{' '}
                  <output>
                    {s.min[index].toFixed(2)} ~ {metres(s.max[index])}
                  </output>
                </span>
                <Slider
                  label={`${axis.toUpperCase()} 최소`}
                  value={s.min[index]}
                  min={bounds.min[index]}
                  max={bounds.max[index]}
                  onChange={(value) => act.sectionBox(index as 0 | 1 | 2, 'min', value)}
                />
                <Slider
                  label={`${axis.toUpperCase()} 최대`}
                  value={s.max[index]}
                  min={bounds.min[index]}
                  max={bounds.max[index]}
                  onChange={(value) => act.sectionBox(index as 0 | 1 | 2, 'max', value)}
                />
              </div>
            ))}
            <button type="button" className="section-reset" onClick={() => act.sectionResetBox()}>
              모델 범위로
            </button>
          </>
        )}
        <p className="section-note">VIDE 화면만 자릅니다. 문서는 바뀌지 않습니다.</p>
      </div>
    </>
  );
}

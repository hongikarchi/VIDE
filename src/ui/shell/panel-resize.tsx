// PanelResize (PLAN-26 T-113, region A): the two width handles of the side panels (drag or arrow
// keys, Home for the default), remembered per browser in `vide:panel-widths`. They are direct
// children of `.workspace` (the tab screens' CSS hides the left one), added at the end of it when
// the panels are set up (src/ui/workspace-panels.ts), as before.
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store/core.ts';
import {
  layoutState,
  layoutWidths,
  persistWidths,
  widthLimits,
  type Side,
} from '../store/layout.ts';

function Handle({ side }: { side: Side }) {
  const width = useStore(layoutState, (s) => s.widths[side]);
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const limits = widthLimits[side];
  const end = () => {
    drag.current = undefined;
    persistWidths();
  };
  return (
    <div
      className={'panel-resize panel-resize-' + side}
      data-side={side}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? '문서 패널 너비' : '대화 패널 너비'}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, width: layoutState.widths[side] };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        layoutState.widths[side] =
          drag.current.width + (event.clientX - drag.current.x) * (side === 'left' ? 1 : -1);
        layoutWidths();
      }}
      onPointerUp={end}
      onLostPointerCapture={end}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
        event.preventDefault();
        layoutState.widths[side] =
          event.key === 'Home'
            ? limits.home
            : layoutState.widths[side] +
              (event.key === 'ArrowRight' ? 16 : -16) * (side === 'left' ? 1 : -1);
        layoutWidths();
        persistWidths();
      }}
    />
  );
}

export function PanelResize() {
  const ready = useStore(layoutState, (s) => s.ready);
  const workspace = ready ? document.querySelector('.workspace') : null;
  if (!workspace) return null;
  return createPortal(
    <>
      <Handle side="left" />
      <Handle side="right" />
    </>,
    workspace,
  );
}

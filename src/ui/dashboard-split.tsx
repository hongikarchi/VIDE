// The handle between the dashboard's month and its right column (할 일 · 연결 파일 · 프로젝트 폴더;
// PLAN-42 T-192, Design §03 「대시보드의 배치」): drag it or use ←/→ (Home for the default) to
// change the right column's width. The width is remembered in this browser only; the row stacks
// when narrow and the handle is hidden then (dashboard.css).
import { useCallback, useRef, useState, type RefObject } from 'react';

const KEY = 'vide:dashboard-side-width';
export const SIDE_HOME = 420;
const SIDE_MIN = 300;
/** The month keeps at least this much beside the right column. */
const CALENDAR_MIN = 520;
const STEP = 16;

function stored() {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isFinite(value) && value >= SIDE_MIN ? value : SIDE_HOME;
  } catch {
    return SIDE_HOME;
  }
}
function remember(width: number) {
  try {
    localStorage.setItem(KEY, String(width));
  } catch {
    /* Kept for this session only. */
  }
}

/** The right column's width and a setter that keeps it between its limits in `pair`. */
export function useSideWidth(pair: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(stored);
  const max = useCallback(() => {
    const room = pair.current?.clientWidth ?? 0;
    return Math.max(SIDE_MIN, room - CALENDAR_MIN - 12);
  }, [pair]);
  const set = useCallback(
    (next: number, keep = false) => {
      const fitted = Math.round(Math.max(SIDE_MIN, Math.min(max(), next)));
      setWidth(fitted);
      if (keep) remember(fitted);
      return fitted;
    },
    [max],
  );
  return { width, set, max };
}

export function SideSplitter({
  width,
  set,
  max,
}: {
  width: number;
  set: (next: number, keep?: boolean) => number;
  max: () => number;
}) {
  const drag = useRef<{ x: number; width: number; last: number } | undefined>(undefined);
  const end = () => {
    if (drag.current) set(drag.current.last, true);
    drag.current = undefined;
  };
  return (
    <div
      className="dash-split"
      role="separator"
      aria-orientation="vertical"
      aria-label="할 일 열 너비"
      aria-valuemin={SIDE_MIN}
      aria-valuemax={max()}
      aria-valuenow={width}
      tabIndex={0}
      title="끌어서 너비 조절 · ←/→ · Home"
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, width, last: width };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        // The column is on the right: dragging left widens it.
        drag.current.last = set(drag.current.width - (event.clientX - drag.current.x));
      }}
      onPointerUp={end}
      onLostPointerCapture={end}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
        event.preventDefault();
        set(
          event.key === 'Home' ? SIDE_HOME : width + (event.key === 'ArrowLeft' ? STEP : -STEP),
          true,
        );
      }}
    />
  );
}

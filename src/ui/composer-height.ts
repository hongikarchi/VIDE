import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react';
import { flushSync } from 'react-dom';

const KEY = 'vide:composer-height';
const max = () => Math.max(76, Math.min(400, innerHeight * 0.45));
const clamp = (height: number) => Math.max(76, Math.min(max(), height));

function storedHeight() {
  try {
    const stored = Number(localStorage.getItem(KEY));
    if (stored > 0) return stored;
  } catch {
    /* Local preference is optional. */
  }
  return 96;
}
function save(height: number) {
  try {
    localStorage.setItem(KEY, String(height));
  } catch {
    /* Session resizing still works. */
  }
}

/**
 * The composer's height handle (`#composer-resize`, PLAN-26 T-113): drag or arrow keys, remembered
 * per browser in `vide:composer-height`. Returns the handle's props; the height goes to `#body`
 * (an uncontrolled textarea) after each commit. Updates commit at once (`flushSync`), so the box
 * has its new height when the pointer or key event ends, as before.
 */
export function useComposerHeight(): HTMLAttributes<HTMLDivElement> {
  const [height, setHeight] = useState(() => clamp(storedHeight()));
  // Window resizes change the limit; the stored height is clamped again then.
  const [, setLimit] = useState(max);
  const drag = useRef<{ y: number; height: number } | undefined>(undefined);
  const current = useRef(height);
  current.current = height;
  const set = (next: number) => flushSync(() => setHeight(clamp(next)));
  useLayoutEffect(() => {
    const body = document.getElementById('body');
    if (body) body.style.height = `${height}px`;
  });
  useEffect(() => {
    const resize = () =>
      flushSync(() => {
        setLimit(max());
        setHeight((value) => clamp(value));
      });
    addEventListener('resize', resize);
    return () => removeEventListener('resize', resize);
  }, []);
  const end = () => {
    drag.current = undefined;
    save(current.current);
  };
  return {
    'aria-valuemin': 76,
    'aria-valuemax': Math.round(max()),
    'aria-valuenow': Math.round(height),
    onPointerDown(event) {
      if (event.button !== 0) return;
      drag.current = { y: event.clientY, height: current.current };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    onPointerMove(event) {
      if (!drag.current) return;
      set(drag.current.height + drag.current.y - event.clientY);
    },
    onPointerUp: end,
    onLostPointerCapture: end,
    onKeyDown(event) {
      if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
      event.preventDefault();
      const next = clamp(
        event.key === 'Home' ? 96 : current.current + (event.key === 'ArrowUp' ? 16 : -16),
      );
      set(next);
      save(next);
    },
  };
}

/**
 * Kept for workspace-panels.ts (region A), which still calls it at start: the handle is now the
 * composer's own (shell/composer.tsx), so there is nothing left to start here.
 */
export function initializeComposerHeight() {}

import { element as $ } from './elements.ts';

/**
 * The composer's height handle (`#composer-resize`, moved out of workspace-panels.ts in PLAN-26
 * T-113): drag or arrow keys, remembered per browser in `vide:composer-height`.
 */
export function initializeComposerHeight() {
  const composerHandle = $('composer-resize');
  const body = $('body');
  let composerHeight = 96;
  try {
    const stored = Number(localStorage.getItem('vide:composer-height'));
    if (stored > 0) composerHeight = stored;
  } catch {
    /* Local preference is optional. */
  }
  function composerLayout() {
    const max = Math.max(76, Math.min(400, innerHeight * 0.45));
    composerHeight = Math.max(76, Math.min(max, composerHeight));
    body.style.height = `${composerHeight}px`;
    composerHandle.setAttribute('aria-valuemin', '76');
    composerHandle.setAttribute('aria-valuemax', String(Math.round(max)));
    composerHandle.setAttribute('aria-valuenow', String(Math.round(composerHeight)));
  }
  function saveComposer() {
    try {
      localStorage.setItem('vide:composer-height', String(composerHeight));
    } catch {
      /* Session resizing still works. */
    }
  }
  let composerDrag: { y: number; height: number } | undefined;
  composerHandle.onpointerdown = (event) => {
    if (event.button !== 0) return;
    composerDrag = { y: event.clientY, height: composerHeight };
    composerHandle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  composerHandle.onpointermove = (event) => {
    if (!composerDrag) return;
    composerHeight = composerDrag.height + composerDrag.y - event.clientY;
    composerLayout();
  };
  composerHandle.onlostpointercapture = composerHandle.onpointerup = () => {
    composerDrag = undefined;
    saveComposer();
  };
  composerHandle.onkeydown = (event) => {
    if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault();
    composerHeight =
      event.key === 'Home' ? 96 : composerHeight + (event.key === 'ArrowUp' ? 16 : -16);
    composerLayout();
    saveComposer();
  };
  addEventListener('resize', composerLayout);
  composerLayout();
}

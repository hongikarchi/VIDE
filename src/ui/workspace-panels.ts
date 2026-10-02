// The side panels' setup (PLAN-26 T-113, region A). The rail (src/ui/shell/rail.tsx), the left
// panel's sections and tabs (src/ui/shell/left-panel.tsx) and the width handles
// (src/ui/shell/panel-resize.tsx) render from the layout slice; this start reads the remembered
// widths, shows the document tree section and adds the handles.
import { initializeComposerHeight } from './composer-height.ts';
import { commitNow, layoutState, layoutWidths } from './store/layout.ts';

export function initializeWorkspacePanels() {
  try {
    const saved = JSON.parse(localStorage.getItem('vide:panel-widths') || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.right))
      layoutState.widths = saved;
  } catch {
    /* Invalid local preference uses defaults. */
  }
  // The document tree section shows (its <details> keeps its own open state), the rail shows
  // which destination is pressed, and the width handles are added.
  layoutState.section = 'document-tree';
  layoutState.ready = true;
  commitNow(layoutState);
  addEventListener('resize', layoutWidths);
  layoutWidths();
  initializeComposerHeight();
}

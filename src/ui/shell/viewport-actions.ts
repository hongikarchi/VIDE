// What the viewport and inspector controls do (PLAN-26 T-113, region B). src/ui/app/viewport.ts
// fills these in at the point of the start where the old code attached its click handlers; until
// then a click does nothing, as before. The shell imports only this table, not the app modules,
// so the module order of the start stays as it was.
import type { InspectorTab } from '../inspector.ts';

const nothing = () => {};

export const viewportActions: {
  tool: (tool: 'select' | 'sketch') => void;
  view: (view: 'axon' | 'plan' | 'front' | 'side') => void;
  toggleProjection: () => void;
  /** Walk mode on/off (PLAN-37). */
  walk: () => void;
  fitSelection: () => void;
  fitView: () => void;
  swatch: (color: string) => void;
  brushColor: (color: string) => void;
  brushWidth: (width: number) => void;
  eraser: () => void;
  surface: () => void;
  undoStroke: () => void;
  clearSketch: () => void;
  finishSketch: () => void;
  cancelSketch: () => void;
  pinSelection: () => void;
  inspectorTab: (tab: InspectorTab) => void;
} = {
  tool: nothing,
  view: nothing,
  toggleProjection: nothing,
  walk: nothing,
  fitSelection: nothing,
  fitView: nothing,
  swatch: nothing,
  brushColor: nothing,
  brushWidth: nothing,
  eraser: nothing,
  surface: nothing,
  undoStroke: nothing,
  clearSketch: nothing,
  finishSketch: nothing,
  cancelSketch: nothing,
  pinSelection: nothing,
  inspectorTab: nothing,
};

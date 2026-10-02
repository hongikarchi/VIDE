// The viewport tool, the brush and the strokes not yet attached (PLAN-26 T-113, region B). The
// strokes array changes in place; draw() in src/ui/app/viewport.ts raises the version after it.
import { createSlice } from './core.ts';
import type { DraftStroke } from '../model.ts';

export interface BrushFields {
  color: string;
  width: number;
  erase: boolean;
  /** Draw on the model surface (on) or on the screen plane at the first point's depth (off). */
  surface: boolean;
}
export interface SketchFields {
  tool: 'select' | 'sketch';
  strokes: DraftStroke[];
  brush: BrushFields;
  /** The brush was applied once: until then the swatches show no pressed state (as before). */
  brushShown: boolean;
  /** A tool was chosen once: until then the sketch button shows no pressed state (as before). */
  toolChosen: boolean;
}
export const sketchState = createSlice<SketchFields>({
  tool: 'select',
  strokes: [],
  brush: { color: '#d0473a', width: 4, erase: false, surface: true },
  brushShown: false,
  toolChosen: false,
});

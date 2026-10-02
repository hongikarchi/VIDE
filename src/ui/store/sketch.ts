// The viewport tool and the brush strokes not yet attached (PLAN-26 T-113, region B).
import { createSlice } from './core.ts';
import type { DraftStroke } from '../model.ts';

export interface SketchFields {
  tool: 'select' | 'sketch';
  strokes: DraftStroke[];
}
export const sketchState = createSlice<SketchFields>({
  tool: 'select',
  strokes: [],
});

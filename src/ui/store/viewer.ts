// The 3D viewport handle and the inspector tab (PLAN-26 T-113, region B). Camera values are not
// kept here: they change every frame (ARCH-01 §1.2).
import { createSlice } from './core.ts';
import type { createViewport } from '../viewport.ts';
import type { renderInspector } from '../inspector.ts';

export interface ViewerFields {
  inspectorTab: NonNullable<Parameters<typeof renderInspector>[3]>;
  viewport: ReturnType<typeof createViewport> | undefined;
  thumbnailTimer: ReturnType<typeof setTimeout> | undefined;
  thumbnailSent: number;
}
export const viewerState = createSlice<ViewerFields>({
  inspectorTab: 'properties',
  viewport: undefined,
  thumbnailTimer: undefined,
  thumbnailSent: 0,
});

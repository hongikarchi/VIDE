// The 3D viewport handle, its camera view, the inspector and the empty-view notice (PLAN-26 T-113,
// region B). The camera is set only when its view or projection changes, never per frame
// (ARCH-01 §1.2).
import { createSlice } from './core.ts';
import type { createViewport } from '../viewport.ts';
import type { InspectorTab, InspectorView } from '../inspector.ts';
import type { ViewportEmptyFields } from '../viewport-empty.ts';

export interface ViewerFields {
  inspectorTab: InspectorTab;
  viewport: ReturnType<typeof createViewport> | undefined;
  thumbnailTimer: ReturnType<typeof setTimeout> | undefined;
  thumbnailSent: number;
  /** The view the camera looks from ('' off the standard views) and its projection. */
  camera: { view: string; projection: 'orthographic' | 'perspective' } | undefined;
  /** The inspector panel is open; it stays as the user left it across reloads. */
  inspectorOpen: boolean;
  /** The inspector title (#selection): the picked object, or the count of a multi-selection. */
  selectionTitle: string;
  /** What the inspector shows, built by paintInspector(); undefined before the first render. */
  inspector: InspectorView | undefined;
  empty: ViewportEmptyFields;
}
export const viewerState = createSlice<ViewerFields>({
  inspectorTab: 'properties',
  viewport: undefined,
  thumbnailTimer: undefined,
  thumbnailSent: 0,
  camera: undefined,
  inspectorOpen: (() => {
    try {
      return localStorage.getItem('vide:inspector-open') === 'true';
    } catch {
      return false;
    }
  })(),
  selectionTitle: '객체 속성',
  inspector: undefined,
  empty: { connection: undefined, sync: 'idle', hidden: false },
});

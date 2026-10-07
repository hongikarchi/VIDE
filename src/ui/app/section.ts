// Section view (SPEC-01.15, PLAN-43 T-197): the 단면 panel's actions. It changes the viewer slice and
// hands the viewer a plane or a box; only VIDE's drawing is cut, the host documents are untouched.
import type { Section } from '../viewport.ts';
import { viewerState, type SectionPanel } from '../store/viewer.ts';
import { viewportActions } from '../shell/viewport-actions.ts';
import { message } from './status.ts';

type Triple = [number, number, number];
const AXES = ['x', 'y', 'z'] as const;

function set(next: Partial<SectionPanel>) {
  viewerState.section = { ...viewerState.section, ...next };
  apply();
  viewerState.bump();
}
/** The viewer's section for the panel's state. */
function apply() {
  const s = viewerState.section;
  const value: Section | null =
    s.mode === 'plane'
      ? { mode: 'plane', axis: s.axis, offset: s.offset, flip: s.flip }
      : s.mode === 'box'
        ? { mode: 'box', min: s.min, max: s.max }
        : null;
  viewerState.viewport?.setSection(value);
}
/** The shown model's bounds with a little room, so flat models still give sliders a range. */
function roomyBounds() {
  const bounds = viewerState.viewport?.modelBounds();
  if (!bounds) return undefined;
  const span = Math.max(...bounds.max.map((v, i) => v - bounds.min[i]));
  const pad = Math.max(span * 0.01, 0.05);
  return {
    min: bounds.min.map((v) => v - pad) as Triple,
    max: bounds.max.map((v) => v + pad) as Triple,
  };
}
const middle = (bounds: { min: Triple; max: Triple }, index: number) =>
  (bounds.min[index] + bounds.max[index]) / 2;

export function initSection() {
  viewportActions.sectionPanel = (open) => {
    const next = open ?? !viewerState.section.open;
    if (next === viewerState.section.open) return;
    viewerState.section = { ...viewerState.section, open: next };
    viewerState.bump();
  };
  viewportActions.sectionMode = (mode) => {
    const s = viewerState.section;
    if (mode === s.mode) return;
    if (mode === 'off') return set({ mode });
    // Each start takes the current model bounds: a box starts around the whole shown model.
    const bounds = roomyBounds();
    if (!bounds) {
      message('단면을 만들 모델이 없습니다. 문서를 연결하고 Sync하세요.');
      return;
    }
    if (mode === 'plane') set({ mode, bounds, offset: middle(bounds, AXES.indexOf(s.axis)) });
    else set({ mode, bounds, min: [...bounds.min], max: [...bounds.max] });
  };
  viewportActions.sectionAxis = (axis) => {
    const s = viewerState.section;
    if (axis === s.axis || !s.bounds) return;
    set({ axis, offset: middle(s.bounds, AXES.indexOf(axis)) });
  };
  viewportActions.sectionOffset = (offset) => {
    if (Number.isFinite(offset)) set({ offset });
  };
  viewportActions.sectionFlip = () => set({ flip: !viewerState.section.flip });
  viewportActions.sectionBox = (index, side, value) => {
    if (!Number.isFinite(value)) return;
    const min = [...viewerState.section.min] as Triple,
      max = [...viewerState.section.max] as Triple;
    // A face never passes its opposite face: the other one moves along.
    if (side === 'min') {
      min[index] = value;
      if (max[index] < value) max[index] = value;
    } else {
      max[index] = value;
      if (min[index] > value) min[index] = value;
    }
    set({ min, max });
  };
  viewportActions.sectionResetBox = () => {
    const bounds = roomyBounds();
    if (!bounds) {
      message('단면을 만들 모델이 없습니다. 문서를 연결하고 Sync하세요.');
      return;
    }
    set({ bounds, min: [...bounds.min], max: [...bounds.max] });
  };
}

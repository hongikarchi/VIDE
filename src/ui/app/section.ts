// Section view (SPEC-01.15, PLAN-43 T-197): the 단면 panel's actions. It changes the viewer slice and
// hands the viewer a plane (a two-click section line or an axis plane) or a box; only VIDE's
// drawing is cut, the host documents are untouched.
import type { Section, SectionLine } from '../viewport.ts';
import { viewerState, type SectionPanel } from '../store/viewer.ts';
import { viewportActions } from '../shell/viewport-actions.ts';
import { message } from './status.ts';

type Triple = [number, number, number];
const AXES = ['x', 'y', 'z'] as const;
const NO_MODEL = '단면을 만들 모델이 없습니다. 문서를 연결하고 Sync하세요.';

function set(next: Partial<SectionPanel>) {
  viewerState.section = { ...viewerState.section, ...next };
  apply();
  viewerState.bump();
}
/** The viewer's section for the panel's state. A line plane cuts only once its line is drawn. */
function apply() {
  const s = viewerState.section;
  let value: Section | null = null;
  if (s.mode === 'plane' && s.kind === 'axis')
    value = { mode: 'plane', axis: s.axis, offset: s.offset, flip: s.flip };
  else if (s.mode === 'plane' && s.line)
    value = {
      mode: 'line',
      point: s.line.a,
      normal: s.line.normal,
      offset: s.lineOffset,
      flip: s.flip,
    };
  else if (s.mode === 'box') value = { mode: 'box', min: s.min, max: s.max };
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
/** How far the line plane can move along its normal and still touch the model (always holds 0). */
function lineRange(line: SectionLine, bounds: { min: Triple; max: Triple }): [number, number] {
  const [nx, ny] = line.normal;
  const base = nx * line.a[0] + ny * line.a[1];
  let low = 0,
    high = 0;
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]]) {
      const along = nx * x + ny * y - base;
      low = Math.min(low, along);
      high = Math.max(high, along);
    }
  return [low, high];
}
/** Ends a drawing in progress; without a drawn line the plane has nothing to cut, so it turns off. */
function drawingEnded() {
  if (viewerState.section.line) set({ placing: null });
  else set({ placing: null, mode: 'off' });
}
/** Waits for two clicks in the viewport; the line already drawn (if any) cuts until they land. */
function startDrawing() {
  const viewport = viewerState.viewport;
  if (!viewport) return;
  viewport.drawSectionLine({
    onFirst: () => set({ placing: 'second' }),
    onDone: (line) => {
      const bounds = roomyBounds() ?? viewerState.section.bounds;
      set({
        placing: null,
        line,
        lineOffset: 0,
        lineRange: bounds ? lineRange(line, bounds) : [0, 0],
        flip: false,
        ...(bounds ? { bounds } : {}),
      });
    },
    onCancel: drawingEnded,
  });
  set({ placing: 'first' });
}
function stopDrawing() {
  if (!viewerState.section.placing) return;
  viewerState.viewport?.cancelSectionLine();
  viewerState.section = { ...viewerState.section, placing: null };
}

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
    stopDrawing();
    if (mode === 'off') return set({ mode });
    // Each start takes the current model bounds: a box starts around the whole shown model.
    const bounds = roomyBounds();
    if (!bounds) {
      message(NO_MODEL);
      if (s.placing && !s.line) set({ mode: 'off' });
      return;
    }
    if (mode === 'plane') {
      // A plane starts by drawing its line with two clicks; '축 기준' stays one click away.
      set({
        mode,
        bounds,
        kind: 'line',
        line: undefined,
        lineOffset: 0,
        flip: false,
        offset: middle(bounds, AXES.indexOf(s.axis)),
      });
      startDrawing();
    } else set({ mode, bounds, min: [...bounds.min], max: [...bounds.max] });
  };
  viewportActions.sectionKind = (kind) => {
    const s = viewerState.section;
    if (kind === s.kind || s.mode !== 'plane') return;
    if (kind === 'axis') {
      stopDrawing();
      const bounds = s.bounds ?? roomyBounds();
      if (!bounds) return message(NO_MODEL);
      set({ kind, bounds, offset: middle(bounds, AXES.indexOf(s.axis)) });
    } else {
      set({ kind });
      if (!viewerState.section.line) startDrawing();
    }
  };
  viewportActions.sectionDraw = () => {
    const s = viewerState.section;
    if (s.mode !== 'plane' || s.kind !== 'line') return;
    if (!roomyBounds()) return message(NO_MODEL);
    startDrawing();
  };
  viewportActions.sectionCancelDraw = () => {
    if (!viewerState.section.placing) return;
    viewerState.viewport?.cancelSectionLine();
    drawingEnded();
  };
  viewportActions.sectionLineOffset = (lineOffset) => {
    if (Number.isFinite(lineOffset)) set({ lineOffset });
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
      message(NO_MODEL);
      return;
    }
    set({ bounds, min: [...bounds.min], max: [...bounds.max] });
  };
}
